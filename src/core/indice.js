// Índice local del catálogo de la PNDA + búsqueda por relevancia (BM25 por campos).
//
// La API del portal no ofrece búsqueda funcional (ver ckan.js), así que se descarga el catálogo
// completo con `current_package_list_with_resources` (≈3 700 datasets en ~40 páginas), se guarda
// con el `almacen` de la plataforma (disco en Node, IndexedDB en la app) y se busca localmente.
// Es isomórfico: no usa APIs de Node.

const POR_PAGINA = 100;
const CONCURRENCIA = 4;

// ---------- normalización de texto ----------

export function sinTildes(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const STOPWORDS = new Set(
  ('a al ante con contra de del desde durante e el en entre hacia hasta la las lo los ' +
    'mediante o para por según sin sobre su sus tras u un una unos unas y que se es son ' +
    'como mas más muy cual cuales donde cuando quien datos dato dataset informacion información')
    .split(' ')
    .map((w) => sinTildes(w)),
);

/** "Contrataciones públicas" → ["contratacion", "public"] (raíz aproximada para español). */
export function tokenizar(texto) {
  return sinTildes(texto || '')
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

// ---------- BM25 por campos ----------

export const PESOS = { titulo: 3, entidades: 2, etiquetas: 2, recursos: 1, descripcion: 1 };
export const K1 = 1.2;
export const B = 0.75;

/** Construye las estructuras BM25 (frecuencias ponderadas, df, largo promedio) de un catálogo. */
export function construirIndice(datasets, pesos = PESOS) {
  const docs = datasets.map((d) => {
    const campos = {
      titulo: tokenizar(d.titulo),
      entidades: tokenizar(d.entidades.join(' ')),
      etiquetas: tokenizar(d.etiquetas.join(' ')),
      recursos: tokenizar(d.recursos.map((r) => r.nombre).join(' ')),
      descripcion: tokenizar(d.descripcion),
    };
    // frecuencia ponderada por campo: f~(q,D) = sum_c w_c * f_c(q,D)
    const tf = new Map();
    let largo = 0;
    for (const [campo, toks] of Object.entries(campos)) {
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + pesos[campo]);
      largo += toks.length * pesos[campo];
    }
    return { tf, largo };
  });
  const df = new Map();
  for (const { tf } of docs) for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const promedio = docs.reduce((s, d) => s + d.largo, 0) / Math.max(docs.length, 1);
  return { docs, df, promedio, N: docs.length };
}

export function puntajeBm25(indice, i, terminos) {
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

// ---------- catálogo ----------

/**
 * @param {object} p
 * @param {ReturnType<import('./ckan.js').crearCkan>} p.api
 * @param {{leer:(clave:string)=>Promise<any>, guardar:(clave:string, valor:any)=>Promise<void>}} p.almacen
 * @param {number} [p.ttlMs]
 * @param {(...a:any[])=>void} [p.log]
 * @param {() => Promise<any>} [p.semilla]  catálogo empaquetado (p. ej. dentro del APK) para el primer arranque
 */
export function crearIndice({ api, almacen, ttlMs = 24 * 3600_000, log = () => {}, semilla }) {
  let catalogo = null; // { generado, datasets: [...] }
  let indice = null;
  let cargando = null;
  const vigente = (c) => c && Date.now() - Date.parse(c.generado) < ttlMs;

  function establecer(c) {
    catalogo = c;
    indice = construirIndice(c.datasets);
  }

  async function descargarCatalogo(progreso) {
    const t0 = Date.now();
    const nombres = await api.ckan('package_list');
    const paginas = Math.ceil(nombres.length / POR_PAGINA) + 1; // +1 por si se publicaron nuevos
    log(`descargando catálogo: ${nombres.length} datasets en ${paginas} páginas…`);
    const resultados = [];
    let siguiente = 0;
    let listas = 0;
    async function trabajador() {
      while (siguiente < paginas) {
        const p = siguiente++;
        const r = await api.ckan('current_package_list_with_resources', { limit: POR_PAGINA, offset: p * POR_PAGINA });
        resultados[p] = r.flat();
        progreso?.(++listas, paginas);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCIA }, trabajador));
    const vistos = new Set();
    const datasets = [];
    for (const d of resultados.flat()) {
      if (!d?.id || vistos.has(d.id)) continue;
      vistos.add(d.id);
      const n = api.normalizarDataset(d);
      if (n.descripcion.length > 600) n.descripcion = n.descripcion.slice(0, 600) + '…';
      datasets.push(n);
    }
    const segundos = (Date.now() - t0) / 1000;
    log(`catálogo listo: ${datasets.length} datasets en ${segundos.toFixed(1)} s`);
    return { generado: new Date().toISOString(), fuente: 'current_package_list_with_resources', segundos, datasets };
  }

  async function obtenerCatalogo({ forzar = false, progreso } = {}) {
    if (!forzar && vigente(catalogo)) return catalogo;
    if (cargando) return cargando;
    cargando = (async () => {
      let guardado = null;
      try {
        guardado = await almacen.leer('catalogo');
        if (!guardado && semilla) guardado = await semilla();
      } catch (e) {
        log('no se pudo leer el caché:', e.message);
      }
      try {
        if (!forzar && vigente(guardado)) {
          establecer(guardado);
          log(`catálogo desde caché: ${guardado.datasets.length} datasets (${guardado.generado})`);
          return catalogo;
        }
        const nuevo = await descargarCatalogo(progreso);
        await almacen.guardar('catalogo', nuevo);
        establecer(nuevo);
        return catalogo;
      } catch (e) {
        // Si el portal falla pero hay un caché viejo, se usa antes que no responder.
        if (guardado) {
          log('no se pudo actualizar, uso caché vencido:', e.message);
          establecer(guardado);
          return catalogo;
        }
        throw e;
      }
    })().finally(() => (cargando = null));
    return cargando;
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
  async function buscar({ consulta, entidad, formato, desde, limite = 10 }) {
    const c = await obtenerCatalogo();
    const terminos = [...new Set(tokenizar(consulta))];
    const ent = entidad ? sinTildes(entidad) : null;
    const fmt = formato ? formato.toLowerCase().replace(/^\./, '') : null;

    const candidatos = [];
    c.datasets.forEach((d, i) => {
      if (ent && !d.entidades.some((e) => sinTildes(e).includes(ent))) return;
      if (fmt && !d.recursos.some((r) => r.formato === fmt)) return;
      if (desde && (!d.modificado || d.modificado < desde)) return;
      const s = terminos.length ? puntajeBm25(indice, i, terminos) : 1;
      if (s > 0) candidatos.push({ d, s });
    });
    candidatos.sort((a, b) => b.s - a.s || (b.d.modificado || '').localeCompare(a.d.modificado || ''));
    return {
      total: candidatos.length,
      terminos,
      resultados: candidatos.slice(0, limite).map(({ d, s }) => ({ ...d, relevancia: Number(s.toFixed(3)) })),
    };
  }

  async function buscarPorNombreOId(x) {
    const c = await obtenerCatalogo();
    return c.datasets.find((d) => d.id === x || d.nombre === x) || null;
  }

  async function entidades(filtro) {
    const c = await obtenerCatalogo();
    const cuenta = new Map();
    for (const d of c.datasets) for (const e of d.entidades) cuenta.set(e, (cuenta.get(e) || 0) + 1);
    const f = filtro ? sinTildes(filtro) : null;
    return [...cuenta]
      .filter(([e]) => !f || sinTildes(e).includes(f))
      .sort((a, b) => b[1] - a[1])
      .map(([entidad, datasets]) => ({ entidad, datasets }));
  }

  function estado() {
    return catalogo ? { generado: catalogo.generado, datasets: catalogo.datasets.length } : null;
  }

  return { obtenerCatalogo, buscar, buscarPorNombreOId, entidades, estado };
}
