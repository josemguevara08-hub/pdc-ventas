-- 07 · "Ventas de hoy" incluye precio e importe por renglón (para el total en pesos del carrito)
create or replace function public.ventas_hoy()
returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', v.id, 'folio', v.folio, 'estado', v.estado,
    'hora', to_char(v.fecha_venta at time zone 'America/Mexico_City', 'HH24:MI'),
    'recibida_en', v.recibida_en,
    'empleado_id', v.empleado_id, 'empleado', e.nombre, 'metodo', m.nombre,
    'items', (select jsonb_agg(jsonb_build_object(
                'producto', d.producto_nombre, 'sabor', d.sabor_nombre, 'cantidad', d.cantidad,
                'precio', d.precio_unitario, 'importe', d.importe)
              order by d.id)
              from public.venta_detalle d where d.venta_id = v.id)
  ) order by v.fecha_venta desc), '[]'::jsonb)
  from public.ventas v
  join public.empleados e on e.id = v.empleado_id
  join public.metodos_pago m on m.id = v.metodo_pago_id
  where v.punto_id = public.mi_punto()
    and (v.fecha_venta at time zone 'America/Mexico_City')::date = public.hoy_cdmx();
$$;
