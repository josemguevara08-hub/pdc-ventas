-- =====================================================================
-- Pedazo de Cielo · Registro de ventas
-- 02 · Seguridad (RLS) y funciones
-- Regla general: nadie sin sesión ve nada; las ventas solo se crean,
-- cancelan y consultan a través de funciones que validan todo.
-- =====================================================================

-- ---------- Ayudantes ----------
create or replace function public.es_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.perfiles where user_id = auth.uid() and rol = 'admin');
$$;

create or replace function public.mi_punto() returns text
language sql stable security definer set search_path = '' as $$
  select punto_id from public.perfiles where user_id = auth.uid() and rol = 'punto';
$$;

create or replace function public.hoy_cdmx() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'America/Mexico_City')::date;
$$;

-- ---------- Activar RLS en todas las tablas ----------
alter table public.puntos_venta     enable row level security;
alter table public.productos        enable row level security;
alter table public.sabores          enable row level security;
alter table public.producto_sabores enable row level security;
alter table public.metodos_pago     enable row level security;
alter table public.metodos_punto    enable row level security;
alter table public.perfiles         enable row level security;
alter table public.empleados        enable row level security;
alter table public.ventas           enable row level security;
alter table public.venta_detalle    enable row level security;
alter table public.agotados         enable row level security;

-- Visitantes sin sesión (anon): sin acceso a nada
revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;

-- ---------- Catálogo: todos los usuarios con sesión leen; solo admin modifica ----------
do $$
declare t text;
begin
  foreach t in array array['puntos_venta','productos','sabores','producto_sabores','metodos_pago','metodos_punto'] loop
    execute format('create policy "leer catalogo" on public.%I for select to authenticated using (true)', t);
    execute format('create policy "admin inserta" on public.%I for insert to authenticated with check ((select public.es_admin()))', t);
    execute format('create policy "admin actualiza" on public.%I for update to authenticated using ((select public.es_admin())) with check ((select public.es_admin()))', t);
    execute format('create policy "admin borra" on public.%I for delete to authenticated using ((select public.es_admin()))', t);
  end loop;
end $$;

-- ---------- Perfiles ----------
create policy "ver mi perfil o admin" on public.perfiles for select to authenticated
  using (user_id = (select auth.uid()) or (select public.es_admin()));

-- ---------- Empleados: solo admin los ve (los cambios van por función) ----------
create policy "admin ve empleados" on public.empleados for select to authenticated
  using ((select public.es_admin()));

-- ---------- Ventas: punto ve solo lo suyo y solo de hoy; admin ve todo. Sin escritura directa ----------
create policy "ver ventas" on public.ventas for select to authenticated
  using (
    (select public.es_admin())
    or (punto_id = (select public.mi_punto())
        and (fecha_venta at time zone 'America/Mexico_City')::date = (select public.hoy_cdmx()))
  );

create policy "ver detalle" on public.venta_detalle for select to authenticated
  using (
    (select public.es_admin())
    or exists (select 1 from public.ventas v where v.id = venta_id)
  );

create policy "ver agotados" on public.agotados for select to authenticated
  using ((select public.es_admin()) or punto_id = (select public.mi_punto()));

-- Sin políticas de insert/update/delete en ventas, detalle, empleados y agotados:
-- solo las funciones de abajo pueden escribir ahí.

-- =====================================================================
-- Funciones para la app
-- =====================================================================

-- Qué cuenta inició sesión
create or replace function public.mi_contexto()
returns table (rol text, punto_id text, punto_nombre text, es_palacio boolean)
language sql stable security definer set search_path = '' as $$
  select pf.rol, pf.punto_id, pv.nombre, coalesce(pv.es_palacio, false)
  from public.perfiles pf
  left join public.puntos_venta pv on pv.id = pf.punto_id
  where pf.user_id = auth.uid();
$$;

-- Iniciar turno con PIN (devuelve el empleado si el PIN es de este punto)
create or replace function public.iniciar_turno(p_pin text)
returns table (empleado_id int, nombre text)
language plpgsql security definer set search_path = '' as $$
declare v_punto text := public.mi_punto();
begin
  if v_punto is null then
    raise exception 'Esta cuenta no está asignada a un punto de venta';
  end if;
  return query
    select e.id, e.nombre
    from public.empleados e
    where e.punto_id = v_punto and e.activo
      and e.pin_hash = extensions.crypt(p_pin, e.pin_hash)
    limit 1;
end $$;

