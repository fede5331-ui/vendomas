/* ================================================
   VendoMas — script.js
   Toda la lógica de la aplicación.
   ================================================ */


/* ================================================
   CONFIGURACIÓN GENERAL
   ================================================ */

const WHATSAPP_SOPORTE     = '5493804887124';
const STOCK_MINIMO_DEFAULT = 5;

// ── Supabase ──────────────────────────────────
const SUPABASE_URL = 'https://hscvjeyepeogpaqtutni.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzY3ZqZXllcGVvZ3BhcXR1dG5pIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExOTM3MjEsImV4cCI6MjA5Njc2OTcyMX0.rzAg-BGMZAhCYASzWzIdrXDGfk0Yd5_kgE9Sv0STNwg';

/* ================================================
   SISTEMA DE LICENCIAS V3 — SUPABASE
   ================================================ */

const CLAVE_LICENCIA_CACHE = 'gestion_licencia_v3';

// Función principal que corre al arrancar la app
async function verificarLicenciaV3() {
  // PWA: si no hay Capacitor, abrimos la app directamente
  if (!window.Capacitor) {
    abrirAplicacionNormal();
    return;
  }
  
  try {
    const { Device } = Capacitor.Plugins;

    const idInfo      = await Device.getId();
    const uuidCelular = idInfo.identifier;

    // Guardamos el UUID como identificador del comercio para sincronización
    if (bd.configuracion.comercioId !== uuidCelular) {
      bd.configuracion.comercioId = uuidCelular;
      guardarBaseDeDatos();
    }

    const infoGeneral   = await Device.getInfo();
    const marcaCelular  = infoGeneral.manufacturer || 'Desconocido';
    const modeloCelular = `${infoGeneral.manufacturer || ''} ${infoGeneral.model || ''} (Android ${infoGeneral.osVersion || ''})`.trim();
    const negocio       = bd.configuracion.nombreNegocio || 'VendoMas';

    // Llamamos a la función de Supabase que registra/actualiza y devuelve el estado
    const respuesta = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/registrar_dispositivo`,
      {
        method: 'POST',
        headers: {
          'apikey':        SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({
          p_uuid:    uuidCelular,
          p_marca:   marcaCelular,
          p_modelo:  modeloCelular,
          p_negocio: negocio
        })
      }
    );

    if (!respuesta.ok) throw new Error('Error de red: ' + respuesta.status);

    const estado = await respuesta.json();

    // Guardamos en caché con timestamp y días restantes al momento de guardar
    localStorage.setItem(CLAVE_LICENCIA_CACHE, JSON.stringify({
      ...estado,
      cached_at:            Date.now(),
      dias_rest_al_guardar: estado.dias_restantes
    }));

    aplicarEstadoLicencia(estado);

  } catch (error) {
    console.error('Error en licencias, usando caché offline:', error);
    verificarLicenciaOffline();
  }
}

// Control offline: si no hay internet usa el último estado guardado
function verificarLicenciaOffline() {
  const cache = localStorage.getItem(CLAVE_LICENCIA_CACHE);

  if (!cache) {
    // Primera vez sin internet: bloqueamos por seguridad
    mostrarPantallaBloqueo('sin_internet');
    return;
  }

  const datos = JSON.parse(cache);

  // Si estaba bloqueado manualmente, seguimos bloqueando
  if (datos.bloqueado) {
    mostrarPantallaBloqueo('bloqueado');
    return;
  }

  // Calculamos días pasados desde que se guardó el caché
  const msPasados     = Date.now() - datos.cached_at;
  const diasPasados   = Math.floor(msPasados / (1000 * 60 * 60 * 24));
  const diasRestantes = datos.dias_rest_al_guardar - diasPasados;

  aplicarEstadoLicencia({
    ...datos,
    dias_restantes: diasRestantes,
    activo:         !datos.bloqueado && diasRestantes > 0
  });
}

/* ================================================
   RESTAURACIÓN DE DATOS DESDE SUPABASE
   Se ejecuta solo si el celular no tiene datos locales
   pero sí tiene un comercioId con historial en la nube.
   Caso de uso: comerciante perdió o cambió de celular,
   y vos reasignaste manualmente sus datos viejos al UUID nuevo.
   ================================================ */

async function restaurarDatosSiHaceFalta() {
  const comercioId = bd.configuracion.comercioId;
  if (!comercioId) return;

  // Si ya hay productos o ventas locales, no hace falta restaurar nada
  if (bd.productos.length > 0 || bd.ventas.length > 0) return;

  try {
    const [respProductos, respVentas] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/productos?comercio_id=eq.${comercioId}`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      }),
      fetch(`${SUPABASE_URL}/rest/v1/ventas?comercio_id=eq.${comercioId}&order=fecha.desc`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      })
    ]);

    const productosNube = await respProductos.json();
    const ventasNube     = await respVentas.json();

    if (productosNube.length === 0 && ventasNube.length === 0) return; // no había nada que restaurar

    // Reconstruimos los productos en el formato que usa la app
    bd.productos = productosNube.map(p => ({
      id:          Date.now() + Math.random(), // id local nuevo, no se usa en Supabase
      codigo:      p.codigo,
      nombre:      p.nombre,
      precio:      p.precio,
      costo:       p.costo,
      stock:       p.stock,
      stockMin:    p.stock_min,
      vencimiento: p.vencimiento
    }));

    // Reconstruimos las ventas en el formato que usa la app
    bd.ventas = ventasNube.map((v, index) => ({
      id:            ventasNube.length - index, // numeración descendente, la más nueva con el id más alto
      fecha:         v.fecha,
      items:         v.items,
      total:         v.total,
      pago:          v.pago,
      clienteId:     null,
      clienteNombre: v.cliente_nombre || '—'
    }));

    bd.siguienteIdVenta = bd.ventas.length + 1;
    guardarBaseDeDatos();

    alert(`✅ Se restauraron ${productosNube.length} productos y ${ventasNube.length} ventas desde tu cuenta en la nube.`);

  } catch (error) {
    console.error('No se pudieron restaurar los datos:', error);
  }
}

// Aplica el estado: bloquea o deja pasar
function aplicarEstadoLicencia(estado) {
  if (!estado) return;

  if (estado.bloqueado) {
    mostrarPantallaBloqueo('bloqueado');
    return;
  }

  // Si es cliente pago, abre la app sin mostrar el chip de días
  if (estado.suscripcion === 'pago') {
    document.getElementById('app').style.display = 'flex';
    restaurarDatosSiHaceFalta();
    return;
  }

  if (!estado.activo || estado.dias_restantes <= 0) {
    mostrarPantallaBloqueo('vencido');
    return;
  }

  // En prueba: abre la app y muestra los días restantes
  abrirAplicacionNormal(estado.dias_restantes);
}

function abrirAplicacionNormal(diasRestantes) {
  document.getElementById('app').style.display = 'flex';
  restaurarDatosSiHaceFalta();

  // Chip en la topbar
  mostrarChipPrueba(diasRestantes);

  // Indicadores en pantalla Ajustes
  const chipAjustes = document.getElementById('chip-dias-ajustes');
  const barra       = document.getElementById('barra-progreso');

  if (chipAjustes) chipAjustes.textContent = `${diasRestantes} día${diasRestantes !== 1 ? 's' : ''} restantes`;
  if (barra) {
    const porcentajeUsado = ((15 - diasRestantes) / 15) * 100;
    barra.style.width = porcentajeUsado + '%';
  }
}

// Chip pequeño en la topbar con días restantes
function mostrarChipPrueba(dias) {
  let chip = document.getElementById('chip-prueba-topbar');
  if (!chip) {
    chip = document.createElement('div');
    chip.id = 'chip-prueba-topbar';
    chip.style.cssText = `
      font-size: 10px;
      color: rgba(255,255,255,0.55);
      text-align: center;
      padding-bottom: 2px;
      letter-spacing: 0.3px;
    `;
    document.querySelector('.topbar').appendChild(chip);
  }
  chip.textContent = `⏱ ${dias} día${dias !== 1 ? 's' : ''} de prueba restantes`;
}

// Bloqueo total: reemplaza todo el body para que no sea saltable
function mostrarPantallaBloqueo(motivo) {
  const mensajes = {
    vencido: {
      icono:       '⏰',
      titulo:      'Período de prueba vencido',
      descripcion: 'Ya pasaron los 15 días de prueba gratuita.<br>Para seguir usando la app contactá a soporte.'
    },
    bloqueado: {
      icono:       '🔒',
      titulo:      'Acceso bloqueado',
      descripcion: 'Tu acceso a esta app fue suspendido.<br>Contactá a soporte para más información.'
    },
    sin_internet: {
      icono:       '📵',
      titulo:      'Sin conexión',
      descripcion: 'Se necesita conexión a internet la primera vez que usás la app.<br>Conectate e intentá de nuevo.'
    }
  };

  const msg = mensajes[motivo] || mensajes.vencido;

  // Reemplazamos TODO el body — no queda nada del HTML original
  document.body.innerHTML = `
    <div style="
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: #f0f2f5;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 32px 24px;
      text-align: center;
      max-width: 480px;
      margin: 0 auto;
      font-family: Arial, sans-serif;
    ">
      <div style="font-size: 64px; margin-bottom: 20px">${msg.icono}</div>
      <p style="font-size: 20px; font-weight: 700; color: #c0392b; margin-bottom: 12px">
        ${msg.titulo}
      </p>
      <p style="font-size: 14px; color: #666; line-height: 1.7; margin-bottom: 32px">
        ${msg.descripcion}
      </p>
      <button onclick="contactarSoporte()"
        style="display: flex; align-items: center; justify-content: center; gap: 12px;
               padding: 16px 28px; background: #25D366; border: none; border-radius: 14px;
               color: #fff; font-size: 16px; font-weight: 600; cursor: pointer; width: 100%">
        📱 Contactar por WhatsApp
      </button>
    </div>
  `;
}



