-- 08 · Las ventas solo descuentan inventario si se hicieron después del conteo inicial del día
--      (las ventas hechas antes de contar ya no estaban en el carrito cuando se contó).
--      Se usa la hora en que la venta llegó a la base de datos (reloj del servidor).
create or replace function public.existencias(p_punto text, p_fecha date)
returns table (producto_id int, sabor_id int, inicial int, resurtido int, ajustes int, vendido int, quedan int)
language sql stable security definer set search_path = '' as $$
  with t0 as (
    select min(m.creado_en) as desde from public.inventario_movimientos m
    where m.punto_id = p_punto and m.fecha = p_fecha and m.tipo = 'inicial'
  ), mov as (
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
      and v.recibida_en >= coalesce((select desde from t0), '-infinity'::timestamptz)
    group by d.producto_id, d.sabor_id
  )
  select coalesce(m.producto_id, v.producto_id), coalesce(m.sabor_id, v.sabor_id),
         coalesce(m.inicial, 0), coalesce(m.resurtido, 0), coalesce(m.ajustes, 0), coalesce(v.vendido, 0),
         coalesce(m.inicial, 0) + coalesce(m.resurtido, 0) + coalesce(m.ajustes, 0) - coalesce(v.vendido, 0)
  from mov m full join ven v on v.producto_id = m.producto_id and v.sabor_id = m.sabor_id;
$$;
revoke all on function public.existencias(text, date) from public, anon, authenticated;
