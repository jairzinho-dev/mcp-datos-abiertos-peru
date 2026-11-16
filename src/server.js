#!/usr/bin/env node
// Servidor MCP para la Plataforma Nacional de Datos Abiertos del Perú (datosabiertos.gob.pe).
// Expone las tres primitivas de MCP:
//   - tools:     buscar, inspeccionar, previsualizar y consultar datasets
//   - resources: resumen del catálogo (pnda://catalogo/resumen)
//   - prompts:   plantilla de análisis con citación de fuente
// Transporte: stdio (JSON-RPC 2.0). Logs a stderr; cada llamada a tool se registra en logs/.

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ckan, normalizarDataset } from './ckan.js';
import { buscar, buscarPorNombreOId, entidades, estadoCatalogo, obtenerCatalogo } from './indice.js';
import { consultar, LISTA_OPERADORES, previsualizar } from './csv.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const DIR_LOGS = process.env.PNDA_LOG_DIR || join(AQUI, '..', 'logs');
const log = (...a) => console.error('[pnda]', ...a);
const MAX_SALIDA = 60_000; // caracteres por respuesta, para no saturar el contexto del LLM

const server = new McpServer({ name: 'datos-abiertos-peru', version: '0.1.0' });

// ---------- utilidades ----------

function registrar(tool, args, ms, ok, error) {
  try {
    mkdirSync(DIR_LOGS, { recursive: true });
    appendFileSync(
      join(DIR_LOGS, 'llamadas.jsonl'),
      JSON.stringify({ fecha: new Date().toISOString(), tool, args, ms, ok, error }) + '\n',
    );
  } catch {}
}

/** Envuelve un handler: serializa a JSON, recorta, mide tiempo y convierte errores en isError. */
function envolver(nombre, fn) {
  return async (args) => {
    const t0 = Date.now();
    try {
      const r = await fn(args);
      registrar(nombre, args, Date.now() - t0, true);
      let texto = JSON.stringify(r, null, 1);
      if (texto.length > MAX_SALIDA) texto = texto.slice(0, MAX_SALIDA) + '\n…[respuesta recortada: usa un límite menor]';
      return { content: [{ type: 'text', text: texto }] };
    } catch (e) {
      registrar(nombre, args, Date.now() - t0, false, e.message);
      log(nombre, 'error:', e.message);
      return { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] };
    }
  };
}

/**
 * Resuelve el recurso a leer y valida que sea una URL del Estado peruano (evita que el LLM
 * use el servidor para descargar URLs arbitrarias: SSRF).
 */
async function resolverRecurso({ url, recurso_id }) {
  const cat = await obtenerCatalogo();
  if (recurso_id) {
    for (const d of cat.datasets) {
      const r = d.recursos.find((x) => x.id === recurso_id);
      if (r) return { url: r.url, dataset: d.nombre, recurso: r.nombre, formato: r.formato };
    }
    throw new Error(`No existe un recurso con id ${recurso_id} en el catálogo`);
  }
  if (!url) throw new Error('Indica recurso_id (preferido) o url');
  const enCatalogo = cat.datasets.some((d) => d.recursos.some((r) => r.url === url));
  const host = new URL(url).hostname;
  if (!enCatalogo && !/(^|\.)gob\.pe$/i.test(host)) {
    throw new Error('Solo se permiten recursos del catálogo de la PNDA o de dominios .gob.pe');
  }
  return { url };
}

function resumenDataset(d) {
  return {
    nombre: d.nombre,
    titulo: d.titulo,
    entidades: d.entidades,
    modificado: d.modificado,
    relevancia: d.relevancia,
    descripcion: d.descripcion.length > 280 ? d.descripcion.slice(0, 280) + '…' : d.descripcion,
    formatos: [...new Set(d.recursos.map((r) => r.formato))],
    url: d.url,
  };
}

// ---------- tools ----------