/* ================================================
   BASE DE DATOS LOCAL
   ================================================ */

const CLAVE_DB = 'gestion_comercio_v3';

let bd                    = cargarBaseDeDatos();
let carritoActual         = [];
let productoEditandoId    = null;
let intervaloEscaneo      = null;
let contadorEscaneo       = 0;
let indiceEscaneoSimulado = 0;
let indiceAutoStock       = 0;
let filtroStockActivo     = 'todos';
let recibeActual           = '';
let gramosActual            = '';
let productoPesandoActual   = null;

function cargarBaseDeDatos() {
  try {
    const datosGuardados = localStorage.getItem(CLAVE_DB);
    if (datosGuardados) return JSON.parse(datosGuardados);
  } catch (error) {
    console.error('Error al cargar la base de datos:', error);
  }

  return {
    productos: [
      { id: 1, nombre: 'Coca Cola 500ml',  categoria: 'Bebidas',   precio: 1200, costo: 800,  stock: 24, stockMin: 5, codigo: '' },
      { id: 2, nombre: 'Galletitas Oreo',  categoria: 'Golosinas', precio: 850,  costo: 550,  stock: 3,  stockMin: 5, codigo: '' },
      { id: 3, nombre: 'Agua mineral 1L',  categoria: 'Bebidas',   precio: 700,  costo: 400,  stock: 18, stockMin: 5, codigo: '' },
      { id: 4, nombre: 'Alfajor Milka',    categoria: 'Golosinas', precio: 600,  costo: 380,  stock: 0,  stockMin: 5, codigo: '' },
    ],
    clientes: [
      { id: 1, nombre: 'María López', tel: '11 4567-8901', nota: '' },
      { id: 2, nombre: 'Juan García', tel: '11 2345-6789', nota: '' },
    ],
    ventas:   [],
    fiado:    {},
    siguienteIdProducto: 5,
    siguienteIdCliente:  3,
    siguienteIdVenta:    1,
    configuracion: {
      nombreNegocio:    'VendoMas',
      fechaInstalacion: new Date().toISOString(),
      licenciaActiva:   false,
      comercioId:       null,
    }
  };
}

function guardarBaseDeDatos() {
  try {
    localStorage.setItem(CLAVE_DB, JSON.stringify(bd));
  } catch (error) {
    console.error('Error al guardar:', error);
    alert('Error al guardar los datos. Verificá que el dispositivo tenga espacio disponible.');
  }
}


/* ================================================
   BÚSQUEDA EN BASES DE DATOS EXTERNAS
   Cascada: Supabase → OpenFoodFacts → UPCitemdb → OpenEAN
   ================================================ */

async function buscarProductoPorCodigo(codigo) {
  let resultado = null;

  resultado = await buscarEnSupabase(codigo);
  if (resultado) return resultado;

  resultado = await buscarEnOpenFoodFacts(codigo);
  if (resultado) return resultado;

  resultado = await buscarEnUPCitemdb(codigo);
  if (resultado) return resultado;

  resultado = await buscarEnOpenEAN(codigo);
  if (resultado) return resultado;

  return null;
}

// Base 1: Supabase (productos argentinos)
async function buscarEnSupabase(codigo) {
  try {
    const codigoPadded = codigo.padStart(13, '0');
    const url = `${SUPABASE_URL}/rest/v1/productos_unificados?ean=eq.${codigoPadded}&select=ean,nombre,marca,cat1,cat2,cat3&limit=1`;
    const r = await fetch(url, {
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json'
      }
    });
    const d = await r.json();
    if (!d || !d.length) return null;
    const p = d[0];
    if (!p.nombre) return null;
    return {
      nombre:    p.nombre,
      marca:     p.marca || '',
      categoria: p.cat1  || 'General',
      codigo:    codigo,
      fuente:    'supabase'
    };
  } catch (e) {
    console.error('Error Supabase:', e);
    return null;
  }
}

// Base 2: Open Food Facts
async function buscarEnOpenFoodFacts(codigo) {
  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${codigo}.json`);
    const d = await r.json();
    if (d.status !== 1 || !d.product) return null;
    const p = d.product;
    const nombre = p.product_name_es || p.product_name;
    if (!nombre) return null;
    return {
      nombre:    nombre,
      categoria: p.categories_tags?.[0]?.replace('en:', '') || 'General',
      marca:     p.brands || '',
      codigo:    codigo,
      fuente:    'openfoodfacts'
    };
  } catch { return null; }
}

// Base 3: UPCitemdb
async function buscarEnUPCitemdb(codigo) {
  try {
    const r = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${codigo}`);
    const d = await r.json();
    if (d.code !== 'OK' || !d.items?.length) return null;
    const item = d.items[0];
    if (!item.title) return null;
    return {
      nombre:    item.title,
      categoria: item.category || 'General',
      marca:     item.brand   || '',
      codigo:    codigo,
      fuente:    'upcitemdb'
    };
  } catch { return null; }
}

// Base 4: Open EAN
async function buscarEnOpenEAN(codigo) {
  try {
    const r = await fetch(`https://opengtindb.org/?ean=${codigo}&cmd=product&lang=es`);
    const text = await r.text();
    const lines = text.split('\n');
    const get = (key) => {
      const line = lines.find(l => l.startsWith(key + '='));
      return line ? line.split('=')[1]?.trim() : null;
    };
    const nombre = get('detailname') || get('name');
    if (!nombre) return null;
    return {
      nombre:    nombre,
      categoria: get('maincategory') || 'General',
      marca:     get('vendor')       || '',
      codigo:    codigo,
      fuente:    'openean'
    };
  } catch { return null; }
}

// Reportar producto desconocido a tabla de pendientes en Supabase
async function reportarCodigoDesconocido(producto) {
  try {
    if (!producto.codigo) return;
    const body = {
      ean:             producto.codigo.padStart(13, '0'),
      nombre_sugerido: producto.nombre,
      marca_sugerida:  producto.marca || '',
      revisado:        false
    };
    await fetch(`${SUPABASE_URL}/rest/v1/productos_pendientes`, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal'
      },
      body: JSON.stringify(body)
    });
    console.log('Código desconocido enviado a revisión:', producto.codigo);
  } catch (e) {
    console.error('Error al reportar código desconocido:', e);
  }
}


/* ================================================
   UTILIDADES GENERALES
   ================================================ */