-- Catálogo del punto para hoy: productos, sabores (con agotados) y métodos de pago
create or replace function public.catalogo_punto()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_punto text := public.mi_punto();
begin
  if v_punto is null then raise exception 'Cuenta sin punto de venta'; end if;
  return jsonb_build_object(
    'productos', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'nombre', p.nombre, 'precio', p.precio,
        'sabores', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', s.id, 'clave', s.clave, 'nombre', s.nombre,
            'agotado', exists (select 1 from public.agotados a
                               where a.punto_id = v_punto and a.producto_id = p.id
                                 and a.sabor_id = s.id and a.fecha = public.hoy_cdmx())
          ) order by s.orden)
          from public.producto_sabores ps join public.sabores s on s.id = ps.sabor_id
          where ps.producto_id = p.id and s.activo), '[]'::jsonb)
      ) order by p.orden)
      from public.productos p where p.activo), '[]'::jsonb),
    'metodos', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'nombre', m.nombre) order by m.orden)
      from public.metodos_punto mp join public.metodos_pago m on m.id = mp.metodo_id
      where mp.punto_id = v_punto and m.activo), '[]'::jsonb)
  );
end $$;

-- Registrar una venta completa. Es "idempotente": si llega dos veces con el mismo id,
-- se guarda una sola vez. Los precios se toman de la base de datos, nunca del dispositivo.
create or replace function public.registrar_venta(
  p_id uuid, p_empleado_id int, p_metodo text, p_fecha timestamptz, p_items jsonb)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_punto  text := public.mi_punto();
  v_folio  bigint;
  v_item   jsonb;
  v_prod   public.productos%rowtype;
  v_sabor  public.sabores%rowtype;
  v_cant   int;
  v_fecha  timestamptz;
begin
  if v_punto is null then raise exception 'Cuenta sin punto de venta'; end if;

  select folio into v_folio from public.ventas where id = p_id;
  if found then return v_folio; end if;

  if not exists (select 1 from public.empleados
                 where id = p_empleado_id and punto_id = v_punto and activo) then
    raise exception 'Empleado no válido para este punto';
  end if;
  if not exists (select 1 from public.metodos_punto mp join public.metodos_pago m on m.id = mp.metodo_id
                 where mp.punto_id = v_punto and mp.metodo_id = p_metodo and m.activo) then
    raise exception 'Método de pago no válido';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 50 then
    raise exception 'La venta no tiene productos';
  end if;

  v_fecha := least(coalesce(p_fecha, now()), now());

  insert into public.ventas (id, punto_id, empleado_id, metodo_pago_id, fecha_venta, registrada_por)
  values (p_id, v_punto, p_empleado_id, p_metodo, v_fecha, auth.uid())
  on conflict (id) do nothing
  returning folio into v_folio;

  if v_folio is null then
    select folio into v_folio from public.ventas where id = p_id;
    return v_folio;
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_cant := (v_item->>'cantidad')::int;
    if v_cant is null or v_cant < 1 or v_cant > 99 then
      raise exception 'Cantidad no válida';
    end if;

    select * into v_prod from public.productos
    where id = (v_item->>'producto_id')::int and activo;
    if not found then raise exception 'Producto no válido'; end if;

    select s.* into v_sabor
    from public.sabores s join public.producto_sabores ps on ps.sabor_id = s.id
    where s.id = (v_item->>'sabor_id')::int and ps.producto_id = v_prod.id and s.activo;
    if not found then raise exception 'Sabor no válido para %', v_prod.nombre; end if;

    insert into public.venta_detalle
      (venta_id, producto_id, producto_nombre, sabor_id, sabor_nombre, cantidad, precio_unitario)
    values (p_id, v_prod.id, v_prod.nombre, v_sabor.id, v_sabor.nombre, v_cant, v_prod.precio);
  end loop;

  return v_folio;
end $$;

