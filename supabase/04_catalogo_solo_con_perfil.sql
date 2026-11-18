-- 04 · El catálogo solo lo ven cuentas con perfil asignado (punto o admin)
create or replace function public.tiene_perfil() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.perfiles where user_id = auth.uid());
$$;
revoke all on function public.tiene_perfil() from public, anon;
grant execute on function public.tiene_perfil() to authenticated;

do $$
declare t text;
begin
  foreach t in array array['puntos_venta','productos','sabores','producto_sabores','metodos_pago','metodos_punto'] loop
    execute format('drop policy "leer catalogo" on public.%I', t);
    execute format('create policy "leer catalogo" on public.%I for select to authenticated using ((select public.tiene_perfil()))', t);
  end loop;
end $$;
