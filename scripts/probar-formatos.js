// Prueba las herramientas con recursos reales de cada formato (PDF, DOCX, XLSX, XLS, ZIP).
//   node scripts/probar-formatos.js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { crearServidorMcp } from '../src/core/servidor.js';
import { crearPlataformaNode } from '../src/plataforma-node.js';

const BASE = 'https://www.datosabiertos.gob.pe/sites/default/files/';
const CASOS = [
  ['leer_documento', { url: BASE + 'DICCIONARIO%20DE%20DATOS%20TEDEF%20-%20ATENCIONES.pdf', max_caracteres: 1500 }],
  ['leer_documento', { url: BASE + 'DICCIONARIO_DATOS_PASLC_MEJORADO.docx', max_caracteres: 1500 }],
  ['previsualizar_recurso', { url: BASE + 'Formato_DiccionarioDatos%20SGSD%20Alertas%20preventivas.xlsx', filas: 3 }],
  ['previsualizar_recurso', { url: BASE + 'Plantaciones_170.xls', filas: 2 }],
  ['explorar_zip', { url: BASE + 'ReporteDatosAbiertos_202306_0.zip', max_vistas: 2 }],
  ['previsualizar_recurso', { url: BASE + 'Carnes%20Universitarios%202018.xls', filas: 2 }],
  ['consultar_recurso', { url: BASE + 'ReporteDatosAbiertos_202306_0.zip', agrupar_por: ['NombreProvincia'], metricas: [{ operacion: 'suma', columna: 'M_Total' }, { operacion: 'contar' }], limite: 5 }],
  ['consultar_recurso', { url: BASE + 'Plantaciones_170.xls', agrupar_por: ['DEPARTAMENTO'], metricas: [{ operacion: 'suma', columna: 'SUPERFICIE PLANTACION' }], limite: 3 }],
];

const p = crearPlataformaNode();
p.log = () => {};
const { server } = crearServidorMcp(p);
const c = new Client({ name: 'formatos', version: '1' });
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(b);
await c.connect(a);
const { tools } = await c.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));
for (const [nombre, args] of CASOS) {
  const t0 = Date.now();
  const r = await c.callTool({ name: nombre, arguments: args }, undefined, { timeout: 600_000 });
  const txt = r.content[0].text;
  console.log(`\n### ${nombre} ${args.url.split('/').pop()} (${Date.now() - t0} ms)${r.isError ? ' ERROR' : ''}\n${txt.slice(0, 1300)}`);
}
await c.close();