-- Cancelar: el empleado solo sus ventas de los últimos 10 minutos; el admin cualquiera
create or replace function public.cancelar_venta(p_id uuid, p_empleado_id int default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare v public.ventas%rowtype; v_admin boolean := public.es_admin();
begin
  select * into v from public.ventas where id = p_id for update;
  if not found then raise exception 'Venta no encontrada'; end if;
  if v.estado = 'cancelada' then return; end if;

  if not v_admin and not (
       v.punto_id = public.mi_punto()
       and v.empleado_id = p_empleado_id
       and v.recibida_en > now() - interval '10 minutes') then
    raise exception 'Solo puedes cancelar tus ventas de los últimos 10 minutos. Pide al administrador que la cancele.';
  end if;

  update public.ventas
     set estado = 'cancelada', cancelada_en = now(), cancelada_por_usuario = auth.uid(),
         cancelada_por_empleado = case when v_admin then null else p_empleado_id end
   where id = p_id;
end $$;

-- Marcar / desmarcar un sabor como agotado hoy en mi punto
create or replace function public.marcar_agotado(
  p_producto_id int, p_sabor_id int, p_agotado boolean, p_empleado_id int)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_punto text := public.mi_punto();
begin
  if v_punto is null then raise exception 'Cuenta sin punto de venta'; end if;
  if not exists (select 1 from public.empleados
                 where id = p_empleado_id and punto_id = v_punto and activo) then
    raise exception 'Empleado no válido';
  end if;
  if p_agotado then
    insert into public.agotados (punto_id, producto_id, sabor_id, fecha, marcado_por)
    values (v_punto, p_producto_id, p_sabor_id, public.hoy_cdmx(), p_empleado_id)
    on conflict do nothing;
  else
    delete from public.agotados
    where punto_id = v_punto and producto_id = p_producto_id
      and sabor_id = p_sabor_id and fecha = public.hoy_cdmx();
  end if;
end $$;

-- Ventas de hoy en mi punto (para la pantalla "Ventas de hoy" del personal)
create or replace function public.ventas_hoy()
returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', v.id, 'folio', v.folio, 'estado', v.estado,
    'hora', to_char(v.fecha_venta at time zone 'America/Mexico_City', 'HH24:MI'),
    'recibida_en', v.recibida_en,
    'empleado_id', v.empleado_id, 'empleado', e.nombre, 'metodo', m.nombre,
    'items', (select jsonb_agg(jsonb_build_object(
                'producto', d.producto_nombre, 'sabor', d.sabor_nombre, 'cantidad', d.cantidad)
              order by d.id)
              from public.venta_detalle d where d.venta_id = v.id)
  ) order by v.fecha_venta desc), '[]'::jsonb)
  from public.ventas v
  join public.empleados e on e.id = v.empleado_id
  join public.metodos_pago m on m.id = v.metodo_pago_id
  where v.punto_id = public.mi_punto()
    and (v.fecha_venta at time zone 'America/Mexico_City')::date = public.hoy_cdmx();
$$;

-- ---------- Funciones solo para el administrador ----------
create or replace function public.guardar_empleado(
  p_id int, p_nombre text, p_punto_id text, p_pin text, p_activo boolean default true)
returns int
language plpgsql security definer set search_path = '' as $$
declare v_id int;
begin
  if not public.es_admin() then raise exception 'Solo el administrador'; end if;
  if coalesce(trim(p_nombre), '') = '' then raise exception 'Falta el nombre'; end if;
  if p_pin is not null and p_pin !~ '^[0-9]{4}$' then raise exception 'El PIN debe tener 4 números'; end if;
  if p_id is null and p_pin is null then raise exception 'Falta el PIN'; end if;

  if p_pin is not null and exists (
      select 1 from public.empleados
      where punto_id = p_punto_id and activo and id is distinct from p_id
        and pin_hash = extensions.crypt(p_pin, pin_hash)) then
    raise exception 'Ese PIN ya lo usa otro empleado de este punto';
  end if;

  if p_id is null then
    insert into public.empleados (nombre, punto_id, pin_hash, activo)
    values (trim(p_nombre), p_punto_id, extensions.crypt(p_pin, extensions.gen_salt('bf')), p_activo)
    returning id into v_id;
  else
    update public.empleados
       set nombre = trim(p_nombre), punto_id = p_punto_id, activo = p_activo,
           pin_hash = case when p_pin is null then pin_hash
                           else extensions.crypt(p_pin, extensions.gen_salt('bf')) end
     where id = p_id
    returning id into v_id;
  end if;
  return v_id;
end $$;

-- Vista de reporte (una fila por producto vendido). Respeta RLS de quien consulta.
create or replace view public.v_ventas_detalle with (security_invoker = true) as
select
  v.folio,
  v.id                                                          as venta_id,
  (v.fecha_venta at time zone 'America/Mexico_City')::date      as fecha,
  to_char(v.fecha_venta at time zone 'America/Mexico_City', 'HH24:MI') as hora,
  v.punto_id,
  p.nombre                                                      as punto,
  e.nombre                                                      as empleado,
  v.metodo_pago_id,
  m.nombre                                                      as metodo_pago,
  d.producto_nombre                                             as producto,
  d.sabor_nombre                                                as sabor,
  d.cantidad,
  d.precio_unitario,
  d.importe,
  v.estado,
  v.fecha_venta,
  v.recibida_en
from public.ventas v
join public.venta_detalle d on d.venta_id = v.id
join public.puntos_venta  p on p.id = v.punto_id
join public.empleados     e on e.id = v.empleado_id
join public.metodos_pago  m on m.id = v.metodo_pago_id;

revoke all on public.v_ventas_detalle from anon;

-- ---------- Permisos de ejecución: solo usuarios con sesión ----------
do $$
declare f text;
begin
  foreach f in array array[
    'es_admin()', 'mi_punto()', 'hoy_cdmx()', 'mi_contexto()', 'iniciar_turno(text)',
    'catalogo_punto()', 'registrar_venta(uuid,int,text,timestamptz,jsonb)',
    'cancelar_venta(uuid,int)', 'marcar_agotado(int,int,boolean,int)', 'ventas_hoy()',
    'guardar_empleado(int,text,text,text,boolean)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
