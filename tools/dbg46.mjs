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
// GT 的隐式 restLocal = inv(GT ctrl rest) @ GT ik2root rest
for (const [child, parent] of [['MCH-upper_arm_ik2.L','upper_arm_ik.L'],['MCH-forearm_ik2.L','MCH-upper_arm_ik2.L'],['MCH-upper_arm_ik.L','MCH-upper_arm_ik_swing.L'],['MCH-forearm_ik.L','MCH-upper_arm_ik.L']]) {
  const myLocal = rigData.bones.get(child).restLocal;
  const gtLocal = new THREE.Matrix4().copy(gt2(rest.matrix[parent])).invert().multiply(gt2(rest.matrix[child]));
  let d=0; for (const [x,y,z] of [[1,0,0],[0,1,0],[0,0,1]]) {
    const a=new V(x,y,z).transformDirection(myLocal).normalize();
    const b=new V(x,y,z).transformDirection(gtLocal).normalize();
    d=Math.max(d,a.angleTo(b)*180/Math.PI);
  }
  const dp = new V().setFromMatrixPosition(myLocal).distanceTo(new V().setFromMatrixPosition(gtLocal));
  const sc = a => [0,1,2].map(i => +new V().setFromMatrixColumn(a, i).length().toFixed(4));
  // Y 段长比
  const yScale = a => +(new V().setFromMatrixColumn(a, 1).length() / rigData.bones.get(child).length).toFixed(4);
  // rest 姿态下该骨的误差
  const myRest = rigData.bones.get(child).rest;
  const gtRest = gt2(rest.matrix[child]);
  const dr = (()=>{let m=0;for(const[x,y,z]of[[1,0,0],[0,1,0],[0,0,1]]){const a=new V(x,y,z).transformDirection(myRest).normalize();const b=new V(x,y,z).transformDirection(gtRest).normalize();m=Math.max(m,a.angleTo(b)*180/Math.PI);}return m;})();
  console.log(`${child.padEnd(24)} restLocal: rot差=${d.toFixed(2)}° pos差=${dp.toFixed(4)} 缩放 mine=${sc(myLocal)} GT=${sc(gtLocal)}  Y段长比 mine=${yScale(myLocal)} GT=${yScale(gtLocal)}   rest姿态rot差=${dr.toFixed(2)}°`);
}
