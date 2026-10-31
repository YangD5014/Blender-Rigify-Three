import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { buildRigData, convMat } from '../js/rigdata.js';
const gt2gltf = (f) => convMat(new THREE.Matrix4().set(f[0],f[1],f[2],f[3],f[4],f[5],f[6],f[7],f[8],f[9],f[10],f[11],f[12],f[13],f[14],f[15]));
const basisRaw = (f) => new THREE.Matrix4().set(f[0],f[1],f[2],f[3],f[4],f[5],f[6],f[7],f[8],f[9],f[10],f[11],f[12],f[13],f[14],f[15]);
import { RigEngine } from '../js/engine.js';
import { ThreeIkDelegate } from '../js/ikadapter.js';

const rigJson = JSON.parse(readFileSync(new URL('../data/rig.json', import.meta.url), 'utf8'));
const posesJson = JSON.parse(readFileSync(new URL('../data/poses2.json', import.meta.url), 'utf8'));
const rigData = buildRigData(rigJson);
const engine = new RigEngine(rigData, new ThreeIkDelegate());
const flat2m4 = f => new THREE.Matrix4().set(f[0],f[1],f[2],f[3],f[4],f[5],f[6],f[7],f[8],f[9],f[10],f[11],f[12],f[13],f[14],f[15]);
const pose = posesJson.poses.find(p=>p.name==='rest');
engine.setBasis('torso', pose.basis.torso ?? engine.getBasis('torso'));
for (const [n,f] of Object.entries(pose.basis)) engine.setBasis(n, basisRaw(f));
const P = engine.evaluate();
const wrong = new Map();
for (const [name, gtFlat] of Object.entries(pose.matrix)) {
  const gt = gt2gltf(gtFlat); const mine = P.get(name);
  const dp = new THREE.Vector3().setFromMatrixPosition(mine).distanceTo(new THREE.Vector3().setFromMatrixPosition(gt));
  let dr = 0;
  for (const [x, y, z] of [[1,0,0],[0,1,0],[0,0,1]]) {
    const a = new THREE.Vector3(x, y, z).transformDirection(mine).normalize();
    const b = new THREE.Vector3(x, y, z).transformDirection(gt).normalize();
    const ang = a.angleTo(b) * 180 / Math.PI;
    if (ang > dr) dr = ang;
  }
  if (dp > 0.002 || dr > 0.5) wrong.set(name, {dp, dr});
}
// 上游错骨：父级和所有约束目标都对，但自己错
const roots = [];
for (const [name, e] of wrong) {
  const rec = rigData.bones.get(name);
  let upstreamWrong = false;
  if (rec.parent && wrong.has(rec.parent)) upstreamWrong = true;
  for (const c of rec.constraints) {
    if (c.subtarget && wrong.has(c.subtarget)) { upstreamWrong = true; break; }
    if (c.type==='ARMATURE') for (const t of (c.targets||[])) if (t.subtarget && wrong.has(t.subtarget)) { upstreamWrong=true; break; }
  }
  if (!upstreamWrong) roots.push([name, e.dp, e.dr, rec.parent]);
}
roots.sort((a,b)=>b[1]-a[1]);
console.log('上游错骨（父级与目标均正确但自身错）：');
for (const [n,dp,dr,par] of roots.slice(0,25)) {
  const rec = rigData.bones.get(n);
  console.log(`\n${n}  posErr=${dp.toFixed(4)} rotErr=${dr.toFixed(1)}°  parent=${par}`);
  for (const c of rec.constraints) console.log(`   ${c.type} "${c.name}" -> ${c.subtarget} infl=${c.influence} mute=${c.mute} ht=${c.get}`);
}
