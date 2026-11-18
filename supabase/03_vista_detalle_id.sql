-- 03 · Agrega detalle_id a la vista de reporte (orden estable al descargar por páginas)
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
  v.recibida_en,
  d.id                                                          as detalle_id
from public.ventas v
join public.venta_detalle d on d.venta_id = v.id
join public.puntos_venta  p on p.id = v.punto_id
join public.empleados     e on e.id = v.empleado_id
join public.metodos_pago  m on m.id = v.metodo_pago_id;

revoke all on public.v_ventas_detalle from anon;
