// tail_rot / tail_rot2 GT 姿态下尾巴骨骼的误差分解
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
const gt2 = f => convMat(flat2m4(f));
const V=THREE.Vector3;
const axisErr = (m, ref) => { let d=0; for (const [x,y,z] of [[1,0,0],[0,1,0],[0,0,1]]) { const a=new V(x,y,z).transformDirection(m).normalize(); const b=new V(x,y,z).transformDirection(ref).normalize(); d=Math.max(d,a.angleTo(b)*180/Math.PI);} return d; };
for (const poseName of ['tail_rot','tail_rot2']) {
  const pose = posesJson.poses.find(p=>p.name===poseName);
  engine.resetBases(); engine.evaluate();
  for (const [n,f] of Object.entries(pose.basis)) engine.setBasis(n, flat2m4(f));
  const P = engine.evaluate();
  console.log(`=== ${poseName} ===`);
  for (const n of ['tail.001','tail.002','tail.003','tail.004','tweak_tail.001','tweak_tail.002','tweak_tail.003','tweak_tail.004','ORG-tail.001','ORG-tail.002','ORG-tail.003','ORG-tail.004','DEF-tail.001','DEF-tail.002','DEF-tail.003','DEF-tail.004']) {
    if (!pose.matrix[n]) continue;
    const dp = new V().setFromMatrixPosition(P.get(n)).distanceTo(new V().setFromMatrixPosition(gt2(pose.matrix[n])));
    const dr = axisErr(P.get(n), gt2(pose.matrix[n]));
    const flag = (dp > 0.01 || dr > 3) ? ' ←!' : '';
    console.log(`  ${n.padEnd(16)} pos差=${dp.toFixed(4)} rot差=${dr.toFixed(1)}°${flag}`);
  }
}
