-- =====================================================================
-- 06 · Inventario diario en los carritos (20 nov 2026)
-- - Al iniciar el día se cuenta todo lo que hay (inicial); se puede registrar
--   lo que llega después (resurtido) y corregir conteos (ajuste a un número real).
-- - Existencias = inicial + resurtidos + ajustes − vendido (solo ventas activas;
--   si se cancela una venta, sus piezas regresan solas).
-- - Un sabor con 0 piezas se marca agotado automáticamente.
-- =====================================================================

alter table public.puntos_venta add column if not exists usa_inventario boolean not null default false;
update public.puntos_venta set usa_inventario = (id in ('artz', 'ph_mitikah', 'ph_satelite', 'ph_polanco'));

create table public.inventario_movimientos (
  id           bigint generated always as identity primary key,
  lote         uuid not null,                         -- un registro completo (evita duplicados por doble toque)
  punto_id     text not null references public.puntos_venta(id),
  fecha        date not null,                          -- día de operación (hora de CDMX)
  producto_id  int  not null references public.productos(id),
  sabor_id     int  not null references public.sabores(id),
  tipo         text not null check (tipo in ('inicial', 'resurtido', 'ajuste')),
  cantidad     int  not null check (cantidad between -999 and 999),
  empleado_id  int  references public.empleados(id),
  creado_en    timestamptz not null default now()
);
create index inventario_punto_fecha_idx on public.inventario_movimientos (punto_id, fecha);
create index inventario_lote_idx on public.inventario_movimientos (lote);

alter table public.inventario_movimientos enable row level security;
revoke all on public.inventario_movimientos from anon;
create policy "ver inventario" on public.inventario_movimientos for select to authenticated
  using ((select public.es_admin()) or punto_id = (select public.mi_punto()));
-- Sin políticas de escritura: solo la función registrar_inventario escribe.

-- Existencias de un punto en un día (uso interno de otras funciones)
create or replace function public.existencias(p_punto text, p_fecha date)
returns table (producto_id int, sabor_id int, inicial int, resurtido int, ajustes int, vendido int, quedan int)
language sql stable security definer set search_path = '' as $$
  with mov as (
    select m.producto_id, m.sabor_id,
           coalesce(sum(m.cantidad) filter (where m.tipo = 'inicial'), 0)::int   as inicial,
           coalesce(sum(m.cantidad) filter (where m.tipo = 'resurtido'), 0)::int as resurtido,
           coalesce(sum(m.cantidad) filter (where m.tipo = 'ajuste'), 0)::int    as ajustes
    from public.inventario_movimientos m
    where m.punto_id = p_punto and m.fecha = p_fecha
    group by m.producto_id, m.sabor_id
  ), ven as (
    select d.producto_id, d.sabor_id, sum(d.cantidad)::int as vendido
    from public.venta_detalle d join public.ventas v on v.id = d.venta_id
    where v.punto_id = p_punto and v.estado = 'activa'
      and (v.fecha_venta at time zone 'America/Mexico_City')::date = p_fecha
    group by d.producto_id, d.sabor_id
  )
  select coalesce(m.producto_id, v.producto_id), coalesce(m.sabor_id, v.sabor_id),
         coalesce(m.inicial, 0), coalesce(m.resurtido, 0), coalesce(m.ajustes, 0), coalesce(v.vendido, 0),
         coalesce(m.inicial, 0) + coalesce(m.resurtido, 0) + coalesce(m.ajustes, 0) - coalesce(v.vendido, 0)
  from mov m full join ven v on v.producto_id = m.producto_id and v.sabor_id = m.sabor_id;
$$;
revoke all on function public.existencias(text, date) from public, anon, authenticated;

-- Catálogo del punto, ahora con inventario: { inventario:{usa, registrado}, productos:[...sabores con quedan], metodos }
create or replace function public.catalogo_punto()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_punto text := public.mi_punto();
  v_hoy   date := public.hoy_cdmx();
  v_usa   boolean;
  v_reg   boolean;
  v_res   jsonb;
begin
  if v_punto is null then raise exception 'Cuenta sin punto de venta'; end if;
  select usa_inventario into v_usa from public.puntos_venta where id = v_punto;
  v_reg := coalesce(v_usa, false) and exists (select 1 from public.inventario_movimientos
                                              where punto_id = v_punto and fecha = v_hoy and tipo = 'inicial');
  with ex as (select * from public.existencias(v_punto, v_hoy)),
  sab as (
    select ps.producto_id, s.orden,
           jsonb_build_object(
             'id', s.id, 'clave', s.clave, 'nombre', s.nombre,
             'quedan', case when v_reg then coalesce(ex.quedan, 0) end,
             'agotado', exists (select 1 from public.agotados a
                                where a.punto_id = v_punto and a.producto_id = ps.producto_id
                                  and a.sabor_id = s.id and a.fecha = v_hoy)
                        or (v_reg and coalesce(ex.quedan, 0) <= 0)) as j
    from public.producto_sabores ps
    join public.sabores s on s.id = ps.sabor_id
    left join ex on ex.producto_id = ps.producto_id and ex.sabor_id = s.id
    where s.activo and public.disponible_en_punto(v_punto, ps.producto_id, s.id)
  ),
  prod as (
    select p.orden, jsonb_build_object('id', p.id, 'nombre', p.nombre, 'precio', p.precio,
             'sabores', (select jsonb_agg(sab.j order by sab.orden) from sab where sab.producto_id = p.id)) as j
    from public.productos p
    where p.activo and exists (select 1 from sab where sab.producto_id = p.id)
  )
  select jsonb_build_object(
    'inventario', jsonb_build_object('usa', coalesce(v_usa, false), 'registrado', v_reg),
    'productos', coalesce((select jsonb_agg(prod.j order by prod.orden) from prod), '[]'::jsonb),
    'metodos', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'nombre', m.nombre) order by m.orden)
      from public.metodos_punto mp join public.metodos_pago m on m.id = mp.metodo_id
      where mp.punto_id = v_punto and m.activo), '[]'::jsonb)
  ) into v_res;
  return v_res;
