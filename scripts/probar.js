// Prueba de extremo a extremo: lanza el servidor por stdio como lo haría un host MCP
// (Claude Desktop, VS Code…) y ejecuta el flujo completo de herramientas.
//   node scripts/probar.js "fallecidos covid"
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const consulta = process.argv[2] || 'fallecidos covid';
const AQUI = dirname(fileURLToPath(import.meta.url));

const cliente = new Client({ name: 'probador', version: '0.1.0' });
await cliente.connect(
  new StdioClientTransport({ command: process.execPath, args: [join(AQUI, '..', 'src', 'server.js')], stderr: 'inherit' }),
);

const llamar = async (name, args) => {
  const t0 = Date.now();
  const r = await cliente.callTool({ name, arguments: args }, undefined, { timeout: 15 * 60_000 });
  const texto = r.content[0].text;
  console.log(`\n### ${name} (${Date.now() - t0} ms)${r.isError ? ' ERROR' : ''}\n${texto.slice(0, 1500)}`);
  return r.isError ? null : JSON.parse(texto);
};

const { tools } = await cliente.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));
console.log('prompts:', (await cliente.listPrompts()).prompts.map((p) => p.name).join(', '));
console.log('resources:', (await cliente.listResources()).resources.map((r) => r.uri).join(', '));

const busqueda = await llamar('buscar_datasets', { consulta, formato: 'csv', limite: 3 });
const primero = busqueda?.resultados[0];
if (primero) {
  const ds = await llamar('ver_dataset', { nombre: primero.nombre });
  const csv = ds?.recursos.find((r) => r.formato === 'csv');
  if (csv) {
    const vista = await llamar('previsualizar_recurso', { recurso_id: csv.id, filas: 3 });
    const texto = vista?.columnas.find((c) => c.tipo === 'texto');
    if (texto) {
      await llamar('consultar_recurso', {
        recurso_id: csv.id,
        agrupar_por: [texto.nombre],
        limite: 5,
        max_mb: 50,
      });
    }
  }
}
await cliente.close();