function formatearMonto(numero) {
  return '$' + parseFloat(numero).toLocaleString('es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatearMontoEntero(numero) {
  return '$' + Math.round(parseFloat(numero) || 0).toLocaleString('es-AR');
}

function formatearFecha(fechaISO) {
  return new Date(fechaISO).toLocaleString('es-AR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function calcularDiasTranscurridos(fechaISO) {
  const inicio     = new Date(fechaISO);
  const ahora      = new Date();
  const diferencia = ahora - inicio;
  return Math.floor(diferencia / (1000 * 60 * 60 * 24));
}

// Calcula cuántos días faltan para el vencimiento (negativo si ya venció)
function calcularDiasHastaVencimiento(fechaVencimiento) {
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const vence = new Date(fechaVencimiento + 'T00:00:00');
  const diferencia = vence - hoy;
  return Math.ceil(diferencia / (1000 * 60 * 60 * 24));
}

// Reproduce el bip usando el archivo de audio
function reproducirBip() {
  try {
    const audio = new Audio('bip.wav');
    audio.volume = 0.8;
    audio.play();
  } catch (error) {
    console.log('Audio no disponible:', error);
  }
}

function mostrarFlashCamara() {
  const flash = document.getElementById('camara-flash');
  if (flash) {
    flash.classList.add('activo');
    setTimeout(() => flash.classList.remove('activo'), 150);
  }
}


/* ================================================
   NAVEGACIÓN
   Controla qué pantalla se muestra y qué ítem
   de la bottom nav queda activo.
   ================================================ */

function irA(pantalla, botonNav) {
  cerrarMenuMas();
  document.querySelectorAll('.pantalla').forEach(p => p.classList.remove('activa'));
  document.getElementById('pantalla-' + pantalla).classList.add('activa');

  document.querySelectorAll('.bottom-nav-item').forEach(i => i.classList.remove('activo'));
  const navEl = document.getElementById('bnav-' + pantalla);
  if (navEl) navEl.classList.add('activo');

  if (pantalla === 'stock') {
    cambiarFiltroStock('todos', document.getElementById('pestana-stock-todos'));
  } else {
           // Limpiamos el buscador de stock al salir
           const buscarStock = document.getElementById('buscar-stock');
           if (buscarStock) buscarStock.value = '';
          }
  if (pantalla === 'historial') renderizarHistorial('hoy');
  if (pantalla === 'resumenes') cargarResumenes('hoy');
  if (pantalla === 'clientes')  renderizarClientes();
  if (pantalla === 'fiado')     renderizarFiado();
  if (pantalla === 'ajustes')   cargarAjustes();
}

/* ------------------------------------------------
   MENÚ "MÁS"
   Abre y cierra el drawer inferior que agrupa
   Clientes, Fiado y Ajustes.
   ------------------------------------------------ */
function abrirMenuMas() {
  document.getElementById('mas-overlay').classList.add('abierto');
}

function cerrarMenuMas() {
  document.getElementById('mas-overlay').classList.remove('abierto');
}


/* ================================================
   NOMBRE DEL NEGOCIO
   ================================================ */

function actualizarNombreNegocio(valor) {
  const nombre = valor.trim() || 'VendoMas';
  bd.configuracion.nombreNegocio = nombre;
  // Solo actualizamos la topbar (ya no existe el menú lateral)
  const topbar = document.getElementById('topbar-titulo');
  if (topbar) topbar.textContent = nombre;
  guardarBaseDeDatos();
}

// Función auxiliar reutilizable — asegura que el módulo esté listo para escanear
async function asegurarModuloEscaneo(BarcodeScanner) {
  try {
    const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
    if (available) return true; // ya está instalado, seguimos normal
  } catch (error) {
    console.warn('No se pudo verificar el módulo de escaneo:', error);
  }
  // No estaba disponible (o no se pudo verificar) → intentamos instalar
  try {
    await BarcodeScanner.installGoogleBarcodeScannerModule();
  } catch (error) {
    const mensaje = (error && error.message) || '';
    // Si el error es "ya está instalado", no es un problema real
    if (!mensaje.toLowerCase().includes('already installed')) {
      alert('No se pudo instalar el módulo de escaneo. Verificá tu conexión a internet.');
      return false;
    }
  }
  alert('Se instaló el módulo de escaneo. Volvé a intentar escanear en unos segundos.');
  return false; // igual frenamos esta vez porque la descarga puede tardar
}


/* ================================================
   PANTALLA: VENTA — CÁMARA
   Usa el escáner nativo de ML Kit sin overlay.
   Se llama recursivamente para escanear múltiples
   productos. El usuario presiona "atrás" para
   volver al carrito.
   ================================================ */

async function pruebaScanner() {
  try {
    const { BarcodeScanner } = Capacitor.Plugins;

    const { camera } = await BarcodeScanner.requestPermissions();
    if (camera !== 'granted' && camera !== 'limited') {
      alert('Necesitás dar permiso de cámara');
      return;
    }

    // ✅ FIX: verificar si el módulo de Google está instalado
    const listo = await asegurarModuloEscaneo(BarcodeScanner);
    if (!listo) return;

    const resultado = await BarcodeScanner.scan({formats: ['EAN_13']});
    if (!resultado.barcodes?.length) return;

    const codigo       = resultado.barcodes[0].rawValue;
    const codigoPadded = codigo.padStart(13, '0');

    const productoLocal = bd.productos.find(p =>
      p.codigo === codigo || p.codigo === codigoPadded
    );

    if (productoLocal) {
      agregarAlCarrito(productoLocal);
      reproducirBip();

    } else {
      const irAStock = confirm(
        '⚠️ Este producto no está en tu inventario.\n\n' +
        '¿Querés cargarlo ahora en Stock?'
      );

      if (irAStock) {
        abrirNuevoProducto();
        document.getElementById('prod-codigo').value        = codigo;
        document.getElementById('prod-nombre').value        = '🔍 Buscando...';
        document.getElementById('badge-auto').style.display = 'none';

        const encontrado = await buscarProductoPorCodigo(codigo);
        if (encontrado && encontrado.nombre) {
          const nombreCompleto = encontrado.marca
            ? `${encontrado.marca} - ${encontrado.nombre}`
            : encontrado.nombre;
          document.getElementById('prod-nombre').value        = nombreCompleto;
          document.getElementById('prod-categoria').value     = encontrado.categoria;
          document.getElementById('badge-auto').style.display = 'block';
        } else {
          document.getElementById('prod-nombre').value = '';
          alert('No se encontró el nombre. Completá manualmente.');
        }

        // Navegamos a Stock usando la bottom nav
        document.querySelectorAll('.pantalla').forEach(p => p.classList.remove('activa'));
        document.getElementById('pantalla-stock').classList.add('activa');
        document.querySelectorAll('.bottom-nav-item').forEach(i => i.classList.remove('activo'));
        const navStock = document.getElementById('bnav-stock');
        if (navStock) navStock.classList.add('activo');
        return;
      }
    }

    // Seguimos escaneando recursivamente
    pruebaScanner();

  } catch (error) {
    // El usuario presionó "atrás": navegamos a la pantalla de venta
    document.querySelectorAll('.pantalla').forEach(p => p.classList.remove('activa'));
    document.getElementById('pantalla-venta').classList.add('activa');
    document.querySelectorAll('.bottom-nav-item').forEach(i => i.classList.remove('activo'));
    const navVenta = document.getElementById('bnav-venta');
    if (navVenta) navVenta.classList.add('activo');
    renderizarCarrito();
  }
}


/* ================================================
   PANTALLA: VENTA — CARRITO
   ================================================ */

function agregarAlCarrito(producto) {
  const itemExistente = carritoActual.find(item => item.id === producto.id);
  if (itemExistente) {
    itemExistente.cantidad++;
  } else {
    carritoActual.push({
      id:       producto.id,
      nombre:   producto.nombre,
      precio:   producto.precio,
      cantidad: 1,
      libre:    producto.libre || false
    });
  }
  renderizarCarrito();
}

function cambiarCantidadCarrito(productoId, cambio) {
  const item = carritoActual.find(i => i.id === productoId);
  if (!item) return;
  item.cantidad += cambio;
  if (item.cantidad <= 0) {
    carritoActual = carritoActual.filter(i => i.id !== productoId);
  }
  renderizarCarrito();
}

function quitarDelCarrito(itemId) {
  carritoActual = carritoActual.filter(i => i.id !== itemId);
  renderizarCarrito();
}

function renderizarCarrito() {
  const contenedor  = document.getElementById('carrito-contenedor');
  const zonaEscaneo = document.getElementById('zona-escaneo');
  const lista       = document.getElementById('carrito-lista');
  const contador    = document.getElementById('carrito-contador');
  const totalMonto  = document.getElementById('total-monto');

  if (carritoActual.length === 0) {
    contenedor.classList.remove('visible');
    zonaEscaneo.classList.remove('mini');
    return;
  }

  contenedor.classList.add('visible');
  zonaEscaneo.classList.add('mini');

  const totalItems = carritoActual.reduce((suma, item) => suma + item.cantidad, 0);
  const totalPesos = carritoActual.reduce((suma, item) => suma + item.precio * item.cantidad, 0);

  contador.textContent   = `${totalItems} producto${totalItems !== 1 ? 's' : ''}`;
  totalMonto.textContent = formatearMonto(totalPesos);

  lista.innerHTML = carritoActual.map(item => {
    const controlesCantidad = item.esPorPeso
      ? `<button class="btn-cantidad" onclick="quitarDelCarrito(${item.id})">🗑</button>`
      : `
        <button class="btn-cantidad" onclick="cambiarCantidadCarrito(${item.id}, -1)">−</button>
        <span class="carrito-item-qty">${item.cantidad}</span>
        <button class="btn-cantidad btn-cantidad-mas" onclick="cambiarCantidadCarrito(${item.id}, 1)">+</button>
      `;

    return `
      <div class="carrito-item">
        <span class="carrito-item-nombre">${item.nombre}</span>
        <div class="carrito-cantidad">
          ${controlesCantidad}
        </div>
        <span class="carrito-item-subtotal">${formatearMonto(item.precio * item.cantidad)}</span>
      </div>
    `;
  }).join('');
}

function cancelarVenta() {
  if (carritoActual.length > 0 && !confirm('¿Cancelar la venta actual?')) return;
  carritoActual = [];
  renderizarCarrito();
}

function cobrarVenta() {
  if (carritoActual.length === 0) {
    alert('Agregá productos antes de cobrar');
    return;
  }

  const total = carritoActual.reduce((s, i) => s + i.precio * i.cantidad, 0);
  document.getElementById('modal-total').textContent = formatearMontoEntero(total);

  // Reseteamos el modal de cobro
  ['transferencia','efectivo','fiado'].forEach(t => {
    document.getElementById('btnpago-' + t).classList.remove('activo');
  });
  document.getElementById('bloque-efectivo-modal').style.display = 'none';
  document.getElementById('bloque-fiado-modal').style.display    = 'none';
  document.getElementById('selector-pago-abierto').style.display   = 'block';   // ← nueva
  document.getElementById('selector-pago-compacto').style.display  = 'none';    // ← nueva
  recibeActual = '';
  document.getElementById('pantalla-recibe').textContent = '$0';
  document.getElementById('monto-vuelto').textContent    = '$0';

  abrirModal('modal-cobro');
}

// Selecciona la forma de pago y muestra el bloque correspondiente
function seleccionarPago(tipo) {
  ['transferencia','efectivo','fiado'].forEach(t => {
    document.getElementById('btnpago-' + t).classList.remove('activo');
  });
  document.getElementById('btnpago-' + tipo).classList.add('activo');

  document.getElementById('bloque-efectivo-modal').style.display = tipo === 'efectivo' ? 'block' : 'none';
  document.getElementById('bloque-fiado-modal').style.display    = tipo === 'fiado'    ? 'block' : 'none';

  // Colapsamos los 3 botones grandes en el chip compacto
  const iconos = { fiado: '🤝', efectivo: '💵', transferencia: '📲' };
  const labels = { fiado: 'Fiado', efectivo: 'Efectivo', transferencia: 'Transferencia' };
  document.getElementById('chip-pago-icono').textContent = iconos[tipo];
  document.getElementById('chip-pago-label').textContent = labels[tipo];
  document.getElementById('selector-pago-abierto').style.display  = 'none';
  document.getElementById('selector-pago-compacto').style.display = 'flex';

  if (tipo === 'efectivo') {
    recibeActual = '';
    document.getElementById('pantalla-recibe').textContent = '$0';
    document.getElementById('monto-vuelto').textContent    = '$0';
  }

  // Si es fiado cargamos los clientes
  if (tipo === 'fiado') {
    const select = document.getElementById('cobro-cliente');
    select.innerHTML = '<option value="">— Seleccioná un cliente —</option>';
    bd.clientes.forEach(c => {
      select.innerHTML += `<option value="${c.id}">${c.nombre}</option>`;
    });
  }
}

// Abre la pantalla de pesada para un producto que se vende por kg
function abrirPantallaPesada(producto) {
  productoPesandoActual = producto;
  gramosActual = '';

  document.getElementById('pesada-titulo').textContent    = producto.nombre;
  document.getElementById('pesada-precio-kg').textContent = formatearMontoEntero(producto.precio);
  document.getElementById('pesada-gramos-display').textContent = '0 gr';
  document.getElementById('pesada-subtotal').textContent  = '$0';

  document.getElementById('pantalla-pesada').classList.add('abierto');
}

function cerrarPantallaPesada() {
  document.getElementById('pantalla-pesada').classList.remove('abierto');
  productoPesandoActual = null;
}

// Teclado numérico de la pantalla de pesada
function tocarTeclaGramos(valor) {
  if (gramosActual === '0') gramosActual = '';
  gramosActual += valor;
  if (gramosActual.length > 5) gramosActual = gramosActual.slice(0, 5);
  actualizarPantallaPesada();
}

function borrarTeclaGramos() {
  gramosActual = gramosActual.slice(0, -1);
  actualizarPantallaPesada();
}

function setGramosRapido(gramos) {
  gramosActual = String(gramos);
  actualizarPantallaPesada();
}

function actualizarPantallaPesada() {
  const gramos = parseInt(gramosActual || '0', 10);
  document.getElementById('pesada-gramos-display').textContent = gramos.toLocaleString('es-AR') + ' gr';

  if (productoPesandoActual) {
    const subtotal = productoPesandoActual.precio * (gramos / 1000);
    document.getElementById('pesada-subtotal').textContent = formatearMontoEntero(subtotal);
  }
}

// Confirma el peso cargado y agrega el ítem al carrito
function agregarPesadoAlCarrito() {
  const gramos = parseInt(gramosActual || '0', 10);

  if (gramos <= 0) {
    alert('Ingresá cuántos gramos vendiste');
    return;
  }

  const producto = productoPesandoActual;
  const subtotal = producto.precio * (gramos / 1000);

  carritoActual.push({
    id:        Date.now() + Math.random(), // id único, no se agrupa con otras pesadas
    nombre:    `${producto.nombre} (${gramos.toLocaleString('es-AR')}gr)`,
    precio:    subtotal,
    cantidad:  1,
    libre:     false,
    productoOrigenId: producto.id,
    esPorPeso: true,
    gramos:    gramos
  });

  renderizarCarrito();
  cerrarPantallaPesada();
  cerrarBusqueda();
}

// Vuelve a mostrar los 3 botones de pago si el usuario quiere cambiar la selección
function cambiarFormaPago() {
  document.getElementById('selector-pago-abierto').style.display  = 'block';
  document.getElementById('selector-pago-compacto').style.display = 'none';
}

// Muestra la pantalla grande de confirmación al terminar una venta
function mostrarConfirmacionVenta(total, vuelto) {
  document.getElementById('confirmacion-total').textContent = formatearMontoEntero(total);

  const bloqueVuelto = document.getElementById('confirmacion-bloque-vuelto');
  if (vuelto > 0) {
    document.getElementById('confirmacion-vuelto').textContent = formatearMontoEntero(vuelto);
    bloqueVuelto.style.display = 'block';
  } else {
    bloqueVuelto.style.display = 'none';
  }

  document.getElementById('pantalla-confirmacion-venta').classList.add('abierta');
}

function cerrarConfirmacionVenta() {
  document.getElementById('pantalla-confirmacion-venta').classList.remove('abierta');
}

// Teclado numérico grande del modal de cobro
function tocarTecla(valor) {
  if (recibeActual === '0') recibeActual = '';
  recibeActual += valor;
  if (recibeActual.length > 9) recibeActual = recibeActual.slice(0, 9);
  actualizarPantallaRecibe();
}

function borrarTecla() {
  recibeActual = recibeActual.slice(0, -1);
  actualizarPantallaRecibe();
}

function setMontoRapido(monto) {
  recibeActual = String(monto);
  actualizarPantallaRecibe();
}

function actualizarPantallaRecibe() {
  const monto = parseInt(recibeActual || '0', 10);
  document.getElementById('pantalla-recibe').textContent = formatearMontoEntero(monto);

  const total  = carritoActual.reduce((s, i) => s + i.precio * i.cantidad, 0);
  const vuelto = Math.max(0, monto - total);
  document.getElementById('monto-vuelto').textContent = formatearMontoEntero(vuelto);
}


/* ================================================
   SINCRONIZACIÓN CON SUPABASE — VENTAS
   Se ejecuta en segundo plano, sin bloquear la UI.
   Si falla (sin internet), no afecta el guardado local.
   ================================================ */

async function sincronizarVenta(venta) {
  const comercioId = bd.configuracion.comercioId;
  if (!comercioId) return;

  try {
    await fetch(`${SUPABASE_URL}/rest/v1/ventas`, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        comercio_id:    comercioId,
        cliente_nombre: venta.clienteNombre,
        total:          venta.total,
        pago:           venta.pago,
        items:          venta.items,
        fecha:          venta.fecha
      })
    });
  } catch (error) {
    console.error('No se pudo sincronizar la venta (se guardó local igual):', error);
  }
}

