// GT（Blender tail_master 转 35°）vs 我的引擎 —— 缩放与几何对比
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { buildRigData, convMat } from '../js/rigdata.js';
import { RigEngine } from '../js/engine.js';
import { ThreeIkDelegate } from '../js/ikadapter.js';
const rigJson = JSON.parse(readFileSync(new URL('../data/rig.json', import.meta.url), 'utf8'));
const probe = JSON.parse(readFileSync('/tmp/probe_tailmaster.json', 'utf8'));
const gt = probe.tail_master_rot35z;
const rigData = buildRigData(rigJson);
const engine = new RigEngine(rigData, new ThreeIkDelegate());
const flat2m4 = f => new THREE.Matrix4().set(f[0],f[1],f[2],f[3],f[4],f[5],f[6],f[7],f[8],f[9],f[10],f[11],f[12],f[13],f[14],f[15]);
const gt2 = f => convMat(flat2m4(f));
engine.resetBases(); engine.evaluate();
// 旋转 tail_master 35°（同探针）
const M4 = THREE.Matrix4; const V3 = THREE.Vector3;
const rec = rigData.bones.get('tail_master.001');
const F = new M4().multiplyMatrices(engine.P.get(rec.parent), rec.restLocal);
const pivot = new V3().setFromMatrixPosition(engine.P.get('tail_master.001'));
const R = new M4().makeRotationZ(35 * Math.PI / 180);
const P0 = engine.P.get('tail_master.001');
engine.setBasis('tail_master.001', new M4().copy(F).invert()
  .multiply(new M4().makeTranslation(pivot.x, pivot.y, pivot.z).multiply(R)
  .multiply(new M4().makeTranslation(-pivot.x, -pivot.y, -pivot.z)).multiply(P0)));
const P = engine.evaluate();
const V=THREE.Vector3;
const yscale = m => +(new V().setFromMatrixColumn(m,1).length()).toFixed(3);
const head = n => new V().setFromMatrixPosition(P.get(n));
const gtHead = n => new V().setFromMatrixPosition(gt2(gt[n]));
console.log('bone            | mine Yscale | GT Yscale | mine头尾距 | GT头尾距 | mine头位 | GT头位 | 头位差');
for (const n of ['tail_master.001','tail.001','tail.002','tail.003','tail.004','tweak_tail.002','ORG-tail.002','DEF-tail.003']) {
  const rec2 = rigData.bones.get(n);
  const mMine = P.get(n); const mGt = gt2(gt[n]);
  const myTip = new V(0, rec2.length, 0).applyMatrix4(mMine);
  const gtTip = new V(0, rec2.length, 0).applyMatrix4(mGt);
  const par = rec2.parent;
  const mySeg = par && P.get(par) ? head(n).distanceTo(new V().setFromMatrixPosition(P.get(par))) : 0;
  const gtSeg = par && gt[par] ? gtHead(n).distanceTo(new V().setFromMatrixPosition(gt2(gt[par]))) : 0;
  const dp = head(n).distanceTo(gtHead(n));
  console.log(`${n.padEnd(17)} | ${yscale(mMine)}       | ${yscale(mGt)}      | ${mySeg.toFixed(3)}      | ${gtSeg.toFixed(3)}     | ${dp.toFixed(3)}`);
}
