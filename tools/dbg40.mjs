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
const rest = posesJson.poses.find(p=>p.name==='rest');
const V=THREE.Vector3;
const headOf = m => new V().setFromMatrixPosition(m);

for (const poseName of ['hand_L_up','hand_L_back','hand_L_forward']) {
  const pose = posesJson.poses.find(p=>p.name===poseName);
  engine.resetBases(); engine.evaluate(); // 预热
  for (const [n,f] of Object.entries(pose.basis)) engine.setBasis(n, flat2m4(f));
  const P = engine.evaluate();
  console.log(`=== ${poseName} ===`);
  // hand_ik.L 拖了多少
  const gtHand = gt2(pose.matrix['hand_ik.L']);
  const gtHandRest = gt2(rest.matrix['hand_ik.L']);
  console.log(`  hand_ik.L       GT 位移=${headOf(gtHand).distanceTo(headOf(gtHandRest)).toFixed(4)}`);
  for (const n of ['MCH-f_toe_ik_socket.L','MCH-hand_track.L','MCH-hand_parent.L','hand_heel_ik.L']) {
    if (!pose.matrix[n] || !rest.matrix[n]) { console.log(`  ${n}: GT 数据缺失`); continue; }
    const g = headOf(gt2(pose.matrix[n]));
    const gr = headOf(gt2(rest.matrix[n]));
    const m = headOf(P.get(n));
    const mRest = headOf(engine.bones.get(n).rest);
    console.log(`  ${n.padEnd(24)} GT位移=${g.distanceTo(gr).toFixed(4)}  mine位移=${m.distanceTo(mRest).toFixed(4)}  mine-vs-GT=${m.distanceTo(g).toFixed(4)}`);
  }
}
