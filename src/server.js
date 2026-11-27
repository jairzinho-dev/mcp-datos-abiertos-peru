#!/usr/bin/env node
// Servidor MCP para la Plataforma Nacional de Datos Abiertos del Perú (datosabiertos.gob.pe).
// Expone las tres primitivas de MCP (definidas en src/core/servidor.js):
//   - tools:     buscar, inspeccionar, previsualizar y consultar datasets
//   - resources: resumen del catálogo (pnda://catalogo/resumen) y pnda://dataset/{nombre}
//   - prompts:   plantilla de análisis con citación de fuente
// Transporte: stdio (JSON-RPC 2.0). Logs a stderr; cada llamada a tool se registra en logs/.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { crearServidorMcp } from './core/servidor.js';
import { crearPlataformaNode } from './plataforma-node.js';

const { server, indice } = crearServidorMcp(crearPlataformaNode());
await server.connect(new StdioServerTransport());
console.error('[pnda] servidor listo (stdio)');
// Precarga del índice en segundo plano para que la primera búsqueda sea rápida.
indice.obtenerCatalogo().catch((e) => console.error('[pnda] no se pudo precargar el catálogo:', e.message));
