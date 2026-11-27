// Descarga el catálogo de la PNDA y lo guarda como semilla para empaquetarlo en el APK.
//   node scripts/exportar-catalogo.js app/public/catalogo.json
import { writeFileSync } from 'node:fs';
import { crearServidorMcp } from '../src/core/servidor.js';
import { crearPlataformaNode } from '../src/plataforma-node.js';

const destino = process.argv[2] || 'app/public/catalogo.json';
const plataforma = crearPlataformaNode();
plataforma.almacen = { leer: async () => null, guardar: async () => {} };
const { indice } = crearServidorMcp(plataforma);
const c = await indice.obtenerCatalogo({ forzar: true });
writeFileSync(destino, JSON.stringify(c));
console.error(`semilla: ${c.datasets.length} datasets → ${destino}`);
