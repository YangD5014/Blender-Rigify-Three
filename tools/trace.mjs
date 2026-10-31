import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { buildRigData, convMat } from '../js/rigdata.js';
import { RigEngine } from '../js/engine.js';
import { ThreeIkDelegate } from '../js/ikadapter.js';
const rigJson = JSON.parse(readFileSync(new URL('../data/rig.json', import.meta.url), 'utf8'));
const posesJson = JSON.parse(readFileSync(new URL('../data/poses2.json', import.meta.url), 'utf8'));
const rigData = buildRigData(rigJson);
const engine = new RigEngine(rigData, new ThreeIkDelegate());
const flat2m4 = f => new THREE.Matrix4().set(f[0],f[1],f[2],f[3],f[4],f[5],f[6],f[7],f[8],f[9],f[10],f[11],f[12],f[13],f[14],f[15]);
const poseName = process.argv[3] || 'rest';
const pose = posesJson.poses.find(p=>p.name===poseName);
for (const [n,f] of Object.entries(pose.basis)) engine.setBasis(n, flat2m4(f));
engine.evaluate();
const V=THREE.Vector3;
const axisErr = (m, ref) => {
  let d = 0;
  for (const [x,y,z] of [[1,0,0],[0,1,0],[0,0,1]]) {
    const a = new V(x,y,z).transformDirection(m).normalize();
    const b = new V(x,y,z).transformDirection(ref).normalize();
    d = Math.max(d, a.angleTo(b)*180/Math.PI);
  }
  return d;
};
// 从指定骨骼向上追
let n = process.argv[2];
const chain = [];
while (n) { chain.unshift(n); n = rigData.bones.get(n).parent; }
console.log(`姿态 ${poseName}, 从叶到根:`);
for (const name of chain) {
  const mine = engine.P.get(name);
  const gt = convMat(flat2m4(pose.matrix[name]));
  const rest = rigData.bones.get(name).rest;
  const dp = new V().setFromMatrixPosition(mine).distanceTo(new V().setFromMatrixPosition(gt));
  const drGt = axisErr(mine, gt);
  const drRest = axisErr(mine, rest);
  const gtVsRest = axisErr(gt, rest);
  const flag = drGt > 2 ? ' ←!' : '';
  console.log(`${name.padEnd(26)} mine-vs-GT轴差=${drGt.toFixed(2).padStart(7)}° pos差=${dp.toFixed(4)}  (mine-vs-rest=${drRest.toFixed(1)}° GT-vs-rest=${gtVsRest.toFixed(1)}°)${flag}`);
}
