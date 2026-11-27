// Lectura de recursos CSV remotos en streaming. En Node nunca se descarga el archivo completo
// a memoria (en la PNDA hay CSV de más de 1 GB); en la app móvil se descarga solo hasta el tope.
// Detecta codificación (UTF-8 o Windows-1252) y separador (, ; | tab) con los primeros 64 KB.
// Es isomórfico: usa TextDecoder y un parser CSV propio (RFC 4180 tolerante), sin APIs de Node.

import * as XLSX from 'xlsx';
import { MB, esOle, esPdf, esZip, extraerEntrada, listarZip, tipoDeContenido, tipoPorNombre, trozosDeEntrada, unir } from './archivos.js';

const MUESTRA_BYTES = 64 * 1024;

function sinTildes(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function detectarCodificacion(bytes) {
  // Se recorta el final por si cortamos un carácter multibyte a la mitad.
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, Math.max(0, bytes.length - 4)));
    return 'utf-8';
  } catch {
    return 'windows-1252';
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


/**
 * Parser CSV incremental: recibe trozos de texto y emite filas (arreglos de campos).
 * Comillas dobles con "" como escape; comillas en medio de un campo sin comillas se toman literal.
 */
export function crearParserCsv(sep) {
  let campo = '';
  let fila = [];
  let enComillas = false;
  let comillaPendiente = false; // vimos " dentro de comillas: puede ser cierre o escape ""
  let citado = false;
  let finCitado = 0; // largo del contenido entre comillas; lo que sigue se recorta
  const listas = [];

  const cerrarCampo = () => {
    fila.push(citado ? campo.slice(0, finCitado) + campo.slice(finCitado).trim() : campo.trim());
    campo = '';
    citado = false;
  };
  const cerrarFila = () => {
    cerrarCampo();
    if (!(fila.length === 1 && fila[0] === '')) listas.push(fila);
    fila = [];
  };

  function empujar(t) {
    let i = 0;
    const n = t.length;
    while (i < n) {
      if (enComillas) {
        if (comillaPendiente) {
          comillaPendiente = false;
          if (t[i] === '"') {
            campo += '"';
            i++;
            continue;
          }
          enComillas = false; // la comilla era de cierre; t[i] se procesa fuera de comillas
          finCitado = campo.length;
          continue;
        }
        const j = t.indexOf('"', i);
        if (j === -1) {
          campo += t.slice(i);
          return;
        }
        campo += t.slice(i, j);
        comillaPendiente = true;
        i = j + 1;
        continue;
      }
      const c = t[i];
      if (c === sep) {
        cerrarCampo();
        i++;
      } else if (c === '\n') {
        cerrarFila();
        i++;
      } else if (c === '\r') {
        i++;
      } else if (c === '"' && !citado && campo.trim() === '') {
        enComillas = true;
        citado = true;
        campo = '';
        i++;
      } else {
        let j = i + 1;
        while (j < n) {
          const d = t[j];
          if (d === sep || d === '\n' || d === '\r' || d === '"') break;
          j++;
        }
        campo += t.slice(i, j);
        i = j;
        // una comilla en medio de un campo sin comillas se toma literal
        if (j < n && t[j] === '"' && campo.trim() !== '') {
          campo += '"';
          i = j + 1;
        }
      }
    }
  }

  return {
    empujar,
    terminar() {
      if (comillaPendiente) {
        comillaPendiente = enComillas = false;
        finCitado = campo.length;
      }
      if (campo !== '' || fila.length) cerrarFila();
    },
    tomar() {
      return listas.splice(0, listas.length);
    },
  };
}

// ---------- apertura de fuentes tabulares ----------

/** CSV a partir de trozos de bytes (de la red o de un ZIP), en flujo y con tope de bytes. */
async function csvDesdeTrozos(iterador, { limite, cerrar, inicio = [], estado }) {
  let n = inicio.reduce((s, t) => s + t.length, 0);
  while (n < MUESTRA_BYTES) {
    const { value, done } = await iterador.next();
    if (done) break;
    inicio.push(value);
    n += value.length;
  }
  const muestra = unir(inicio, n);
  const codificacion = detectarCodificacion(muestra.subarray(0, MUESTRA_BYTES));
  const separador = detectarSeparador(new TextDecoder(codificacion).decode(muestra.subarray(0, MUESTRA_BYTES)));

  async function* bytesConLimite() {
    for (const c of inicio) {
      if (estado.bytes + c.length > limite) {
        estado.truncado = true;
        yield c.subarray(0, limite - estado.bytes);
        estado.bytes = limite;
        return;
      }
      estado.bytes += c.length;
      yield c;
    }
    for (;;) {
      const { value, done } = await iterador.next();
      if (done) return;
      if (estado.bytes + value.length > limite) {
        estado.truncado = true;
        return;
      }
      estado.bytes += value.length;
      yield value;
    }
  }

  async function* filas() {
    const dec = new TextDecoder(codificacion); // quita el BOM de UTF-8 por defecto
    const parser = crearParserCsv(separador);
    let cabecera = null;
    const aObjeto = (f) => {
      const o = {};
      for (let i = 0; i < cabecera.length; i++) o[cabecera[i]] = f[i] ?? '';
      return o;
    };
    try {
      for await (const trozo of bytesConLimite()) {
        parser.empujar(dec.decode(trozo, { stream: true }));
        for (const f of parser.tomar()) {
          if (!cabecera) cabecera = nombresDeColumnas(f);
          else yield aObjeto(f);
        }
      }
      parser.empujar(dec.decode());
      // si se truncó, la última fila puede estar incompleta: se descarta
      if (!estado.truncado) parser.terminar();
      for (const f of parser.tomar()) {
        if (!cabecera) cabecera = nombresDeColumnas(f);
        else yield aObjeto(f);
      }
    } finally {
      cerrar();
    }
  }

  return { filas: filas(), estado, cerrar, meta: { formato: 'csv', codificacion, separador: separador === '\t' ? 'tab' : separador } };
}

/** Nombres de columna limpios y sin repetir. */
function nombresDeColumnas(fila) {
  const vistos = new Map();
  return fila.map((c, i) => {
    let n = String(c ?? '').replace(/\s+/g, ' ').trim() || `columna_${i + 1}`;
    const k = vistos.get(n) || 0;
    vistos.set(n, k + 1);
    if (k) n = `${n}_${k + 1}`;
    return n;
  });
}

function valorDeCelda(v) {
  if (v instanceof Date) {
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
  }
  return v === null || v === undefined ? '' : typeof v === 'string' ? v.trim() : v;
}

/** Hoja de cálculo (XLSX, XLS antiguo u ODS) con SheetJS. Detecta la fila de encabezados. */
function abrirHoja(bytes, { hoja, filaEncabezado, filasMax } = {}) {
  const libro = XLSX.read(bytes, { type: 'array', dense: true, cellDates: true, cellHTML: false, cellFormula: false, sheetRows: filasMax || 0 });
  const nombres = libro.SheetNames;
  const conDatos = (n) => libro.Sheets[n]?.['!ref'];
  let nombre;
  if (hoja !== undefined && hoja !== null && hoja !== '') {
    const h = String(hoja);
    nombre =
      nombres.find((n) => n === h) ||
      nombres.find((n) => sinTildes(n) === sinTildes(h)) ||
      (/^\d+$/.test(h) ? nombres[Number(h) - 1] : undefined);
    if (!nombre) throw new Error(`La hoja "${h}" no existe. Hojas: ${nombres.join(', ')}`);
  } else nombre = nombres.find(conDatos) || nombres[0];
  const ws = libro.Sheets[nombre];
  const inicioFila = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']).s.r : 0;
  const matriz = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: true }).map((f) => f.map(valorDeCelda));
  const llenas = (f) => f.filter((v) => v !== '').length;

  // Encabezado: la fila indicada o la primera "ancha" y mayormente de texto (muchas hojas del
  // Estado traen títulos y notas arriba de la tabla).
  let idx;
  if (filaEncabezado) idx = filaEncabezado - 1 - inicioFila;
  else {
    const primeras = matriz.slice(0, 30);
    const maximo = Math.max(0, ...primeras.map(llenas));
    idx = primeras.findIndex((f) => {
      const vals = f.filter((v) => v !== '');
      return vals.length >= Math.max(2, Math.ceil(maximo * 0.6)) && vals.filter((v) => typeof v === 'string').length >= vals.length / 2;
    });
    if (idx < 0) idx = Math.max(0, matriz.findIndex((f) => llenas(f) > 0));
  }
  const cabecera = nombresDeColumnas(matriz[idx] || []);
  const datos = matriz.slice(idx + 1);
  async function* filas() {
    for (const f of datos) {
      if (!llenas(f)) continue;
      const o = {};
      for (let i = 0; i < cabecera.length; i++) o[cabecera[i]] = f[i] ?? '';
      yield o;
    }
  }
  return {
    filas: filas(),
    meta: { hojas: nombres, hoja: nombre, fila_encabezado: inicioFila + idx + 1 },
  };
}