function confirmarCobro() {
  const botonActivo = document.querySelector('.btn-pago-grande.activo');
  if (!botonActivo) { alert('Seleccioná una forma de pago'); return; }
  const pago      = botonActivo.id.replace('btnpago-', '');
  const clienteId = document.getElementById('cobro-cliente').value;
  const cliente   = clienteId ? bd.clientes.find(c => c.id == clienteId) : null;

  if (pago === 'fiado' && !clienteId) {
    alert('Para venta fiada seleccioná un cliente');
    return;
  }

  const total = carritoActual.reduce((s, i) => s + i.precio * i.cantidad, 0);

  // Si es efectivo y no se tocó el teclado (o quedó en 0), asumimos pago exacto
  if (pago === 'efectivo') {
    const recibido = parseInt(recibeActual || '0', 10);
    if (recibido < total) {
      recibeActual = String(total);
      actualizarPantallaRecibe();
    }
  }

  carritoActual.forEach(item => {
    if (item.esPorPeso) {
      // Para productos por peso, descontamos los kg reales del producto de origen
      const producto = bd.productos.find(p => p.id === item.productoOrigenId);
      if (producto) {
        producto.stock = Math.max(0, producto.stock - (item.gramos / 1000));
      }
    } else {
      const producto = bd.productos.find(p => p.id === item.id);
      if (producto && !item.libre) {
        producto.stock = Math.max(0, producto.stock - item.cantidad);
      }
    }
  });

  const nuevaVenta = {
    id:            bd.siguienteIdVenta++,
    fecha:         new Date().toISOString(),
    items:         [...carritoActual],
    total:         total,
    pago:          pago,
    clienteId:     clienteId || null,
    clienteNombre: cliente ? cliente.nombre : '—'
  };
  bd.ventas.unshift(nuevaVenta);

  if (pago === 'fiado') {
    if (!bd.fiado[clienteId]) {
      bd.fiado[clienteId] = { deuda: 0, movimientos: [] };
    }
    bd.fiado[clienteId].deuda += total;
    bd.fiado[clienteId].movimientos.unshift({
      tipo:    'compra',
      monto:   total,
      fecha:   nuevaVenta.fecha,
      ventaId: nuevaVenta.id
    });
  }

  const vuelto = pago === 'efectivo'
    ? Math.max(0, parseInt(recibeActual || '0', 10) - total)
    : 0;

  guardarBaseDeDatos();
  sincronizarVenta(nuevaVenta);
  carritoActual = [];
  renderizarCarrito();
  cerrarModal('modal-cobro');
  mostrarConfirmacionVenta(total, vuelto);
}


/* ================================================
   BÚSQUEDA POR NOMBRE
   Alternativa al escaneo para agregar productos.
   ================================================ */

function abrirBusqueda() {
  document.getElementById('busqueda-overlay').classList.add('abierta');
  filtrarBusqueda('');
  setTimeout(() => document.getElementById('busqueda-input').focus(), 100);
}

function cerrarBusqueda() {
  document.getElementById('busqueda-overlay').classList.remove('abierta');
  document.getElementById('busqueda-input').value = '';
}

function filtrarBusqueda(consulta) {
  const contenedor = document.getElementById('busqueda-resultados');
  const texto      = consulta.toLowerCase().trim();

  const resultados = bd.productos.filter(p =>
    p.nombre.toLowerCase().includes(texto) ||
    p.categoria.toLowerCase().includes(texto)
  );

  if (resultados.length === 0) {
    contenedor.innerHTML = '<div class="estado-vacio">No se encontraron productos</div>';
    return;
  }

  contenedor.innerHTML = resultados.map(p => {
    const precioTexto = p.vendePorPeso ? `${formatearMonto(p.precio)}/kg` : formatearMonto(p.precio);
    const accionBoton  = p.vendePorPeso
      ? `abrirPantallaPesada({id:${p.id},nombre:'${p.nombre}',precio:${p.precio}})`
      : `agregarAlCarrito({id:${p.id},nombre:'${p.nombre}',precio:${p.precio}});cerrarBusqueda()`;

    return `
      <div class="resultado-item">
        <div>
          <div class="resultado-nombre">${p.nombre}</div>
          <div style="font-size:11px;color:var(--texto-secundario)">${p.categoria}</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="resultado-precio">${precioTexto}</span>
          <button class="btn-agregar-redondo" onclick="${accionBoton}">
            ${p.vendePorPeso ? '⚖️' : '+'}
          </button>
        </div>
      </div>
    `;
  }).join('');
}


/* ================================================
   PANTALLA: STOCK / INVENTARIO
   Con esto: entrás a Stock y ves todo (alfabético), 
   tocás "Por vencer" y te ordena por fecha más próxima primero, 
   tocás "Poco stock" y junta sin-stock + stock bajo ordenado de menor a 
   mayor cantidad — y el buscador funciona como filtro extra dentro de cualquiera de las tres pestañas.
   ================================================ */

