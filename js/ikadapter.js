// ikadapter.js — IK 求解适配层
// 本 rig 的 IK 链全部是 2 链（chain_count=2），用余弦定理闭式解：
//   - 肘部位置解析求出，垂直分量取「pre-IK 种子」一侧 → 无分支歧义
//     （FABRIK 对大幅目标跳变会跨轴翻转分支 → hand_track/heel 旋转异常，已踩坑验证）
//   - use_stretch：目标超出 rest 可达范围时沿骨 Y 均匀拉伸（Blender 语义，只拉不压）
//   - 朝向由「种子姿态 + 最小摆动」重建，保留 Blender 无 pole IK 的 roll 语义
//     （three-ik 的 setQuaternionFromDirection 会丢 roll，只取其位置解，朝向自己重建）
// n>2 的链回退到 three-ik (FABRIK)（为通用 rig 预留）。
import { Object3D, Matrix4, Vector3, Quaternion } from 'three';
import { IK, IKChain, IKJoint } from 'three-ik';

export class ThreeIkDelegate {
  constructor() {
    this.iterations = 60;
    this.tolerance = 1e-5;
  }

  /**
   * @param chain [{rec, P, F}] 从链根到末端（pre-IK）
   * @param targetPos Vector3 目标点（armature space）
   * @param opts { polePos, poleAngle, useStretch }
   * @returns Matrix4[] 与 chain 对齐的求解后矩阵
   */
  solve(chain, targetPos, opts = {}) {
    const n = chain.length;
    if (n < 1) return null;
    if (n !== 2) return this._solveFABRIK(chain, targetPos, opts);

    // ---------- 2 链解析解 ----------
    const lastRec = chain[1].rec;
    const r = new Vector3().setFromMatrixPosition(chain[0].P); // 链根（父级驱动）
    const eSeed = new Vector3().setFromMatrixPosition(chain[1].P); // 种子肘部（pre-IK）
    const endSeed = lastRec.length > 1e-9
      ? new Vector3(0, lastRec.length, 0).applyMatrix4(chain[1].P)
      : targetPos.clone();
    const preQ = chain.map((c) => new Quaternion().setFromRotationMatrix(_rotOf(c.P)));

    // 有效段长（含父链继承缩放，与 Blender 求解器使用的长度一致）
    const L1 = r.distanceTo(eSeed);
    const L2 = eSeed.distanceTo(endSeed);

    const d0 = new Vector3().subVectors(targetPos, r);
    let d = d0.length();
    if (d < 1e-9) d = 1e-9;
    const axis = d0.clone().multiplyScalar(1 / d);

    // use_stretch：目标超出可达范围时均匀拉伸（只拉伸、不压缩——Blender 行为）
    let stretch = 1;
    const total = L1 + L2;
    if (opts.useStretch && d > total * 1.0001) {
      stretch = d / total;
    }
    const l1 = L1 * stretch;
    const l2 = L2 * stretch;

    // 余弦定理：肘部沿轴距离 a、垂直高度 h
    const dd = Math.min(Math.max(d, Math.abs(l1 - l2) + 1e-9), l1 + l2 - 1e-9);
    const a = (l1 * l1 - l2 * l2 + dd * dd) / (2 * dd);
    const h2 = l1 * l1 - a * a;
    const h = Math.sqrt(Math.max(0, h2));

    // 肘部垂直分量取种子一侧（关键：无分支歧义）
    const center = r.clone().addScaledVector(axis, a);
    const perp = new Vector3().subVectors(eSeed, r);
    perp.addScaledVector(axis, -perp.dot(axis));
    if (perp.lengthSq() < 1e-12) {
      perp.copy(new Vector3(0, 1, 0).cross(axis));
      if (perp.lengthSq() < 1e-12) perp.set(1, 0, 0).cross(axis);
    }
    const elbow = center.addScaledVector(perp.normalize(), h);

    // 链末端（owner tail）：拉伸时沿肘→目标方向放 l2；未拉伸精确落在目标上
    let end;
    if (stretch === 1) {
      end = targetPos.clone();
    } else {
      const endDir = new Vector3().subVectors(targetPos, elbow);
      if (endDir.lengthSq() < 1e-12) endDir.copy(axis);
      end = elbow.clone().addScaledVector(endDir.normalize(), l2);
    }
    const solPos = [r.clone(), elbow, end];

    // ---------- 重建骨骼矩阵：swing(种子方向 -> 解方向) @ q_pre ----------
    const out = [];
    for (let i = 0; i < 2; i++) {
      const startP = solPos[i];
      const seedEnd = i === 0 ? eSeed : endSeed;
      const solEnd = i === 0 ? elbow : end;
      const anchor = i === 0 ? r : eSeed;
      const dirPre = new Vector3().subVectors(seedEnd, anchor);
      const dirSol = new Vector3().subVectors(solEnd, startP);
      let q = preQ[i].clone();
      if (dirPre.lengthSq() > 1e-12 && dirSol.lengthSq() > 1e-12) {
        const swing = new Quaternion().setFromUnitVectors(dirPre.normalize(), dirSol.normalize());
        q.premultiply(swing);
      }
      out.push(new Matrix4().compose(startP, q, new Vector3(1, stretch, 1)));
    }
    return out;
  }