end $$;

-- Registrar inventario
--   p_tipo 'inicial'  : items [{producto_id, sabor_id, cantidad}] (todo lo contado, incluidos ceros); una vez por día
--   p_tipo 'resurtido': items [{producto_id, sabor_id, cantidad}] (lo que llegó)
--   p_tipo 'ajuste'   : items [{producto_id, sabor_id, real}] (cuántas hay de verdad; la función guarda la diferencia)
create or replace function public.registrar_inventario(p_lote uuid, p_tipo text, p_items jsonb, p_empleado_id int)
returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_punto text := public.mi_punto();
  v_hoy   date := public.hoy_cdmx();
  v_item  jsonb;
  v_prod  int;
  v_sabor int;
  v_cant  int;
  v_act   int;
  v_n     int := 0;
begin
  if v_punto is null then raise exception 'Cuenta sin punto de venta'; end if;
  if not (select usa_inventario from public.puntos_venta where id = v_punto) then
    raise exception 'Este punto no usa inventario';
  end if;
  if p_tipo not in ('inicial', 'resurtido', 'ajuste') then raise exception 'Tipo no válido'; end if;
  if not exists (select 1 from public.empleados where id = p_empleado_id and punto_id = v_punto and activo) then
    raise exception 'Empleado no válido para este punto';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0
     or jsonb_array_length(p_items) > 200 then
    raise exception 'No hay productos que registrar';
  end if;
  if exists (select 1 from public.inventario_movimientos where lote = p_lote) then
    return 0;   -- ya se guardó (doble toque o reintento)
  end if;
  if p_tipo = 'inicial' and exists (select 1 from public.inventario_movimientos
                                    where punto_id = v_punto and fecha = v_hoy and tipo = 'inicial') then
    raise exception 'El inventario de hoy ya está registrado. Para cambiarlo usa "Corregir".';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_prod := (v_item->>'producto_id')::int;
    v_sabor := (v_item->>'sabor_id')::int;
    if not exists (select 1 from public.producto_sabores ps join public.sabores s on s.id = ps.sabor_id
                   where ps.producto_id = v_prod and ps.sabor_id = v_sabor and s.activo)
       or not public.disponible_en_punto(v_punto, v_prod, v_sabor) then
      raise exception 'Producto o sabor no válido para este punto';
    end if;

    if p_tipo = 'ajuste' then
      v_cant := (v_item->>'real')::int;
      if v_cant is null or v_cant < 0 or v_cant > 999 then raise exception 'Cantidad no válida'; end if;
      select coalesce(max(quedan), 0) into v_act from public.existencias(v_punto, v_hoy)
       where producto_id = v_prod and sabor_id = v_sabor;
      v_cant := v_cant - v_act;          -- se guarda la diferencia
      if v_cant = 0 then
        -- sin diferencia, pero si estaba marcado agotado a mano y hay piezas, se reactiva
        if v_act > 0 then
          delete from public.agotados where punto_id = v_punto and producto_id = v_prod and sabor_id = v_sabor and fecha = v_hoy;
        end if;
        continue;
      end if;
    else
      v_cant := (v_item->>'cantidad')::int;
      if v_cant is null or v_cant < 0 or v_cant > 999 then raise exception 'Cantidad no válida'; end if;
      if p_tipo = 'resurtido' and v_cant = 0 then continue; end if;
    end if;

    insert into public.inventario_movimientos (lote, punto_id, fecha, producto_id, sabor_id, tipo, cantidad, empleado_id)
    values (p_lote, v_punto, v_hoy, v_prod, v_sabor, p_tipo, v_cant, p_empleado_id);
    v_n := v_n + 1;

    -- si después del movimiento hay piezas, se quita cualquier "agotado" manual de hoy
    if p_tipo in ('resurtido', 'ajuste') and exists (
         select 1 from public.existencias(v_punto, v_hoy) e
         where e.producto_id = v_prod and e.sabor_id = v_sabor and e.quedan > 0) then
      delete from public.agotados where punto_id = v_punto and producto_id = v_prod and sabor_id = v_sabor and fecha = v_hoy;
    end if;
  end loop;

  -- el inventario inicial siempre deja marca de "registrado", aunque todo sea 0
  if p_tipo = 'inicial' and v_n = 0 then
    raise exception 'No hay productos que registrar';
  end if;
  return v_n;
end $$;

-- Reporte de inventario para el administrador
create or replace function public.reporte_inventario(p_desde date, p_hasta date, p_punto text default null)
returns table (fecha date, punto text, producto text, sabor text,
               inicial int, resurtido int, ajustes int, vendido int, quedan int)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.es_admin() then raise exception 'Solo el administrador'; end if;
  return query
    select d::date, pv.nombre, p.nombre, s.nombre, e.inicial, e.resurtido, e.ajustes, e.vendido, e.quedan
    from generate_series(p_desde, p_hasta, interval '1 day') d
    cross join public.puntos_venta pv
    cross join lateral public.existencias(pv.id, d::date) e
    join public.productos p on p.id = e.producto_id
    join public.sabores s on s.id = e.sabor_id
    where pv.usa_inventario and (p_punto is null or pv.id = p_punto)
    order by d, pv.orden, p.orden, s.orden;
end $$;

do $$
declare f text;
begin
  foreach f in array array['catalogo_punto()', 'registrar_inventario(uuid,text,jsonb,int)', 'reporte_inventario(date,date,text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
