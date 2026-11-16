// Lectura de recursos CSV remotos en streaming: nunca se descarga el archivo completo a
// memoria (en la PNDA hay CSV de más de 1 GB). Detecta codificación (UTF-8 o Windows-1252)
// y separador (, ; | tab) a partir de los primeros 64 KB.

import { Readable } from 'node:stream';
import { parse } from 'csv-parse';
import iconv from 'iconv-lite';
import { USER_AGENT } from './ckan.js';

const MUESTRA_BYTES = 64 * 1024;
const MAX_MB_DEFECTO = Number(process.env.PNDA_MAX_MB || 300);

function sinTildes(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function detectarCodificacion(buf) {
  // Se recorta el final por si cortamos un carácter multibyte a la mitad.
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, Math.max(0, buf.length - 4)));
    return 'utf-8';
  } catch {
    return 'win1252';
  }
}

function detectarSeparador(texto) {
  const lineas = texto.split(/\r?\n/).filter(Boolean).slice(0, 10);
  let mejor = ',';
  let mejorPuntaje = -1;
  for (const sep of [',', ';', '|', '\t']) {
    const cuentas = lineas.map((l) => l.split(sep).length - 1);
    if (!cuentas[0]) continue;
    // separador consistente entre líneas y con más columnas
    const constantes = cuentas.filter((c) => c === cuentas[0]).length;
    const p = constantes * 100 + cuentas[0];
    if (p > mejorPuntaje) [mejor, mejorPuntaje] = [sep, p];
  }
  return mejor;
}

/** Abre un CSV remoto y devuelve un iterador de filas (objetos) más metadatos de lectura. */
async function abrirCsv(url, { maxMb = MAX_MB_DEFECTO } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!res.ok) throw new Error(`No se pudo descargar el recurso (HTTP ${res.status})`);
  const tipo = res.headers.get('content-type') || '';
  if (/html/i.test(tipo)) throw new Error('El enlace devuelve una página HTML, no un CSV (posible enlace roto o caído)');

  const lector = Readable.fromWeb(res.body);
  const limite = maxMb * 1024 * 1024;
  const estado = { bytes: 0, truncado: false, tamanoTotal: Number(res.headers.get('content-length')) || null };

  // Leer la muestra inicial para detectar codificación y separador.
  const iterador = lector[Symbol.asyncIterator]();
  const inicio = [];
  let n = 0;
  while (n < MUESTRA_BYTES) {
    const { value, done } = await iterador.next();
    if (done) break;
    inicio.push(value);
    n += value.length;
  }
  const muestra = Buffer.concat(inicio);
  if (/^PK\x03\x04/.test(muestra.subarray(0, 4).toString('latin1'))) {
    lector.destroy();
    throw new Error('El recurso es un ZIP comprimido; este servidor solo lee CSV sin comprimir');
  }
  const codificacion = detectarCodificacion(muestra);
  const separador = detectarSeparador(iconv.decode(muestra, codificacion));

  async function* bytesConLimite() {
    for (const c of inicio) {
      estado.bytes += c.length;
      yield c;
    }
    for (;;) {
      const { value, done } = await iterador.next();
      if (done) return;
      if (estado.bytes + value.length > limite) {
        estado.truncado = true;
        lector.destroy();
        return;
      }
      estado.bytes += value.length;
      yield value;
    }
  }

  const parser = Readable.from(bytesConLimite())
    .pipe(iconv.decodeStream(codificacion))
    .pipe(
      parse({
        delimiter: separador,
        columns: (cab) => cab.map((c, i) => String(c).trim() || `columna_${i + 1}`),
        bom: true,
        relax_column_count: true,
        relax_quotes: true,
        skip_empty_lines: true,
        trim: true,
      }),
    );
  const cerrar = () => {
    lector.destroy();
    parser.destroy();
  };
  return { filas: parser, estado, codificacion, separador, cerrar };
}

// ---------- utilidades de valores ----------

export function aNumero(v) {
  if (v === null || v === undefined) return null;
  let s = String(v).trim().replace(/^S\/\.?\s*/i, '');
  if (!s) return null;
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, ''); // 1,234.56
  else if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); // 1.234,56
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.'); // 12,5
  const x = Number(s);
  return Number.isFinite(x) ? x : null;
}

