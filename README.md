# Pedazo de Cielo · Registro de ventas

App web para que el personal de Pedazo de Cielo registre qué se vende en cada punto (sin papel, sin Excel, sin recaptura en ElCheff). **No cobra**: solo registra producto, sabor, cantidad y método de pago.

## Las 4 piezas

| Pieza | Dónde vive | Para qué |
|---|---|---|
| Código | GitHub, repositorio privado `pdc-ventas` | Los archivos de la app y su historial |
| Alojamiento | Cloudflare Workers (sitio estático) | Publica la app en internet; se actualiza sola con cada cambio en GitHub |
| URL | `https://pdc-ventas.<tu-subdominio>.workers.dev` | Personal: `/` · Administración: `/admin` |
| Datos | Supabase, proyecto `pdc-ventas` | Base de datos privada con las ventas y los inicios de sesión |

## Cómo se usa (personal)
1. Abrir la URL en el dispositivo del punto. La primera vez: usuario del punto (ej. `artz`) y contraseña. Queda guardado.
2. Al iniciar turno: PIN de 4 dígitos.
3. Carritos (Artz, Mitikah, Satélite, Polanco): lo primero del día es contar el inventario (tocar cada sabor una vez por pieza). Sin esto no se puede vender. Un sabor que llega a 0 se agota solo; si sí hay, se toca y se pone cuántas piezas hay. En "Inventario" se registra lo que llega después y se corrige un conteo.
4. Tocar producto → tocar sabor (una vez por pieza) → **Listo** → **Continuar** → elegir cómo pagó → **Confirmar venta**.
5. Pantalla verde = guardada en la base de datos. Pantalla crema = guardada en el dispositivo; se envía sola al volver el internet.
6. **Ventas de hoy**: ver lo registrado y cancelar una venta propia durante los primeros 10 minutos, escribiendo el motivo (obligatorio).
7. **Agotados** (solo Lomas): marcar un sabor agotado (solo ese día).
8. **Cambiar turno**: terminar turno para que entre otro empleado.

## Administración (`/admin`)
- **Ventas**: filtrar por fechas, punto, método, producto, sabor y estado; descargar Excel. **Respaldo completo** una vez por semana (el plan gratis de Supabase no guarda respaldos).
- **Productos y precios**: cambiar precios (solo afecta ventas nuevas), nombre del sabor de temporada, activar o desactivar sabores, qué sabores tiene cada producto.
- **Empleados**: alta con nombre, punto y PIN; cambiar PIN; desactivar.
- **Inventario**: por carrito y día: inicial, llegó, ajustes, vendido y lo que queda; descarga a Excel.
- **Puntos y pagos**: qué vende cada punto y qué botones de pago aparecen en cada uno.

## Seguridad
- La URL es pública, pero sin iniciar sesión no se ve ni se guarda nada (reglas RLS en la base de datos).
- Cada cuenta de punto solo puede **agregar** ventas de su punto y **ver** las del día. Solo el administrador ve todo y cambia el catálogo.
- Los precios los pone la base de datos; el dispositivo no puede alterarlos.
- Cada venta lleva un identificador único creado en el dispositivo: aunque se toque dos veces o se corte el internet, se guarda una sola vez.
- La clave de `js/config.js` es la clave **publicable** (hecha para el navegador). **Nunca** pongas en el código la clave `service_role` ni contraseñas.

## Planes gratuitos (sin tarjeta registrada = sin cobros)
- **Supabase Free**: 500 MB de base de datos (cientos de miles de ventas). Pausa el proyecto tras 7 días sin actividad; si pasa, se reactiva desde supabase.com con el botón *Restore*. Sin respaldos automáticos → usar *Respaldo completo*.
- **Cloudflare Workers Free**: los archivos estáticos (esta app) se sirven sin costo; sin tarjeta registrada no hay cobros.

## Estructura
```
wrangler.jsonc             → le dice a Cloudflare que publique solo la carpeta public/
public/                    → todo lo que se publica en internet
index.html, js/app.js      → app del personal
admin.html, js/admin.js    → panel de administración
css/estilos.css            → identidad visual (Manual de Identidad PDC)
js/config.js               → conexión a Supabase, fotos y colores por producto
sw.js, manifest.webmanifest→ funcionamiento sin internet / instalar en pantalla de inicio
_headers                   → encabezados de seguridad (Cloudflare)
img/                       → logo, fotos e íconos (tipografías: Arial Black y la del sistema)
supabase/*.sql             → estructura de la base de datos (ya aplicada)
```
