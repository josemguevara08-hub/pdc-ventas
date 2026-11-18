// =====================================================================
// Pedazo de Cielo · App de registro de ventas (personal de los puntos)
// =====================================================================
(() => {
  'use strict';

  const C = window.PDC_CONFIG;
  const sb = window.supabase.createClient(C.supabaseUrl, C.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'pdc-auth' }
  });

  // ---------- Utilidades ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin espacio */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* nada */ } }
  };
  const K = { ctx: 'pdc_ctx', turno: 'pdc_turno', catalogo: 'pdc_catalogo', cola: 'pdc_cola', ticket: 'pdc_ticket' };

  const hoyCDMX = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const horaCDMX = (d) => new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  const fechaCDMX = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  // ¿El error es de conexión (reintentar) o la base de datos rechazó la venta?
  function esErrorDeRed(error, status) {
    if (!error) return false;
    if (!status || status === 0 || status >= 500 || [401, 403, 408, 429].includes(status)) return true;
    const m = String(error.message || '');
    return /fetch|network|abort|timeout|Failed|Load failed/i.test(m);
  }

  // ---------- Estado ----------
  const E = {
    ctx: null,          // { rol, punto_id, punto_nombre, es_palacio }
    turno: null,        // { empleado_id, nombre, fecha, punto }
    catalogo: null,     // { productos:[{id,nombre,sabores:[{id,nombre,agotado}]}], metodos:[{id,nombre}] }
    ticket: LS.get(K.ticket, []),   // [{ producto_id, sabor_id, cantidad }]
    cola: LS.get(K.cola, []),       // ventas guardadas en el dispositivo aún no confirmadas por la base de datos
    productoAbierto: null,
    metodo: null,
    guardando: false,
    sincronizando: false
  };
  const guardarCola = () => LS.set(K.cola, E.cola);
  const guardarTicket = () => LS.set(K.ticket, E.ticket);

  // ---------- Pantallas ----------
  function mostrar(v) {
    ['login', 'pin', 'venta', 'hoy', 'agotados'].forEach((n) => { $('#v-' + n).hidden = n !== v; });
    window.scrollTo(0, 0);
  }

  let avisoTimer;
  function aviso(texto, tipo = '') {
    const a = $('#aviso');
    a.textContent = texto; a.className = 'aviso ' + tipo; a.hidden = false;
    clearTimeout(avisoTimer);
    avisoTimer = setTimeout(() => { a.hidden = true; }, tipo === 'error' ? 6000 : (texto.startsWith('+1') ? 1200 : 2500));
  }

  // Ventana de confirmación propia (sin diálogos del navegador)
  function preguntar(texto, si = 'Sí', no = 'No', peligro = false) {
    return new Promise((resolve) => {
      const f = document.createElement('div');
      f.className = 'fondo-modal';
      f.innerHTML = `<div class="hoja" role="alertdialog" aria-modal="true">
          <div class="hoja-cabecera"><h2 class="titulo">${esc(texto)}</h2></div>
          <div class="botones-hoja">
            <button class="btn ${peligro ? 'btn-peligro' : 'btn-primario'} btn-bloque" data-r="1">${esc(si)}</button>
            <button class="btn btn-secundario btn-bloque" data-r="0">${esc(no)}</button>
          </div></div>`;
      f.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-r]');
        if (!b && ev.target !== f) return;
        f.remove(); resolve(b ? b.dataset.r === '1' : false);
      });
      document.body.appendChild(f);
    });
  }

  // =====================================================================
  // Inicio
  // =====================================================================
  async function iniciar() {
    $$('.ver').forEach((e) => { e.textContent = C.version; });
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return mostrar('login');
    await cargarContexto();
  }

  async function cargarContexto() {
    const { data, error, status } = await sb.rpc('mi_contexto');
    if (error) {
      if (esErrorDeRed(error, status) && LS.get(K.ctx)) { E.ctx = LS.get(K.ctx); }
      else { $('#l-error').textContent = 'No se pudo cargar la cuenta. Revisa el internet e intenta de nuevo.'; return mostrar('login'); }
    } else {
      const ctx = data && data[0];
      if (!ctx) {
        await sb.auth.signOut();
        $('#l-error').textContent = 'Esta cuenta no tiene un punto de venta asignado. Avisa al administrador.';
        return mostrar('login');
      }
      if (ctx.rol === 'admin') { await sb.auth.signOut(); window.location.href = 'admin.html'; return; }
      E.ctx = ctx; LS.set(K.ctx, ctx);
    }
    const t = LS.get(K.turno);
    if (t && t.fecha === hoyCDMX() && t.punto === E.ctx.punto_id) { E.turno = t; abrirVenta(); }
    else mostrarPin();
  }

  // ---------- Login ----------
  $('#f-login').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const usuario = $('#l-usuario').value.trim().toLowerCase();
    const email = usuario.includes('@') ? usuario : `${usuario}@${C.dominioCuentas}`;
    const btn = $('#l-entrar');
    btn.disabled = true; btn.textContent = 'Entrando…'; $('#l-error').textContent = '';
    const { error } = await sb.auth.signInWithPassword({ email, password: $('#l-clave').value });
    btn.disabled = false; btn.textContent = 'Entrar';
    if (error) {
      $('#l-error').textContent = /invalid|credentials/i.test(error.message)
        ? 'Usuario o contraseña incorrectos.' : 'No hay conexión. Revisa el internet.';
      return;
    }
    $('#l-clave').value = '';
    await cargarContexto();
  });

  // ---------- PIN ----------
  let pin = '';
  function mostrarPin() {
    pin = ''; pintarPin(); $('#p-error').textContent = '';
    $('#p-punto').textContent = E.ctx ? E.ctx.punto_nombre : '';
    mostrar('pin');
  }
  function pintarPin() { $$('#p-puntos span').forEach((s, i) => s.classList.toggle('lleno', i < pin.length)); }

  $('#p-teclado').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button'); if (!b || pin.length >= 4 && b.dataset.n !== 'borrar') return;
    $('#p-error').textContent = '';
    if (b.dataset.n === 'borrar') pin = pin.slice(0, -1); else pin += b.dataset.n;
    pintarPin();
    if (pin.length === 4) await verificarPin();
  });

  async function verificarPin() {
    const { data, error, status } = await sb.rpc('iniciar_turno', { p_pin: pin });
    if (error) {
      $('#p-error').textContent = esErrorDeRed(error, status)
        ? 'Sin internet. Se necesita conexión para iniciar turno.' : 'No se pudo verificar el PIN.';
      pin = ''; pintarPin(); return;
    }
    if (!data || !data.length) {
      const p = $('#p-puntos'); p.classList.remove('sacude'); void p.offsetWidth; p.classList.add('sacude');
      $('#p-error').textContent = 'PIN incorrecto';
      pin = ''; pintarPin(); return;
    }
    E.turno = { empleado_id: data[0].empleado_id, nombre: data[0].nombre, fecha: hoyCDMX(), punto: E.ctx.punto_id };
    LS.set(K.turno, E.turno);
    abrirVenta();
  }

  $('#p-salir').addEventListener('click', async () => {
    if (E.cola.length) { aviso('Hay ventas guardadas sin enviar. Conéctate a internet antes de cerrar sesión.', 'error'); return; }
    if (!await preguntar('¿Cerrar la sesión de este dispositivo? Después habrá que escribir usuario y contraseña del punto.', 'Cerrar sesión', 'Cancelar', true)) return;
    await sb.auth.signOut();
    [K.ctx, K.turno, K.catalogo, K.ticket].forEach(LS.del);
    E.ctx = null; E.turno = null; E.ticket = [];
    mostrar('login');
  });

  // =====================================================================
  // Pantalla de venta
  // =====================================================================
  function abrirVenta() {
    $('#b-punto').textContent = E.ctx.punto_nombre;
    $('#b-empleado').textContent = 'Atiende: ' + E.turno.nombre;
    mostrar('venta');
    if (E.catalogo) pintarProductos();
    cargarCatalogo();
    pintarTicket(); pintarPendientes();
    sincronizar();
  }

  async function cargarCatalogo() {
    const cache = LS.get(K.catalogo);
    if (!E.catalogo && cache && cache.punto === E.ctx.punto_id) { E.catalogo = cache.data; pintarProductos(); }
    const { data, error } = await sb.rpc('catalogo_punto');
    if (!error && data) {
      E.catalogo = data;
      LS.set(K.catalogo, { punto: E.ctx.punto_id, data });
      // quitar del ticket lo que ya no exista
      E.ticket = E.ticket.filter((l) => buscar(l.producto_id, l.sabor_id).sabor);
      guardarTicket();
      pintarProductos(); pintarTicket();
    } else if (!E.catalogo) {
      $('#productos').innerHTML = '<p class="vacio">No se pudo cargar el catálogo. Revisa el internet.</p>';
    }
  }

  function buscar(pid, sid) {
    const producto = E.catalogo && E.catalogo.productos.find((p) => p.id === pid);
    const sabor = producto && producto.sabores.find((s) => s.id === sid);
    return { producto, sabor };
  }
  const piezasDe = (pid) => E.ticket.filter((l) => l.producto_id === pid).reduce((a, l) => a + l.cantidad, 0);
  const piezasDeSabor = (pid, sid) => (E.ticket.find((l) => l.producto_id === pid && l.sabor_id === sid) || { cantidad: 0 }).cantidad;
  const totalPiezas = () => E.ticket.reduce((a, l) => a + l.cantidad, 0);

  function pintarProductos() {
    if (!E.catalogo) return;
    $('#productos').innerHTML = E.catalogo.productos.map((p) => {
      const n = piezasDe(p.id);
      const foto = C.fotos[p.id] || C.fotoGenerica;
      const color = C.colores[p.id] || 'azul';
      return `<button class="producto" data-pid="${p.id}">
          <div class="foto"><img src="${esc(foto)}" alt="" loading="lazy"></div>
          <div class="nombre titulo">${esc(p.nombre)}</div>
          <div class="franja c-${color}"></div>
          ${n ? `<span class="contador">${n}</span>` : ''}
        </button>`;
    }).join('');
  }

  $('#productos').addEventListener('click', (ev) => {
    const b = ev.target.closest('.producto'); if (!b) return;
    const p = E.catalogo.productos.find((x) => x.id === Number(b.dataset.pid)); if (!p) return;
    const disponibles = p.sabores.filter((s) => !s.agotado);
    if (!p.sabores.length) return aviso('Este producto no tiene sabores configurados', 'error');
    if (p.sabores.length === 1) {
      if (!disponibles.length) return aviso(`${p.nombre}: agotado hoy`, 'error');
      agregar(p.id, p.sabores[0].id);
      aviso(`+1 ${p.nombre}`);
      return;
    }
    abrirSabores(p);
  });

  function agregar(pid, sid) {
    const l = E.ticket.find((x) => x.producto_id === pid && x.sabor_id === sid);
    if (l) { if (l.cantidad < 99) l.cantidad += 1; } else E.ticket.push({ producto_id: pid, sabor_id: sid, cantidad: 1 });
    guardarTicket(); pintarProductos(); pintarTicket();
  }
  function quitar(pid, sid) {
    const l = E.ticket.find((x) => x.producto_id === pid && x.sabor_id === sid); if (!l) return;
    l.cantidad -= 1;
    if (l.cantidad <= 0) E.ticket = E.ticket.filter((x) => x !== l);
    guardarTicket(); pintarProductos(); pintarTicket();
  }

  // ---------- Hoja de sabores ----------
  function abrirSabores(p) {
    E.productoAbierto = p;
    $('#s-titulo').textContent = p.nombre;
    pintarSabores();
    $('#m-sabores').hidden = false;
  }
  function pintarSabores() {
    const p = E.productoAbierto; if (!p) return;
    $('#s-lista').innerHTML = p.sabores.map((s) => {
      const n = piezasDeSabor(p.id, s.id);
      return `<div class="fila-sabor">
          <button class="sabor ${n ? 'con-cantidad' : ''} ${s.agotado ? 'agotado' : ''}" data-sid="${s.id}">
            ${esc(s.nombre)}${n ? `<span class="num">${n}</span>` : ''}
          </button>
          ${n ? `<button class="sabor-quitar" data-quitar="${s.id}">− Quitar 1</button>` : ''}
        </div>`;
    }).join('');
  }
  $('#s-lista').addEventListener('click', (ev) => {
    const p = E.productoAbierto; if (!p) return;
    const q = ev.target.closest('[data-quitar]');
    if (q) { quitar(p.id, Number(q.dataset.quitar)); return pintarSabores(); }
    const b = ev.target.closest('.sabor'); if (!b || b.classList.contains('agotado')) return;
    agregar(p.id, Number(b.dataset.sid)); pintarSabores();
  });
  $('#s-listo').addEventListener('click', cerrarSabores);
  $('#m-sabores').addEventListener('click', (ev) => { if (ev.target.id === 'm-sabores') cerrarSabores(); });
  function cerrarSabores() { $('#m-sabores').hidden = true; E.productoAbierto = null; }

  // ---------- Ticket ----------
  function htmlLineas() {
    if (!E.ticket.length) return '<li class="vacio">Toca un producto para empezar</li>';
    return E.ticket.map((l) => {
      const { producto, sabor } = buscar(l.producto_id, l.sabor_id);
      return `<li class="linea">
          <span class="cant">${l.cantidad}×</span>
          <span class="desc">${esc(producto ? producto.nombre : '¿?')}<small>${esc(sabor ? sabor.nombre : '')}</small></span>
          <button class="menos" data-p="${l.producto_id}" data-s="${l.sabor_id}" aria-label="Quitar uno">−</button>
        </li>`;
    }).join('');
  }
  function pintarTicket() {
    const n = totalPiezas();
    $('#t-lineas').innerHTML = htmlLineas();
    $('#t-continuar').disabled = !n; $('#i-continuar').disabled = !n;
    $('#i-num').textContent = n; $('#i-txt').textContent = n === 1 ? 'pieza' : 'piezas';
    if (!$('#m-resumen').hidden) {
      if (!n) cerrarResumen(); else { $('#r-lineas').innerHTML = htmlLineas(); actualizarConfirmar(); }
    }
  }
  const alQuitarLinea = (ev) => {
    const b = ev.target.closest('.menos'); if (!b) return;
    quitar(Number(b.dataset.p), Number(b.dataset.s));
  };
  $('#t-lineas').addEventListener('click', alQuitarLinea);
  $('#r-lineas').addEventListener('click', alQuitarLinea);

  // ---------- Resumen y método de pago ----------
  function abrirResumen() {
    if (!totalPiezas()) return;
    E.metodo = null;
    $('#r-lineas').innerHTML = htmlLineas();
    $('#r-metodos').innerHTML = (E.catalogo ? E.catalogo.metodos : []).map((m) =>
      `<button class="metodo ${m.id === 'tarjeta_ph' ? 'ph' : ''}" data-m="${esc(m.id)}">${esc(m.nombre)}</button>`).join('');
    actualizarConfirmar();
    $('#m-resumen').hidden = false;
  }
  function cerrarResumen() { $('#m-resumen').hidden = true; }
  function actualizarConfirmar() {
    const b = $('#r-confirmar');
    b.disabled = E.guardando || !E.metodo || !totalPiezas();
    b.textContent = E.guardando ? 'Guardando…' : (E.metodo ? 'Confirmar venta' : 'Elige cómo pagó');
  }
  $('#t-continuar').addEventListener('click', abrirResumen);
  $('#i-continuar').addEventListener('click', abrirResumen);
  $('#r-seguir').addEventListener('click', cerrarResumen);
  $('#m-resumen').addEventListener('click', (ev) => { if (ev.target.id === 'm-resumen' && !E.guardando) cerrarResumen(); });
  $('#r-metodos').addEventListener('click', (ev) => {
    const b = ev.target.closest('.metodo'); if (!b) return;
    E.metodo = b.dataset.m;
    $$('#r-metodos .metodo').forEach((x) => x.classList.toggle('elegido', x === b));
    actualizarConfirmar();
  });
  $('#r-confirmar').addEventListener('click', confirmarVenta);

  async function confirmarVenta() {
    if (E.guardando || !E.metodo || !totalPiezas()) return;   // evita doble toque
    E.guardando = true; actualizarConfirmar();

    const metodo = E.catalogo.metodos.find((m) => m.id === E.metodo);
    const venta = {
      id: uuid(),
      empleado_id: E.turno.empleado_id,
      empleado: E.turno.nombre,
      punto: E.ctx.punto_id,
      metodo: E.metodo,
      metodo_nombre: metodo ? metodo.nombre : E.metodo,
      fecha: new Date().toISOString(),
      items: E.ticket.map((l) => {
        const { producto, sabor } = buscar(l.producto_id, l.sabor_id);
        return { producto_id: l.producto_id, sabor_id: l.sabor_id, cantidad: l.cantidad,
                 producto: producto ? producto.nombre : '', sabor: sabor ? sabor.nombre : '' };
      })
    };
    // 1) Primero se guarda en el dispositivo: aunque se vaya el internet, no se pierde.
    E.cola.push(venta); guardarCola();
    E.ticket = []; guardarTicket();

    // 2) Se envía a la base de datos.
    const r = await enviar(venta);

    E.guardando = false; E.metodo = null;
    cerrarResumen(); pintarProductos(); pintarTicket(); pintarPendientes();
    const piezas = venta.items.reduce((a, i) => a + i.cantidad, 0);
    if (r.ok) confirmacion('ok', 'Venta guardada', `#${r.folio} · ${piezas} ${piezas === 1 ? 'pieza' : 'piezas'} · ${venta.metodo_nombre}`);
    else if (r.rechazada) aviso('No se pudo guardar: ' + r.mensaje + '. Revisa "Ventas de hoy".', 'error');
    else confirmacion('pendiente', 'Guardada en este dispositivo', 'Se enviará sola cuando vuelva el internet.');
  }

  async function enviar(venta) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    let res;
    try {
      res = await sb.rpc('registrar_venta', {
        p_id: venta.id, p_empleado_id: venta.empleado_id, p_metodo: venta.metodo,
        p_fecha: venta.fecha,
        p_items: venta.items.map((i) => ({ producto_id: i.producto_id, sabor_id: i.sabor_id, cantidad: i.cantidad }))
      }).abortSignal(ctrl.signal);
    } catch (e) {
      res = { error: { message: String(e) }, status: 0 };
    } finally { clearTimeout(t); }

    const { data, error, status } = res;
    if (!error && data != null) {
      E.cola = E.cola.filter((v) => v.id !== venta.id); guardarCola();
      return { ok: true, folio: data };
    }
    if (esErrorDeRed(error, status)) return { ok: false };
    const v = E.cola.find((x) => x.id === venta.id);
    if (v) { v.error = (error && error.message) || 'Error desconocido'; guardarCola(); }
    return { ok: false, rechazada: true, mensaje: v ? v.error : 'Error' };
  }

  let confTimer;
  function confirmacion(tipo, titulo, texto) {
    const c = $('#c-ok');
    c.className = 'confirmacion ' + tipo;
    $('#c-titulo').textContent = titulo; $('#c-texto').textContent = texto;
    c.querySelector('.icono').textContent = tipo === 'ok' ? '✓' : '⏳';
    c.hidden = false;
    clearTimeout(confTimer);
    confTimer = setTimeout(() => { c.hidden = true; }, tipo === 'ok' ? 1800 : 3000);
  }
  $('#c-ok').addEventListener('click', () => { $('#c-ok').hidden = true; });

  // ---------- Envío de ventas pendientes ----------
  function pintarPendientes() {
    const pend = E.cola.filter((v) => !v.error).length;
    const err = E.cola.filter((v) => v.error).length;
    const b = $('#b-pendientes');
    const partes = [];
    if (pend) partes.push(`⏳ ${pend} ${pend === 1 ? 'venta guardada' : 'ventas guardadas'} en este dispositivo, ${pend === 1 ? 'se enviará' : 'se enviarán'} al volver el internet`);
    if (err) partes.push(`⚠️ ${err} ${err === 1 ? 'venta' : 'ventas'} con error: revisa "Ventas de hoy"`);
    b.textContent = partes.join(' · '); b.hidden = !partes.length;
  }

  async function sincronizar() {
    if (E.sincronizando || E.guardando) return;
    const porEnviar = E.cola.filter((v) => !v.error);
    if (!porEnviar.length) return;
    E.sincronizando = true;
    for (const v of porEnviar) {
      const r = await enviar(v);
      if (!r.ok && !r.rechazada) break;   // sigue sin internet: se intenta más tarde
    }
    E.sincronizando = false;
    pintarPendientes();
  }
  setInterval(() => {
    sincronizar();
    // Cambio de día: se pide PIN de nuevo (solo si no hay una venta a medias)
    if (E.turno && E.turno.fecha !== hoyCDMX() && !E.ticket.length && $('#m-resumen').hidden && !$('#v-venta').hidden) {
      E.turno = null; LS.del(K.turno); mostrarPin();
    }
  }, 20000);
  setInterval(() => { if (E.ctx && !$('#v-venta').hidden && !E.ticket.length) cargarCatalogo(); }, 5 * 60000);
  window.addEventListener('online', sincronizar);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sincronizar(); });

  // ---------- Barra superior ----------
  $('#b-cambiar').addEventListener('click', async () => {
    const msg = E.ticket.length
      ? `Hay una venta a medias. ¿Terminar el turno de ${E.turno.nombre} y descartarla?`
      : `¿Terminar el turno de ${E.turno.nombre}?`;
    if (!await preguntar(msg, 'Terminar turno', 'Cancelar', !!E.ticket.length)) return;
    E.ticket = []; guardarTicket(); E.turno = null; LS.del(K.turno);
    mostrarPin();
  });
  $('#b-hoy').addEventListener('click', abrirHoy);
  $('#b-agotados').addEventListener('click', abrirAgotados);
  $$('[data-ir="venta"]').forEach((b) => b.addEventListener('click', () => { mostrar('venta'); pintarProductos(); }));

  // =====================================================================
  // Ventas de hoy
  // =====================================================================
  async function abrirHoy() {
    mostrar('hoy');
    $('#h-lista').innerHTML = '<p class="vacio">Cargando…</p>';
    await sincronizar();
    const { data, error } = await sb.rpc('ventas_hoy');
    const servidor = error ? [] : (data || []);
    const hoy = hoyCDMX();
    const locales = E.cola.filter((v) => fechaCDMX(new Date(v.fecha)) === hoy && v.punto === E.ctx.punto_id);

    const activas = servidor.filter((v) => v.estado === 'activa');
    const piezasServ = activas.reduce((a, v) => a + (v.items || []).reduce((b, i) => b + i.cantidad, 0), 0);
    const piezasLoc = locales.filter((v) => !v.error).reduce((a, v) => a + v.items.reduce((b, i) => b + i.cantidad, 0), 0);
    $('#h-ventas').textContent = activas.length + locales.filter((v) => !v.error).length;
    $('#h-piezas').textContent = piezasServ + piezasLoc;

    const ahora = Date.now();
    const htmlLocal = locales.map((v) => `
      <div class="venta-hoy">
        <div class="cab">
          <span class="folio">Sin folio</span><span>${horaCDMX(new Date(v.fecha))}</span>
          <span>${esc(v.empleado)}</span><span class="chip">${esc(v.metodo_nombre)}</span>
          ${v.error ? `<span class="chip rojo">No se guardó: ${esc(v.error)}</span>` : '<span class="chip">Pendiente de enviar</span>'}
        </div>
        <ul>${v.items.map((i) => `<li>${i.cantidad} × ${esc(i.producto)} · ${esc(i.sabor)}</li>`).join('')}</ul>
        ${v.error ? `<button class="btn btn-secundario" data-reintentar="${v.id}">Reintentar</button>` : ''}
        <button class="btn btn-peligro" data-descartar="${v.id}">${v.error ? 'Descartar' : 'Cancelar'}</button>
      </div>`).join('');

    const htmlServ = servidor.map((v) => {
      const puede = v.estado === 'activa' && v.empleado_id === E.turno.empleado_id &&
        (ahora - Date.parse(v.recibida_en)) < C.minutosParaCancelar * 60000;
      return `<div class="venta-hoy ${v.estado === 'cancelada' ? 'cancelada' : ''}">
          <div class="cab">
            <span class="folio">#${v.folio}</span><span>${esc(v.hora)}</span>
            <span>${esc(v.empleado)}</span><span class="chip azul">${esc(v.metodo)}</span>
            ${v.estado === 'cancelada' ? '<span class="chip rojo">Cancelada</span>' : ''}
          </div>
          <ul>${(v.items || []).map((i) => `<li>${i.cantidad} × ${esc(i.producto)} · ${esc(i.sabor)}</li>`).join('')}</ul>
          ${puede ? `<button class="btn btn-peligro" data-cancelar="${v.id}" data-folio="${v.folio}">Cancelar venta</button>` : ''}
        </div>`;
    }).join('');

    $('#h-lista').innerHTML = (error ? '<p class="error">No se pudieron cargar las ventas del servidor (sin internet).</p>' : '') +
      (htmlLocal + htmlServ || '<p class="vacio">Todavía no hay ventas hoy.</p>');
    pintarPendientes();
  }

  $('#h-lista').addEventListener('click', async (ev) => {
    const c = ev.target.closest('[data-cancelar]');
    if (c) {
      if (!await preguntar(`¿Cancelar la venta #${c.dataset.folio}? Quedará marcada como cancelada.`, 'Sí, cancelar', 'No', true)) return;
      const { error } = await sb.rpc('cancelar_venta', { p_id: c.dataset.cancelar, p_empleado_id: E.turno.empleado_id });
      if (error) aviso(error.message, 'error'); else aviso('Venta cancelada');
      return abrirHoy();
    }
    const d = ev.target.closest('[data-descartar]');
    if (d) {
      if (!await preguntar('¿Quitar esta venta? No se registrará.', 'Sí, quitar', 'No', true)) return;
      E.cola = E.cola.filter((v) => v.id !== d.dataset.descartar); guardarCola();
      return abrirHoy();
    }
    const r = ev.target.closest('[data-reintentar]');
    if (r) {
      const v = E.cola.find((x) => x.id === r.dataset.reintentar);
      if (v) { delete v.error; guardarCola(); await enviar(v); }
      return abrirHoy();
    }
  });

  // =====================================================================
  // Agotados
  // =====================================================================
  async function abrirAgotados() {
    mostrar('agotados');
    await cargarCatalogo();
    pintarAgotados();
  }
  function pintarAgotados() {
    if (!E.catalogo) { $('#a-lista').innerHTML = '<p class="vacio">Sin catálogo. Revisa el internet.</p>'; return; }
    $('#a-lista').innerHTML = E.catalogo.productos.map((p) => `
      <div class="agotado-producto">
        <h3 class="titulo">${esc(p.nombre)}</h3>
        <div class="interruptores">
          ${p.sabores.map((s) => `<button class="interruptor ${s.agotado ? 'off' : ''}" data-p="${p.id}" data-s="${s.id}">${esc(s.nombre)}</button>`).join('')}
        </div>
      </div>`).join('');
  }
  $('#a-lista').addEventListener('click', async (ev) => {
    const b = ev.target.closest('.interruptor'); if (!b || b.disabled) return;
    const { producto, sabor } = buscar(Number(b.dataset.p), Number(b.dataset.s)); if (!sabor) return;
    b.disabled = true;
    const { error } = await sb.rpc('marcar_agotado', {
      p_producto_id: producto.id, p_sabor_id: sabor.id, p_agotado: !sabor.agotado, p_empleado_id: E.turno.empleado_id
    });
    if (error) { b.disabled = false; return aviso('No se pudo cambiar. Revisa el internet.', 'error'); }
    sabor.agotado = !sabor.agotado;
    LS.set(K.catalogo, { punto: E.ctx.punto_id, data: E.catalogo });
    pintarAgotados();
    aviso(`${producto.nombre} · ${sabor.nombre}: ${sabor.agotado ? 'agotado' : 'disponible'}`);
  });

  sb.auth.onAuthStateChange((evento) => {
    if (evento === 'SIGNED_OUT') { E.ctx = null; E.turno = null; mostrar('login'); }
  });

  iniciar();
})();