function renderizarStock() {
  const contenedor  = document.getElementById('lista-stock');
  const textoBuscar = document.getElementById('buscar-stock').value.toLowerCase().trim();

  // Contadores de las pestañas (sobre el total, sin importar lo que esté escrito en el buscador)
  const totalPorVencer = bd.productos.filter(p =>
    p.vencimiento && calcularDiasHastaVencimiento(p.vencimiento) <= 15
  ).length;
  const totalPocoStock = bd.productos.filter(p => p.stock <= p.stockMin).length;

  const contadorVencer    = document.getElementById('contador-vencer');
  const contadorPocoStock = document.getElementById('contador-pocostock');
  if (contadorVencer)    contadorVencer.textContent    = totalPorVencer;
  if (contadorPocoStock) contadorPocoStock.textContent = totalPocoStock;

  // Filtramos según la pestaña activa
  let productos = bd.productos.filter(p => {
    if (filtroStockActivo === 'vencer')    return p.vencimiento && calcularDiasHastaVencimiento(p.vencimiento) <= 15;
    if (filtroStockActivo === 'pocostock') return p.stock <= p.stockMin;
    if (filtroStockActivo === 'todos' && !textoBuscar) return false; // oculta lista si no hay búsqueda
    return true;
  });

  // Filtramos además por lo que esté escrito en el buscador, si hay algo
  if (textoBuscar) {
    productos = productos.filter(p =>
      p.nombre.toLowerCase().includes(textoBuscar) ||
      p.categoria.toLowerCase().includes(textoBuscar) ||
      (p.codigo && p.codigo.includes(textoBuscar))
    );
  }

  // Ordenamos según la pestaña activa
  if (filtroStockActivo === 'vencer') {
    productos = productos.slice().sort((a, b) =>
      calcularDiasHastaVencimiento(a.vencimiento) - calcularDiasHastaVencimiento(b.vencimiento)
    );
  } else if (filtroStockActivo === 'pocostock') {
    productos = productos.slice().sort((a, b) => a.stock - b.stock);
  } else {
    productos = productos.slice().sort((a, b) => a.nombre.localeCompare(b.nombre));
  }

  if (productos.length === 0) {
    const mensajeVacio = filtroStockActivo === 'vencer'    ? 'No hay productos por vencer' :
                         filtroStockActivo === 'pocostock' ? 'No hay productos con poco stock' :
                         filtroStockActivo === 'todos' && !textoBuscar ? '' :
                         'No se encontraron productos';
    contenedor.innerHTML = mensajeVacio ? `<div class="estado-vacio">${mensajeVacio}</div>` : '';
    return;
  }

  contenedor.innerHTML = productos.map(p => {
    const claseStock = p.stock <= 0          ? 'sin-stock'    :
                       p.stock <= p.stockMin ? 'alerta-stock' : '';
    const textoStock = p.stock <= 0          ? 'Sin stock'    :
                       p.stock <= p.stockMin ? `Stock bajo: ${p.stock} uds` :
                       `Stock: ${p.stock} uds`;
    const margen = p.costo > 0
      ? ` · Margen: ${Math.round((p.precio - p.costo) / p.costo * 100)}%`
      : '';

    let infoVencimiento = '';
    if (p.vencimiento) {
      const diasParaVencer  = calcularDiasHastaVencimiento(p.vencimiento);
      const claseVencimiento = diasParaVencer <= 15 ? 'sin-stock' : '';
      const fechaFormateada  = new Date(p.vencimiento + 'T00:00:00')
        .toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const textoVencimiento = diasParaVencer < 0
        ? `Vencido el ${fechaFormateada}`
        : `Vence el ${fechaFormateada}`;
      infoVencimiento = `<div class="prod-info-sub ${claseVencimiento}">${textoVencimiento}</div>`;
    }

    return `
      <div class="fila-producto">
        <div>
          <div class="prod-info-nombre">${p.nombre}</div>
          <div class="prod-info-sub ${claseStock}">
            ${textoStock} · ${formatearMonto(p.precio)}${margen}
          </div>
          ${infoVencimiento}
        </div>
        <button class="btn-editar" onclick="editarProducto(${p.id})">Editar</button>
      </div>
    `;
  }).join('');
}

function filtrarStock() {
  renderizarStock();
}

function cambiarFiltroStock(filtro, pestana) {
  filtroStockActivo = filtro;
  document.querySelectorAll('#pantalla-stock .pestana').forEach(p => p.classList.remove('activa'));
  if (pestana) pestana.classList.add('activa');
  renderizarStock();
}

function abrirNuevoProducto() {
  productoEditandoId = null;

  document.getElementById('form-prod-titulo').textContent   = 'Agregar producto';
  document.getElementById('prod-nombre').value              = '';
  document.getElementById('prod-categoria').value           = '';
  document.getElementById('prod-precio').value              = '';
  document.getElementById('prod-costo').value               = '';
  document.getElementById('prod-vencimiento').value          = '';   // Fecha de vencimiento 
  document.getElementById('prod-stock').value               = '0';
  document.getElementById('prod-stock-display').textContent = '0';
  document.getElementById('prod-stock-min').value           = '5';
  document.getElementById('prod-codigo').value              = '';
  document.getElementById('badge-auto').style.display       = 'none';
  document.getElementById('prod-vende-peso').checked = false;
  toggleVendePorPeso();
  document.getElementById('form-nuevo-producto').classList.add('abierto');
  document.getElementById('btn-eliminar-producto').style.display = 'none';

  // ✅ OCULTAR BOTTOM NAV
  document.querySelector('.bottom-nav').style.display = 'none';
}

// Cambia las etiquetas del formulario según si el producto se vende por peso
function toggleVendePorPeso() {
  const marcado = document.getElementById('prod-vende-peso').checked;

  document.getElementById('wrap-vende-peso').classList.toggle('activo', marcado);

  document.getElementById('label-prod-precio').textContent = marcado ? 'PRECIO POR KG' : 'PRECIO VENTA';
  document.getElementById('label-prod-costo').textContent  = marcado ? 'COSTO POR KG'  : 'COSTO';
  document.getElementById('label-prod-stock').textContent  = marcado ? 'STOCK (EN KG)' : 'CANTIDAD DE STOCK';
}

// Controla el contador + / - de stock en el formulario
function cambiarStockFormulario(cambio) {
  const actual = parseInt(document.getElementById('prod-stock').value) || 0;
  const nuevo  = Math.max(0, actual + cambio);
  document.getElementById('prod-stock').value               = nuevo;
  document.getElementById('prod-stock-display').textContent = nuevo;
}

// Permite editar el stock tocando el número directamente
function editarStockManual() {
  const display = document.getElementById('prod-stock-display');
  const valorActual = document.getElementById('prod-stock').value || '0';

  // Reemplazamos el span por un input temporal
  display.outerHTML = `
    <input id="prod-stock-input-manual" type="number" step="any"
      value="${valorActual}"
      style="font-size:22px;font-weight:700;color:var(--texto);width:80px;text-align:center;border:none;border-bottom:2px solid var(--azul);background:transparent;outline:none"
      onblur="confirmarStockManual(this.value)"
      onkeydown="if(event.key==='Enter') this.blur()"/>
  `;

  // Enfocamos el input automáticamente
  setTimeout(() => {
    const input = document.getElementById('prod-stock-input-manual');
    if (input) { input.focus(); input.select(); }
  }, 50);
}

// Confirma el valor ingresado y vuelve al span
function confirmarStockManual(valor) {
  const esPorPeso = document.getElementById('prod-vende-peso').checked;
  const nuevo = Math.max(0, parseFloat(valor) || 0);
  document.getElementById('prod-stock').value = esPorPeso ? nuevo : Math.round(nuevo);

  // Reemplazamos el input de vuelta por el span
  const inputEl = document.getElementById('prod-stock-input-manual');
  if (inputEl) {
    inputEl.outerHTML = `
      <span id="prod-stock-display"
        onclick="editarStockManual()"
        style="font-size:22px;font-weight:700;color:var(--texto);cursor:pointer;text-decoration:underline dotted;min-width:40px;text-align:center">
        ${nuevo}
      </span>
    `;
  }
}

function editarProducto(id) {
  const producto = bd.productos.find(p => p.id === id);
  if (!producto) return;

  productoEditandoId = id;
  document.getElementById('form-prod-titulo').textContent   = 'Editar producto';
  document.getElementById('prod-nombre').value              = producto.nombre;
  document.getElementById('prod-categoria').value           = producto.categoria;
  document.getElementById('prod-precio').value              = producto.precio;
  document.getElementById('prod-costo').value               = producto.costo || '';
  document.getElementById('prod-vencimiento').value          = producto.vencimiento || '';
  document.getElementById('prod-stock').value               = producto.stock;
  document.getElementById('prod-stock-display').textContent = producto.stock;
  document.getElementById('prod-stock-min').value           = producto.stockMin;
  document.getElementById('prod-codigo').value              = producto.codigo || '';
  document.getElementById('badge-auto').style.display       = 'none';
  document.getElementById('prod-vende-peso').checked = producto.vendePorPeso || false;
  toggleVendePorPeso();  document.getElementById('form-nuevo-producto').classList.add('abierto');
  document.getElementById('btn-eliminar-producto').style.display = 'flex';
}

function cerrarNuevoProducto() {
  document.getElementById('form-nuevo-producto').classList.remove('abierto');

  // ✅ VOLVER A MOSTRAR BOTTOM NAV
  document.querySelector('.bottom-nav').style.display = 'flex';
}

/* ================================================
   SINCRONIZACIÓN CON SUPABASE — PRODUCTOS
   Se ejecuta en segundo plano, sin bloquear la UI.
   Si falla (sin internet), no afecta el guardado local.
   ================================================ */

