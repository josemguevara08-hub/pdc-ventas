-- =====================================================================
-- Pedazo de Cielo · Registro de ventas
-- 01 · Tablas y catálogo inicial
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- Catálogo ----------
create table public.puntos_venta (
  id          text primary key,
  nombre      text not null,
  es_palacio  boolean not null default false,
  activo      boolean not null default true,
  orden       int not null default 0
);

create table public.productos (
  id              serial primary key,
  nombre          text not null unique,
  precio          numeric(10,2) not null check (precio >= 0),
  activo          boolean not null default true,
  orden           int not null default 0,
  actualizado_en  timestamptz not null default now()
);

create table public.sabores (
  id            serial primary key,
  clave         text not null unique,
  nombre        text not null,
  es_temporada  boolean not null default false,
  activo        boolean not null default true,
  orden         int not null default 0
);

create table public.producto_sabores (
  producto_id int not null references public.productos(id) on delete cascade,
  sabor_id    int not null references public.sabores(id) on delete cascade,
  primary key (producto_id, sabor_id)
);

create table public.metodos_pago (
  id      text primary key,
  nombre  text not null,
  activo  boolean not null default true,
  orden   int not null default 0
);

-- Qué métodos de pago aparecen en cada punto
create table public.metodos_punto (
  punto_id   text not null references public.puntos_venta(id) on delete cascade,
  metodo_id  text not null references public.metodos_pago(id) on delete cascade,
  primary key (punto_id, metodo_id)
);

-- ---------- Usuarios ----------
-- Cada cuenta de Supabase Auth es un punto de venta o el administrador
create table public.perfiles (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  rol       text not null check (rol in ('punto','admin')),
  punto_id  text references public.puntos_venta(id),
  check (rol = 'admin' or punto_id is not null)
);

-- Empleados: se identifican con un PIN de 4 dígitos (guardado cifrado)
create table public.empleados (
  id         serial primary key,
  nombre     text not null,
  punto_id   text not null references public.puntos_venta(id),
  pin_hash   text not null,
  activo     boolean not null default true,
  creado_en  timestamptz not null default now()
);

-- ---------- Ventas ----------
create table public.ventas (
  id                      uuid primary key,              -- lo genera el dispositivo (evita duplicados)
  folio                   bigint generated always as identity unique,
  punto_id                text not null references public.puntos_venta(id),
  empleado_id             int  not null references public.empleados(id),
  metodo_pago_id          text not null references public.metodos_pago(id),
  fecha_venta             timestamptz not null,          -- momento en que se registró en el dispositivo
  recibida_en             timestamptz not null default now(),  -- momento en que llegó a la base de datos
  registrada_por          uuid not null references auth.users(id),
  estado                  text not null default 'activa' check (estado in ('activa','cancelada')),
  cancelada_en            timestamptz,
  cancelada_por_usuario   uuid references auth.users(id),
  cancelada_por_empleado  int references public.empleados(id)
);
create index ventas_punto_fecha_idx on public.ventas (punto_id, fecha_venta);
create index ventas_fecha_idx on public.ventas (fecha_venta);

-- Renglones de cada venta. Nombre y precio se copian al momento de la venta
-- para que los cambios futuros al catálogo no alteren el historial.
create table public.venta_detalle (
  id               bigint generated always as identity primary key,
  venta_id         uuid not null references public.ventas(id),
  producto_id      int  not null references public.productos(id),
  producto_nombre  text not null,
  sabor_id         int  not null references public.sabores(id),
  sabor_nombre     text not null,
  cantidad         int  not null check (cantidad between 1 and 99),
  precio_unitario  numeric(10,2) not null,
  importe          numeric(12,2) generated always as (cantidad * precio_unitario) stored
);
create index venta_detalle_venta_idx on public.venta_detalle (venta_id);

-- Sabores agotados por punto y por día
create table public.agotados (
  punto_id     text not null references public.puntos_venta(id) on delete cascade,
  producto_id  int  not null references public.productos(id) on delete cascade,
  sabor_id     int  not null references public.sabores(id) on delete cascade,
  fecha        date not null,
  marcado_por  int references public.empleados(id),
  primary key (punto_id, producto_id, sabor_id, fecha)
);

-- ---------- Datos iniciales ----------
insert into public.puntos_venta (id, nombre, es_palacio, orden) values
  ('lomas',       'Pedazo de Cielo Lomas',          false, 1),
  ('ph_mitikah',  'El Palacio de Hierro Mitikah',   true,  2),
  ('ph_satelite', 'El Palacio de Hierro Satélite',  true,  3),
  ('ph_polanco',  'El Palacio de Hierro Polanco',   true,  4),
  ('artz',        'Artz Pedregal',                  false, 5);

insert into public.productos (nombre, precio, orden) values
  ('Tarta de Cuchara',      150, 1),
  ('Tarta Chica Clásica',   230, 2),
  ('Tarta Chica Sabores',   245, 3),
  ('Tarta Grande Clásica',  650, 4),
  ('Tarta Grande Sabores',  680, 5);

insert into public.sabores (clave, nombre, es_temporada, orden) values
  ('clasico',         'Clásico',          false, 1),
  ('nutella',         'Nutella',          false, 2),
  ('dulce_de_leche',  'Dulce de Leche',   false, 3),
  ('tiramisu',        'Tiramisú',         false, 4),
  ('lotus',           'Lotus',            false, 5),
  ('sugar_free',      'Sugar Free',       false, 6),
  ('temporada',       'Temporada',        true,  7);

insert into public.producto_sabores (producto_id, sabor_id)
select p.id, s.id
from public.productos p
join public.sabores s on
  (p.nombre in ('Tarta de Cuchara','Tarta Chica Clásica','Tarta Chica Sabores')
     and s.clave in ('nutella','dulce_de_leche','tiramisu','lotus','temporada'))
  or (p.nombre = 'Tarta Grande Clásica' and s.clave = 'clasico')
  or (p.nombre = 'Tarta Grande Sabores'
     and s.clave in ('sugar_free','nutella','dulce_de_leche','tiramisu','lotus','temporada'));

insert into public.metodos_pago (id, nombre, orden) values
  ('tarjeta',     'Tarjeta',                    1),
  ('efectivo',    'Efectivo',                   2),
  ('delivery',    'Delivery',                   3),
  ('tarjeta_ph',  'Tarjeta Palacio de Hierro',  4);

-- Tarjeta, Efectivo y Delivery en todos; Tarjeta PH solo en Palacio
insert into public.metodos_punto (punto_id, metodo_id)
select p.id, m.id from public.puntos_venta p cross join public.metodos_pago m
where m.id in ('tarjeta','efectivo','delivery') or (m.id = 'tarjeta_ph' and p.es_palacio);
