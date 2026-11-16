// Índice local del catálogo de la PNDA + búsqueda por relevancia (BM25 por campos).
//
// La API del portal no ofrece búsqueda funcional (ver ckan.js), así que el servidor descarga
// el catálogo completo con `current_package_list_with_resources` (≈3 700 datasets en ~40
// páginas), lo guarda en disco y busca localmente. El caché se renueva cada PNDA_TTL_HORAS.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ckan, normalizarDataset } from './ckan.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const DIR_CACHE = process.env.PNDA_CACHE_DIR || join(AQUI, '..', '.cache');
const ARCHIVO = join(DIR_CACHE, 'catalogo.json');
const TTL_MS = Number(process.env.PNDA_TTL_HORAS || 24) * 3600_000;
const POR_PAGINA = 100;
const CONCURRENCIA = 4;
const log = (...a) => console.error('[indice]', ...a);

// ---------- normalización de texto ----------

const STOPWORDS = new Set(
  ('a al ante con contra de del desde durante e el en entre hacia hasta la las lo los ' +
    'mediante o para por según sin sobre su sus tras u un una unos unas y que se es son ' +
    'como mas más muy cual cuales donde cuando quien datos dato dataset informacion información')
    .split(' ')
    .map((w) => sinTildes(w)),
);

function sinTildes(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** "Contrataciones públicas" → ["contratacion", "public"] (raíz aproximada para español). */
export function tokenizar(texto) {
  return sinTildes(String(texto || ''))
    .split(/[^a-z0-9ñ]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(raiz);
}

function raiz(t) {
  if (/^\d+$/.test(t) || t.length <= 4) return t;
  // plurales y algunos sufijos frecuentes; suficiente para emparejar "fallecidos" ~ "fallecido"
  return t
    .replace(/(ciones|cion)$/, 'cion')
    .replace(/(es|s)$/, '')
    .replace(/(as|os|a|o)$/, '');
}

// ---------- carga del catálogo ----------

let catalogo = null; // { generado, datasets: [...] }
let indice = null; // estructuras BM25
let cargando = null;

export async function obtenerCatalogo({ forzar = false } = {}) {
  if (catalogo && !forzar && Date.now() - Date.parse(catalogo.generado) < TTL_MS) return catalogo;
  if (cargando) return cargando;
  cargando = (async () => {
    try {
      if (!forzar && existsSync(ARCHIVO)) {
        const enDisco = JSON.parse(readFileSync(ARCHIVO, 'utf8'));
        if (Date.now() - Date.parse(enDisco.generado) < TTL_MS) {
          establecer(enDisco);
          log(`catálogo desde caché: ${enDisco.datasets.length} datasets (${enDisco.generado})`);
          return catalogo;
        }
      }
      const nuevo = await descargarCatalogo();
      mkdirSync(DIR_CACHE, { recursive: true });
      writeFileSync(ARCHIVO, JSON.stringify(nuevo));
      establecer(nuevo);
      return catalogo;
    } catch (e) {
      // Si el portal falla pero hay un caché viejo, se usa antes que no responder.
      if (existsSync(ARCHIVO)) {
        log('no se pudo actualizar, uso caché vencido:', e.message);
        establecer(JSON.parse(readFileSync(ARCHIVO, 'utf8')));
        return catalogo;
      }
      throw e;
    } finally {
      cargando = null;
    }
  })();
  return cargando;
}

async function descargarCatalogo() {
  const t0 = Date.now();
  const nombres = await ckan('package_list');
  const paginas = Math.ceil(nombres.length / POR_PAGINA) + 1; // +1 por si se publicaron nuevos
  log(`descargando catálogo: ${nombres.length} datasets en ${paginas} páginas…`);
  const resultados = [];
  let siguiente = 0;
  async function trabajador() {
    while (siguiente < paginas) {
      const p = siguiente++;
      const r = await ckan('current_package_list_with_resources', { limit: POR_PAGINA, offset: p * POR_PAGINA });
      resultados[p] = r.flat();
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCIA }, trabajador));
  const vistos = new Set();
  const datasets = [];
  for (const d of resultados.flat()) {
    if (!d?.id || vistos.has(d.id)) continue;
    vistos.add(d.id);
    const n = normalizarDataset(d);
    if (n.descripcion.length > 600) n.descripcion = n.descripcion.slice(0, 600) + '…';
    datasets.push(n);
  }
  log(`catálogo listo: ${datasets.length} datasets en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return { generado: new Date().toISOString(), fuente: 'current_package_list_with_resources', datasets };
}

// ---------- BM25 por campos ----------

const PESOS = { titulo: 3, entidades: 2, etiquetas: 2, recursos: 1, descripcion: 1 };
const K1 = 1.2;
const B = 0.75;

function establecer(c) {
  catalogo = c;
  const docs = c.datasets.map((d) => {
    const campos = {
      titulo: tokenizar(d.titulo),
      entidades: tokenizar(d.entidades.join(' ')),
      etiquetas: tokenizar(d.etiquetas.join(' ')),
      recursos: tokenizar(d.recursos.map((r) => r.nombre).join(' ')),
      descripcion: tokenizar(d.descripcion),
    };
    // frecuencia ponderada por campo
    const tf = new Map();
    let largo = 0;
    for (const [campo, toks] of Object.entries(campos)) {
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + PESOS[campo]);
      largo += toks.length * PESOS[campo];
    }
    return { tf, largo };
  });
  const df = new Map();
  for (const { tf } of docs) for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const promedio = docs.reduce((s, d) => s + d.largo, 0) / Math.max(docs.length, 1);
  indice = { docs, df, promedio, N: docs.length };
}

function puntaje(i, terminos) {
  const { docs, df, promedio, N } = indice;
  const { tf, largo } = docs[i];
  let s = 0;
  for (const t of terminos) {
    const f = tf.get(t);
    if (!f) continue;
    const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
    s += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * largo) / promedio)));
  }
  return s;
}

/**
 * Busca datasets por relevancia.
 * @param {object} o
 * @param {string} o.consulta   texto libre
 * @param {string} [o.entidad]  filtro por nombre de entidad (subcadena, sin tildes)
 * @param {string} [o.formato]  p. ej. "csv"
 * @param {string} [o.desde]    fecha ISO mínima de última modificación
 * @param {number} [o.limite]
 */
export async function buscar({ consulta, entidad, formato, desde, limite = 10 }) {
  const c = await obtenerCatalogo();
  const terminos = [...new Set(tokenizar(consulta))];
  const ent = entidad ? sinTildes(entidad) : null;
  const fmt = formato ? formato.toLowerCase().replace(/^\./, '') : null;

  const candidatos = [];
  c.datasets.forEach((d, i) => {
    if (ent && !d.entidades.some((e) => sinTildes(e).includes(ent))) return;
    if (fmt && !d.recursos.some((r) => r.formato === fmt)) return;
    if (desde && (!d.modificado || d.modificado < desde)) return;
    const s = terminos.length ? puntaje(i, terminos) : 1;
    if (s > 0) candidatos.push({ d, s });
  });
  candidatos.sort((a, b) => b.s - a.s || (b.d.modificado || '').localeCompare(a.d.modificado || ''));
  return {
    total: candidatos.length,
    terminos,
    resultados: candidatos.slice(0, limite).map(({ d, s }) => ({ ...d, relevancia: Number(s.toFixed(3)) })),
  };
}

export async function buscarPorNombreOId(x) {
  const c = await obtenerCatalogo();
  return c.datasets.find((d) => d.id === x || d.nombre === x) || null;
}

export async function entidades(filtro) {
  const c = await obtenerCatalogo();
  const cuenta = new Map();
  for (const d of c.datasets) for (const e of d.entidades) cuenta.set(e, (cuenta.get(e) || 0) + 1);
  const f = filtro ? sinTildes(filtro) : null;
  return [...cuenta]
    .filter(([e]) => !f || sinTildes(e).includes(f))
    .sort((a, b) => b[1] - a[1])
    .map(([entidad, datasets]) => ({ entidad, datasets }));
}

export function estadoCatalogo() {
  return catalogo ? { generado: catalogo.generado, datasets: catalogo.datasets.length } : null;
}
