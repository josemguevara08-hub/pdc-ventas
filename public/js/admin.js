// =====================================================================
// Pedazo de Cielo · Panel de administración
// =====================================================================
(() => {
  'use strict';

  const C = window.PDC_CONFIG;
  const sb = window.supabase.createClient(C.supabaseUrl, C.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'pdc-admin-auth' }
  });

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dinero = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n || 0);
  const entero = (n) => new Intl.NumberFormat('es-MX').format(n || 0);
  const hoyCDMX = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

  let avisoTimer;
  function aviso(texto, tipo = '') {
    const a = $('#aviso'); a.textContent = texto; a.className = 'aviso ' + tipo; a.hidden = false;
    clearTimeout(avisoTimer); avisoTimer = setTimeout(() => { a.hidden = true; }, tipo === 'error' ? 6000 : 2500);
  }
  function preguntar(texto, si = 'Sí', no = 'No') {
    return new Promise((resolve) => {
      const f = document.createElement('div'); f.className = 'fondo-modal';
      f.innerHTML = `<div class="hoja" role="alertdialog" aria-modal="true"><div class="hoja-cabecera"><h2 class="titulo">${esc(texto)}</h2></div>
        <div class="botones-hoja"><button class="btn btn-peligro btn-bloque" data-r="1">${esc(si)}</button>
        <button class="btn btn-secundario btn-bloque" data-r="0">${esc(no)}</button></div></div>`;
      f.addEventListener('click', (ev) => { const b = ev.target.closest('[data-r]'); if (!b && ev.target !== f) return; f.remove(); resolve(b ? b.dataset.r === '1' : false); });
      document.body.appendChild(f);
    });
  }

  const D = { puntos: [], metodos: [], productos: [], sabores: [], prodSabores: [], metodosPunto: [], noDisponible: [], empleados: [], filas: [] };

  // =====================================================================
  // Sesión
  // =====================================================================
  async function iniciar() {
    $$('.ver').forEach((e) => { e.textContent = C.version; });
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return mostrarLogin();
    await entrarPanel();
  }
  function mostrarLogin(msg = '') { $('#v-panel').hidden = true; $('#v-login').hidden = false; $('#l-error').textContent = msg; }

  $('#f-login').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const b = $('#l-entrar'); b.disabled = true; b.textContent = 'Entrando…';
    const { error } = await sb.auth.signInWithPassword({ email: $('#l-email').value.trim(), password: $('#l-clave').value });
    b.disabled = false; b.textContent = 'Entrar';
    if (error) { $('#l-error').textContent = /invalid|credentials/i.test(error.message) ? 'Correo o contraseña incorrectos.' : error.message; return; }
    $('#l-clave').value = '';
    await entrarPanel();
  });
  $('#salir').addEventListener('click', async () => { await sb.auth.signOut(); mostrarLogin(); });

  async function entrarPanel() {
    const { data, error } = await sb.rpc('mi_contexto');
    const ctx = data && data[0];
    if (error || !ctx || ctx.rol !== 'admin') {
      await sb.auth.signOut();
      return mostrarLogin(error ? 'No hay conexión.' : 'Esta cuenta no es de administrador.');
    }
    $('#v-login').hidden = true; $('#v-panel').hidden = false;
    await cargarCatalogo();
    $('#f-desde').value = hoyCDMX(); $('#f-hasta').value = hoyCDMX();
    consultar();
  }

  // ---------- Pestañas ----------
  $('#pestanas').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-tab]'); if (!b) return;
    $$('#pestanas button').forEach((x) => x.classList.toggle('activa', x === b));
    $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== b.dataset.tab; });
    if (b.dataset.tab === 'empleados') cargarEmpleados();
  });

  // =====================================================================
  // Catálogo (se usa en filtros y pestañas de configuración)
  // =====================================================================
  async function cargarCatalogo() {
    const [pv, mp, pr, sa, ps, mpp, nd] = await Promise.all([
      sb.from('puntos_venta').select('*').order('orden'),
      sb.from('metodos_pago').select('*').order('orden'),
      sb.from('productos').select('*').order('orden'),
      sb.from('sabores').select('*').order('orden'),
      sb.from('producto_sabores').select('*'),
      sb.from('metodos_punto').select('*'),
      sb.from('no_disponible_punto').select('*')
    ]);
    const err = [pv, mp, pr, sa, ps, mpp, nd].find((r) => r.error);
    if (err) return aviso('No se pudo cargar el catálogo: ' + err.error.message, 'error');
    D.puntos = pv.data; D.metodos = mp.data; D.productos = pr.data; D.sabores = sa.data; D.prodSabores = ps.data; D.metodosPunto = mpp.data; D.noDisponible = nd.data;

    const opts = (arr, val, txt) => arr.map((x) => `<option value="${esc(x[val])}">${esc(x[txt])}</option>`).join('');
    $('#f-punto').innerHTML = '<option value="">Todos</option>' + opts(D.puntos, 'id', 'nombre');
    $('#f-metodo').innerHTML = '<option value="">Todos</option>' + opts(D.metodos, 'id', 'nombre');
    $('#e-punto').innerHTML = opts(D.puntos, 'id', 'nombre');
    const dSel = $('#d-punto').value;
    $('#d-punto').innerHTML = opts(D.puntos, 'id', 'nombre');
    if (dSel) $('#d-punto').value = dSel;
    pintarCatalogo(); pintarMetodosPunto(); pintarDisponibilidad();
  }

  // =====================================================================
  // Ventas
  // =====================================================================
  async function traerFilas(filtros) {
    const paso = 1000; let desde = 0; let todas = [];
    for (;;) {
      let q = sb.from('v_ventas_detalle').select('*');
      if (filtros.desde) q = q.gte('fecha', filtros.desde);
      if (filtros.hasta) q = q.lte('fecha', filtros.hasta);
      if (filtros.punto) q = q.eq('punto_id', filtros.punto);
      if (filtros.metodo) q = q.eq('metodo_pago_id', filtros.metodo);
      if (filtros.estado) q = q.eq('estado', filtros.estado);
      const { data, error } = await q.order('fecha_venta', { ascending: false }).order('detalle_id', { ascending: true }).range(desde, desde + paso - 1);
      if (error) throw error;
      todas = todas.concat(data);
      if (data.length < paso) break;
      desde += paso;
    }
    return todas;
  }

  function filtrosActuales() {
    return { desde: $('#f-desde').value, hasta: $('#f-hasta').value, punto: $('#f-punto').value, metodo: $('#f-metodo').value, estado: $('#f-estado').value };
  }

  async function consultar() {
    const b = $('#b-consultar'); b.disabled = true; b.textContent = 'Consultando…';
    try {
      D.filas = await traerFilas(filtrosActuales());
    } catch (e) { aviso('Error al consultar: ' + e.message, 'error'); D.filas = []; }
    b.disabled = false; b.textContent = 'Consultar';
    // Opciones de producto y sabor según lo que hay en el periodo (incluye sabores de temporada pasados)
    const prodSel = $('#f-producto').value, sabSel = $('#f-sabor').value;
    const unicos = (k) => [...new Set(D.filas.map((f) => f[k]))].sort((a, b) => a.localeCompare(b, 'es'));
    $('#f-producto').innerHTML = '<option value="">Todos</option>' + unicos('producto').map((x) => `<option ${x === prodSel ? 'selected' : ''}>${esc(x)}</option>`).join('');
    $('#f-sabor').innerHTML = '<option value="">Todos</option>' + unicos('sabor').map((x) => `<option ${x === sabSel ? 'selected' : ''}>${esc(x)}</option>`).join('');
    pintarVentas();
  }

  function filasFiltradas() {
    const p = $('#f-producto').value, s = $('#f-sabor').value;
    return D.filas.filter((f) => (!p || f.producto === p) && (!s || f.sabor === s));
  }

  function agrupar(filas, claves) {
    const m = new Map();
    for (const f of filas) {
      const k = claves.map((c) => f[c]).join('||');
      const g = m.get(k) || Object.assign(Object.fromEntries(claves.map((c) => [c, f[c]])), { piezas: 0, ingresos: 0, ventas: new Set() });
      g.piezas += f.cantidad; g.ingresos += Number(f.importe); g.ventas.add(f.venta_id);
      m.set(k, g);
    }
    return [...m.values()].map((g) => ({ ...g, ventas: g.ventas.size })).sort((a, b) => b.piezas - a.piezas);
  }

  function tabla(cols, filas, pie) {
    return `<table class="tabla"><thead><tr>${cols.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.t)}</th>`).join('')}</tr></thead>
      <tbody>${filas.map((f) => `<tr class="${f._clase || ''}">${cols.map((c) => `<td class="${c.num ? 'num' : ''}">${c.html ? c.html(f) : esc(c.f ? c.f(f) : f[c.k])}</td>`).join('')}</tr>`).join('') ||
      `<tr><td colspan="${cols.length}" class="vacio">Sin ventas en este periodo</td></tr>`}</tbody>
      ${pie ? `<tfoot><tr>${pie.map((p, i) => `<td class="${cols[i].num ? 'num' : ''}">${esc(p)}</td>`).join('')}</tr></tfoot>` : ''}</table>`;
  }

  function pintarVentas() {
    const filas = filasFiltradas();
    const activas = filas.filter((f) => f.estado === 'activa');
    const ventas = new Set(activas.map((f) => f.venta_id)).size;
    const piezas = activas.reduce((a, f) => a + f.cantidad, 0);
    const ingresos = activas.reduce((a, f) => a + Number(f.importe), 0);
    const canceladas = new Set(filas.filter((f) => f.estado === 'cancelada').map((f) => f.venta_id)).size;
    $('#kpis').innerHTML = `
      <div class="kpi azul"><span>Ventas</span><b>${entero(ventas)}</b></div>
      <div class="kpi menta"><span>Piezas vendidas</span><b>${entero(piezas)}</b></div>
      <div class="kpi crema"><span>Ingresos (precio de lista)</span><b>${dinero(ingresos)}</b></div>
      <div class="kpi frambuesa"><span>Ventas canceladas</span><b>${entero(canceladas)}</b></div>`;

    const base = $('#f-estado').value === 'cancelada' ? filas : activas;
    const colsPS = [{ t: 'Producto', k: 'producto' }, { t: 'Sabor', k: 'sabor' }, { t: 'Piezas', k: 'piezas', num: true, f: (g) => entero(g.piezas) }, { t: 'Ingresos', num: true, f: (g) => dinero(g.ingresos) }];
    const ps = agrupar(base, ['producto', 'sabor']);
    $('#t-prodsabor').innerHTML = tabla(colsPS, ps, ['Total', '', entero(ps.reduce((a, g) => a + g.piezas, 0)), dinero(ps.reduce((a, g) => a + g.ingresos, 0))]);

    const colsP = [{ t: 'Punto', k: 'punto' }, { t: 'Ventas', num: true, f: (g) => entero(g.ventas) }, { t: 'Piezas', num: true, f: (g) => entero(g.piezas) }, { t: 'Ingresos', num: true, f: (g) => dinero(g.ingresos) }];
    $('#t-punto').innerHTML = tabla(colsP, agrupar(base, ['punto']));
    const colsM = [{ t: 'Método', k: 'metodo_pago' }, { t: 'Ventas', num: true, f: (g) => entero(g.ventas) }, { t: 'Piezas', num: true, f: (g) => entero(g.piezas) }, { t: 'Ingresos', num: true, f: (g) => dinero(g.ingresos) }];
    $('#t-metodo').innerHTML = tabla(colsM, agrupar(base, ['metodo_pago']));

    const LIM = 500;
    const det = filas.slice(0, LIM).map((f) => ({ ...f, _clase: f.estado === 'cancelada' ? 'cancelada' : '' }));
    const colsD = [
      { t: 'Folio', k: 'folio' }, { t: 'Fecha', k: 'fecha' }, { t: 'Hora', k: 'hora' }, { t: 'Punto', k: 'punto' },
      { t: 'Empleado', k: 'empleado' }, { t: 'Producto', k: 'producto' }, { t: 'Sabor', k: 'sabor' },
      { t: 'Cant.', k: 'cantidad', num: true }, { t: 'Precio', num: true, f: (f) => dinero(f.precio_unitario) },
      { t: 'Importe', num: true, f: (f) => dinero(f.importe) }, { t: 'Pago', k: 'metodo_pago' }, { t: 'Estado', k: 'estado' },
      { t: '', html: (f) => f.estado === 'activa' ? `<button class="btn btn-secundario" data-cancelar="${esc(f.venta_id)}" data-folio="${f.folio}">Cancelar</button>` : '' }
    ];
    $('#t-detalle').innerHTML = tabla(colsD, det) + (filas.length > LIM ? `<p class="nota">Se muestran ${LIM} de ${entero(filas.length)} renglones. La descarga de Excel incluye todos.</p>` : '');
  }

  $('#b-consultar').addEventListener('click', consultar);
  $('#b-hoy').addEventListener('click', () => { $('#f-desde').value = hoyCDMX(); $('#f-hasta').value = hoyCDMX(); consultar(); });
  ['#f-producto', '#f-sabor'].forEach((s) => $(s).addEventListener('change', pintarVentas));

  $('#t-detalle').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-cancelar]'); if (!b) return;
    if (!await preguntar(`¿Cancelar la venta #${b.dataset.folio} completa? Quedará marcada como cancelada (no se borra).`, 'Sí, cancelar', 'No')) return;
    const { error } = await sb.rpc('cancelar_venta', { p_id: b.dataset.cancelar });
    if (error) return aviso(error.message, 'error');
    aviso('Venta cancelada'); consultar();
  });

  // ---------- Excel ----------
  function filasExcel(filas) {
    return filas.map((f) => ({
      Folio: f.folio, Fecha: f.fecha, Hora: f.hora, Punto: f.punto, Empleado: f.empleado,
      Producto: f.producto, Sabor: f.sabor, Cantidad: f.cantidad,
      'Precio unitario': Number(f.precio_unitario), Importe: Number(f.importe),
      'Método de pago': f.metodo_pago, Estado: f.estado
    }));
  }
  function libro(filas) {
    const wb = XLSX.utils.book_new();
    const activas = filas.filter((f) => f.estado === 'activa');
    const hoja = (datos) => XLSX.utils.json_to_sheet(datos.length ? datos : [{ 'Sin datos': '' }]);
    XLSX.utils.book_append_sheet(wb, hoja(filasExcel(filas)), 'Detalle');
    XLSX.utils.book_append_sheet(wb, hoja(agrupar(activas, ['producto', 'sabor']).map((g) => ({ Producto: g.producto, Sabor: g.sabor, Piezas: g.piezas, Ingresos: g.ingresos }))), 'Producto y sabor');
    XLSX.utils.book_append_sheet(wb, hoja(agrupar(activas, ['fecha', 'punto']).map((g) => ({ Fecha: g.fecha, Punto: g.punto, Ventas: g.ventas, Piezas: g.piezas, Ingresos: g.ingresos }))
      .sort((a, b) => a.Fecha.localeCompare(b.Fecha) || a.Punto.localeCompare(b.Punto))), 'Día y punto');
    XLSX.utils.book_append_sheet(wb, hoja(agrupar(activas, ['metodo_pago']).map((g) => ({ 'Método de pago': g.metodo_pago, Ventas: g.ventas, Piezas: g.piezas, Ingresos: g.ingresos }))), 'Método de pago');
    return wb;
  }
  $('#b-excel').addEventListener('click', () => {
    const f = filtrosActuales();
    XLSX.writeFile(libro(filasFiltradas()), `ventas_pdc_${f.desde || 'inicio'}_a_${f.hasta || 'hoy'}.xlsx`);
  });
  $('#b-respaldo').addEventListener('click', async () => {
    const b = $('#b-respaldo'); b.disabled = true; b.textContent = 'Preparando…';
    try {
      const todas = await traerFilas({});
      XLSX.writeFile(libro(todas), `respaldo_ventas_pdc_${hoyCDMX()}.xlsx`);
    } catch (e) { aviso('Error: ' + e.message, 'error'); }
    b.disabled = false; b.textContent = 'Respaldo completo';
  });

  // =====================================================================
  // Productos, precios y sabores
  // =====================================================================
  function pintarCatalogo() {
    const temp = D.sabores.find((s) => s.es_temporada);
    $('#c-temporada').value = temp ? temp.nombre : '';

    $('#c-productos').innerHTML = `<table class="tabla"><thead><tr><th>Producto</th><th class="num">Precio (MXN)</th><th>Activo</th><th></th></tr></thead><tbody>
      ${D.productos.map((p) => `<tr data-id="${p.id}">
        <td><input type="text" value="${esc(p.nombre)}" data-k="nombre" maxlength="50"></td>
        <td><input type="number" value="${Number(p.precio)}" data-k="precio" min="0" step="1"></td>
        <td><input type="checkbox" class="check" data-k="activo" ${p.activo ? 'checked' : ''}></td>
        <td><button class="btn btn-primario" data-guardar-producto>Guardar</button></td></tr>`).join('')}</tbody></table>`;

    $('#c-sabores').innerHTML = `<table class="tabla"><thead><tr><th>Sabor</th><th>Activo</th><th></th></tr></thead><tbody>
      ${D.sabores.map((s) => `<tr data-id="${s.id}">
        <td><input type="text" value="${esc(s.nombre)}" data-k="nombre" maxlength="40">${s.es_temporada ? ' <span class="chip">Temporada</span>' : ''}</td>
        <td><input type="checkbox" class="check" data-k="activo" ${s.activo ? 'checked' : ''}></td>
        <td><button class="btn btn-primario" data-guardar-sabor>Guardar</button></td></tr>`).join('')}</tbody></table>`;

    const tiene = (p, s) => D.prodSabores.some((x) => x.producto_id === p && x.sabor_id === s);
    $('#c-matriz').innerHTML = `<table class="tabla"><thead><tr><th>Producto</th>${D.sabores.map((s) => `<th>${esc(s.nombre)}</th>`).join('')}</tr></thead><tbody>
      ${D.productos.map((p) => `<tr><td>${esc(p.nombre)}</td>${D.sabores.map((s) =>
        `<td><input type="checkbox" class="check" data-ps="${p.id}:${s.id}" ${tiene(p.id, s.id) ? 'checked' : ''}></td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }

  const filaValores = (tr) => Object.fromEntries($$('[data-k]', tr).map((i) => [i.dataset.k, i.type === 'checkbox' ? i.checked : i.value]));

  async function actualizar(tabla, id, cambios) {
    const { data, error } = await sb.from(tabla).update(cambios).eq('id', id).select();
    if (error) { aviso('No se guardó: ' + error.message, 'error'); return false; }
    if (!data || !data.length) { aviso('No se guardó (sin permiso).', 'error'); return false; }
    aviso('Guardado'); return true;
  }

  $('#c-productos').addEventListener('click', async (ev) => {
    if (!ev.target.closest('[data-guardar-producto]')) return;
    const tr = ev.target.closest('tr'); const v = filaValores(tr);
    const precio = Number(v.precio);
    if (!v.nombre.trim() || !(precio >= 0)) return aviso('Revisa el nombre y el precio', 'error');
    const p = D.productos.find((x) => x.id === Number(tr.dataset.id));
    if (Number(p.precio) !== precio && !await preguntar(`¿Cambiar el precio de ${p.nombre} de ${dinero(p.precio)} a ${dinero(precio)}? Aplica a partir de ahora.`, 'Sí, cambiar', 'No')) return;
    if (await actualizar('productos', tr.dataset.id, { nombre: v.nombre.trim(), precio, activo: v.activo, actualizado_en: new Date().toISOString() })) cargarCatalogo();
  });
  $('#c-sabores').addEventListener('click', async (ev) => {
    if (!ev.target.closest('[data-guardar-sabor]')) return;
    const tr = ev.target.closest('tr'); const v = filaValores(tr);
    if (!v.nombre.trim()) return aviso('Falta el nombre', 'error');
    if (await actualizar('sabores', tr.dataset.id, { nombre: v.nombre.trim(), activo: v.activo })) cargarCatalogo();
  });
  $('#b-temporada').addEventListener('click', async () => {
    const temp = D.sabores.find((s) => s.es_temporada); const nombre = $('#c-temporada').value.trim();
    if (!temp || !nombre) return aviso('Escribe el nombre del sabor', 'error');
    if (await actualizar('sabores', temp.id, { nombre })) cargarCatalogo();
  });
  $('#c-matriz').addEventListener('change', async (ev) => {
    const c = ev.target.closest('[data-ps]'); if (!c) return;
    const [producto_id, sabor_id] = c.dataset.ps.split(':').map(Number);
    const { error } = c.checked
      ? await sb.from('producto_sabores').insert({ producto_id, sabor_id })
      : await sb.from('producto_sabores').delete().match({ producto_id, sabor_id });
    if (error) { c.checked = !c.checked; return aviso('No se guardó: ' + error.message, 'error'); }
    aviso('Guardado'); cargarCatalogo();
  });

  // =====================================================================
  // Qué se vende en cada punto (combinaciones producto-sabor)
  // =====================================================================
  function pintarDisponibilidad() {
    const punto = $('#d-punto').value; if (!punto) return;
    const valida = (p, s) => D.prodSabores.some((x) => x.producto_id === p && x.sabor_id === s);
    const vende = (p, s) => !D.noDisponible.some((x) => x.punto_id === punto && x.producto_id === p && x.sabor_id === s);
    const sabores = D.sabores.filter((s) => s.activo);
    $('#d-matriz').innerHTML = `<table class="tabla"><thead><tr><th>Producto</th>${sabores.map((s) => `<th>${esc(s.nombre)}</th>`).join('')}</tr></thead><tbody>
      ${D.productos.filter((p) => p.activo).map((p) => `<tr><td>${esc(p.nombre)}</td>${sabores.map((s) => valida(p.id, s.id)
        ? `<td><input type="checkbox" class="check" data-disp="${p.id}:${s.id}" ${vende(p.id, s.id) ? 'checked' : ''} aria-label="${esc(p.nombre)} ${esc(s.nombre)}"></td>`
        : '<td style="color:#c9bdb0">—</td>').join('')}</tr>`).join('')}</tbody></table>`;
  }
  $('#d-punto').addEventListener('change', pintarDisponibilidad);
  $('#d-matriz').addEventListener('change', async (ev) => {
    const c = ev.target.closest('[data-disp]'); if (!c) return;
    const punto_id = $('#d-punto').value;
    const [producto_id, sabor_id] = c.dataset.disp.split(':').map(Number);
    const { error } = c.checked
      ? await sb.from('no_disponible_punto').delete().match({ punto_id, producto_id, sabor_id })
      : await sb.from('no_disponible_punto').insert({ punto_id, producto_id, sabor_id });
    if (error) { c.checked = !c.checked; return aviso('No se guardó: ' + error.message, 'error'); }
    aviso('Guardado'); cargarCatalogo();
  });

  // =====================================================================
  // Métodos de pago por punto
  // =====================================================================
  function pintarMetodosPunto() {
    const tiene = (p, m) => D.metodosPunto.some((x) => x.punto_id === p && x.metodo_id === m);
    $('#p-matriz').innerHTML = `<table class="tabla"><thead><tr><th>Punto</th>${D.metodos.map((m) => `<th>${esc(m.nombre)}</th>`).join('')}</tr></thead><tbody>
      ${D.puntos.map((p) => `<tr><td>${esc(p.nombre)}</td>${D.metodos.map((m) =>
        `<td><input type="checkbox" class="check" data-mp="${esc(p.id)}|${esc(m.id)}" ${tiene(p.id, m.id) ? 'checked' : ''}></td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }
  $('#p-matriz').addEventListener('change', async (ev) => {
    const c = ev.target.closest('[data-mp]'); if (!c) return;
    const [punto_id, metodo_id] = c.dataset.mp.split('|');
    const { error } = c.checked
      ? await sb.from('metodos_punto').insert({ punto_id, metodo_id })
      : await sb.from('metodos_punto').delete().match({ punto_id, metodo_id });
    if (error) { c.checked = !c.checked; return aviso('No se guardó: ' + error.message, 'error'); }
    aviso('Guardado'); cargarCatalogo();
  });

  // =====================================================================
  // Empleados
  // =====================================================================
  async function cargarEmpleados() {
    const { data, error } = await sb.from('empleados').select('id, nombre, punto_id, activo, creado_en').order('punto_id').order('nombre');
    if (error) return aviso('No se pudieron cargar: ' + error.message, 'error');
    D.empleados = data;
    $('#e-tabla').innerHTML = `<table class="tabla"><thead><tr><th>Nombre</th><th>Punto</th><th>Activo</th><th>Nuevo PIN</th><th></th></tr></thead><tbody>
      ${data.map((e) => `<tr data-id="${e.id}">
        <td><input type="text" value="${esc(e.nombre)}" data-k="nombre" maxlength="40"></td>
        <td><select data-k="punto_id" class="campo-sel">${D.puntos.map((p) => `<option value="${esc(p.id)}" ${p.id === e.punto_id ? 'selected' : ''}>${esc(p.nombre)}</option>`).join('')}</select></td>
        <td><input type="checkbox" class="check" data-k="activo" ${e.activo ? 'checked' : ''}></td>
        <td><input type="text" inputmode="numeric" maxlength="4" placeholder="(sin cambio)" data-k="pin" autocomplete="off"></td>
        <td><button class="btn btn-primario" data-guardar-empleado>Guardar</button></td></tr>`).join('') ||
        '<tr><td colspan="5" class="vacio">Aún no hay empleados</td></tr>'}</tbody></table>`;
  }

  async function guardarEmpleado(id, nombre, punto, pin, activo) {
    const { error } = await sb.rpc('guardar_empleado', { p_id: id, p_nombre: nombre, p_punto_id: punto, p_pin: pin || null, p_activo: activo });
    if (error) { aviso(error.message, 'error'); return false; }
    aviso('Empleado guardado'); return true;
  }
  $('#e-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const pin = $('#e-pin').value.trim();
    if (!/^\d{4}$/.test(pin)) return aviso('El PIN debe tener 4 números', 'error');
    if (await guardarEmpleado(null, $('#e-nombre').value.trim(), $('#e-punto').value, pin, true)) {
      $('#e-nombre').value = ''; $('#e-pin').value = ''; cargarEmpleados();
    }
  });
  $('#e-tabla').addEventListener('click', async (ev) => {
    if (!ev.target.closest('[data-guardar-empleado]')) return;
    const tr = ev.target.closest('tr'); const v = filaValores(tr);
    if (v.pin && !/^\d{4}$/.test(v.pin)) return aviso('El PIN debe tener 4 números', 'error');
    if (await guardarEmpleado(Number(tr.dataset.id), v.nombre.trim(), v.punto_id, v.pin, v.activo)) cargarEmpleados();
  });

  iniciar();
})();
