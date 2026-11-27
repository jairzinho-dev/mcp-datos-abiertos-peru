// Plataforma Node para el núcleo isomórfico (src/core): red con fetch nativo (streaming),
// caché del catálogo en disco y registro de llamadas en logs/llamadas.jsonl.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));

export function crearPlataformaNode(env = process.env) {
  const dirCache = env.PNDA_CACHE_DIR || join(AQUI, '..', '.cache');
  const dirLogs = env.PNDA_LOG_DIR || join(AQUI, '..', 'logs');
  const log = (...a) => console.error(...a);

  return {
    base: env.PNDA_URL || undefined,
    userAgent: env.PNDA_USER_AGENT || undefined,
    ttlHoras: Number(env.PNDA_TTL_HORAS || 24),
    maxMbDefecto: Number(env.PNDA_MAX_MB || 300),
    log,

    async pedirJson(url, { headers, timeoutMs }) {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(Number(env.PNDA_TIMEOUT_MS || timeoutMs)),
        redirect: 'manual',
      });
      return { status: res.status, tipo: res.headers.get('content-type') || '', json: () => res.json() };
    },

    async abrirBytes(url, { headers }) {
      const control = new AbortController();
      const reloj = setTimeout(() => control.abort(), 10 * 60_000);
      const res = await fetch(url, { headers, signal: control.signal });
      const lector = res.body?.getReader();
      return {
        status: res.status,
        tipo: res.headers.get('content-type') || '',
        tamanoTotal: Number(res.headers.get('content-length')) || null,
        trozos: {
          async *[Symbol.asyncIterator]() {
            if (!lector) return;
            for (;;) {
              const { value, done } = await lector.read();
              if (done) return;
              yield value;
            }
          },
        },
        cerrar() {
          clearTimeout(reloj);
          lector?.cancel().catch(() => {});
          control.abort();
        },
      };
    },

    almacen: {
      async leer(clave) {
        const f = join(dirCache, `${clave}.json`);
        return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
      },
      async guardar(clave, valor) {
        mkdirSync(dirCache, { recursive: true });
        writeFileSync(join(dirCache, `${clave}.json`), JSON.stringify(valor));
      },
    },

    registrar(tool, args, ms, ok, error) {
      try {
        mkdirSync(dirLogs, { recursive: true });
        appendFileSync(
          join(dirLogs, 'llamadas.jsonl'),
          JSON.stringify({ fecha: new Date().toISOString(), tool, args, ms, ok, error }) + '\n',
        );
      } catch {}
    },
  };
}