async function sincronizarProducto(producto) {
  const comercioId = bd.configuracion.comercioId;
  if (!comercioId) return; // todavía no se obtuvo el UUID, no hay con qué sincronizar

  try {
    await fetch(`${SUPABASE_URL}/rest/v1/productos?on_conflict=comercio_id,codigo`, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        comercio_id:  comercioId,
        codigo:       producto.codigo || null,
        nombre:       producto.nombre,
        precio:       producto.precio,
        costo:        producto.costo,
        stock:        producto.stock,
        stock_min:    producto.stockMin,
        vencimiento:  producto.vencimiento || null
      })
    });
  } catch (error) {
    console.error('No se pudo sincronizar el producto (se guardó local igual):', error);
  }
}

async function eliminarProductoSupabase(codigo) {
  const comercioId = bd.configuracion.comercioId;
  if (!comercioId || !codigo) return;

  try {
    await fetch(`${SUPABASE_URL}/rest/v1/productos?comercio_id=eq.${comercioId}&codigo=eq.${codigo}`, {
      method: 'DELETE',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    });
  } catch (error) {
    console.error('No se pudo eliminar de Supabase (se eliminó local igual):', error);
  }
}

// Guarda el producto local y lo reporta a Supabase si es nuevo
async function guardarProducto() {
  const nombre = document.getElementById('prod-nombre').value.trim();
  if (!nombre) { alert('Ingresá el nombre del producto'); return; }

  const precio = parseFloat(document.getElementById('prod-precio').value);
  if (!precio || precio <= 0) { alert('Ingresá un precio válido'); return; }

  const datos = {
    nombre:    nombre,
    categoria: document.getElementById('prod-categoria').value.trim() || 'General',
    precio:    precio,
    costo:     parseFloat(document.getElementById('prod-costo').value)   || 0,
    stock:     parseFloat(document.getElementById('prod-stock').value)   || 0,
    stockMin:  parseInt(document.getElementById('prod-stock-min').value) || STOCK_MINIMO_DEFAULT,
    codigo:    document.getElementById('prod-codigo').value.trim(),
    vencimiento: document.getElementById('prod-vencimiento').value,
    vendePorPeso: document.getElementById('prod-vende-peso').checked
  };

  if (productoEditandoId) {
    const producto = bd.productos.find(p => p.id === productoEditandoId);
    const precioAnterior = producto.precio;
    Object.assign(producto, datos);
    ajustarDeudaFiadoPorCambioPrecio(producto.id, precioAnterior, datos.precio);
  } else {
    bd.productos.push({ id: bd.siguienteIdProducto++, ...datos });
    if (datos.codigo) {
      const yaExiste = await buscarEnSupabase(datos.codigo);
      if (!yaExiste) {
        await reportarCodigoDesconocido(datos);
      }
    }
  }

  guardarBaseDeDatos();
  sincronizarProducto(datos.codigo ? datos : { ...datos });
  cerrarNuevoProducto();
  renderizarStock();
}

//Funcion Eliminar Producto

function eliminarProducto() {
  if (!productoEditandoId) return;

  const producto = bd.productos.find(p => p.id === productoEditandoId);
  if (!producto) return;

  const confirmar = confirm(`¿Eliminar "${producto.nombre}" del inventario?`);
  if (!confirmar) return;

  bd.productos = bd.productos.filter(p => p.id !== productoEditandoId);
  guardarBaseDeDatos();
  if (producto.codigo) eliminarProductoSupabase(producto.codigo);
  cerrarNuevoProducto();
  renderizarStock();
}


// Escáner para el formulario de Stock
async function escanearParaStock() {
  try {
    const { BarcodeScanner } = Capacitor.Plugins;
    const { camera } = await BarcodeScanner.requestPermissions();
    if (camera !== 'granted' && camera !== 'limited') {
      alert('Necesitás dar permiso de cámara');
      return;
    }

    // ✅ FIX: verificar si el módulo de Google está instalado
    const listo = await asegurarModuloEscaneo(BarcodeScanner);
    if (!listo) return;

    const resultado = await BarcodeScanner.scan({formats: ['EAN_13']});

    let codigo = null;
    if (resultado?.barcodes?.length) {
      codigo = resultado.barcodes[0].rawValue;
    } else if (resultado?.hasContent) {
      codigo = resultado.content;
    } else if (typeof resultado === 'string') {
      codigo = resultado;
    }

    if (!codigo) return;

    reproducirBip();
    document.getElementById('prod-nombre').value        = '🔍 Buscando...';
    document.getElementById('badge-auto').style.display = 'none';

    const encontrado = await buscarProductoPorCodigo(codigo);

    if (encontrado && encontrado.nombre) {
      // Solo agregamos la marca si no está ya incluida en el nombre
      const nombreYaTieneMarca = encontrado.marca &&
      encontrado.nombre.toLowerCase().includes(encontrado.marca.toLowerCase());
      const nombreCompleto = (encontrado.marca && !nombreYaTieneMarca)
      ? `${encontrado.marca} ${encontrado.nombre}`
  : encontrado.nombre;
      document.getElementById('prod-nombre').value        = nombreCompleto;
      document.getElementById('prod-categoria').value     = encontrado.categoria;
      document.getElementById('prod-codigo').value        = codigo;
      document.getElementById('badge-auto').style.display = 'block';
    } else {
      document.getElementById('prod-nombre').value = '';
      document.getElementById('prod-codigo').value = codigo;
      alert('No se encontró el producto en internet.\nEl código fue cargado. Completá el nombre manualmente.');
    }

  } catch (error) {
    document.getElementById('prod-nombre').value = '';
    alert('Error al escanear: ' + error.message);
  }
}


/* ================================================
   PANTALLA: HISTORIAL
   ================================================ */

function renderizarHistorial(periodo) {
  const contenedor = document.getElementById('lista-historial');
  const ahora      = new Date();

  const ventasFiltradas = bd.ventas.filter(v => {
    const fechaVenta = new Date(v.fecha);
    if (periodo === 'hoy')    return fechaVenta.toDateString() === ahora.toDateString();
    if (periodo === 'semana') { const limite = new Date(ahora); limite.setDate(ahora.getDate()-7); return fechaVenta >= limite; }
    if (periodo === 'mes')    return fechaVenta.getMonth() === ahora.getMonth() && fechaVenta.getFullYear() === ahora.getFullYear();
    return true;
  });

  if (ventasFiltradas.length === 0) {
    contenedor.innerHTML = '<div class="estado-vacio">No hay ventas en este período</div>';
    return;
  }

  contenedor.innerHTML = ventasFiltradas.map(v => {
    const itemsHTML = v.items.map(item => `
      <div class="historial-detalle-item">
        <span class="historial-detalle-nombre">${item.nombre}</span>
        <span class="historial-detalle-cant">x${item.cantidad}</span>
        <span class="historial-detalle-subtotal">${formatearMonto(item.precio * item.cantidad)}</span>
      </div>
    `).join('');

    return `
      <div class="historial-venta" id="venta-${v.id}">
        <div class="historial-header" onclick="toggleVenta(${v.id})">
          <div class="historial-izq">
            <div class="venta-info-titulo">#${v.id} — ${v.clienteNombre}</div>
            <div class="venta-info-sub">
              ${formatearFecha(v.fecha)} ·
              <span class="badge-pago badge-${v.pago}">${v.pago}</span>
            </div>
          </div>
          <div class="historial-der">
            <span class="venta-monto">${formatearMonto(v.total)}</span>
            <span class="historial-chevron" id="chevron-${v.id}">▼</span>
          </div>
        </div>
        <div class="historial-detalle" id="detalle-${v.id}" style="display:none">
          <div class="historial-detalle-titulo">Productos</div>
          ${itemsHTML}
        </div>
      </div>
    `;
  }).join('');
}

function filtrarHistorial(periodo, elemento) {
  document.querySelectorAll('#pantalla-historial .pestana').forEach(p => p.classList.remove('activa'));
  elemento.classList.add('activa');
  renderizarHistorial(periodo);
}

function toggleVenta(id) {
  const detalle = document.getElementById('detalle-' + id);
  const chevron = document.getElementById('chevron-' + id);
  const abierto = detalle.style.display !== 'none';
  detalle.style.display = abierto ? 'none' : 'block';
  chevron.style.transform = abierto ? 'rotate(0deg)' : 'rotate(180deg)';
}


/* ================================================
   PANTALLA: RESÚMENES / DASHBOARD
   Pantalla principal con diseño de dashboard.
   ================================================ */

