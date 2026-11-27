// Ejecuta el agente de la app desde Node (mismo código que el APK), para probar y medir.
//   LLM_PROVEEDOR=gemini LLM_API_KEY=... [LLM_MODELO=...] node scripts/chat.js "¿pregunta?"
// Varias keys: LLM_API_KEY="key1,key2". Respaldo: LLM_RESPALDO=groq LLM_RESPALDO_KEY=...
// Con --json imprime la traza completa (herramientas, tiempos, tokens) para el informe.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { crearServidorMcp } from '../src/core/servidor.js';
import { crearPlataformaNode } from '../src/plataforma-node.js';
import { configuracionInicial, responder } from '../app/src/agente.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const pregunta = args.filter((a) => a !== '--json').join(' ');
if (!pregunta) {
  console.error('Uso: node scripts/chat.js "¿pregunta?" [--json]');
  process.exit(1);
}

export const httpNode = {
  async pedir({ url, method = 'GET', headers = {}, body }) {
    const r = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    const texto = await r.text();
    let data = texto;
    try {
      data = JSON.parse(texto);
    } catch {}
    return { status: r.status, headers: Object.fromEntries(r.headers.entries()), data };
  },
};

const config = configuracionInicial();
const env = process.env;
const fijar = (id, keys, modelo) => {
  config.proveedores[id].keys = keys.split(',').map((k) => k.trim()).filter(Boolean);
  if (modelo) config.proveedores[id].modelo = modelo;
};
config.activo = env.LLM_PROVEEDOR || 'gemini';
if (env.LLM_BASE) config.proveedores[config.activo].base = env.LLM_BASE;
fijar(config.activo, env.LLM_API_KEY || '', env.LLM_MODELO);
if (env.LLM_RESPALDO) fijar(env.LLM_RESPALDO, env.LLM_RESPALDO_KEY || '', env.LLM_RESPALDO_MODELO);

const plataforma = crearPlataformaNode();
plataforma.log = () => {};
const { server } = crearServidorMcp(plataforma);
const cliente = new Client({ name: 'chat-cli', version: '0.2.0' });
const [tc, ts] = InMemoryTransport.createLinkedPair();
await server.connect(ts);
await cliente.connect(tc);

const t0 = Date.now();
const { texto, traza } = await responder({
  pregunta,
  historial: [],
  cliente,
  config,
  http: httpNode,
  onEvento: (e) => {
    if (json) return;
    if (e.tipo === 'herramienta_inicio') console.error(`  🔧 ${e.nombre} ${JSON.stringify(e.args).slice(0, 160)}`);
    if (e.tipo === 'herramienta_fin') console.error(`     ${e.error ? '✗' : '✓'} ${e.ms} ms`);
    if (e.tipo === 'rotacion') console.error(`  ↻ ${e.motivo}`);
  },
});
const segundos = (Date.now() - t0) / 1000;
if (json) console.log(JSON.stringify({ pregunta, segundos, respuesta: texto, traza }, null, 1));
else console.log(`\n${texto}\n\n— ${traza.proveedores.join(', ')} · ${traza.pasos.length} herramientas · ${segundos.toFixed(1)} s`);
await cliente.close();