/** Elige la entrada tabular de un ZIP: la indicada o la más grande. */
function elegirEntradaTabular(entradas, archivo) {
  if (archivo) {
    const a = sinTildes(archivo);
    const e =
      entradas.find((x) => x.nombre === archivo) ||
      entradas.find((x) => sinTildes(x.nombre) === a) ||
      entradas.find((x) => sinTildes(x.nombre.split('/').pop()) === a.split('/').pop());
    if (!e) throw new Error(`El ZIP no contiene "${archivo}". Contiene: ${entradas.map((x) => x.nombre).slice(0, 40).join(', ')}`);
    return e;
  }
  const tabulares = entradas.filter((x) => ['csv', 'hoja'].includes(tipoPorNombre(x.nombre))).sort((p, q) => q.tamano - p.tamano);
  if (!tabulares.length) {
    throw new Error(
      `El ZIP no contiene CSV ni hojas de cálculo. Contiene: ${entradas.map((x) => x.nombre).slice(0, 40).join(', ')}. ` +
        'Usa explorar_zip para ver su contenido o leer_documento con "archivo" para leer un PDF o DOCX de adentro.',
    );
  }
  return tabulares[0];
}

/**
 * Abre cualquier fuente tabular: CSV (en flujo), XLSX/XLS/ODS, o un CSV/hoja dentro de un ZIP.
 * El tipo se decide por la firma del archivo, no por el formato declarado en el portal.
 */
