// ikadapter.js — IK 求解适配层
// 本 rig 的全部活动 IK 链都是 chain_count=2，交给 blenderIK.js（Blender 标准
// legacy iksolver 的忠实移植，SDLS 迭代 + lock_ik 段类型语义）求解。
// 之前的 three-ik (FABRIK) 方案无法复现 Blender 无 pole 链的肘部弯曲分支
// （GT 实证：hand_L_back/in/out 肘部分支错误 → hand_heel_ik 跟随姿态错误）。
import { Matrix4, Vector3 } from 'three';
import { solveBlenderIK } from './blenderIK.js';

export class ThreeIkDelegate {
  /**
   * @param chain [{rec, P, F}] 从链根到末端（pre-IK 姿态矩阵，armature space）
   *   rec: rigdata 骨骼记录；P: 该骨当前 pre-IK 姿态；F: 父骨姿态 @ restLocal
   * @param targetPos Vector3 目标点（目标骨 HEAD，armature space）
   * @param opts { polePos, poleAngle, useStretch, iterations }
   * @returns Matrix4[] 与 chain 对齐的求解后 armature-space 矩阵数组
   */
  solve(chain, targetPos, opts = {}) {
    const n = chain.length;
    if (n < 1) return null;
    const entries = chain.map((c, i) => {
      // parentP：链根的父骨姿态 = F @ inv(restLocal)（F = P(parent) @ restLocal）
      let parentP = null;
      if (i === 0) {
        if (c.rec.restLocal) {
          parentP = new Matrix4().copy(c.F)
            .multiply(new Matrix4().copy(c.rec.restLocal).invert());
        } // restLocal 为空（无父骨）→ parentP = null → 求解器按单位旋转处理
      } else {
        parentP = chain[i - 1].P;
      }
      return {
        rec: c.rec,
        P: c.P,
        parentP,
        locks: c.rec.lockIk ? { x: c.rec.lockIk[0], y: c.rec.lockIk[1], z: c.rec.lockIk[2] } : null,
      };
    });
    return solveBlenderIK(entries, {
      goal: targetPos,
      polePos: opts.polePos || null,
      poleAngle: opts.poleAngle || 0,
      iterations: opts.iterations || 200,
    });
  }
}
