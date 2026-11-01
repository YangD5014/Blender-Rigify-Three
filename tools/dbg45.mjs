// 验证 hand_track 的瞄准目标：新鲜 ik2 肘部 vs 旧帧肘部
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { buildRigData, convMat } from '../js/rigdata.js';
const rigJson = JSON.parse(readFileSync(new URL('../data/rig.json', import.meta.url), 'utf8'));
const posesJson = JSON.parse(readFileSync(new URL('../data/poses2.json', import.meta.url), 'utf8'));
const rigData = buildRigData(rigJson);
const flat2m4 = f => new THREE.Matrix4().set(f[0],f[1],f[2],f[3],f[4],f[5],f[6],f[7],f[8],f[9],f[10],f[11],f[12],f[13],f[14],f[15]);
const gt2 = f => convMat(flat2m4(f));
const V=THREE.Vector3;
const pose = posesJson.poses.find(p=>p.name==='hand_L_back');
const rest = posesJson.poses.find(p=>p.name==='rest');
const prev = posesJson.poses.find(p=>p.name==='hand_L_forward');
const trackRest = rigData.bones.get('MCH-hand_track.L').rest;
const trackRestY = new V(0,1,0).transformDirection(trackRest).normalize();
const gtTrackNow = gt2(pose.matrix['MCH-hand_track.L']);
const gtTrackY = new V(0,1,0).transformDirection(gtTrackNow).normalize();
// 影响度 0.8 混合：GT_final ≈ slerp(restY, fullAim, 0.8) → fullAim 方向重建：
// 用 GT_final 相对 rest 的旋转差放大 1/0.8 —— 近似：直接比较各候选方向与 GT_final Y 的夹角
const headNow = new V().setFromMatrixPosition(gt2(pose.matrix['MCH-hand_track.L']));
const freshElbow = new V().setFromMatrixPosition(gt2(pose.matrix['MCH-forearm_ik2.L']));
const staleElbow = new V().setFromMatrixPosition(gt2(prev.matrix['MCH-forearm_ik2.L']));
const dFresh = new V().subVectors(freshElbow, headNow).normalize();
const dStale = new V().subVectors(staleElbow, headNow).normalize();
const ang = (a,b) => (a.angleTo(b)*180/Math.PI).toFixed(1);
console.log('GT track 最终 Y 与各候选方向的夹角（影响度 0.8 → 期望有 ~1/0.8 残差角）:');
console.log('  vs 新鲜 ik2 肘部方向:', ang(gtTrackY, dFresh), '°');
console.log('  vs 旧帧 ik2 肘部方向:', ang(gtTrackY, dStale), '°');
console.log('  vs track rest Y     :', ang(gtTrackY, trackRestY), '° (= 0.8×全摆角 → 全摆角≈' + (parseFloat(ang(gtTrackY, trackRestY))/0.8).toFixed(1) + '°)');
console.log('  新鲜 vs rest Y      :', ang(dFresh, trackRestY), '°');
console.log('  旧帧 vs rest Y      :', ang(dStale, trackRestY), '°');