server.registerTool(
  'buscar_datasets',
  {
    title: 'Buscar datasets',
    description:
      'Busca datasets en la Plataforma Nacional de Datos Abiertos del Perú por texto libre (ranking BM25 ' +
      'sobre título, entidad, etiquetas y descripción). Úsalo primero para encontrar qué datos existen. ' +
      'Devuelve el `nombre` de cada dataset, que luego se pasa a ver_dataset.',
    inputSchema: {
      consulta: z.string().describe('Texto libre, p. ej. "fallecidos covid", "ejecución presupuestal municipal"'),
      entidad: z.string().optional().describe('Filtra por entidad publicadora (subcadena), p. ej. "MINSA", "MEF", "INEI"'),
      formato: z.string().optional().describe('Solo datasets con un recurso de este formato, p. ej. "csv"'),
      modificado_desde: z.string().optional().describe('Fecha ISO mínima de última actualización, p. ej. "2025-01-01"'),
      limite: z.number().int().min(1).max(50).default(10),
    },
  },
  envolver('buscar_datasets', async ({ consulta, entidad, formato, modificado_desde, limite }) => {
    const r = await buscar({ consulta, entidad, formato, desde: modificado_desde, limite });
    return {
      total_coincidencias: r.total,
      terminos_buscados: r.terminos,
      resultados: r.resultados.map(resumenDataset),
    };
  }),
);

server.registerTool(
  'ver_dataset',
  {
    title: 'Ver dataset',
    description:
      'Metadatos completos de un dataset y la lista de sus recursos (archivos) con su `id`, formato, tamaño y URL. ' +
      'Consulta la API en vivo para tener la versión más reciente.',
    inputSchema: { nombre: z.string().describe('`nombre` (slug) o `id` del dataset, tal como lo devuelve buscar_datasets') },
  },
  envolver('ver_dataset', async ({ nombre }) => {
    try {
      const r = await ckan('package_show', { id: nombre });
      return normalizarDataset(Array.isArray(r) ? r[0] : r);
    } catch (e) {
      const local = await buscarPorNombreOId(nombre);
      if (local) return { ...local, nota: 'Datos del índice local (la API en vivo no respondió)' };
      throw e;
    }
  }),
);

server.registerTool(
  'listar_entidades',
  {
    title: 'Listar entidades',
    description: 'Entidades del Estado que publican datos en la PNDA, con su número de datasets (de mayor a menor).',
    inputSchema: {
      filtro: z.string().optional().describe('Subcadena para filtrar, p. ej. "municipalidad", "ministerio"'),
      limite: z.number().int().min(1).max(500).default(30),
    },
  },
  envolver('listar_entidades', async ({ filtro, limite }) => {
    const lista = await entidades(filtro);
    return { total: lista.length, entidades: lista.slice(0, limite) };
  }),
);

server.registerTool(
  'previsualizar_recurso',
  {
    title: 'Previsualizar recurso CSV',
    description:
      'Lee solo el inicio de un recurso CSV y devuelve sus columnas (con tipo inferido y ejemplo) y las primeras filas. ' +
      'Úsalo SIEMPRE antes de consultar_recurso para conocer los nombres exactos de las columnas.',
    inputSchema: {
      recurso_id: z.string().optional().describe('`id` del recurso (de ver_dataset). Preferido.'),
      url: z.string().url().optional().describe('URL directa del recurso, si no se tiene el id'),
      filas: z.number().int().min(1).max(50).default(5),
    },
  },
  envolver('previsualizar_recurso', async ({ recurso_id, url, filas }) => {
    const r = await resolverRecurso({ recurso_id, url });
    return { ...r, ...(await previsualizar(r.url, { filas })) };
  }),
);

const filtroSchema = z.object({
  columna: z.string(),
  operador: z.enum(LISTA_OPERADORES),
  valor: z.union([z.string(), z.number(), z.array(z.string())]),
});
const metricaSchema = z.object({
  operacion: z.enum(['contar', 'suma', 'promedio', 'min', 'max']),
  columna: z.string().optional().describe('Obligatoria salvo para "contar"'),
});

