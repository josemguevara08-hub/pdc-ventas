-- 05 · Correcciones de catálogo (Excel "sabores_PDC", 19 nov 2026) y disponibilidad por punto

-- Sabores por producto
delete from public.producto_sabores
 where producto_id = (select id from public.productos where nombre = 'Tarta Chica Clásica');
insert into public.producto_sabores (producto_id, sabor_id)
select p.id, s.id from public.productos p, public.sabores s
 where (p.nombre = 'Tarta Chica Clásica' and s.clave = 'clasico')
    or (p.nombre in ('Tarta Chica Sabores', 'Tarta de Cuchara') and s.clave = 'sugar_free')
on conflict do nothing;

-- Combinaciones producto-sabor que NO se venden en un punto.
-- Todo lo demás (lo definido en producto_sabores) está disponible en todos los puntos.
create table public.no_disponible_punto (
  punto_id    text not null references public.puntos_venta(id) on delete cascade,
  producto_id int  not null references public.productos(id) on delete cascade,
  sabor_id    int  not null references public.sabores(id) on delete cascade,
  primary key (punto_id, producto_id, sabor_id)
);
alter table public.no_disponible_punto enable row level security;
revoke all on public.no_disponible_punto from anon;
create policy "leer catalogo" on public.no_disponible_punto for select to authenticated using ((select public.tiene_perfil()));
create policy "admin inserta" on public.no_disponible_punto for insert to authenticated with check ((select public.es_admin()));
create policy "admin actualiza" on public.no_disponible_punto for update to authenticated using ((select public.es_admin())) with check ((select public.es_admin()));
create policy "admin borra" on public.no_disponible_punto for delete to authenticated using ((select public.es_admin()));

-- Según el Excel: Artz no vende Tarta Chica de sabores (solo Clásica); Lomas no vende Tarta de Cuchara
insert into public.no_disponible_punto (punto_id, producto_id, sabor_id)
select 'artz', ps.producto_id, ps.sabor_id from public.producto_sabores ps
  join public.productos p on p.id = ps.producto_id where p.nombre = 'Tarta Chica Sabores'
union all
select 'lomas', ps.producto_id, ps.sabor_id from public.producto_sabores ps
  join public.productos p on p.id = ps.producto_id where p.nombre = 'Tarta de Cuchara';

create or replace function public.disponible_en_punto(p_punto text, p_producto int, p_sabor int) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.no_disponible_punto
                     where punto_id = p_punto and producto_id = p_producto and sabor_id = p_sabor);
$$;
revoke all on function public.disponible_en_punto(text,int,int) from public, anon;
grant execute on function public.disponible_en_punto(text,int,int) to authenticated;

-- Catálogo del punto: solo lo que ese punto vende; oculta productos sin sabores disponibles
create or replace function public.catalogo_punto()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_punto text := public.mi_punto();
begin
  if v_punto is null then raise exception 'Cuenta sin punto de venta'; end if;
  return jsonb_build_object(
    'productos', coalesce((
      select jsonb_agg(x.prod order by x.orden) from (
        select p.orden, jsonb_build_object('id', p.id, 'nombre', p.nombre, 'precio', p.precio,
          'sabores', (
            select jsonb_agg(jsonb_build_object(
              'id', s.id, 'clave', s.clave, 'nombre', s.nombre,
              'agotado', exists (select 1 from public.agotados a
                                 where a.punto_id = v_punto and a.producto_id = p.id
                                   and a.sabor_id = s.id and a.fecha = public.hoy_cdmx())
            ) order by s.orden)
            from public.producto_sabores ps join public.sabores s on s.id = ps.sabor_id
            where ps.producto_id = p.id and s.activo and public.disponible_en_punto(v_punto, p.id, s.id))) as prod
        from public.productos p where p.activo
      ) x where x.prod->'sabores' is not null and x.prod->'sabores' <> 'null'::jsonb), '[]'::jsonb),
    'metodos', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'nombre', m.nombre) order by m.orden)
      from public.metodos_punto mp join public.metodos_pago m on m.id = mp.metodo_id
      where mp.punto_id = v_punto and m.activo), '[]'::jsonb)
  );
end $$;

-- Registrar venta: además valida que el punto venda esa combinación
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

    if not public.disponible_en_punto(v_punto, v_prod.id, v_sabor.id) then
      raise exception '% % no se vende en este punto', v_prod.nombre, v_sabor.nombre;
    end if;

    insert into public.venta_detalle
      (venta_id, producto_id, producto_nombre, sabor_id, sabor_nombre, cantidad, precio_unitario)
    values (p_id, v_prod.id, v_prod.nombre, v_sabor.id, v_sabor.nombre, v_cant, v_prod.precio);
  end loop;

  return v_folio;
end $$;
