import { readFileSync } from 'node:fs';
import { buildRigData } from '../js/rigdata.js';
const rigJson = JSON.parse(readFileSync(new URL('../data/rig.json', import.meta.url), 'utf8'));
const rigData = buildRigData(rigJson);
const order = rigData.order;
const idx = n => order.indexOf(n);
const names = ['tail.001','tail.002','tail.003','tail.004','tweak_tail.001','tweak_tail.002','tweak_tail.003','ORG-tail.001','ORG-tail.002','ORG-tail.003','ORG-tail.004','DEF-tail.003','MCH-ROT-tail','tail_master.001','tweak_spine'];
const sorted = [...names].sort((a,b)=>idx(a)-idx(b));
for (const n of sorted) {
  const rec = rigData.bones.get(n);
  console.log(`${String(idx(n)).padStart(4)}  ${n.padEnd(18)} parent=${String(rec.parent).padEnd(16)} @${idx(rec.parent)}`);
}