server.registerTool(
  'consultar_recurso',
  {
    title: 'Consultar recurso CSV',
    description:
      'Filtra y agrega un CSV completo en streaming (sin descargarlo a memoria) y devuelve el resultado calculado. ' +
      'Úsalo para responder preguntas cuantitativas ("¿cuántos…?", "¿cuánto se gastó…?", "top 5 de…"). ' +
      `Operadores: ${LISTA_OPERADORES.join(', ')} (comparación sin tildes ni mayúsculas; "en" acepta lista). ` +
      'Si no se indica agrupar_por, devuelve filas que cumplen los filtros. Revisa `lectura_completa`: si es false, ' +
      'el resultado es parcial.',
    inputSchema: {
      recurso_id: z.string().optional(),
      url: z.string().url().optional(),
      filtros: z.array(filtroSchema).default([]),
      agrupar_por: z.array(z.string()).default([]),
      metricas: z.array(metricaSchema).default([{ operacion: 'contar' }]).describe('Por defecto, contar filas'),
      columnas: z.array(z.string()).optional().describe('Columnas a devolver cuando no se agrupa'),
      limite: z.number().int().min(1).max(200).default(20).describe('Máximo de grupos o filas devueltos'),
      max_mb: z.number().min(1).max(3000).optional().describe('Tope de lectura en MB (por defecto 300)'),
    },
  },
  envolver('consultar_recurso', async ({ recurso_id, url, ...opciones }) => {
    const r = await resolverRecurso({ recurso_id, url });
    return { ...r, ...(await consultar(r.url, opciones)) };
  }),
);

server.registerTool(
  'actualizar_catalogo',
  {
    title: 'Actualizar catálogo',
    description: 'Vuelve a descargar el índice del catálogo desde la PNDA (normalmente no es necesario: se renueva cada 24 h).',
    inputSchema: {},
  },
  envolver('actualizar_catalogo', async () => {
    await obtenerCatalogo({ forzar: true });
    return estadoCatalogo();
  }),
);

// ---------- resources ----------

server.registerResource(
  'resumen-catalogo',
  'pnda://catalogo/resumen',
  {
    title: 'Resumen del catálogo PNDA',
    description: 'Totales del catálogo: datasets, recursos por formato y entidades con más publicaciones',
    mimeType: 'application/json',
  },
  async (uri) => {
    const c = await obtenerCatalogo();
    const formatos = {};
    for (const d of c.datasets) for (const r of d.recursos) formatos[r.formato] = (formatos[r.formato] || 0) + 1;
    const top = (await entidades()).slice(0, 15);
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({ ...estadoCatalogo(), recursos_por_formato: formatos, entidades_principales: top }, null, 1),
        },
      ],
    };
  },
);

server.registerResource(
  'dataset',
  new ResourceTemplate('pnda://dataset/{nombre}', { list: undefined }),
  { title: 'Dataset de la PNDA', description: 'Metadatos de un dataset por su nombre', mimeType: 'application/json' },
  async (uri, { nombre }) => {
    const d = await buscarPorNombreOId(decodeURIComponent(nombre));
    if (!d) throw new Error(`Dataset ${nombre} no encontrado`);
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(d, null, 1) }] };
  },
);

// ---------- prompts ----------

server.registerPrompt(
  'analizar_datos_publicos',
  {
    title: 'Analizar datos públicos',
    description: 'Guía al modelo para responder una pregunta con datos de la PNDA, citando la fuente',
    argsSchema: { pregunta: z.string().describe('Pregunta del ciudadano, p. ej. "¿Cuántos fallecidos por COVID hubo en Arequipa en 2021?"') },
  },
  ({ pregunta }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text:
            `Responde esta pregunta usando SOLO datos de la Plataforma Nacional de Datos Abiertos del Perú:\n\n"${pregunta}"\n\n` +
            'Procedimiento: (1) buscar_datasets; (2) ver_dataset del más pertinente; (3) previsualizar_recurso para ' +
            'conocer las columnas; (4) consultar_recurso para calcular la cifra. No inventes números: si los datos no ' +
            'alcanzan, dilo. Termina citando dataset, entidad, fecha de actualización y URL, e indica si la lectura fue parcial.',
        },
      },
    ],
  }),
);

// ---------- arranque ----------

const transporte = new StdioServerTransport();
await server.connect(transporte);
log('servidor listo (stdio)');
// Precarga del índice en segundo plano para que la primera búsqueda sea rápida.
obtenerCatalogo().catch((e) => log('no se pudo precargar el catálogo:', e.message));