  /** n>2 链的 FABRIK 回退（three-ik） */
  _solveFABRIK(chain, targetPos, opts = {}) {
    const n = chain.length;
    const container = new Object3D();
    container.matrixAutoUpdate = false;
    container.matrix.copy(chain[0].F);
    const joints = [];
    let prev = container;
    for (let i = 0; i < n; i++) {
      const j = new Object3D();
      j.matrixAutoUpdate = false;
      const parentWorld = i === 0 ? chain[0].F : chain[i - 1].P;
      j.matrix.copy(new Matrix4().copy(parentWorld).invert()).multiply(chain[i].P);
      prev.add(j);
      joints.push(j);
      prev = j;
    }
    const lastRec = chain[n - 1].rec;
    let tailJoint = null;
    if (lastRec.length > 1e-9) {
      tailJoint = new Object3D();
      tailJoint.matrixAutoUpdate = false;
      tailJoint.matrix.makeTranslation(0, lastRec.length, 0);
      prev.add(tailJoint);
    }
    container.updateMatrixWorld(true);
    const prePos = (tailJoint ? [...joints, tailJoint] : joints)
      .map((j) => new Vector3().setFromMatrixPosition(j.matrixWorld));
    const preQ = chain.map((c) => new Quaternion().setFromRotationMatrix(_rotOf(c.P)));
    const target = new Object3D();
    target.matrixAutoUpdate = false;
    target.matrix.makeTranslation(targetPos.x, targetPos.y, targetPos.z);
    target.matrixWorld.copy(target.matrix);
    target.updateMatrixWorld(true);

    const ik = new IK();
    const ikChain = new IKChain();
    ikChain.iterations = this.iterations;
    ikChain.tolerance = this.tolerance;
    const allJoints = tailJoint ? [...joints, tailJoint] : joints;
    for (let i = 0; i < allJoints.length; i++) {
      if (i === allJoints.length - 1) ikChain.add(new IKJoint(allJoints[i]), { target });
      else ikChain.add(new IKJoint(allJoints[i]));
    }
    ik.add(ikChain);

    // use_stretch 预拉伸
    let stretch = 1;
    if (opts.useStretch) {
      let total = 0;
      for (let i = 0; i < prePos.length - 1; i++) total += prePos[i].distanceTo(prePos[i + 1]);
      const want = prePos[0].distanceTo(targetPos);
      if (total > 1e-9 && want > total * 1.0001) {
        stretch = want / total;
        const newWorld = [prePos[0].clone()];
        for (let i = 0; i < prePos.length - 1; i++) {
          const dir = new Vector3().subVectors(prePos[i + 1], prePos[i]).normalize();
          newWorld.push(new Vector3().copy(newWorld[i]).addScaledVector(dir, prePos[i].distanceTo(prePos[i + 1]) * stretch));
        }
        const all = tailJoint ? [...joints, tailJoint] : joints;
        let parentW = chain[0].F;
        for (let i = 0; i < all.length; i++) {
          all[i].matrix.copy(new Matrix4().copy(parentW).invert())
            .multiply(new Matrix4().makeTranslation(newWorld[i].x, newWorld[i].y, newWorld[i].z));
          parentW = new Matrix4().makeTranslation(newWorld[i].x, newWorld[i].y, newWorld[i].z);
        }
        container.updateMatrixWorld(true);
      }
    }

    ik.solve();
    container.updateMatrixWorld(true);
    const solPos = allJoints.map((j) => new Vector3().setFromMatrixPosition(j.matrixWorld));

    const out = [];
    for (let i = 0; i < n; i++) {
      const startP = solPos[i];
      const endP = i < n - 1 ? solPos[i + 1] : (tailJoint ? solPos[n] : targetPos.clone());
      const dirPre = new Vector3().subVectors(i < n - 1 ? prePos[i + 1] : (tailJoint ? prePos[n] : targetPos), prePos[i]);
      const dirSol = new Vector3().subVectors(endP, startP);
      let q = preQ[i].clone();
      if (dirPre.lengthSq() > 1e-12 && dirSol.lengthSq() > 1e-12) {
        q.premultiply(new Quaternion().setFromUnitVectors(dirPre.normalize(), dirSol.normalize()));
      }
      out.push(new Matrix4().compose(startP, q, new Vector3(1, stretch, 1)));
    }
    return out;
  }
}

function _rotOf(M) {
  const p = new Vector3(); const q = new Quaternion(); const s = new Vector3();
  M.decompose(p, q, s);
  return new Matrix4().makeRotationFromQuaternion(q);
}