function inferirTipo(valores) {
  const llenos = valores.filter((v) => v !== '' && v != null);
  if (!llenos.length) return 'vacío';
  if (llenos.every((v) => aNumero(v) !== null)) return 'número';
  if (llenos.every((v) => /^\d{4}-?\d{2}-?\d{2}/.test(v) || /^\d{1,2}\/\d{1,2}\/\d{4}/.test(v))) return 'fecha';
  return 'texto';
}

function resolverColumna(columnas, nombre) {
  const exacta = columnas.find((c) => c === nombre);
  if (exacta) return exacta;
  const n = sinTildes(nombre);
  const c = columnas.find((x) => sinTildes(x) === n);
  if (c) return c;
  throw new Error(`La columna "${nombre}" no existe. Columnas disponibles: ${columnas.join(', ')}`);
}

// ---------- operaciones expuestas ----------

/** Devuelve columnas, tipos inferidos y las primeras filas. */
export async function previsualizar(url, { filas = 10 } = {}) {
  const csv = await abrirCsv(url, { maxMb: 50 });
  const muestra = [];
  try {
    for await (const fila of csv.filas) {
      muestra.push(fila);
      if (muestra.length >= Math.max(filas, 50)) break; // 50 filas para inferir tipos
    }
  } finally {
    csv.cerrar();
  }
  const columnas = muestra.length ? Object.keys(muestra[0]) : [];
  return {
    codificacion: csv.codificacion,
    separador: csv.separador === '\t' ? 'tab' : csv.separador,
    tamano_total_bytes: csv.estado.tamanoTotal,
    columnas: columnas.map((c) => ({
      nombre: c,
      tipo: inferirTipo(muestra.map((f) => f[c])),
      ejemplo: muestra.find((f) => f[c])?.[c] ?? null,
    })),
    filas: muestra.slice(0, filas),
  };
}

const OPERADORES = {
  '=': (a, b) => sinTildes(a) === sinTildes(b),
  '!=': (a, b) => sinTildes(a) !== sinTildes(b),
  contiene: (a, b) => sinTildes(a).includes(sinTildes(b)),
  empieza: (a, b) => sinTildes(a).startsWith(sinTildes(b)),
  en: (a, b) => (Array.isArray(b) ? b : String(b).split('|')).some((x) => sinTildes(a) === sinTildes(x)),
  '>': (a, b) => cmp(a, b) > 0,
  '>=': (a, b) => cmp(a, b) >= 0,
  '<': (a, b) => cmp(a, b) < 0,
  '<=': (a, b) => cmp(a, b) <= 0,
};
export const LISTA_OPERADORES = Object.keys(OPERADORES);

function cmp(a, b) {
  const x = aNumero(a);
  const y = aNumero(b);
  if (x !== null && y !== null) return x - y;
  return String(a).localeCompare(String(b)); // fechas ISO / AAAAMMDD comparan bien como texto
}

/**
 * Filtra y agrega un CSV remoto en una sola pasada.
 * @param {string} url
 * @param {object} o
 * @param {{columna:string, operador:string, valor:any}[]} [o.filtros]
 * @param {string[]} [o.agrupar_por]
 * @param {{operacion:'contar'|'suma'|'promedio'|'min'|'max', columna?:string}[]} [o.metricas]
 * @param {string[]} [o.columnas]  columnas a devolver cuando no se agrupa
 * @param {number} [o.limite]
 * @param {number} [o.max_mb]
 */
