// Evaluación reproducible del buscador (búsqueda de un dataset conocido).
// Para N datasets elegidos al azar (semilla fija) se arma una consulta con palabras de su título o de
// su descripción, y se mide en qué posición aparece ese mismo dataset con cada método:
//   - Coincidencia: cuenta cuántas palabras de la consulta aparecen en el título o la descripción
//   - BM25: un solo campo (todos los pesos = 1)
//   - BM25F: campos ponderados (título 3, entidad 2, etiquetas 2, recursos 1, descripción 1) ← el servidor
// Métricas: acierto@1, @5, @10 y MRR (rango recíproco medio). También mide el tiempo por búsqueda.
//   node scripts/evaluar-busqueda.js [N] > resultados.json
import { readFileSync } from 'node:fs';
import { construirIndice, puntajeBm25, tokenizar, sinTildes } from '../src/core/indice.js';

const N = Number(process.argv[2] || 300);
const catalogo = JSON.parse(readFileSync(new URL('../.cache/catalogo.json', import.meta.url), 'utf8'));
const ds = catalogo.datasets;

// PRNG con semilla (mulberry32) para que la muestra sea reproducible
let semilla = 20261129;
const azar = () => {
  semilla |= 0;
  semilla = (semilla + 0x6d2b79f5) | 0;
  let t = Math.imul(semilla ^ (semilla >>> 15), 1 | semilla);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const elegir = (arr, k) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(azar() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
};
const limpiarHtml = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ');
const palabras = (s) => [...new Set(limpiarHtml(s).split(/[^\p{L}\p{N}]+/u).filter((w) => tokenizar(w).length && w.length > 3))];

const indices = {
  BM25: construirIndice(ds, { titulo: 1, entidades: 1, etiquetas: 1, recursos: 1, descripcion: 1 }),
  BM25F: construirIndice(ds),
};
const textoPlano = ds.map((d) => new Set(tokenizar(`${d.titulo} ${limpiarHtml(d.descripcion)}`)));

function rango(metodo, consulta, objetivo) {
  const terminos = [...new Set(tokenizar(consulta))];
  const p = ds.map((d, i) => {
    if (metodo === 'Coincidencia') return terminos.filter((t) => textoPlano[i].has(t)).length;
    return puntajeBm25(indices[metodo], i, terminos);
  });
  const s = p[objetivo];
  if (!s) return Infinity;
  // posición pesimista: cuenta los que tienen igual o mayor puntaje (los empates no favorecen al método)
  let r = 0;
  for (let i = 0; i < p.length; i++) if (p[i] > s || (p[i] === s && i !== objetivo)) r++;
  return r + 1;
}

const escenarios = {
  titulo: (d) => {
    const w = palabras(d.titulo);
    return w.length >= 3 ? elegir(w, 3).join(' ') : null;
  },
  descripcion: (d) => {
    const enTitulo = new Set(tokenizar(d.titulo));
    const w = palabras(d.descripcion).filter((x) => !tokenizar(x).every((t) => enTitulo.has(t)));
    return w.length >= 6 ? elegir(w, 4).join(' ') : null;
  },
};

const salida = { fecha: new Date().toISOString(), catalogo: { datasets: ds.length, generado: catalogo.generado }, escenarios: {} };
for (const [nombre, armar] of Object.entries(escenarios)) {
  const candidatos = ds.map((d, i) => ({ i, q: armar(d) })).filter((x) => x.q);
  const muestra = elegir(candidatos, N);
  const res = {};
  for (const metodo of ['Coincidencia', 'BM25', 'BM25F']) {
    const rangos = muestra.map(({ i, q }) => rango(metodo, q, i));
    const tasa = (k) => rangos.filter((r) => r <= k).length / rangos.length;
    res[metodo] = {
      acierto1: tasa(1),
      acierto5: tasa(5),
      acierto10: tasa(10),
      mrr: rangos.reduce((s, r) => s + (r === Infinity ? 0 : 1 / r), 0) / rangos.length,
    };
  }
  salida.escenarios[nombre] = { consultas: muestra.length, ejemplos: muestra.slice(0, 5).map((m) => ({ consulta: m.q, objetivo: ds[m.i].titulo })), resultados: res };
}

// Tiempo de búsqueda con el índice BM25F (promedio de 200 consultas)
const consultas = elegir(ds, 200).map((d) => palabras(d.titulo).slice(0, 3).join(' '));
const t0 = performance.now();
for (const q of consultas) {
  const terminos = [...new Set(tokenizar(q))];
  ds.map((_, i) => puntajeBm25(indices.BM25F, i, terminos)).sort((a, b) => b - a);
}
salida.ms_por_busqueda = Number(((performance.now() - t0) / consultas.length).toFixed(2));
const t1 = performance.now();
construirIndice(ds);
salida.ms_construir_indice = Math.round(performance.now() - t1);
salida.terminos_vocabulario = indices.BM25F.df.size;
console.log(JSON.stringify(salida, null, 1));