function cargarResumenes(periodo, pestana) {
  if (pestana) {
    document.querySelectorAll('#pantalla-resumenes .pestana').forEach(p => p.classList.remove('activa'));
    pestana.classList.add('activa');
  }

  const ahora = new Date();
  const ventas = bd.ventas.filter(v => {
    const fecha = new Date(v.fecha);
    if (periodo === 'hoy')    return fecha.toDateString() === ahora.toDateString();
    if (periodo === 'semana') { const l = new Date(ahora); l.setDate(ahora.getDate()-7); return fecha >= l; }
    if (periodo === 'mes')    return fecha.getMonth() === ahora.getMonth() && fecha.getFullYear() === ahora.getFullYear();
    return true;
  });

  const totalVentas      = ventas.length;
  const totalFacturado   = ventas.reduce((s, v) => s + v.total, 0);
  const ticketPromedio   = totalVentas > 0 ? totalFacturado / totalVentas : 0;
  const gananciaEstimada = ventas.reduce((s, v) =>
    s + v.items.reduce((ss, item) => {
      const producto = bd.productos.find(p => p.id === item.id);
      const ganancia = producto ? (item.precio - (producto.costo || 0)) * item.cantidad : 0;
      return ss + ganancia;
    }, 0), 0);

  const fechaHoy = ahora.toLocaleDateString('es-AR', {
    weekday: 'long', day: 'numeric', month: 'short'
  });

  // Tarjeta principal + mini KPIs
  document.getElementById('grilla-kpi').innerHTML = `
    <p style="font-size:12px;color:var(--texto-secundario);margin:0 0 4px;text-transform:capitalize">${fechaHoy}</p>
    <p class="titulo-pantalla" style="margin-bottom:14px">Resumen del día</p>

    <div class="dashboard-card-principal">
      <p class="dashboard-label">Total vendido</p>
      <p class="dashboard-monto">${formatearMonto(totalFacturado)}</p>
      <p class="dashboard-sub">${totalVentas} venta${totalVentas !== 1 ? 's' : ''} realizadas</p>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">
  <div class="dashboard-mini-card">
    <p class="dashboard-label">Ganancia est.</p>
    <p class="dashboard-valor" style="color:var(--verde);font-size:18px">${formatearMonto(gananciaEstimada)}</p>
  </div>
  <div class="dashboard-mini-card">
    <p class="dashboard-label">Ticket prom.</p>
    <p class="dashboard-valor" style="font-size:18px">${formatearMonto(ticketPromedio)}</p>
  </div>
</div>
  `;

  // Más vendidos
  const conteoProductos = {};
  ventas.forEach(v => v.items.forEach(item => {
    conteoProductos[item.nombre] = (conteoProductos[item.nombre] || 0) + item.cantidad;
  }));
  const topProductos = Object.entries(conteoProductos).sort((a, b) => b[1] - a[1]).slice(0, 5);

  document.getElementById('mas-vendidos').innerHTML = topProductos.length > 0 ? `
    <p class="dashboard-subtitulo">Más vendidos</p>
    <div class="dashboard-lista">
      ${topProductos.map(([nombre, cantidad]) => `
        <div class="dashboard-fila">
          <span class="dashboard-fila-nombre">${nombre}</span>
          <span class="dashboard-fila-valor azul">${cantidad} uds</span>
        </div>
      `).join('')}
    </div>
  ` : '<div class="estado-vacio">Sin ventas en este período</div>';

  // Por forma de pago
  const porPago = {};
  ventas.forEach(v => { porPago[v.pago] = (porPago[v.pago] || 0) + v.total; });

  const coloresPago = {
    efectivo:      'verde',
    transferencia: 'azul',
    tarjeta:       'azul',
    fiado:         'naranja'
  };

  document.getElementById('por-pago').innerHTML = Object.entries(porPago).length > 0 ? `
    <p class="dashboard-subtitulo">Por forma de pago</p>
    <div class="dashboard-lista">
      ${Object.entries(porPago).map(([forma, monto]) => `
        <div class="dashboard-fila">
          <span class="dashboard-fila-nombre" style="text-transform:capitalize">${forma}</span>
          <span class="dashboard-fila-valor ${coloresPago[forma] || 'azul'}">${formatearMonto(monto)}</span>
        </div>
      `).join('')}
    </div>
  ` : '';
}


/* ================================================
   PANTALLA: CLIENTES
   ================================================ */

function renderizarClientes() {
  const contenedor = document.getElementById('lista-clientes');

  if (bd.clientes.length === 0) {
    contenedor.innerHTML = '<div class="estado-vacio">No hay clientes registrados</div>';
    return;
  }

  contenedor.innerHTML = bd.clientes.map(c => {
    const totalCompras = bd.ventas
      .filter(v => v.clienteId == c.id)
      .reduce((s, v) => s + v.total, 0);
    const deuda = bd.fiado[c.id] ? bd.fiado[c.id].deuda : 0;

    return `
      <div class="fila-cliente">
        <div>
          <div class="cliente-nombre">${c.nombre}</div>
          <div class="cliente-tel">
            ${c.tel || '—'}
            ${totalCompras > 0 ? ` · Total compras: ${formatearMonto(totalCompras)}` : ''}
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          ${deuda > 0
            ? `<span class="chip-con-deuda">${formatearMonto(deuda)}</span>`
            : `<span class="chip-sin-deuda">Sin deuda</span>`
          }
          <button onclick="eliminarCliente(${c.id})"
            style="width:32px;height:32px;border-radius:50%;border:0.5px solid var(--rojo);background:transparent;color:var(--rojo);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0">
            🗑
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function eliminarCliente(id) {
  const cliente = bd.clientes.find(c => c.id == id);
  if (!cliente) return;

  const deuda = bd.fiado[id] ? bd.fiado[id].deuda : 0;

  // Si tiene deuda pendiente, avisamos antes de eliminar
  if (deuda > 0) {
    const confirmar = confirm(
      `⚠️ ${cliente.nombre} tiene una deuda pendiente de ${formatearMonto(deuda)}.\n\n` +
      `¿Estás seguro que querés eliminarlo igual?`
    );
    if (!confirmar) return;
  } else {
    const confirmar = confirm(`¿Eliminár a ${cliente.nombre}?`);
    if (!confirmar) return;
  }

  // Eliminamos el cliente y sus datos de fiado
  bd.clientes = bd.clientes.filter(c => c.id != id);
  delete bd.fiado[id];

  guardarBaseDeDatos();
  renderizarClientes();
}

function abrirNuevoCliente() {
  document.getElementById('cliente-nombre').value = '';
  document.getElementById('cliente-tel').value    = '';
  document.getElementById('cliente-nota').value   = '';
  document.getElementById('form-nuevo-cliente').classList.add('abierto');
  // Ocultamos la bottom nav igual que en agregar producto
  const bottomNav = document.querySelector('.bottom-nav');
  if (bottomNav) bottomNav.style.display = 'none';
}

function cerrarNuevoCliente() {
  document.getElementById('form-nuevo-cliente').classList.remove('abierto');
  // Restauramos la bottom nav
  const bottomNav = document.querySelector('.bottom-nav');
  if (bottomNav) bottomNav.style.display = 'flex';
}

function guardarCliente() {
  const nombre = document.getElementById('cliente-nombre').value.trim();
  if (!nombre) { alert('Ingresá el nombre del cliente'); return; }

  bd.clientes.push({
    id:     bd.siguienteIdCliente++,
    nombre: nombre,
    tel:    document.getElementById('cliente-tel').value.trim(),
    nota:   document.getElementById('cliente-nota').value.trim()
  });

  guardarBaseDeDatos();
  cerrarNuevoCliente();
  renderizarClientes();
}


/* ================================================
   PANTALLA: FIADO / CUENTAS CORRIENTES
   ================================================ */

function renderizarFiado() {
  const contenedor      = document.getElementById('lista-fiado');
  const cuentasConDeuda = Object.entries(bd.fiado).filter(([id, cuenta]) => cuenta.deuda > 0);

  if (cuentasConDeuda.length === 0) {
    contenedor.innerHTML = '<div class="estado-vacio">No hay cuentas corrientes pendientes 🎉</div>';
    return;
  }

  contenedor.innerHTML = cuentasConDeuda.map(([clienteId, cuenta]) => {
    const cliente       = bd.clientes.find(c => c.id == clienteId);
    const ultimoMov     = cuenta.movimientos[0];
    const nombreCliente = cliente ? cliente.nombre : `Cliente #${clienteId}`;

    return `
      <div class="fila-cliente">
        <div>
          <div class="cliente-nombre">${nombreCliente}</div>
          <div class="cliente-tel">
            ${cliente && cliente.tel ? cliente.tel + ' · ' : ''}
            Última op: ${ultimoMov ? formatearFecha(ultimoMov.fecha) : '—'}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
          <span class="deuda-monto">${formatearMonto(cuenta.deuda)}</span>
          <button class="btn-cobrar-fiado" onclick="pagoRapidoFiado(${clienteId})">
            💰 Cobrar
          </button>
        </div>
      </div>
    `;
  }).join('');

  const selector = document.getElementById('fiado-cliente-sel');
  if (selector) {
    selector.innerHTML = '';
    cuentasConDeuda.forEach(([id]) => {
      const c = bd.clientes.find(x => x.id == id);
      if (c) selector.innerHTML += `<option value="${id}">${c.nombre}</option>`;
    });
  }
}

function mostrarDeudaCliente() {
  const id    = document.getElementById('fiado-cliente-sel').value;
  const panel = document.getElementById('alerta-deuda');
  if (id && bd.fiado[id]) {
    document.getElementById('deuda-actual-monto').textContent = formatearMonto(bd.fiado[id].deuda);
    panel.style.display = 'block';
  } else {
    panel.style.display = 'none';
  }
}

function pagoRapidoFiado(clienteId) {
  const cliente = bd.clientes.find(c => c.id == clienteId);
  const cuenta  = bd.fiado[clienteId];
  if (!cuenta) return;

  const montoStr = prompt(
    `Cobro a ${cliente ? cliente.nombre : 'cliente'}\n` +
    `Deuda actual: ${formatearMonto(cuenta.deuda)}\n\n` +
    `¿Cuánto paga? ($)`
  );

  const monto = parseFloat(montoStr);
  if (!monto || monto <= 0) return;

  cuenta.deuda = Math.max(0, cuenta.deuda - monto);
  cuenta.movimientos.unshift({
    tipo:  'pago',
    monto: monto,
    fecha: new Date().toISOString()
  });

  guardarBaseDeDatos();
  renderizarFiado();
  alert(`✅ Pago registrado: ${formatearMonto(monto)}\nDeuda restante: ${formatearMonto(cuenta.deuda)}`);
}

function confirmarPagoFiado() {
  const clienteId = document.getElementById('fiado-cliente-sel').value;
  const monto     = parseFloat(document.getElementById('fiado-monto').value);

  if (!clienteId || !monto || monto <= 0) {
    alert('Seleccioná un cliente e ingresá un monto válido');
    return;
  }

  const cuenta = bd.fiado[clienteId];
  if (!cuenta) return;

  cuenta.deuda = Math.max(0, cuenta.deuda - monto);
  cuenta.movimientos.unshift({
    tipo:  'pago',
    monto: monto,
    fecha: new Date().toISOString()
  });

  guardarBaseDeDatos();
  cerrarModal('modal-pago-fiado');
  renderizarFiado();
}

