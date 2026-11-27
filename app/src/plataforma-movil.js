// Plataforma Android (Capacitor) para el núcleo isomórfico (src/core) y para el agente.
//  - Red: CapacitorHttp hace las peticiones desde la capa nativa de Android, así que no aplica CORS
//    (el portal de datos abiertos no envía cabeceras CORS) y se puede fijar un User-Agent propio.
//  - Almacenamiento: IndexedDB del WebView (privado de la app) para el catálogo.
//  - Memoria: los CSV se descargan solo hasta el tope (cabecera Range), no en streaming.

import { Capacitor, CapacitorHttp } from '@capacitor/core';

const nativo = Capacitor.isNativePlatform();

function cabecera(headers, nombre) {
  const k = Object.keys(headers || {}).find((h) => h.toLowerCase() === nombre);
  return k ? headers[k] : '';
}

function base64ABytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Petición genérica. En el navegador (modo desarrollo) cae a fetch, sujeto a CORS. */
async function pedir({ url, method = 'GET', headers = {}, body, responseType = 'json', timeoutMs = 120_000 }) {
  if (nativo) {
    const r = await CapacitorHttp.request({
      url,
      method,
      headers,
      data: body,
      responseType,
      connectTimeout: timeoutMs,
      readTimeout: timeoutMs,
    });
    let data = r.data;
    if (responseType === 'json' && typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {}
    }
    return { status: r.status, headers: r.headers || {}, data };
  }
  const { 'User-Agent': _ua, ...resto } = headers; // el navegador no deja fijar User-Agent
  const r = await fetch(url, {
    method,
    headers: resto,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const h = Object.fromEntries(r.headers.entries());
  if (responseType === 'arraybuffer') return { status: r.status, headers: h, data: new Uint8Array(await r.arrayBuffer()) };
  const texto = await r.text();
  let data = texto;
  try {
    data = JSON.parse(texto);
  } catch {}
  return { status: r.status, headers: h, data };
}

// ---------- almacén en IndexedDB ----------

function abrirBD() {
  return new Promise((ok, mal) => {
    const req = indexedDB.open('datos-abiertos-peru', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => ok(req.result);
    req.onerror = () => mal(req.error);
  });
}

const almacen = {
  async leer(clave) {
    const bd = await abrirBD();
    return new Promise((ok, mal) => {
      const req = bd.transaction('kv').objectStore('kv').get(clave);
      req.onsuccess = () => ok(req.result ?? null);
      req.onerror = () => mal(req.error);
    });
  },
  async guardar(clave, valor) {
    const bd = await abrirBD();
    return new Promise((ok, mal) => {
      const tx = bd.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(valor, clave);
      tx.oncomplete = () => ok();
      tx.onerror = () => mal(tx.error);
    });
  },
};

// ---------- plataforma ----------

export const MAX_MB_MOVIL = 40;

export function crearPlataformaMovil({ log = console.log } = {}) {
  return {
    ttlHoras: 24 * 7, // en el móvil el catálogo se renueva semanalmente (o a mano desde Ajustes)
    maxMbDefecto: 25,
    maxMbTope: MAX_MB_MOVIL,
    maxSalida: 30_000,
    log,
    almacen,
    http: { pedir },

    async pedirJson(url, { headers, timeoutMs }) {
      const r = await pedir({ url, headers, timeoutMs });
      const tipo = cabecera(r.headers, 'content-type') || (typeof r.data === 'object' ? 'application/json' : '');
      return { status: r.status, tipo, json: async () => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) };
    },

    async abrirBytes(url, { headers, maxBytes }) {
      const r = await pedir({
        url,
        headers: { ...headers, Range: `bytes=0-${maxBytes - 1}` },
        responseType: 'arraybuffer',
        timeoutMs: 5 * 60_000,
      });
      const bytes = typeof r.data === 'string' ? base64ABytes(r.data) : r.data instanceof Uint8Array ? r.data : new Uint8Array(r.data || []);
      // 206 = el servidor respetó el rango; el total viene en Content-Range ("bytes 0-99/12345")
      const total = Number(/\/(\d+)$/.exec(cabecera(r.headers, 'content-range'))?.[1]) || Number(cabecera(r.headers, 'content-length')) || null;
      const truncado = (r.status === 206 && total > bytes.length) || bytes.length > maxBytes;
      const datos = bytes.length > maxBytes ? bytes.subarray(0, maxBytes) : bytes;
      return {
        status: r.status === 206 ? 200 : r.status,
        tipo: cabecera(r.headers, 'content-type'),
        tamanoTotal: total,
        truncado,
        trozos: {
          async *[Symbol.asyncIterator]() {
            // en trozos de 256 KB para no bloquear la interfaz
            for (let i = 0; i < datos.length; i += 256 * 1024) {
              yield datos.subarray(i, i + 256 * 1024);
              await new Promise((ok) => setTimeout(ok, 0));
            }
          },
        },
        cerrar() {},
      };
    },

    /** Catálogo empaquetado en el APK (lo genera la compilación), para no esperar en el primer arranque. */
    async semilla() {
      try {
        const r = await fetch('./catalogo.json');
        return r.ok ? await r.json() : null;
      } catch {
        return null;
      }
    },
  };
}