async function abrirTabla(plataforma, url, { maxMb, hoja, archivo, filaEncabezado, filasMax } = {}) {
  const limite = maxMb * MB;
  const topeCompleto = (plataforma.maxMbCompleto ?? 200) * MB;
  const res = await plataforma.abrirBytes(url, {
    headers: { 'User-Agent': plataforma.userAgent },
    maxBytes: Math.max(limite, topeCompleto),
  });
  if (res.status >= 400) throw new Error(`No se pudo descargar el recurso (HTTP ${res.status})`);
  if (/html/i.test(res.tipo || '')) {
    res.cerrar();
    throw new Error('El enlace devuelve una página HTML, no un archivo de datos (posible enlace roto o caído)');
  }
  const estado = { bytes: 0, truncado: false, tamanoTotal: res.tamanoTotal || null };
  const iterador = res.trozos[Symbol.asyncIterator]();
  const inicio = [];
  let n = 0;
  while (n < 8) {
    const { value, done } = await iterador.next();
    if (done) break;
    inicio.push(value);
    n += value.length;
  }
  const cabeza = unir(inicio, n);

  if (!esZip(cabeza) && !esOle(cabeza)) {
    if (esPdf(cabeza)) {
      res.cerrar();
      throw new Error('El recurso es un PDF, no una tabla. Usa leer_documento para leerlo.');
    }
    const r = await csvDesdeTrozos(iterador, { limite, cerrar: () => res.cerrar(), inicio, estado });
    // En el teléfono la descarga ya viene cortada por la cabecera Range.
    if (res.truncado && (res.tamanoTotal || 0) > limite) estado.truncado = true;
    return r;
  }

  // Contenedor (XLSX, XLS, ZIP): hace falta el archivo completo.
  const trozos = [...inicio];
  try {
    for (;;) {
      const { value, done } = await iterador.next();
      if (done) break;
      n += value.length;
      if (n > topeCompleto) break;
      trozos.push(value);
    }
  } finally {
    res.cerrar();
  }
  if (n > topeCompleto || res.truncado) {
    throw new Error(`El archivo supera el tope de ${Math.round(topeCompleto / MB)} MB para leerlo completo en este dispositivo`);
  }
  const bytes = unir(trozos, n);
  estado.bytes = bytes.length;
  const tipo = tipoDeContenido(bytes, url);
  if (['xlsx', 'xls', 'ods'].includes(tipo)) {
    const h = abrirHoja(bytes, { hoja, filaEncabezado, filasMax });
    return { filas: h.filas, estado, cerrar() {}, meta: { formato: tipo, ...h.meta } };
  }
  if (tipo === 'docx' || tipo === 'doc') throw new Error('El recurso es un documento de Word. Usa leer_documento para leerlo.');
  if (tipo !== 'zip') throw new Error(`Formato no soportado para consultas: ${tipo}`);

  const entradas = listarZip(bytes);
  const e = elegirEntradaTabular(entradas, archivo);
  const otros = entradas.filter((x) => x !== e && ['csv', 'hoja'].includes(tipoPorNombre(x.nombre))).map((x) => x.nombre);
  const metaZip = { archivo: e.nombre, otros_archivos_tabulares: otros.length ? otros.slice(0, 30) : undefined };
  if (tipoPorNombre(e.nombre) === 'hoja') {
    const interno = extraerEntrada(bytes, e.nombre, topeCompleto * 4);
    const h = abrirHoja(interno, { hoja, filaEncabezado, filasMax });
    return { filas: h.filas, estado, cerrar() {}, meta: { formato: `zip → ${tipoDeContenido(interno, e.nombre)}`, ...metaZip, ...h.meta } };
  }
  const estadoInterno = { bytes: 0, truncado: false, tamanoTotal: e.tamano };
  const it = trozosDeEntrada(bytes, e.nombre)[Symbol.asyncIterator]();
  // El ZIP ya está en memoria y se descomprime en flujo: el tope de descarga no aplica, solo uno de seguridad.
  const limiteInterno = Math.max(limite, (plataforma.maxMbDescomprimido ?? 300) * MB);
  const r = await csvDesdeTrozos(it, { limite: limiteInterno, cerrar() {}, estado: estadoInterno });
  return { ...r, meta: { ...r.meta, formato: 'zip → csv', ...metaZip } };
}