// Ajusta la deuda de fiado cuando cambia el precio de un producto
// puntual, sumando solo la diferencia (sin borrar pagos ya hechos)
function ajustarDeudaFiadoPorCambioPrecio(productoId, precioAnterior, precioNuevo) {
  if (precioAnterior === precioNuevo) return;
  const diferenciaUnitaria = precioNuevo - precioAnterior;

  Object.entries(bd.fiado).forEach(([clienteId, cuenta]) => {
    if (cuenta.deuda <= 0) return;

    let ajusteTotal = 0;
    bd.ventas
      .filter(v => v.clienteId == clienteId && v.pago === 'fiado')
      .forEach(venta => {
        venta.items.forEach(item => {
          if (item.id === productoId) {
            ajusteTotal += diferenciaUnitaria * item.cantidad;
            item.precio = precioNuevo;
          }
        });
      });

    if (ajusteTotal !== 0) {
      cuenta.deuda += ajusteTotal;
      cuenta.movimientos.unshift({
        tipo:  'ajuste_precio',
        monto: ajusteTotal,
        fecha: new Date().toISOString()
      });
    }
  });
}

/* ================================================
   PANTALLA: AJUSTES
   ================================================ */

function cargarAjustes() {
  const config = bd.configuracion;
  document.getElementById('input-nombre-negocio').value = config.nombreNegocio;
}

function contactarSoporte() {
  const numero  = WHATSAPP_SOPORTE; // ya está definido en línea 11: '5491130960864'
  const negocio = bd.configuracion.nombreNegocio || 'VendoMas';
  const mensaje = encodeURIComponent(`Hola! Te escribo desde la app VendoMas. Mi negocio es: ${negocio}`);
  const url     = `https://wa.me/${numero}?text=${mensaje}`;
  window.open(url, '_blank');
}

/* ================================================
   MODALES
   ================================================ */

function abrirModal(id) {
  document.getElementById(id).classList.add('abierto');
}

function cerrarModal(id) {
  document.getElementById(id).classList.remove('abierto');
}

// Cerrar modales tocando fuera del contenido
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', function (evento) {
    if (evento.target === this) {
      this.classList.remove('abierto');
    }
  });
});


/* ================================================
   PANEL: ACTUALIZAR PRECIOS POR MARCA
   ================================================ */

let tipoAjuste = 'subir';

function abrirActualizarPrecios() {
  const marcas = [...new Set(bd.productos
    .map(p => p.nombre.split(' ')[0])
    .filter(Boolean)
  )].sort();

  const select = document.getElementById('precio-marca');
  select.innerHTML = '<option value="">— Seleccioná una marca —</option>';
  marcas.forEach(m => {
    select.innerHTML += `<option value="${m}">${m}</option>`;
  });

  tipoAjuste = 'subir';
  seleccionarTipoAjuste('subir');
  setPct(5);
  document.getElementById('check-venta').checked          = true;
  document.getElementById('check-costo').checked          = true;
  document.getElementById('badge-cantidad').style.display = 'none';

  document.getElementById('form-actualizar-precios').classList.add('abierto');
}

function cerrarActualizarPrecios() {
  document.getElementById('form-actualizar-precios').classList.remove('abierto');
}

function seleccionarTipoAjuste(tipo) {
  tipoAjuste = tipo;
  document.getElementById('btn-subir').classList.toggle('activo', tipo === 'subir');
  document.getElementById('btn-bajar').classList.toggle('activo', tipo === 'bajar');
}

function syncSlider(val) {
  document.getElementById('precio-pct').value = parseFloat(val).toFixed(1);
  actualizarCantidadProductos();
}

function syncInput(val) {
  const v = Math.min(50, Math.max(0.1, parseFloat(val) || 0.1));
  document.getElementById('precio-slider').value = v;
  actualizarCantidadProductos();
}

function setPct(val) {
  document.getElementById('precio-slider').value = val;
  document.getElementById('precio-pct').value    = val;
  actualizarCantidadProductos();
}

function actualizarCantidadProductos() {
  const marca = document.getElementById('precio-marca').value;
  const badge = document.getElementById('badge-cantidad');

  if (!marca) {
    badge.style.display = 'none';
    return;
  }

  const cantidad = bd.productos.filter(p =>
    p.nombre.toLowerCase().startsWith(marca.toLowerCase())
  ).length;

  document.getElementById('cant-productos').textContent = cantidad;
  badge.style.display = cantidad > 0 ? 'block' : 'none';
}

function aplicarActualizacionPrecios() {
  const marca       = document.getElementById('precio-marca').value;
  const pct         = parseFloat(document.getElementById('precio-pct').value);
  const aplicaVenta = document.getElementById('check-venta').checked;
  const aplicaCosto = document.getElementById('check-costo').checked;

  if (!marca)                       { alert('Seleccioná una marca'); return; }
  if (!pct || pct <= 0)             { alert('Ingresá un porcentaje válido'); return; }
  if (!aplicaVenta && !aplicaCosto) { alert('Seleccioná al menos un precio para actualizar'); return; }

  const factor   = tipoAjuste === 'subir' ? 1 + pct / 100 : 1 - pct / 100;
  const productos = bd.productos.filter(p =>
    p.nombre.toLowerCase().startsWith(marca.toLowerCase())
  );

  if (productos.length === 0) {
    alert('No se encontraron productos de esa marca');
    return;
  }

  const confirmacion = confirm(
    `¿Confirmar ${tipoAjuste === 'subir' ? 'aumento' : 'reducción'} del ${pct}% ` +
    `en ${productos.length} productos de "${marca}"?`
  );
  if (!confirmacion) return;

  productos.forEach(p => {
    if (aplicaVenta) p.precio = Math.round(p.precio * factor);
    if (aplicaCosto && p.costo > 0) p.costo = Math.round(p.costo * factor);
  });

  // Actualizamos las deudas de clientes con fiado
  // que tengan items de los productos actualizados
  if (aplicaVenta) {
    Object.entries(bd.fiado).forEach(([clienteId, cuenta]) => {
      if (cuenta.deuda <= 0) return;

      // Buscamos todas las ventas fiadas de este cliente
      const ventasFiadas = bd.ventas.filter(v =>
        v.clienteId == clienteId && v.pago === 'fiado'
      );

      // Recalculamos la deuda sumando los items con precios actualizados
      let nuevaDeuda = 0;
      ventasFiadas.forEach(venta => {
        venta.items.forEach(item => {
          // Buscamos si este item es uno de los productos actualizados
          const productoActualizado = productos.find(p => p.id === item.id);
          if (productoActualizado) {
            // Usamos el nuevo precio
            item.precio = productoActualizado.precio;
          }
          nuevaDeuda += item.precio * item.cantidad;
        });
      });

      // Registramos el ajuste como movimiento
      const diferencia = nuevaDeuda - cuenta.deuda;
      if (diferencia !== 0) {
        cuenta.deuda = nuevaDeuda;
        cuenta.movimientos.unshift({
          tipo:  'ajuste_precio',
          monto: diferencia,
          fecha: new Date().toISOString()
        });
      }
    });
  }

  guardarBaseDeDatos();
  cerrarActualizarPrecios();
  renderizarStock();
  alert(`✅ ${productos.length} productos actualizados correctamente`);
}


/* ================================================
   INICIALIZACIÓN
   Se ejecuta una sola vez cuando carga la app.
   ================================================ */

function inicializar() {
  const nombre = bd.configuracion.nombreNegocio;
  const topbar = document.getElementById('topbar-titulo');
  if (topbar) topbar.textContent = nombre;

  renderizarCarrito();
  cargarResumenes('hoy');

  // Ocultamos la app mientras verificamos la licencia
  document.getElementById('app').style.display = 'none';
  setTimeout(verificarLicenciaV3, 1000);
}

function pushEstado(nombre) {
  history.pushState({ pantalla: nombre }, '', '');
}

/* ================================================
   BOTÓN ATRÁS (ANDROID - CAPACITOR)
   ================================================ */

if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {

  const { App } = window.Capacitor.Plugins;

  App.addListener('backButton', ({ canGoBack }) => {

    // 1. Cerrar modal abierto
    const modalAbierto = document.querySelector('.modal-overlay.abierto');
    if (modalAbierto) {
      modalAbierto.classList.remove('abierto');
      return;
    }

    // 2. Cerrar menú Más
    const masOverlay = document.getElementById('mas-overlay');
    if (masOverlay && masOverlay.classList.contains('abierto')) {
      cerrarMenuMas();
      return;
    }

    // 3. Cerrar formulario overlay (agregar/editar producto, actualizar precios, nuevo client)
    const formAbierto = document.querySelector('.formulario-overlay.abierto');
    if (formAbierto) {
    formAbierto.classList.remove('abierto');
    // Nos aseguramos que la bottom nav vuelva a ser visible
    const bottomNav = document.querySelector('.bottom-nav');
    if (bottomNav) bottomNav.style.display = 'flex';
    return;
    }

    // 4. Cerrar búsqueda
    const busquedaAbierta = document.getElementById('busqueda-overlay');
    if (busquedaAbierta && busquedaAbierta.classList.contains('abierta')) {
      cerrarBusqueda();
      return;
    }

    // 5. Si no estamos en Inicio, volvemos a Inicio
    const pantallaActual = document.querySelector('.pantalla.activa');
    if (pantallaActual && pantallaActual.id !== 'pantalla-resumenes') {
      irA('resumenes', document.getElementById('bnav-resumenes'));
      return;
    }

    // 6. Ya estamos en Inicio → salir de la app
    App.exitApp();
  });
}

window.addEventListener('load', inicializar);
