// poseApply.js — 把引擎求值结果（armature-space 姿态矩阵）写回 GLB 骨骼
import { Matrix4 } from 'three';

const _m = new Matrix4();

/**
 * @param P Map<boneName, Matrix4> 引擎姿态（armature space, glTF 坐标）
 * @param boneByName Map<boneName, THREE.Bone>
 * @param rigData buildRigData() 结果
 * 每根骨骼的局部矩阵 = inv(parentP) @ P；根骨 = P。
 * 之后由调用方 modelRoot.updateMatrixWorld(true) 传播到蒙皮与 widget。
 */
export function applyWorldPose(P, boneByName, rigData) {
  for (const [name, bone] of boneByName) {
    if (bone.matrixAutoUpdate) bone.matrixAutoUpdate = false; // 防止 updateMatrix() 覆写姿态矩阵
    const rec = rigData.bones.get(name);
    const p = P.get(name);
    if (!p) continue;
    if (rec && rec.parent) {
      const pp = P.get(rec.parent);
      if (pp) {
        _m.copy(pp).invert().multiply(p);
        bone.matrix.copy(_m);
        bone.matrixWorldNeedsUpdate = true;
        continue;
      }
    }
    bone.matrix.copy(p);
    bone.matrixWorldNeedsUpdate = true;
  }
}
