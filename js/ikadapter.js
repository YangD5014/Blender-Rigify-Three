// ikadapter.js — THREE.IK 适配层
// 用 three-ik (FABRIK) 求解链上关节位置；骨骼朝向由「pre 姿态 + 最小摆动」重建，
// 保留 Blender 无 pole IK 的 roll 语义（three-ik 的 setQuaternionFromDirection 会丢 roll，
// 这里只取它的位置解，朝向自己重建 —— 与 SKILL.md 记录的 fixChainRoll 经验一致）。
// 超出链长时按 Blender use_stretch 语义把链骨均匀拉伸。
import { Object3D, Matrix4, Vector3, Quaternion } from 'three';
import { IK, IKChain, IKJoint } from 'three-ik';

export class ThreeIkDelegate {
  constructor() {
    this.iterations = 60;
    this.tolerance = 1e-5;
    this.debug = false;
  }

  /**
   * @param chain [{rec, P, F}] 从链根到末端（pre-IK）
   * @param targetPos Vector3 目标点（世界/armature space）
   * @param opts { polePos, poleAngle, useStretch }
   * @returns Matrix4[] 与 chain 对齐的求解后矩阵
   */
  solve(chain, targetPos, opts = {}) {
    const n = chain.length;
    if (n < 1) return null;
    // ---- 构建临时镜像层级 ----
    const container = new Object3D();
    container.matrixAutoUpdate = false;
    container.matrix.copy(chain[0].F); // 链根的父系帧（updateMatrixWorld 会据此算 matrixWorld）
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
    // use_tail：加一个末端虚拟关节（尾部点）
    const lastRec = chain[n - 1].rec;
    let tailJoint = null;
    if (lastRec.length > 1e-9) {
      tailJoint = new Object3D();
      tailJoint.matrixAutoUpdate = false;
      tailJoint.matrix.makeTranslation(0, lastRec.length, 0);
      prev.add(tailJoint);
    }
    // ---- pre 姿态数据（用于 roll 重建与 stretch） ----
    container.updateMatrixWorld(true);
    const prePos = (tailJoint ? [...joints, tailJoint] : joints)
      .map((j) => new Vector3().setFromMatrixPosition(j.matrixWorld));
    const preQ = chain.map((c) => new Quaternion().setFromRotationMatrix(_rotOf(c.P)));
    const preTail = lastRec.length > 1e-9
      ? new Vector3(0, lastRec.length, 0).applyMatrix4(chain[n - 1].P)
      : null;
    // ---- Blender use_stretch：目标超出可达范围时按比例预拉伸镜像链 ----
    let stretch = 1;
    if (opts.useStretch) {
      let total = 0;
      for (let i = 0; i < prePos.length - 1; i++) total += prePos[i].distanceTo(prePos[i + 1]);
      const want = prePos[0].distanceTo(targetPos);
      if (total > 1e-9 && want > total * 1.0001) {
        stretch = want / total;
        // 沿 pre 方向重建关节位置（保持方向，拉伸段长）
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
    const target = new Object3D();
    target.matrixAutoUpdate = false;
    target.matrix.makeTranslation(targetPos.x, targetPos.y, targetPos.z);
    target.matrixWorld.copy(target.matrix);
    target.updateMatrixWorld(true);

    // ---- three-ik 链 ----
    const ik = new IK();
    const ikChain = new IKChain();
    ikChain.iterations = this.iterations;
    ikChain.tolerance = this.tolerance;
    const allJoints = tailJoint ? [...joints, tailJoint] : joints;
    for (let i = 0; i < allJoints.length; i++) {
      const isLast = i === allJoints.length - 1;
      if (isLast) ikChain.add(new IKJoint(allJoints[i]), { target });
      else ikChain.add(new IKJoint(allJoints[i]));
    }
    ik.add(ikChain);

    // ---- 求解 ----
    ik.solve();

    // ---- 读解 ----
    container.updateMatrixWorld(true);
    const solPos = allJoints.map((j) => new Vector3().setFromMatrixPosition(j.matrixWorld));

    // ---- 重建骨骼矩阵：swing(pre_dir -> sol_dir) @ q_pre ----
    const out = [];
    for (let i = 0; i < n; i++) {
      const startP = solPos[i];
      let endP;
      if (i < n - 1) endP = solPos[i + 1];
      else if (preTail) endP = solPos[n];
      else endP = targetPos.clone();
      const dirPre = new Vector3().subVectors(i < n - 1 ? prePos[i + 1] : preTail, prePos[i]);
      const dirSol = new Vector3().subVectors(endP, startP);
      let q = preQ[i].clone();
      if (dirPre.lengthSq() > 1e-12 && dirSol.lengthSq() > 1e-12) {
        const swing = new Quaternion().setFromUnitVectors(dirPre.normalize(), dirSol.normalize());
        q.premultiply(swing);
      }
      const sc = new Vector3(1, 1, 1);
      if (stretch !== 1) {
        // Blender 的 stretch 是沿骨 Y 的长度拉伸：解后段长 / pre 段长
        const segPre = i < n - 1 ? prePos[i].distanceTo(prePos[i + 1]) : (preTail ? prePos[i].distanceTo(preTail) : 1);
        const segSol = i < n - 1 ? solPos[i].distanceTo(solPos[i + 1]) : (preTail ? solPos[i].distanceTo(solPos[n]) : 1);
        sc.set(1, segPre > 1e-9 ? segSol / segPre : 1, 1);
      }
      out.push(new Matrix4().compose(startP, q, sc));
    }
    return out;
  }
}

function _rotOf(M) {
  const p = new Vector3(); const q = new Quaternion(); const s = new Vector3();
  M.decompose(p, q, s);
  return new Matrix4().makeRotationFromQuaternion(q);
}
