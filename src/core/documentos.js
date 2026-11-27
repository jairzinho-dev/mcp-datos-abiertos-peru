// Herramientas para recursos que no son tablas: leer documentos (PDF, DOCX, HTML, texto) como
// Markdown y explorar archivos ZIP (contenido, metadatos y vista rápida de cada archivo).

import * as XLSX from 'xlsx';
import { MB, decodificarTexto, descargarCompleto, docxAMarkdown, extraerEntrada, htmlATexto, listarZip, tipoDeContenido, tipoPorNombre } from './archivos.js';
import { pdfAMarkdown } from './pdf.js';
import { vistaDeEntrada } from './csv.js';

function sinTildes(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function buscarEntrada(entradas, archivo) {
  const a = sinTildes(archivo);
  const e =
    entradas.find((x) => x.nombre === archivo) ||
    entradas.find((x) => sinTildes(x.nombre) === a) ||
    entradas.find((x) => sinTildes(x.nombre.split('/').pop()) === a.split('/').pop());
  if (!e) throw new Error(`El ZIP no contiene "${archivo}". Contiene: ${entradas.map((x) => x.nombre).slice(0, 40).join(', ')}`);
  return e;
}

function recortar(texto, desde, max) {
  const total = texto.length;
  const inicio = Math.min(Math.max(0, desde), total);
  const fin = Math.min(total, inicio + max);
  return { markdown: texto.slice(inicio, fin), caracteres_totales: total, desde_caracter: inicio, siguiente_caracter: fin < total ? fin : null };
}

export function crearLectorDocumentos(plataforma) {
  const tope = () => (plataforma.maxMbCompleto ?? 200) * MB;

  /** Convierte a Markdown un PDF, DOCX, HTML, texto u hoja de cálculo (también dentro de un ZIP). */
  async function leer(url, { archivo, desde_pagina = 1, desde_caracter = 0, max_caracteres = 10_000 } = {}) {
    const { bytes: crudos, tamanoTotal } = await descargarCompleto(plataforma, url, tope());
    let bytes = crudos;
    let nombre = decodeURIComponent(url.split('?')[0].split('/').pop() || '');
    let tipo = tipoDeContenido(bytes, nombre);
    let dentroDe;
    if (tipo === 'zip') {
      const entradas = listarZip(bytes);
      if (!archivo) {
        const docs = entradas.filter((x) => tipoPorNombre(x.nombre) === 'documento');
        if (docs.length !== 1) {
          throw new Error(
            `Es un ZIP con ${entradas.length} archivos; indica cuál leer con "archivo". ` +
              `Documentos: ${docs.map((x) => x.nombre).slice(0, 30).join(', ') || 'ninguno'}. Usa explorar_zip para ver todo.`,
          );
        }
        archivo = docs[0].nombre;
      }
      const e = buscarEntrada(entradas, archivo);
      bytes = extraerEntrada(crudos, e.nombre, tope() * 4);
      dentroDe = nombre;
      nombre = e.nombre;
      tipo = tipoDeContenido(bytes, nombre);
    }
    const base = { archivo: nombre, dentro_de_zip: dentroDe, tamano_bytes: dentroDe ? bytes.length : tamanoTotal };

    if (tipo === 'pdf') {
      if (!plataforma.cargarPdfjs) throw new Error('Esta plataforma no puede leer PDF');
      const pdfjs = await plataforma.cargarPdfjs();
      const r = await pdfAMarkdown(pdfjs, bytes, { desde: desde_pagina, maxCaracteres: max_caracteres });
      if (r.sin_texto) r.aviso = 'Las páginas leídas no tienen texto seleccionable: probablemente es un documento escaneado (imagen).';
      return { ...base, ...r };
    }
    if (tipo === 'docx') {
      const { markdown, metadatos } = docxAMarkdown(bytes);
      return { ...base, tipo, metadatos, ...recortar(markdown, desde_caracter, max_caracteres) };
    }
    if (tipo === 'html' || tipo === 'texto') {
      const texto = decodificarTexto(bytes);
      return { ...base, tipo, ...recortar(tipo === 'html' ? htmlATexto(texto) : texto, desde_caracter, max_caracteres) };
    }
    if (['xlsx', 'xls', 'ods'].includes(tipo)) {
      // Hojas pequeñas (diccionarios de datos, catálogos) se devuelven como tablas Markdown.
      const libro = XLSX.read(bytes, { type: 'array', dense: true, cellDates: true, sheetRows: 200 });
      const partes = libro.SheetNames.map((h) => `## Hoja: ${h}\n\n` + aTablaMarkdown(libro.Sheets[h]));
      return {
        ...base,
        tipo,
        hojas: libro.SheetNames,
        nota: 'Se muestran hasta 200 filas por hoja. Para calcular sobre la hoja completa usa consultar_recurso.',
        ...recortar(partes.join('\n\n'), desde_caracter, max_caracteres),
      };
    }
    if (tipo === 'doc') throw new Error('Es un documento de Word antiguo (.doc), que no se puede leer; solo .docx.');
    throw new Error(`No se puede leer este tipo de archivo (${tipo})`);
  }

  /** Lista el contenido de un ZIP y da una vista rápida de sus tablas. */
  async function explorarZip(url, { max_vistas = 5 } = {}) {
    const { bytes, tamanoTotal } = await descargarCompleto(plataforma, url, tope());
    if (tipoDeContenido(bytes) !== 'zip') {
      throw new Error('El recurso no es un ZIP genérico (puede ser XLSX o DOCX): usa previsualizar_recurso o leer_documento.');
    }
    const entradas = listarZip(bytes);
    const total = entradas.reduce((s, e) => s + e.tamano, 0);
    const porTipo = {};
    for (const e of entradas) {
      const t = tipoPorNombre(e.nombre);
      porTipo[t] = (porTipo[t] || 0) + 1;
    }
    const lista = entradas.slice(0, 150).map((e) => ({ nombre: e.nombre, tipo: tipoPorNombre(e.nombre), tamano_bytes: e.tamano }));
    const vistas = [];
    for (const e of entradas.filter((x) => ['csv', 'hoja'].includes(tipoPorNombre(x.nombre))).sort((p, q) => q.tamano - p.tamano).slice(0, max_vistas)) {
      try {
        vistas.push({ archivo: e.nombre, ...(await vistaDeEntrada(bytes, e, tope())) });
      } catch (err) {
        vistas.push({ archivo: e.nombre, error: err.message });
      }
    }
    return {
      tamano_zip_bytes: tamanoTotal,
      tamano_descomprimido_bytes: total,
      numero_de_archivos: entradas.length,
      archivos_por_tipo: porTipo,
      archivos: lista,
      archivos_omitidos: entradas.length > lista.length ? entradas.length - lista.length : undefined,
      vista_de_tablas: vistas,
      como_seguir:
        'Para calcular sobre una tabla usa previsualizar_recurso / consultar_recurso con el mismo recurso y "archivo". ' +
        'Para leer un PDF, DOCX o texto de adentro usa leer_documento con "archivo".',
    };
  }

  return { leer, explorarZip };
}

function aTablaMarkdown(ws) {
  const filas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: false });
  if (!filas.length) return '_(hoja vacía)_';
  const ancho = Math.max(...filas.map((f) => f.length));
  const celda = (v) => String(v ?? '').replace(/\s+/g, ' ').replace(/\|/g, '/').trim();
  const fila = (f) => '| ' + Array.from({ length: ancho }, (_, i) => celda(f[i])).join(' | ') + ' |';
  return [fila(filas[0]), '|' + ' --- |'.repeat(ancho), ...filas.slice(1).map(fila)].join('\n');
}
