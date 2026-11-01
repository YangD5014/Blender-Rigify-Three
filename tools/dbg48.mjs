import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { buildRigData, convMat } from '../js/rigdata.js';
const rigJson = JSON.parse(readFileSync(new URL('../data/rig.json', import.meta.url), 'utf8'));
const posesJson = JSON.parse(readFileSync(new URL('../data/poses2.json', import.meta.url), 'utf8'));
const rigData = buildRigData(rigJson);
const flat2m4 = f => new THREE.Matrix4().set(f[0],f[1],f[2],f[3],f[4],f[5],f[6],f[7],f[8],f[9],f[10],f[11],f[12],f[13],f[14],f[15]);
const gt2 = f => convMat(flat2m4(f));
const rest = posesJson.poses.find(p=>p.name==='rest');
const V=THREE.Vector3;
const scl = m => [0,1,2].map(i => +new V().setFromMatrixColumn(m, i).length().toFixed(4));
console.log('bone                          | GT rest 缩放        | 我的rest缩放        | GT位移段长(父头→子头)');
const parentOf = n => rigData.bones.get(n).parent;
for (const n of ['root','MCH-torso.parent','torso','ORG-shoulder.L','MCH-upper_arm_parent.L','upper_arm_ik.L','MCH-upper_arm_ik_swing.L','MCH-upper_arm_ik.L','MCH-forearm_ik.L','ORG-upper_arm.L','ORG-forearm.L','ORG-hand.L','MCH-upper_arm_ik2.L','MCH-forearm_ik2.L']) {
  const g = gt2(rest.matrix[n]);
  const m = rigData.bones.get(n).rest;
  const p = parentOf(n);
  let seg = '-';
  if (p && rest.matrix[p]) {
    seg = new V().setFromMatrixPosition(g).distanceTo(new V().setFromMatrixPosition(gt2(rest.matrix[p]))).toFixed(4);
  }
  console.log(`${n.padEnd(29)} | ${JSON.stringify(scl(g)).padEnd(19)} | ${JSON.stringify(scl(m)).padEnd(19)} | ${seg}`);
}