export async function consultar(url, o = {}) {
  const { filtros = [], agrupar_por = [], columnas: proyectar, limite = 20, max_mb } = o;
  const metricas = o.metricas?.length ? o.metricas : [{ operacion: 'contar' }];
  for (const f of filtros) if (!OPERADORES[f.operador]) throw new Error(`Operador "${f.operador}" no válido. Usa: ${LISTA_OPERADORES.join(', ')}`);

  const t0 = Date.now();
  const csv = await abrirCsv(url, { maxMb: max_mb });
  let resueltas = null;
  let leidas = 0;
  let coinciden = 0;
  const grupos = new Map();
  const filasSalida = [];
  const metricasGlobales = metricas.map(() => nuevoAcumulador());

  try {
    for await (const fila of csv.filas) {
      leidas++;
      if (!resueltas) {
        const cols = Object.keys(fila);
        resueltas = {
          filtros: filtros.map((f) => ({ ...f, columna: resolverColumna(cols, f.columna) })),
          grupos: agrupar_por.map((g) => resolverColumna(cols, g)),
          metricas: metricas.map((m) => ({ ...m, columna: m.columna ? resolverColumna(cols, m.columna) : null })),
          proyectar: proyectar?.map((p) => resolverColumna(cols, p)),
        };
        for (const m of resueltas.metricas) {
          if (m.operacion !== 'contar' && !m.columna) throw new Error(`La métrica "${m.operacion}" necesita una columna`);
        }
      }
      if (!resueltas.filtros.every((f) => OPERADORES[f.operador](fila[f.columna] ?? '', f.valor))) continue;
      coinciden++;

      resueltas.metricas.forEach((m, i) => acumular(metricasGlobales[i], m, fila));
      if (resueltas.grupos.length) {
        const clave = JSON.stringify(resueltas.grupos.map((g) => fila[g] ?? ''));
        let acc = grupos.get(clave);
        if (!acc) grupos.set(clave, (acc = resueltas.metricas.map(() => nuevoAcumulador())));
        resueltas.metricas.forEach((m, i) => acumular(acc[i], m, fila));
      } else if (filasSalida.length < limite) {
        filasSalida.push(
          resueltas.proyectar ? Object.fromEntries(resueltas.proyectar.map((p) => [p, fila[p]])) : fila,
        );
      }
    }
  } finally {
    csv.cerrar();
  }

  const nombreMetrica = (m) => (m.operacion === 'contar' ? 'contar' : `${m.operacion}(${m.columna})`);
  const ms = resueltas?.metricas || metricas;
  const resultado = {
    filas_leidas: leidas,
    filas_que_cumplen: coinciden,
    lectura_completa: !csv.estado.truncado,
    bytes_leidos: csv.estado.bytes,
    segundos: Number(((Date.now() - t0) / 1000).toFixed(2)),
    totales: Object.fromEntries(ms.map((m, i) => [nombreMetrica(m), cerrarAcumulador(metricasGlobales[i], m)])),
  };
  if (csv.estado.truncado) {
    resultado.advertencia =
      `Se alcanzó el límite de ${max_mb || MAX_MB_DEFECTO} MB: los resultados son PARCIALES. ` +
      'Sube max_mb si se necesita el total exacto.';
  }
  if (resueltas?.grupos.length) {
    const lista = [...grupos].map(([clave, acc]) => {
      const valores = JSON.parse(clave);
      const g = Object.fromEntries(resueltas.grupos.map((c, i) => [c, valores[i]]));
      ms.forEach((m, i) => (g[nombreMetrica(m)] = cerrarAcumulador(acc[i], m)));
      return g;
    });
    const orden = nombreMetrica(ms[0]);
    lista.sort((a, b) => (b[orden] ?? -Infinity) - (a[orden] ?? -Infinity));
    resultado.numero_de_grupos = lista.length;
    resultado.grupos = lista.slice(0, limite);
  } else {
    resultado.filas = filasSalida;
  }
  return resultado;
}

function nuevoAcumulador() {
  return { n: 0, suma: 0, min: null, max: null, validos: 0 };
}

function acumular(acc, m, fila) {
  acc.n++;
  if (m.operacion === 'contar') return;
  const x = aNumero(fila[m.columna]);
  if (x === null) return;
  acc.validos++;
  acc.suma += x;
  acc.min = acc.min === null ? x : Math.min(acc.min, x);
  acc.max = acc.max === null ? x : Math.max(acc.max, x);
}

function cerrarAcumulador(acc, m) {
  const r = (x) => (x === null ? null : Math.round(x * 100) / 100);
  switch (m.operacion) {
    case 'contar':
      return acc.n;
    case 'suma':
      return r(acc.suma);
    case 'promedio':
      return acc.validos ? r(acc.suma / acc.validos) : null;
    case 'min':
      return r(acc.min);
    case 'max':
      return r(acc.max);
    default:
      throw new Error(`Métrica "${m.operacion}" no soportada`);
  }
}
