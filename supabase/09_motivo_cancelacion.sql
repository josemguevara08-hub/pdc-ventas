-- 09 · Motivo de cancelación obligatorio (25 nov 2026)
alter table public.ventas add column if not exists motivo_cancelacion text;

drop function if exists public.cancelar_venta(uuid, int);

create or replace function public.cancelar_venta(p_id uuid, p_motivo text, p_empleado_id int default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare v public.ventas%rowtype; v_admin boolean := public.es_admin(); v_motivo text := trim(coalesce(p_motivo, ''));
begin
  if length(v_motivo) < 3 then raise exception 'Escribe el motivo de la cancelación'; end if;
  if length(v_motivo) > 300 then v_motivo := left(v_motivo, 300); end if;

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
         cancelada_por_empleado = case when v_admin then null else p_empleado_id end,
         motivo_cancelacion = v_motivo
   where id = p_id;
end $$;
revoke all on function public.cancelar_venta(uuid, text, int) from public, anon;
grant execute on function public.cancelar_venta(uuid, text, int) to authenticated;

-- "Ventas de hoy" con motivo y hora de cancelación
create or replace function public.ventas_hoy()
returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', v.id, 'folio', v.folio, 'estado', v.estado,
    'hora', to_char(v.fecha_venta at time zone 'America/Mexico_City', 'HH24:MI'),
    'recibida_en', v.recibida_en,
    'empleado_id', v.empleado_id, 'empleado', e.nombre, 'metodo', m.nombre,
    'motivo', v.motivo_cancelacion,
    'cancelada_hora', to_char(v.cancelada_en at time zone 'America/Mexico_City', 'HH24:MI'),
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

-- Vista de reporte con motivo, hora y quién canceló
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
  d.id                                                          as detalle_id,
  v.motivo_cancelacion,
  to_char(v.cancelada_en at time zone 'America/Mexico_City', 'YYYY-MM-DD HH24:MI') as cancelada_en,
  coalesce(ec.nombre, case when v.estado = 'cancelada' then 'Administrador' end) as cancelada_por
from public.ventas v
join public.venta_detalle d on d.venta_id = v.id
join public.puntos_venta  p on p.id = v.punto_id
join public.empleados     e on e.id = v.empleado_id
join public.metodos_pago  m on m.id = v.metodo_pago_id
left join public.empleados ec on ec.id = v.cancelada_por_empleado;

revoke all on public.v_ventas_detalle from anon;
