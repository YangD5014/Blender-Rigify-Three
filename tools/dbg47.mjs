import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { buildRigData, convMat } from '../js/rigdata.js';
import { RigEngine } from '../js/engine.js';
const rigJson = JSON.parse(readFileSync(new URL('../data/rig.json', import.meta.url), 'utf8'));
const posesJson = JSON.parse(readFileSync(new URL('../data/poses2.json', import.meta.url), 'utf8'));
const rigData = buildRigData(rigJson);
const engine = new RigEngine(rigData, null);
const flat2m4 = f => new THREE.Matrix4().set(f[0],f[1],f[2],f[3],f[4],f[5],f[6],f[7],f[8],f[9],f[10],f[11],f[12],f[13],f[14],f[15]);
const gt2 = f => convMat(flat2m4(f));
const V=THREE.Vector3;
// 引擎（无IK）顺序回放 → hand_L_back 的 pre-IK 种子
for (const pose of posesJson.poses) {
  engine.resetBases();
  for (const [n,f] of Object.entries(pose.basis)) engine.setBasis(n, flat2m4(f));
  engine.evaluate();
  if (pose.name === 'hand_L_back') break;
}
const P = engine.P;
const pose = posesJson.poses.find(p=>p.name==='hand_L_back');
const rootRec = rigData.bones.get('MCH-upper_arm_ik2.L');
const foreRec = rigData.bones.get('MCH-forearm_ik2.L');
const r = new V().setFromMatrixPosition(P.get('MCH-upper_arm_ik2.L'));
const eSeed = new V().setFromMatrixPosition(P.get('MCH-forearm_ik2.L'));
const endSeed = new V(0, foreRec.length, 0).applyMatrix4(P.get('MCH-forearm_ik2.L'));
const tgt = new V().setFromMatrixPosition(gt2(pose.matrix['MCH-f_toe_ik_socket.L']));
const gtElbow = new V().setFromMatrixPosition(gt2(pose.matrix['MCH-forearm_ik2.L']));
const L1 = r.distanceTo(eSeed), L2 = eSeed.distanceTo(endSeed);
const d = r.distanceTo(tgt);
const axis = new V().subVectors(tgt, r).normalize();
const a = (L1*L1 - L2*L2 + d*d) / (2*d);
const h = Math.sqrt(Math.max(0, L1*L1 - a*a));
const center = r.clone().addScaledVector(axis, a);
const ref = new V().subVectors(eSeed, r);
ref.addScaledVector(axis, -ref.dot(axis));
const perp = ref.normalize();
const e1 = center.clone().addScaledVector(perp, h);   // 种子侧
const e2 = center.clone().addScaledVector(perp, -h);  // 镜像
console.log(`d=${d.toFixed(3)} L1=${L1.toFixed(3)} L2=${L2.toFixed(3)} a=${a.toFixed(4)} h=${h.toFixed(4)}`);
console.log('种子肘:', eSeed.toArray().map(x=>+x.toFixed(3)));
console.log('种子侧解:', e1.toArray().map(x=>+x.toFixed(3)), ' dist→GT =', e1.distanceTo(gtElbow).toFixed(4));
console.log('镜像解  :', e2.toArray().map(x=>+x.toFixed(3)), ' dist→GT =', e2.distanceTo(gtElbow).toFixed(4));
console.log('GT 肘  :', gtElbow.toArray().map(x=>+x.toFixed(3)));
