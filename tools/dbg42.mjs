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
const pose = posesJson.poses.find(p=>p.name==='hand_L_back');
engine.resetBases(); engine.evaluate();
for (const [n,f] of Object.entries(pose.basis)) engine.setBasis(n, flat2m4(f));
const P = engine.evaluate();
const gt = n => convMat(flat2m4(pose.matrix[n]));
const V=THREE.Vector3;
let out=[];
for (const n of ['MCH-upper_arm_ik_target.L','hand_heel_ik.L','MCH-hand_parent.L','MCH-hand_track.L','MCH-forearm_ik2.L','MCH-upper_arm_ik2.L','MCH-upper_arm_ik.L','MCH-forearm_ik.L','ORG-upper_arm.L','ORG-forearm.L','ORG-hand.L','DEF-hand.L']) {
  const dp = new V().setFromMatrixPosition(P.get(n)).distanceTo(new V().setFromMatrixPosition(gt(n)));
  out.push(`${n}=${dp.toFixed(3)}`);
}
console.log(out.join('  '));
