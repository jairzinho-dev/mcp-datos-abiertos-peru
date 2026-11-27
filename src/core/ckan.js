// Cliente mínimo de la API CKAN v3 de la Plataforma Nacional de Datos Abiertos (PNDA).
// Es isomórfico: no usa APIs de Node. El acceso a la red lo da la `plataforma`
// (fetch en Node, CapacitorHttp en Android); ver src/plataforma-node.js y app/src/plataforma-movil.js.
//
// Particularidades del portal (verificadas en nov-2026):
//  - Es DKAN (Drupal 7) con una capa compatible con CKAN en /api/3/action/*.
//  - Un WAF bloquea (HTTP 418) a clientes sin User-Agent (p. ej. curl por defecto).
//  - `package_search` NO funciona: Drupal interpreta el parámetro `q` como ruta interna
//    y redirige. Por eso la búsqueda se hace sobre un índice local (ver indice.js).
//  - `package_show`, `package_list`, `group_list` y
//    `current_package_list_with_resources` (paginado con limit/offset) sí funcionan.
//  - Las fechas vienen como "Sáb, 11/14/2026 - 00:31" (mes/día/año).
//  - No envía cabeceras CORS: desde un WebView hay que llamar por la capa nativa.

export const BASE_POR_DEFECTO = 'https://www.datosabiertos.gob.pe';
// Identificador honesto del cliente. Si el WAF del portal lo rechaza (HTTP 418), lo correcto es
// pedir acceso a la entidad administradora (PCM / Secretaría de Gobierno y Transformación Digital).
export const USER_AGENT_POR_DEFECTO = 'mcp-datos-abiertos-peru/0.2 (proyecto academico; servidor MCP)';

/**
 * @param {object} p
 * @param {(url:string, op:{headers:object, timeoutMs:number}) => Promise<{status:number, tipo:string, json:()=>Promise<any>}>} p.pedirJson
 * @param {string} [p.base]
 * @param {string} [p.userAgent]
 * @param {number} [p.timeoutMs]
 */
export function crearCkan({ pedirJson, base = BASE_POR_DEFECTO, userAgent = USER_AGENT_POR_DEFECTO, timeoutMs = 60_000 }) {
  base = base.replace(/\/$/, '');

  async function ckan(action, params = {}) {
    const url = new URL(`${base}/api/3/action/${action}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));

    let ultimoError;
    for (let intento = 1; intento <= 3; intento++) {
      try {
        const res = await pedirJson(url.toString(), {
          headers: { 'User-Agent': userAgent, Accept: 'application/json' },
          timeoutMs,
        });
        if (!res.tipo.includes('json')) throw new Error(`Respuesta no JSON (HTTP ${res.status}) en ${action}`);
        const body = await res.json();
        if (!body.success) throw new Error(`La API respondió success=false en ${action}`);
        // DKAN devuelve errores de "no encontrado" como success=true + [{__type: 'Query Error'}]
        const r = body.result;
        if (Array.isArray(r) && r[0]?.__type === 'Query Error') {
          const e = new Error(`No encontrado: ${r[0].name_or_id || action}`);
          e.noEncontrado = true;
          throw e;
        }
        return r;
      } catch (e) {
        if (e.noEncontrado) throw e;
        ultimoError = e;
        await new Promise((ok) => setTimeout(ok, 500 * intento));
      }
    }
    throw ultimoError;
  }

  return { ckan, normalizarDataset: (d) => normalizar(d, base), base, userAgent };
}

/** Convierte "Sáb, 11/14/2026 - 00:31" en ISO "2026-11-14T00:31". Devuelve null si no se puede. */
export function parsearFecha(s) {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s*-\s*(\d{1,2}):(\d{2}))?/.exec(s || '');
  if (!m) return null;
  const [, mes, dia, anio, hh = '00', mm = '00'] = m;
  return `${anio}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}T${hh.padStart(2, '0')}:${mm}`;
}

/** Normaliza un dataset crudo de la API a un objeto compacto y estable. */
function normalizar(d, base) {
  return {
    id: d.id,
    nombre: d.name,
    titulo: (d.title || '').replace(/\s+/g, ' ').trim(),
    descripcion: (d.notes || '').replace(/\s+/g, ' ').trim(),
    entidades: (d.groups || []).map((g) => g.title).filter(Boolean),
    etiquetas: (d.tags || []).map((t) => t.name).filter(Boolean),
    licencia: d.license_title || null,
    modificado: parsearFecha(d.metadata_modified),
    creado: parsearFecha(d.metadata_created),
    url: `${base}/dataset/${encodeURIComponent(d.name)}`,
    recursos: (d.resources || []).map((r) => ({
      id: r.id,
      nombre: (r.name || '').replace(/\s+/g, ' ').trim(),
      formato: normalizarFormato(r.format, r.url),
      tamano: r.size || null,
      url: r.url,
      descripcion: (r.description || '').replace(/\s+/g, ' ').trim() || undefined,
    })),
  };
}

export function normalizarFormato(formato, url = '') {
  let f = String(formato || '').toLowerCase().replace(/^\./, '').trim();
  if (f === 'cvs') f = 'csv';
  if (!f || f === 'data' || f === '.') {
    const ext = /\.([a-z0-9]{2,5})(?:$|\?)/i.exec(url)?.[1]?.toLowerCase();
    f = ext || 'desconocido';
  }
  return f;
}
