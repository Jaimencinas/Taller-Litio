-- =====================================================================
--  TALLER LITIO · Volta Baterías — esquema de Supabase
--  Ejecutar completo en: Supabase → SQL Editor → New query → Run
--  Se puede volver a ejecutar sin romper nada (todo es "if not exists").
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1. Perfiles de usuario y roles
--    Cada usuario de Authentication tiene una fila aquí.
--    rol: 'admin' (dirección) | 'empleado'
--    El PRIMER usuario que se registra pasa a ser admin automáticamente.
-- ---------------------------------------------------------------------
create table if not exists public.perfiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  nombre     text,
  rol        text not null default 'empleado' check (rol in ('admin','empleado')),
  activo     boolean not null default true,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  n_admins int;
  rol_meta text;
begin
  select count(*) into n_admins from public.perfiles where rol = 'admin';
  rol_meta := coalesce(new.raw_user_meta_data->>'rol', '');
  insert into public.perfiles (id, email, nombre, rol)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'nombre', split_part(new.email, '@', 1)),
    case when n_admins = 0 then 'admin'
         when rol_meta in ('admin','empleado') then rol_meta
         else 'empleado' end
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Funciones de ayuda para las políticas
create or replace function public.es_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.perfiles where id = auth.uid() and rol = 'admin' and activo);
$$;
create or replace function public.es_activo()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.perfiles where id = auth.uid() and activo);
$$;

-- ---------------------------------------------------------------------
-- 2. Tablas de datos (id texto + documento JSON, igual que usaba el panel)
-- ---------------------------------------------------------------------
create table if not exists public.encargos (
  id text primary key, data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
create table if not exists public.notas (
  id text primary key, data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
create table if not exists public.presupuestos (
  id text primary key, data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
create table if not exists public.config (
  id text primary key, data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
create table if not exists public.analitica (
  id text primary key, data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
do $$ declare t text; begin
  foreach t in array array['encargos','notas','presupuestos','config','analitica'] loop
    execute format('drop trigger if exists touch_%1$s on public.%1$s; create trigger touch_%1$s before update on public.%1$s for each row execute function public.touch_updated_at();', t);
  end loop; end $$;

-- ---------------------------------------------------------------------
-- 3. Seguridad por filas (RLS)
-- ---------------------------------------------------------------------
alter table public.perfiles     enable row level security;
alter table public.encargos     enable row level security;
alter table public.notas        enable row level security;
alter table public.presupuestos enable row level security;
alter table public.config       enable row level security;
alter table public.analitica    enable row level security;

-- perfiles: cada uno ve el suyo; los admin ven y editan todos
drop policy if exists perfiles_self_read  on public.perfiles;
drop policy if exists perfiles_admin_all  on public.perfiles;
create policy perfiles_self_read on public.perfiles for select using (id = auth.uid() or public.es_admin());
create policy perfiles_admin_all on public.perfiles for all    using (public.es_admin()) with check (public.es_admin());

-- encargos y notas: cualquier usuario activo lee y escribe
do $$ declare t text; begin
  foreach t in array array['encargos','notas'] loop
    execute format('drop policy if exists %1$s_rw on public.%1$s; create policy %1$s_rw on public.%1$s for all using (public.es_activo()) with check (public.es_activo());', t);
  end loop; end $$;

-- presupuestos: todos leen (estado, total), solo admin escribe
drop policy if exists presupuestos_read  on public.presupuestos;
drop policy if exists presupuestos_write on public.presupuestos;
create policy presupuestos_read  on public.presupuestos for select using (public.es_activo());
create policy presupuestos_write on public.presupuestos for all    using (public.es_admin()) with check (public.es_admin());

-- config: todos leen tarifas y ajustes generales; los COSTES solo admin; solo admin escribe
drop policy if exists config_read  on public.config;
drop policy if exists config_write on public.config;
create policy config_read  on public.config for select using (public.es_activo() and (id <> 'costes' or public.es_admin()));
create policy config_write on public.config for all    using (public.es_admin()) with check (public.es_admin());

-- analitica (coste y beneficio de cada presupuesto): solo admin
drop policy if exists analitica_admin on public.analitica;
create policy analitica_admin on public.analitica for all using (public.es_admin()) with check (public.es_admin());

-- ---------------------------------------------------------------------
-- 4. Tiempo real (para que todos vean los cambios al momento)
-- ---------------------------------------------------------------------
do $$ begin
  begin alter publication supabase_realtime add table public.encargos;     exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.notas;        exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.presupuestos; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.config;       exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.perfiles;     exception when duplicate_object then null; end;
end $$;

-- ---------------------------------------------------------------------
-- 5. Adjuntos (fotos y audios) en Storage
--    Bucket público de lectura (los nombres de archivo son aleatorios e
--    imposibles de adivinar); solo usuarios activos pueden subir.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('adjuntos', 'adjuntos', true, 20971520)
on conflict (id) do update set public = true, file_size_limit = 20971520;

drop policy if exists adjuntos_read   on storage.objects;
drop policy if exists adjuntos_insert on storage.objects;
drop policy if exists adjuntos_delete on storage.objects;
create policy adjuntos_read   on storage.objects for select using (bucket_id = 'adjuntos');
create policy adjuntos_insert on storage.objects for insert with check (bucket_id = 'adjuntos' and public.es_activo());
create policy adjuntos_delete on storage.objects for delete using (bucket_id = 'adjuntos' and public.es_activo());

-- ---------------------------------------------------------------------
-- 6. Datos iniciales (tarifas, costes, ajustes) — ver seed.sql
-- ---------------------------------------------------------------------
