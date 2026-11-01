// 顺序回放姿态序列（与 dump 一致），在 hand_L_back 处比较 pre-IK 状态
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { buildRigData, convMat } from '../js/rigdata.js';
import { RigEngine } from '../js/engine.js';
const rigJson = JSON.parse(readFileSync(new URL('../data/rig.json', import.meta.url), 'utf8'));
const posesJson = JSON.parse(readFileSync(new URL('../data/poses2.json', import.meta.url), 'utf8'));
const probe = JSON.parse(readFileSync('/tmp/probe_preik2.json', 'utf8'));
const rigData = buildRigData(rigJson);
const engine = new RigEngine(rigData, null); // IK 禁用 = Blender mute IK
const flat2m4 = f => new THREE.Matrix4().set(f[0],f[1],f[2],f[3],f[4],f[5],f[6],f[7],f[8],f[9],f[10],f[11],f[12],f[13],f[14],f[15]);
const gt2 = f => convMat(flat2m4(f));
const V=THREE.Vector3;
const axisErr = (m, ref) => { let d=0; for (const [x,y,z] of [[1,0,0],[0,1,0],[0,0,1]]) { const a=new V(x,y,z).transformDirection(m).normalize(); const b=new V(x,y,z).transformDirection(ref).normalize(); d=Math.max(d,a.angleTo(b)*180/Math.PI);} return d; };
// 回放
for (const pose of posesJson.poses) {
  engine.resetBases();
  for (const [n,f] of Object.entries(pose.basis)) engine.setBasis(n, flat2m4(f));
  engine.evaluate();
  if (pose.name === 'hand_L_back') break;
}
const P = engine.P;
console.log('bone                          | mine-vs-BLR_preIK轴差 | pos差');
for (const n of ['MCH-upper_arm_ik_swing.L','upper_arm_ik.L','MCH-upper_arm_ik2.L','MCH-forearm_ik2.L','MCH-f_toe_ik_socket.L','MCH-hand_track.L','MCH-hand_parent.L','hand_heel_ik.L','MCH-upper_arm_ik_target.L','MCH-upper_arm_ik.L','MCH-forearm_ik.L','ORG-hand.L','MCH-thigh_ik2.L','MCH-shin_ik2.L','MCH-foot_ik3.L','MCH-shin_ik3.L','foot_heel_ik.L','MCH-thigh_ik_target.L']) {
  if (!probe.preik[n]) continue;
  const bl = gt2(probe.preik[n]);
  const mine = P.get(n);
  const dr = axisErr(mine, bl);
  const dp = new V().setFromMatrixPosition(mine).distanceTo(new V().setFromMatrixPosition(bl));
  console.log(`${n.padEnd(29)} | ${dr.toFixed(2).padStart(8)}° | ${dp.toFixed(4)}`);
}
