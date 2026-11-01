import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { buildRigData, convMat } from '../js/rigdata.js';
const rigJson = JSON.parse(readFileSync(new URL('../data/rig.json', import.meta.url), 'utf8'));
const posesJson = JSON.parse(readFileSync(new URL('../data/poses2.json', import.meta.url), 'utf8'));
const rigData = buildRigData(rigJson);
const flat2m4 = f => new THREE.Matrix4().set(f[0],f[1],f[2],f[3],f[4],f[5],f[6],f[7],f[8],f[9],f[10],f[11],f[12],f[13],f[14],f[15]);
const gt2 = f => convMat(flat2m4(f));
const V=THREE.Vector3;
const rest = posesJson.poses.find(p=>p.name==='rest');
// ik2 链几何参数
const rootRec = rigData.bones.get('MCH-upper_arm_ik2.L');
const foreRec = rigData.bones.get('MCH-forearm_ik2.L');
const L1 = rootRec.length, L2 = foreRec.length;
// 链根的世界位置由父级驱动（upper_arm_ik ctrl ← swing ← ...）——直接用 GT 的根位置
// 目标 = MCH-f_toe_ik_socket.L 的 HEAD
// GT 两个镜像肘：沿 root→target 轴，垂直分量取 ±
function elbows(rootPos, targetPos) {
  const axis = new V().subVectors(targetPos, rootPos);
  const d = axis.length();
  axis.normalize();
  const a = (L1*L1 - L2*L2 + d*d) / (2*d);
  const h = Math.sqrt(Math.max(0, L1*L1 - a*a));
  const perp = new V(0,1,0).cross(axis);
  if (perp.lengthSq() < 1e-8) perp.set(1,0,0).cross(axis);
  perp.normalize().multiplyScalar(h);
  const center = rootPos.clone().addScaledVector(axis, a);
  return { e1: center.clone().add(perp), e2: center.clone().sub(perp), d };
}
// rest 肘部（GT rest 的 MCH-forearm_ik2.L head）
const restElbow = new V().setFromMatrixPosition(gt2(rest.matrix['MCH-forearm_ik2.L']));
const restRoot = new V().setFromMatrixPosition(gt2(rest.matrix['MCH-upper_arm_ik2.L']));
for (const poseName of ['hand_L_up','hand_L_forward','hand_L_in','hand_L_back','hand_L_out','hand_L_rot','fk_arm','combo_prone','rest']) {
  const pose = posesJson.poses.find(p=>p.name===poseName);
  if (!pose.matrix['MCH-upper_arm_ik2.L']) continue;
  const rootPos = new V().setFromMatrixPosition(gt2(pose.matrix['MCH-upper_arm_ik2.L']));
  const tgtPos = new V().setFromMatrixPosition(gt2(pose.matrix['MCH-f_toe_ik_socket.L']));
  const gtElbow = new V().setFromMatrixPosition(gt2(pose.matrix['MCH-forearm_ik2.L']));
  const { e1, e2, d } = elbows(rootPos, tgtPos);
  // 哪个镜像解匹配 GT
  const d1 = e1.distanceTo(gtElbow), d2 = e2.distanceTo(gtElbow);
  const picked = d1 < d2 ? 'e1(+)' : 'e2(-)';
  // rest 肘在 rest 轴下的侧向符号 vs GT 肘在当前轴下的侧向符号
  const rAxis = new V().subVectors(new V().setFromMatrixPosition(gt2(rest.matrix['MCH-f_toe_ik_socket.L'])), restRoot).normalize();
  const rPerp = new V(0,1,0).cross(rAxis).normalize();
  const rSide = Math.sign(new V().subVectors(restElbow, restRoot).dot(rPerp));
  const cAxis = new V().subVectors(tgtPos, rootPos).normalize();
  const cPerp = new V(0,1,0).cross(cAxis).normalize();
  const gSide = Math.sign(new V().subVectors(gtElbow, rootPos).dot(cPerp));
  const sameSideAsRest = rSide === gSide ? '同侧' : '反侧';
  // 均匀拉伸假设验证：|root→GT肘| / L1 == |GT肘→tgt| / L2 == d/ΣL ?
  const g1 = rootPos.distanceTo(gtElbow), g2 = gtElbow.distanceTo(tgtPos);
  const k = d / (L1 + L2);
  // GT 骨骼的实际缩放（matrix 分解 Y scale）
  const m1 = gt2(pose.matrix['MCH-upper_arm_ik2.L']);
  const s1 = new V().setFromMatrixColumn(m1, 1).length();
  const m2 = gt2(pose.matrix['MCH-forearm_ik2.L']);
  const s2 = new V().setFromMatrixColumn(m2, 1).length();
  console.log(`${poseName.padEnd(14)} d=${d.toFixed(3)} k=d/ΣL=${k.toFixed(3)} |root→肘|/L1=${(g1/L1).toFixed(3)} |肘→tgt|/L2=${(g2/L2).toFixed(3)} GT骨Y缩放: upper=${s1.toFixed(3)} fore=${s2.toFixed(3)}`);
}
