// Archivos que no son CSV: descarga completa, detección del tipo real por su firma (el formato
// declarado en el portal suele estar mal), ZIP (listado y descompresión en flujo), DOCX y HTML a
// Markdown. Isomórfico: usa fflate (JavaScript puro) y TextDecoder.

import { Unzip, UnzipInflate, unzipSync, strFromU8 } from 'fflate';

export const MB = 1024 * 1024;

// ---------- descarga ----------

/** Descarga un recurso completo (hasta maxBytes). Lanza un error claro si es más grande. */
export async function descargarCompleto(plataforma, url, maxBytes) {
  const res = await plataforma.abrirBytes(url, { headers: { 'User-Agent': plataforma.userAgent }, maxBytes });
  if (res.status >= 400) throw new Error(`No se pudo descargar el recurso (HTTP ${res.status})`);
  const trozos = [];
  let n = 0;
  try {
    for await (const t of res.trozos) {
      n += t.length;
      if (n > maxBytes) break;
      trozos.push(t);
    }
  } finally {
    res.cerrar();
  }
  if (n > maxBytes || res.truncado) {
    const total = res.tamanoTotal ? ` (${(res.tamanoTotal / MB).toFixed(1)} MB)` : '';
    throw new Error(`El archivo${total} supera el tope de ${Math.round(maxBytes / MB)} MB para leerlo completo en este dispositivo`);
  }
  return { bytes: unir(trozos, n), tipo: res.tipo || '', tamanoTotal: res.tamanoTotal || n };
}

export function unir(trozos, n = trozos.reduce((s, t) => s + t.length, 0)) {
  if (trozos.length === 1) return trozos[0];
  const out = new Uint8Array(n);
  let o = 0;
  for (const t of trozos) {
    out.set(t, o);
    o += t.length;
  }
  return out;
}

// ---------- tipo real por firma ----------

const empieza = (b, ...firma) => firma.every((x, i) => b[i] === x);
export const esZip = (b) => empieza(b, 0x50, 0x4b, 0x03, 0x04) || empieza(b, 0x50, 0x4b, 0x05, 0x06);
export const esOle = (b) => empieza(b, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1); // .xls / .doc antiguos
export const esPdf = (b) => {
  const s = String.fromCharCode(...b.subarray(0, 1024));
  return s.includes('%PDF-');
};

/** Clasifica el contenido: pdf, xlsx, docx, zip, ole (xls/doc antiguo), html o texto. */
export function tipoDeContenido(bytes, nombre = '') {
  if (esPdf(bytes)) return 'pdf';
  if (esOle(bytes)) return /\.doc$/i.test(nombre) ? 'doc' : 'xls';
  if (esZip(bytes)) {
    const n = listarZip(bytes).map((e) => e.nombre);
    if (n.includes('xl/workbook.xml')) return 'xlsx';
    if (n.includes('word/document.xml')) return 'docx';
    if (n.includes('content.xml') && /\.ods$/i.test(nombre)) return 'ods';
    return 'zip';
  }
  const muestra = new TextDecoder('utf-8').decode(bytes.subarray(0, 2048)).toLowerCase();
  if (/<!doctype html|<html[\s>]/.test(muestra)) return 'html';
  return 'texto';
}

export function tipoPorNombre(nombre) {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(nombre)?.[1]?.toLowerCase() || '';
  if (['csv', 'txt', 'tsv'].includes(ext)) return 'csv';
  if (['xlsx', 'xlsm', 'xls', 'ods'].includes(ext)) return 'hoja';
  if (['pdf', 'docx', 'doc', 'html', 'htm', 'md', 'json', 'xml'].includes(ext)) return 'documento';
  if (ext === 'zip') return 'zip';
  return 'otro';
}

// ---------- ZIP ----------

/** Lista las entradas de un ZIP sin descomprimirlas. */
export function listarZip(bytes) {
  const entradas = [];
  unzipSync(bytes, {
    filter(f) {
      if (!f.name.endsWith('/')) entradas.push({ nombre: f.name, comprimido: f.size, tamano: f.originalSize });
      return false;
    },
  });
  return entradas;
}

/** Descomprime una sola entrada a memoria (con tope de tamaño, contra "bombas zip"). */
export function extraerEntrada(bytes, nombre, maxBytes) {
  const e = listarZip(bytes).find((x) => x.nombre === nombre);
  if (!e) throw new Error(`El ZIP no contiene "${nombre}"`);
  if (e.tamano > maxBytes) {
    throw new Error(`"${nombre}" ocupa ${(e.tamano / MB).toFixed(1)} MB descomprimido, más que el tope de ${Math.round(maxBytes / MB)} MB`);
  }
  return unzipSync(bytes, { filter: (f) => f.name === nombre })[nombre];
}

