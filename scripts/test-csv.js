// Compara el parser CSV propio con csv-parse en casos difíciles, cortando el texto en trozos de varios tamaños.
//   node scripts/test-csv.js
import { crearParserCsv } from '../src/core/csv.js';
import { parse } from 'csv-parse/sync';
const casos = ['a,b,c\n1,2,3\n', 'a,b\n"x, y",2\r\n"he said ""hi""",3\n', 'a;b\n  "q" ;z\nab"c;d\n\n', 'a,b\n1,"multi\nline"\n2,3'];
let ok=0;
for (const c of casos) for (const corte of [1,2,3,5,1000]) {
  const sep = c.includes(';')?';':',';
  const p = crearParserCsv(sep); for (let i=0;i<c.length;i+=corte) p.empujar(c.slice(i,i+corte)); p.terminar();
  const mio = p.tomar();
  const ref = parse(c,{delimiter:sep,relax_quotes:true,relax_column_count:true,skip_empty_lines:true,trim:true});
  if (JSON.stringify(mio)===JSON.stringify(ref)) ok++; else console.log('DIF', corte, JSON.stringify(c), JSON.stringify(mio), JSON.stringify(ref));
}
console.log('ok', ok, 'de', casos.length*5);
