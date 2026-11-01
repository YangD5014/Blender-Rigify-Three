import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { buildRigData, convMat } from '../js/rigdata.js';
const rigJson = JSON.parse(readFileSync(new URL('../data/rig.json', import.meta.url), 'utf8'));
const posesJson = JSON.parse(readFileSync(new URL('../data/poses2.json', import.meta.url), 'utf8'));
const rigData = buildRigData(rigJson);
const flat2m4 = f => new THREE.Matrix4().set(f[0],f[1],f[2],f[3],f[4],f[5],f[6],f[7],f[8],f[9],f[10],f[11],f[12],f[13],f[14],f[15]);
const gt2 = f => convMat(flat2m4(f));
const V=THREE.Vector3;
const ys = m => +(new V().setFromMatrixColumn(m,1).length()/rigData.bones.get('MCH-upper_arm_ik.L').length).toFixed(4);
// IK1 链的 use_stretch 缩放：MCH-upper_arm_ik.L / MCH-forearm_ik.L 的 Y scale
console.log('pose            | ik1root_Yscale | ik1fore_Yscale | dist(root→target) | ΣL_rest');
for (const pose of posesJson.poses) {
  if (!pose.matrix['MCH-upper_arm_ik.L']) continue;
  const m1 = gt2(pose.matrix['MCH-upper_arm_ik.L']);
  const m2 = gt2(pose.matrix['MCH-forearm_ik.L']);
  const s1 = ys(m1), s2 = ys(gt2(pose.matrix['MCH-forearm_ik.L']));
  // IK1 目标 = MCH-upper_arm_ik_target.L (COPY ← heel tail) — 链末端 = forearm_ik.L 的 tail
  const root = new V().setFromMatrixPosition(m1);
  const tgt = new V().setFromMatrixPosition(gt2(pose.matrix['MCH-upper_arm_ik_target.L']));
  const d = root.distanceTo(tgt);
  console.log(`${pose.name.padEnd(16)}| ${s1}          | ${s2}          | ${d.toFixed(4)}             | 0.8380`);
}