/** Descomprime una entrada en flujo: devuelve trozos sin cargar el archivo completo en memoria. */
export async function* trozosDeEntrada(bytes, nombre) {
  const cola = [];
  let fin = false;
  let error = null;
  let encontrada = false;
  const uz = new Unzip((f) => {
    if (f.name !== nombre) return;
    encontrada = true;
    f.ondata = (err, dat, final) => {
      if (err) error = err;
      else if (dat?.length) cola.push(dat);
      if (final) fin = true;
    };
    f.start();
  });
  uz.register(UnzipInflate);
  const PASO = 256 * 1024;
  for (let i = 0; i < bytes.length && !fin; i += PASO) {
    uz.push(bytes.subarray(i, i + PASO), i + PASO >= bytes.length);
    if (error) throw error;
    while (cola.length) yield cola.shift();
    await new Promise((ok) => setTimeout(ok, 0));
  }
  while (cola.length) yield cola.shift();
  if (!encontrada) {
    // Algunos ZIP no traen los tamaños en la cabecera local: se descomprime de una vez.
    const datos = unzipSync(bytes, { filter: (f) => f.name === nombre })[nombre];
    if (!datos) throw new Error(`El ZIP no contiene "${nombre}"`);
    yield datos;
  }
}

// ---------- texto ----------

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodificarEntidades(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTIDADES[n.toLowerCase()] ?? m);
}

/** Decodifica texto probando UTF-8 y, si no es válido, Windows-1252. */
export function decodificarTexto(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

export function htmlATexto(html) {
  return decodificarEntidades(
    html
      .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '')
      .replace(/<h([1-6])[^>]*>/gi, (_, n) => '\n\n' + '#'.repeat(Number(n)) + ' ')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<\/(p|div|tr|h[1-6]|li|table|section|article)>|<br\s*\/?>/gi, '\n')
      .replace(/<\/t[dh]>/gi, ' | ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

// ---------- DOCX ----------

function textoDeXmlWord(xml) {
  let s = '';
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br(?:\s[^>]*)?\/>/g)) {
    if (m[1] !== undefined) s += m[1];
    else s += m[0].startsWith('<w:tab') ? '\t' : '\n';
  }
  return decodificarEntidades(s);
}

/** Convierte un .docx a Markdown: títulos, listas y tablas. */
export function docxAMarkdown(bytes) {
  const archivos = unzipSync(bytes, { filter: (f) => f.name === 'word/document.xml' || f.name === 'docProps/core.xml' });
  const xml = strFromU8(archivos['word/document.xml'] || new Uint8Array());
  const cuerpo = xml.slice(xml.indexOf('<w:body>'), xml.lastIndexOf('</w:body>'));
  const bloques = [];
  for (const m of cuerpo.matchAll(/<w:tbl[\s>][\s\S]*?<\/w:tbl>|<w:p[\s>][\s\S]*?<\/w:p>/g)) {
    const b = m[0];
    if (b.startsWith('<w:tbl')) {
      const filas = [...b.matchAll(/<w:tr[\s>][\s\S]*?<\/w:tr>/g)].map((tr) =>
        [...tr[0].matchAll(/<w:tc[\s>][\s\S]*?<\/w:tc>/g)].map((tc) =>
          [...tc[0].matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)].map((p) => textoDeXmlWord(p[0]).trim()).filter(Boolean).join(' ').replace(/\|/g, '/'),
        ),
      );
      if (!filas.length) continue;
      const ancho = Math.max(...filas.map((f) => f.length));
      const fila = (f) => '| ' + Array.from({ length: ancho }, (_, i) => f[i] ?? '').join(' | ') + ' |';
      bloques.push([fila(filas[0]), '|' + ' --- |'.repeat(ancho), ...filas.slice(1).map(fila)].join('\n'));
      continue;
    }
    const texto = textoDeXmlWord(b).trim();
    if (!texto) continue;
    const estilo = /<w:pStyle w:val="([^"]+)"/.exec(b)?.[1] || '';
    const nivel = /(?:heading|ttulo|titulo|título)\s*(\d)/i.exec(estilo)?.[1];
    if (nivel) bloques.push('#'.repeat(Math.min(Number(nivel), 4)) + ' ' + texto);
    else if (/^(title|ttulo|titulo)$/i.test(estilo)) bloques.push('# ' + texto);
    else if (/<w:numPr>/.test(b)) bloques.push('- ' + texto);
    else bloques.push(texto);
  }
  const core = archivos['docProps/core.xml'] ? strFromU8(archivos['docProps/core.xml']) : '';
  const campo = (n) => decodificarEntidades(new RegExp(`<[^>]*${n}[^>]*>([^<]*)<`).exec(core)?.[1] || '') || undefined;
  return {
    markdown: bloques.join('\n\n'),
    metadatos: { titulo: campo('title'), autor: campo('creator'), creado: campo('created'), modificado: campo('modified') },
  };
}
