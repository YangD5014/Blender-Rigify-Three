// tools/validate.mjs — 用 poses2.json 的 32 个 Blender 真值姿态数值校验引擎
// 用法: node tools/validate.mjs [poseName ...] [--verbose]
import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { buildRigData, convMat } from '../js/rigdata.js';
import { RigEngine } from '../js/engine.js';
import { ThreeIkDelegate } from '../js/ikadapter.js';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const only = args.filter((a) => !a.startsWith('--'));

const rigJson = JSON.parse(readFileSync(new URL('../data/rig.json', import.meta.url), 'utf8'));
const posesJson = JSON.parse(readFileSync(new URL('../data/poses2.json', import.meta.url), 'utf8'));
const rigData = buildRigData(rigJson);
const ik = new ThreeIkDelegate();
const engine = new RigEngine(rigData, ik);

function flatToM4(flat) {
  return new THREE.Matrix4().set(
    flat[0], flat[1], flat[2], flat[3],
    flat[4], flat[5], flat[6], flat[7],
    flat[8], flat[9], flat[10], flat[11],
    flat[12], flat[13], flat[14], flat[15]);
}

/** Blender armature-space 姿态矩阵 -> glTF 坐标（左乘 C） */
const gt2gltf = (flat) => convMat(flatToM4(flat));
/** basis 在 bone-space：原样保留 */
const basisRaw = (flat) => flatToM4(flat);

let worst = [];
let pass = 0; let fail = 0;
for (const pose of posesJson.poses) {
  if (only.length && !only.includes(pose.name)) continue;
  // 1. 重置到静止，再套用该姿态的 basis 与 props
  engine.resetBases();
  engine.setProps({});
  for (const [name, flat] of Object.entries(pose.basis)) {
    engine.setBasis(name, basisRaw(flat));
  }
  const props = {};
  for (const [bone, kv] of Object.entries(pose.props || {})) {
    const vals = {};
    for (const [k, v] of Object.entries(kv)) {
      if (typeof v === 'number') vals[k] = v;
    }
    if (Object.keys(vals).length) props[bone] = vals;
  }
  engine.setProps(props);
  // 2. 求值并与真值比较
  const P = engine.evaluate();
  
// 缩放稳健的旋转差：去缩放后比较四元数夹角。
// （旧实现用轴向量夹角，COPY_TRANSFORMS 携带的非均匀缩放会把轴斜切，
//   旋转完全正确也报 45° —— 已实测误报，改为极分解提取纯旋转。）
const _rq = { p1: new THREE.Vector3(), q1: new THREE.Quaternion(), s1: new THREE.Vector3(),
              p2: new THREE.Vector3(), q2: new THREE.Quaternion(), s2: new THREE.Vector3() };
function axisRotErr(mine, gt) {
  mine.decompose(_rq.p1, _rq.q1, _rq.s1);
  gt.decompose(_rq.p2, _rq.q2, _rq.s2);
  return _rq.q1.angleTo(_rq.q2) * 180 / Math.PI;
}

  let maxD = 0; let maxR = 0; let worstBone = '';
  const perBone = [];
  for (const [name, gtFlat] of Object.entries(pose.matrix)) {
    const gt = gt2gltf(gtFlat);
    const mine = P.get(name);
    if (!mine) { perBone.push([name, 'MISSING']); continue; }
    const dp = new THREE.Vector3().setFromMatrixPosition(mine)
      .distanceTo(new THREE.Vector3().setFromMatrixPosition(gt));
    const dr = axisRotErr(mine, gt);
    if (dp > maxD) { maxD = dp; }
    if (dr > maxR) { maxR = dr; }
    if (dp > 0.01 || dr > 2) worstBone = name;
    perBone.push([name, dp, dr]);
  }
  const ok = maxD < 0.01 && maxR < 2;
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${pose.name.padEnd(18)} maxPosErr=${maxD.toFixed(5)}  maxRotErr=${maxR.toFixed(2)}°  ${worstBone ? 'worst:' + worstBone : ''}`);
  if (verbose) {
    perBone.sort((a, b) => (typeof b[1] === 'number' ? b[1] : 9) - (typeof a[1] === 'number' ? a[1] : 9));
    for (const [name, dp, dr] of perBone.slice(0, 12)) {
      if (typeof dp === 'number' && (dp > 0.002 || dr > 0.5)) console.log(`      ${name.padEnd(32)} pos=${dp.toFixed(5)} rot=${dr.toFixed(2)}°`);
    }
  }
  worst.push({ name: pose.name, maxD, maxR, worstBone });
}
console.log(`\n${pass} pass / ${fail} fail`);
