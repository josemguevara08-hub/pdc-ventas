// =====================================================================
// Configuración de la app de ventas de Pedazo de Cielo
// Esta clave es "publicable": está hecha para ir en el navegador.
// La seguridad la ponen las reglas (RLS) de la base de datos.
// NUNCA pongas aquí la clave "service_role" ni contraseñas.
// =====================================================================
window.PDC_CONFIG = {
  version: '1.1.0',
  supabaseUrl: 'https://uuurvehklcacrhnkhadk.supabase.co',
  supabaseKey: 'sb_publishable__5CH8jEq2olts2pK5epTHA_4YN-rT6C',

  // Las cuentas de punto se escriben corto ("artz") y la app completa el correo
  dominioCuentas: 'pdc-ventas.local',

  // Foto de cada producto (por id de producto en la base de datos)
  fotos: {
    1: 'img/rebanada.webp',        // Tarta de Cuchara
    2: 'img/tarta_entera.webp',    // Tarta Chica Clásica
    3: 'img/tarta_chocolate.webp', // Tarta Chica Sabores
    4: 'img/tarta_entera.webp',    // Tarta Grande Clásica
    5: 'img/tarta_chocolate.webp'  // Tarta Grande Sabores
  },
  fotoGenerica: 'img/tarta_entera.webp',

  // Color de acento de cada producto (paleta primaria del manual)
  colores: { 1: 'menta', 2: 'crema', 3: 'frambuesa', 4: 'azul', 5: 'menta' },

  minutosParaCancelar: 10
};