// Vista rápida de una entrada tabular de un ZIP (para explorar_zip): columnas y 3 filas.
export async function vistaDeEntrada(bytes, entrada, topeBytes) {
  let fuente;
  if (tipoPorNombre(entrada.nombre) === 'hoja') {
    fuente = abrirHoja(extraerEntrada(bytes, entrada.nombre, topeBytes), { filasMax: 40 });
  } else {
    const it = trozosDeEntrada(bytes, entrada.nombre)[Symbol.asyncIterator]();
    fuente = await csvDesdeTrozos(it, { limite: 2 * MB, cerrar() {}, estado: { bytes: 0, truncado: false } });
  }
  const filas = [];
  for await (const f of fuente.filas) {
    filas.push(f);
    if (filas.length >= 3) break;
  }
  return { columnas: filas.length ? Object.keys(filas[0]) : [], ejemplo: filas, ...(fuente.meta?.hojas ? { hojas: fuente.meta.hojas } : {}) };
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

// ---------- operaciones expuestas ----------

export function crearLectorCsv(plataforma, { maxMbDefecto = 300, maxMbPrevia = 2 } = {}) {
  /** Devuelve columnas, tipos inferidos y las primeras filas (CSV, XLSX, XLS o dentro de un ZIP). */
  async function previsualizar(url, { filas = 10, hoja, archivo, fila_encabezado } = {}) {
    const csv = await abrirTabla(plataforma, url, { maxMb: maxMbPrevia, hoja, archivo, filaEncabezado: fila_encabezado, filasMax: 80 });
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
      ...csv.meta,
      tamano_total_bytes: csv.estado.tamanoTotal,
      columnas: columnas.map((c) => ({
        nombre: c,
        tipo: inferirTipo(muestra.map((f) => f[c])),
        ejemplo: muestra.find((f) => f[c])?.[c] ?? null,
      })),
      filas: muestra.slice(0, filas),
    };
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
  async function consultar(url, o = {}) {
    const { filtros = [], agrupar_por = [], columnas: proyectar, limite = 20, hoja, archivo, fila_encabezado } = o;
    const maxMb = Math.min(o.max_mb || maxMbDefecto, plataforma.maxMbTope || Infinity);
    const metricas = o.metricas?.length ? o.metricas : [{ operacion: 'contar' }];
    for (const f of filtros) {
      if (!OPERADORES[f.operador]) throw new Error(`Operador "${f.operador}" no válido. Usa: ${LISTA_OPERADORES.join(', ')}`);
    }

    const t0 = Date.now();
    const csv = await abrirTabla(plataforma, url, { maxMb, hoja, archivo, filaEncabezado: fila_encabezado });
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
          filasSalida.push(resueltas.proyectar ? Object.fromEntries(resueltas.proyectar.map((p) => [p, fila[p]])) : fila);
        }
      }
    } finally {
      csv.cerrar();
    }

    const nombreMetrica = (m) => (m.operacion === 'contar' ? 'contar' : `${m.operacion}(${m.columna})`);
    const ms = resueltas?.metricas || metricas;
    const resultado = {
      ...csv.meta,
      filas_leidas: leidas,
      filas_que_cumplen: coinciden,
      lectura_completa: !csv.estado.truncado,
      bytes_leidos: csv.estado.bytes,
      segundos: Number(((Date.now() - t0) / 1000).toFixed(2)),
      totales: Object.fromEntries(ms.map((m, i) => [nombreMetrica(m), cerrarAcumulador(metricasGlobales[i], m)])),
    };
    if (csv.estado.truncado) {
      resultado.advertencia =
        `Se alcanzó el límite de ${maxMb} MB: los resultados son PARCIALES. ` +
        (plataforma.maxMbTope ? `En este dispositivo el tope es ${plataforma.maxMbTope} MB.` : 'Sube max_mb si se necesita el total exacto.');
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

  return { previsualizar, consultar };
}
