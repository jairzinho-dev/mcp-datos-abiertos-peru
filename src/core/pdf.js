// PDF → Markdown con pdf.js (Mozilla). pdf.js lo carga la plataforma (en Node y en el WebView se
// configura distinto), así este módulo sigue siendo isomórfico.
// Reconstruye las líneas a partir de las posiciones del texto: agrupa por altura, ordena por x,
// marca como título las líneas con letra más grande, separa párrafos por el espacio vertical y
// convierte los huecos horizontales grandes en " | " para que las tablas sigan siendo legibles.

function mediana(xs) {
  if (!xs.length) return 0;
  const a = [...xs].sort((p, q) => p - q);
  return a[Math.floor(a.length / 2)];
}

function paginaAMarkdown(items) {
  const elems = items
    .filter((it) => it.str !== undefined && (it.str.trim() || it.width > 0))
    .map((it) => {
      const [, , c, d, x, y] = it.transform;
      const alto = Math.abs(it.height) || Math.hypot(c, d) || 10;
      return { s: it.str, x, y, ancho: it.width || 0, alto };
    })
    .filter((e) => e.s.trim());
  if (!elems.length) return { texto: '', caracteres: 0 };

  // Agrupar en líneas por coordenada y (tolerancia: media altura de letra)
  elems.sort((a, b) => b.y - a.y || a.x - b.x);
  const lineas = [];
  for (const e of elems) {
    const l = lineas[lineas.length - 1];
    if (l && Math.abs(l.y - e.y) <= Math.max(l.alto, e.alto) * 0.5) {
      l.items.push(e);
      l.alto = Math.max(l.alto, e.alto);
    } else lineas.push({ y: e.y, alto: e.alto, items: [e] });
  }
  const cuerpo = mediana(lineas.map((l) => l.alto));

  let salida = '';
  let anterior = null;
  let caracteres = 0;
  for (const l of lineas) {
    l.items.sort((a, b) => a.x - b.x);
    let txt = '';
    let fin = null;
    for (const it of l.items) {
      if (fin !== null) {
        const hueco = it.x - fin;
        if (hueco > it.alto * 1.8) txt += ' | ';
        else if (hueco > it.alto * 0.12 && !txt.endsWith(' ') && !it.s.startsWith(' ')) txt += ' ';
      }
      txt += it.s;
      fin = it.x + it.ancho;
    }
    txt = txt.replace(/\s+/g, ' ').trim();
    if (!txt) continue;
    caracteres += txt.length;
    const esTitulo = l.alto >= cuerpo * 1.25 && txt.length < 120 && !txt.includes(' | ');
    if (anterior) {
      const salto = anterior.y - l.y;
      salida += esTitulo || salto > Math.max(anterior.alto, l.alto) * 1.7 ? '\n\n' : '\n';
    }
    salida += esTitulo ? `${l.alto >= cuerpo * 1.6 ? '#' : '##'} ${txt}` : txt;
    anterior = l;
  }
  return { texto: salida, caracteres };
}

/**
 * @param {object} pdfjs  módulo pdfjs-dist
 * @param {Uint8Array} bytes
 * @param {{desde?:number, maxCaracteres?:number, maxPaginas?:number}} o
 */
export async function pdfAMarkdown(pdfjs, bytes, { desde = 1, maxCaracteres = 10_000, maxPaginas = 40 } = {}) {
  const tarea = pdfjs.getDocument({
    data: new Uint8Array(bytes), // pdf.js se queda con el buffer: se le pasa una copia
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  const doc = await tarea.promise;
  try {
    const total = doc.numPages;
    let metadatos = {};
    try {
      const { info } = await doc.getMetadata();
      metadatos = {
        titulo: info?.Title || undefined,
        autor: info?.Author || undefined,
        asunto: info?.Subject || undefined,
        creado: info?.CreationDate || undefined,
        modificado: info?.ModDate || undefined,
        programa: info?.Producer || info?.Creator || undefined,
      };
    } catch {}
    const inicio = Math.min(Math.max(1, desde), total);
    let markdown = '';
    let hasta = inicio - 1;
    let conTexto = 0;
    for (let n = inicio; n <= total && n < inicio + maxPaginas; n++) {
      const pagina = await doc.getPage(n);
      const { items } = await pagina.getTextContent();
      const { texto, caracteres } = paginaAMarkdown(items);
      pagina.cleanup();
      if (caracteres > 20) conTexto++;
      const bloque = `\n\n<!-- página ${n} de ${total} -->\n\n${texto || '_(página sin texto: posible imagen escaneada)_'}`;
      if (markdown && markdown.length + bloque.length > maxCaracteres) break;
      markdown += bloque;
      hasta = n;
    }
    if (markdown.length > maxCaracteres) markdown = markdown.slice(0, maxCaracteres) + '\n…[texto recortado]';
    const leidas = hasta - inicio + 1;
    return {
      tipo: 'pdf',
      paginas_totales: total,
      desde_pagina: inicio,
      hasta_pagina: hasta,
      siguiente_pagina: hasta < total ? hasta + 1 : null,
      sin_texto: leidas > 0 && conTexto === 0,
      metadatos,
      markdown: markdown.trim(),
    };
  } finally {
    await tarea.destroy();
  }
}
