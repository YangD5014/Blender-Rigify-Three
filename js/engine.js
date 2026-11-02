// engine.js — Blender 姿态求值引擎
// 复刻 Blender 的骨骼层级 + 约束栈 + 驱动器求值模型：
//   P(bone) = P(parent) @ restLocal(bone) @ basis(bone)，再逐条叠加约束（在 basis 空间）。
// 坐标系：glTF（Y-up），rest 矩阵已由 rigdata.js 转换。
// Copy 类约束带 rest 补偿：M = rest_o @ inv(rest_t) @ T，B_new = inv(F) @ M，
// 保证静止位 influence=1 时精确复现 rest（与 Blender 行为一致）。
import { Matrix4, Vector3, Quaternion, Euler } from 'three';
import { indexDriverRules, evalRule } from './drivers.js';

export class RigEngine {
  /**
   * @param rigData buildRigData() 的返回值
   * @param ikDelegate { solve(chain, targetPos, opts) => Matrix4[] } 可选
   *   chain: [{rec, P}] 从链根到末端（pre-IK 姿态矩阵）
   *   返回与 chain 对齐的求解后 armature-space 矩阵数组
   */
  constructor(rigData, ikDelegate = null) {
    this.rig = rigData;
    this.bones = rigData.bones;
    this.order = rigData.order;
    this.ikDelegate = ikDelegate;
    this.P = new Map(); // name -> Matrix4（armature space 姿态）
    this.bases = new Map(); // name -> Matrix4（matrix_basis）
    this.propValues = {};
    this.driverIdx = indexDriverRules(rigData.driverRules);
    this.weightRules = new Map(); // `${bone}\u0000${con}\u0000${index}` -> rule
    for (const r of rigData.driverRules) {
      if (r.kind === 'weight') this.weightRules.set(`${r.bone}\u0000${r.con}\u0000${r.index}`, r);
    }
    this.warnedTypes = new Set();
    // 交互式 IK 覆写：被覆写的骨骼跳过自身约束栈，直接使用外部写入的 basis
    // （如拖动 tail_master.001 → 尾部 IK 求解，tail.001-004 的 Copy Rotation 不再覆盖结果）
    this.overrides = new Set();
    this.resetBases();
    // P 持久化：循环依赖的目标读「上一帧」状态（与 Blender 对 cyclic 约束的处理一致）
    for (const rec of this.bones.values()) this.P.set(rec.name, rec.rest.clone());
  }

  resetBases() {
    // 初始 basis = 单位阵（= rest 姿态，与 GLB 导出一致；文件里保存的少量非单位 basis 不采用）
    for (const rec of this.bones.values()) {
      this.bases.set(rec.name, new Matrix4());
    }
    if (this.overrides) this.overrides.clear();
  }

  /** 交互式 IK：写入 basis 并标记为覆写（求值时跳过该骨自身约束栈） */
  setOverrideBasis(name, m) {
    this.bases.set(name, m);
    this.overrides.add(name);
  }

  clearOverrides(names) {
    const list = names || [...this.overrides];
    for (const n of list) this.bases.set(n, new Matrix4());
    for (const n of list) this.overrides.delete(n);
  }

  setBasis(name, m) { this.bases.set(name, m); }
  getBasis(name) { return this.bases.get(name); }

  setProp(propBone, prop, value) {
    if (!this.propValues[propBone]) this.propValues[propBone] = {};
    this.propValues[propBone][prop] = value;
  }

  getProp(propBone, prop) { return this.propValues[propBone]?.[prop]; }

  /** 应用全部自定义属性（{propBone: {prop: value}}） */
  setProps(props) { this.propValues = props || {}; }

  /** 求值整棵骨架，返回 P（Map name -> Matrix4，armature space） */
  evaluate() {
    const P = this.P;
    for (const name of this.order) {
      const rec = this.bones.get(name);
      const F = rec.parent
        ? new Matrix4().multiplyMatrices(P.get(rec.parent), rec.restLocal)
        : rec.rest.clone();
      let B = this.bases.get(name);
      if (!this.overrides.has(name)) {
        for (const con of rec.constraints) {
        // 驱动器求值（influence / mute）
        let mute = con.mute;
        let influence = con.influence;
        const rules = this.driverIdx.get(`${name}\u0000${con.name}`);
        if (rules) {
          for (const r of rules) {
            const v = evalRule(r, this.propValues);
            if (r.kind === 'influence') influence = v;
            else if (r.kind === 'mute') mute = v > 0.5;
          }
        }
        if (mute || influence <= 1e-6) continue;
        B = this._applyConstraint(rec, con, B, F, influence);
        }
      }
      P.set(name, new Matrix4().multiplyMatrices(F, B));
    }
    return P;
  }

  _applyConstraint(rec, con, B, F, influence) {
    switch (con.type) {
      case 'COPY_TRANSFORMS': return this._copyTransforms(rec, con, B, F, influence);
      case 'COPY_LOCATION': return this._copyLocation(rec, con, B, F, influence);
      case 'COPY_ROTATION': return this._copyRotation(rec, con, B, F, influence);
      case 'COPY_SCALE': return this._copyScale(rec, con, B, F, influence);
      case 'STRETCH_TO': return this._stretchTo(rec, con, B, F, influence);
      case 'DAMPED_TRACK': return this._dampedTrack(rec, con, B, F, influence);
      case 'LIMIT_DISTANCE': return this._limitDistance(rec, con, B, F, influence);
      case 'ARMATURE': return this._armature(rec, con, B, F, influence);
      case 'IK': return this._ik(rec, con, B, F, influence);
      default:
        if (!this.warnedTypes.has(con.type)) {
          this.warnedTypes.add(con.type);
          console.warn('未实现的约束类型:', con.type);
        }
        return B;
    }
  }

  /** 目标骨骼的当前参考点（armature space）：head_tail ∈ [0,1] 沿目标 Y 插值 */
  _targetPoint(con, tRec, T, headTail) {
    const p = new Vector3().setFromMatrixPosition(T);
    if (headTail > 0) {
      p.addScaledVector(new Vector3(0, 1, 0).transformDirection(T), headTail * tRec.length);
    }
    return p;
  }

  _copyTransforms(rec, con, B, F, influence) {
    const tRec = this.bones.get(con.subtarget);
    if (!tRec) return B;
    const T = this.P.get(con.subtarget) || tRec.rest;
    // Blender 语义（对照真值反推）：位置 = owner rest 点 +（目标当前点 − 目标 rest 点）；
    // 旋转 = 目标相对其 rest 的旋转差叠加在 owner rest 朝向上；缩放原样携带目标当前缩放。
    const restO = rec.rest;
    const pNew = new Vector3().setFromMatrixPosition(restO)
      .add(new Vector3().subVectors(
        this._targetPoint(con, tRec, T, 0),
        this._targetPoint(con, tRec, tRec.rest, 0),
      ));
    const qT = new Quaternion().setFromRotationMatrix(_pureRot(T));
    const qTr = new Quaternion().setFromRotationMatrix(_pureRot(tRec.rest));
    const qO = new Quaternion().setFromRotationMatrix(_pureRot(restO));
    const qNew = qT.multiply(qTr.invert()).multiply(qO);
    const sT = new Vector3();
    T.decompose(_V1, _Q1, sT);
    const PNew = new Matrix4().compose(pNew, qNew, sT);
    let Bnew = new Matrix4().copy(F).invert().multiply(PNew);
    if (con.mix_mode === 'BEFORE') {
      Bnew = new Matrix4().multiplyMatrices(Bnew, B);
    } else if (con.mix_mode === 'AFTER') {
      Bnew = new Matrix4().multiplyMatrices(B, Bnew);
    }
    return _blend(B, Bnew, influence);
  }

  _copyLocation(rec, con, B, F, influence) {
    const tRec = this.bones.get(con.subtarget);
    if (!tRec) return B;
    const T = this.P.get(con.subtarget) || tRec.rest;
    const ht = con.head_tail || 0;
    // 世界系 delta =（目标当前点 − 目标 rest 点），轴过滤后加到 owner rest 点上
    const delta = new Vector3().subVectors(
      this._targetPoint(con, tRec, T, ht),
      this._targetPoint(con, tRec, tRec.rest, ht),
    );
    const dx = con.use_x === false ? 0 : delta.x * (con.invert_x ? -1 : 1);
    const dy = con.use_y === false ? 0 : delta.y * (con.invert_y ? -1 : 1);
    const dz = con.use_z === false ? 0 : delta.z * (con.invert_z ? -1 : 1);
    const pNew = new Vector3().setFromMatrixPosition(rec.rest).add(new Vector3(dx, dy, dz));
    // 只改世界位置：P_new = P_cur 平移替换，再转回 basis 空间
    const Pcur = new Matrix4().multiplyMatrices(F, B);
    const Pnew = Pcur.clone().setPosition(pNew);
    const out = new Matrix4().copy(F).invert().multiply(Pnew);
    return _blend(B, out, influence);
  }

  _copyRotation(rec, con, B, F, influence) {
    const tRec = this.bones.get(con.subtarget);
    if (!tRec) return B;
    const T = this.P.get(con.subtarget) || tRec.rest;
    const curQ = new Quaternion();
    B.decompose(_V1, curQ, _V2);

    if (con.target_space === 'LOCAL' || con.owner_space === 'LOCAL') {
      // LOCAL/LOCAL：通道级拷贝（GT 实证）——owner 通道旋转 := 目标通道旋转。
      // 直接拷"basis 对 basis"的旋转，链式 whip（tail.00N ← tail.00N-1）每环拷到
      // 相同的通道增量，不会像世界系拷贝那样逐环翻倍（tail_rot GT 已验证）。
      const FT = tRec.parent
        ? new Matrix4().multiplyMatrices(this.P.get(tRec.parent), tRec.restLocal)
        : tRec.rest.clone();
      const Rcopy = _rotOf(new Matrix4().copy(FT).invert().multiply(T));
      // 轴过滤：euler XYZ 分解，未选轴保留 owner 当前通道分量
      const euT = new Euler().setFromRotationMatrix(Rcopy, 'XYZ');
      const euCur = new Euler().setFromQuaternion(curQ, 'XYZ');
      const ex = con.use_x === false ? euCur.x : euT.x * (con.invert_x ? -1 : 1);
      const ey = con.use_y === false ? euCur.y : euT.y * (con.invert_y ? -1 : 1);
      const ez = con.use_z === false ? euCur.z : euT.z * (con.invert_z ? -1 : 1);
      const qCopy = new Quaternion().setFromEuler(new Euler(ex, ey, ez, 'XYZ'));
      let qMix;
      if (con.mix_mode === 'BEFORE') qMix = qCopy.clone().multiply(curQ);
      else if (con.mix_mode === 'AFTER') qMix = curQ.clone().multiply(qCopy);
      else qMix = qCopy;
      const out = B.clone();
      _setRot(out, new Matrix4().makeRotationFromQuaternion(qMix));
      return _blend(B, out, influence);
    }

    // WORLD/WORLD：目标相对其 rest 的旋转差（世界系）叠加到 owner rest 朝向
    const qT = new Quaternion().setFromRotationMatrix(_pureRot(T));
    const qTr = new Quaternion().setFromRotationMatrix(_pureRot(tRec.rest));
    const qDelta = qT.multiply(qTr.invert());
    const qO = new Quaternion().setFromRotationMatrix(_pureRot(rec.rest));
    const qLocal = qO.clone().invert().multiply(qDelta).multiply(qO);
    const eu = new Euler().setFromQuaternion(qLocal, 'XYZ');
    const ex = con.use_x === false ? 0 : eu.x * (con.invert_x ? -1 : 1);
    const ey = con.use_y === false ? 0 : eu.y * (con.invert_y ? -1 : 1);
    const ez = con.use_z === false ? 0 : eu.z * (con.invert_z ? -1 : 1);
    const qDeltaF = qO.clone().multiply(new Quaternion().setFromEuler(new Euler(ex, ey, ez, 'XYZ'))).multiply(qO.clone().invert());
    const qF = new Quaternion().setFromRotationMatrix(_pureRot(F));
    let qWorld;
    if (con.mix_mode === 'BEFORE') qWorld = qDeltaF.clone().multiply(qF).multiply(curQ);
    else if (con.mix_mode === 'AFTER') qWorld = qF.clone().multiply(curQ).multiply(qDeltaF);
    else qWorld = qDeltaF.clone().multiply(qO);
    const out = B.clone();
    _setRot(out, new Matrix4().makeRotationFromQuaternion(qF.clone().invert().multiply(qWorld)));
    return _blend(B, out, influence);
  }

  _copyScale(rec, con, B, F, influence) {
    const tRec = this.bones.get(con.subtarget);
    if (!tRec) return B;
    const T = this.P.get(con.subtarget) || tRec.rest;
    const s = new Vector3();
    T.decompose(_V1, _Q1, s);
    const cur = new Vector3(); const cq = new Quaternion(); const cs = new Vector3();
    B.decompose(cur, cq, cs);
    const sx = con.use_x === false ? cs.x : s.x * (con.invert_x ? -1 : 1);
    const sy = con.use_y === false ? cs.y : s.y * (con.invert_y ? -1 : 1);
    const sz = con.use_z === false ? cs.z : s.z * (con.invert_z ? -1 : 1);
    const out = new Matrix4().compose(cur, cq, new Vector3(sx, sy, sz));
    return _blend(B, out, influence);
  }

  _stretchTo(rec, con, B, F, influence) {
    const tRec = this.bones.get(con.subtarget);
    if (!tRec) return B;
    const T = this.P.get(con.subtarget) || tRec.rest;
    const Pcur = new Matrix4().multiplyMatrices(F, B);
    const head = new Vector3().setFromMatrixPosition(Pcur);
    const tp = new Vector3().setFromMatrixPosition(T);
    const dir = new Vector3().subVectors(tp, head);
    const dist = dir.length();
    // 退化：目标与 owner 头部重合时 Blender 不动作（GT 验证：缩放/旋转保持不变）。
    // 阈值 1e-3：级联浮点噪声约 1e-4 量级，真实 stretch 距离 ≥ 骨长（≥0.02）。
    if (dist < 1e-3) {
      return _blend(B, B, influence);
    }
    const yscale = con.rest_length > 1e-9 ? dist / con.rest_length : 1;
    let sx = 1; let sz = 1;
    if (con.volume === 'XZ') { const f = yscale > 1e-9 ? 1 / Math.sqrt(yscale) : 1; sx = f; sz = f; }
    else if (con.volume === 'X') { sx = yscale > 1e-9 ? 1 / yscale : 1; }
    else if (con.volume === 'Z') { sz = yscale > 1e-9 ? 1 / yscale : 1; }
    const yCur = new Vector3(0, 1, 0).transformDirection(Pcur);
    const qSwing = new Quaternion().setFromUnitVectors(yCur.normalize(), dir.normalize());
    const out = B.clone();
    _applyWorldSwing(out, F, qSwing);
    const p = new Vector3(); const q = new Quaternion(); const s = new Vector3();
    out.decompose(p, q, s);
    out.compose(p, q, new Vector3(s.x * sx, s.y * yscale, s.z * sz));
    return _blend(B, out, influence);
  }

  _dampedTrack(rec, con, B, F, influence) {
    const tRec = this.bones.get(con.subtarget);
    if (!tRec) return B;
    const T = this.P.get(con.subtarget) || tRec.rest;
    const Pcur = new Matrix4().multiplyMatrices(F, B);
    const head = new Vector3().setFromMatrixPosition(Pcur);
    const rawDir = new Vector3().subVectors(new Vector3().setFromMatrixPosition(T), head);
    const axisName = con.track_axis || 'TRACK_Y';
    const axisVec = axisName.startsWith('TRACK_NY') ? new Vector3(0, -1, 0)
      : axisName.startsWith('TRACK_Y') ? new Vector3(0, 1, 0)
        : axisName.startsWith('TRACK_NX') ? new Vector3(-1, 0, 0)
          : axisName.startsWith('TRACK_X') ? new Vector3(1, 0, 0)
            : axisName.startsWith('TRACK_NZ') ? new Vector3(0, 0, -1)
              : new Vector3(0, 0, 1);
    const axisCur = axisVec.clone().transformDirection(Pcur).normalize();
    // 退化：目标与 owner 重合（含浮点噪声级）时，对齐目标骨骼的 +Y（= 指向目标 tail，
    // 与 GT 中 MCH-upper_arm_tweak 旋转 17.29° 对齐 orgY 的行为一致）
    let dir;
    if (!Number.isFinite(rawDir.x) || rawDir.lengthSq() < 1e-8) {
      dir = new Vector3(0, 1, 0).transformDirection(T).normalize();
    } else {
      dir = rawDir.normalize();
    }
    const qSwing = new Quaternion().setFromUnitVectors(axisCur, dir);
    const out = B.clone();
    _applyWorldSwing(out, F, qSwing);
    return _blend(B, out, influence);
  }

  _limitDistance(rec, con, B, F, influence) {
    return B; // 本 rig 全部 influence=0
  }

  _armature(rec, con, B, F, influence) {
    const acc = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    let totalW = 0;
    const targets = con.targets || [];
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      let w = t.weight;
      const rule = this.weightRules.get(`${rec.name}\u0000${con.name}\u0000${i}`);
      if (rule) w = evalRule(rule, this.propValues);
      if (!w || !t.subtarget || !this.bones.has(t.subtarget)) continue;
      const tRec = this.bones.get(t.subtarget);
      const T = this.P.get(t.subtarget) || tRec.rest;
      // SWITCH_PARENT：刚性挂接到目标（P_t @ inv(rest_t) @ rest_o）
      const Mi = new Matrix4().copy(T)
        .multiply(new Matrix4().copy(tRec.rest).invert())
        .multiply(rec.rest)
        .multiplyScalar(w);
      for (let k = 0; k < 16; k++) acc[k] += Mi.elements[k];
      totalW += w;
    }
    if (totalW <= 1e-9) return B;
    const M = new Matrix4().fromArray(acc).multiplyScalar(1 / totalW);
    const Bnew = new Matrix4().copy(F).invert().multiply(M);
    return _blend(B, Bnew, influence);
  }

  _ik(rec, con, B, F, influence) {
    if (!this.ikDelegate) {
      if (!this.warnedTypes.has('NO_IK')) {
        this.warnedTypes.add('NO_IK');
        console.warn('未提供 ikDelegate，IK 约束被跳过');
      }
      return B;
    }
    // 链：owner 往上 chain_count 根（沿父级，不要求 connected —— 与 Blender 一致，
    // 本 rig 的 _ik 链就是 connect=false 的两骨链）
    const chainRecs = [rec];
    let cur = rec;
    for (let i = 1; i < con.chain_count; i++) {
      const p = this.bones.get(cur.parent);
      if (!p) break;
      chainRecs.unshift(p);
      cur = p;
    }
    const targetRec = this.bones.get(con.subtarget);
    if (!targetRec) return B;
    const T = this.P.get(con.subtarget) || targetRec.rest;
    // IK 目标点 = 目标骨骼的 HEAD（use_tail 只控制链末端 = owner 的 tail，已用虚拟关节处理）
    const targetPos = new Vector3().setFromMatrixPosition(T);
    // pre-IK 链姿态
    const chain = chainRecs.map((r, i) => ({
      rec: r,
      P: i < chainRecs.length - 1
        ? this.P.get(r.name)
        : new Matrix4().multiplyMatrices(F, B),
      F: i < chainRecs.length - 1
        ? (r.parent ? new Matrix4().multiplyMatrices(this.P.get(r.parent), r.restLocal) : r.rest.clone())
        : F.clone(),
    }));
    let polePos = null;
    if (con.pole_subtarget && this.bones.has(con.pole_subtarget)) {
      polePos = new Vector3().setFromMatrixPosition(this.P.get(con.pole_subtarget) || this.bones.get(con.pole_subtarget).rest);
    }
    const solved = this.ikDelegate.solve(chain, targetPos, {
      polePos, poleAngle: con.pole_angle, useStretch: con.use_stretch,
    });
    if (!solved) return B;
    for (let i = 0; i < chainRecs.length; i++) {
      const r = chainRecs[i];
      const Pout = _blend(chain[i].P, solved[i], influence);
      if (i < chainRecs.length - 1) {
        this.P.set(r.name, Pout);
      } else {
        B = new Matrix4().copy(F).invert().multiply(Pout);
      }
    }
    return B;
  }
}

// ---------- 工具 ----------

const _V1 = new Vector3(); const _V2 = new Vector3();
const _Q1 = new Quaternion(); const _Q2 = new Quaternion();

function _blend(Ma, Mb, t) {
  if (t >= 1 - 1e-9) return Mb.clone();
  const pa = new Vector3(); const qa = new Quaternion(); const sa = new Vector3();
  const pb = new Vector3(); const qb = new Quaternion(); const sb = new Vector3();
  Ma.decompose(pa, qa, sa);
  Mb.decompose(pb, qb, sb);
  return new Matrix4().compose(
    new Vector3().lerpVectors(pa, pb, t),
    qa.clone().slerp(qb, t),
    new Vector3().lerpVectors(sa, sb, t),
  );
}

function _rotOf(M) {
  M.decompose(_V1, _Q1, _V2);
  return new Matrix4().makeRotationFromQuaternion(_Q1);
}

/** 纯旋转矩阵（去缩放） */
function _pureRot(M) {
  return _rotOf(M);
}

function _setRot(M, R) {
  const p = new Vector3(); const s = new Vector3();
  const q = new Quaternion();
  M.decompose(p, q, s);
  R.decompose(_V1, _Q2, _V2);
  M.compose(p, _Q2, s);
}

/** 世界系最小摆动应用到 basis：B' = inv(Frot) @ q @ Frot @ R(B) */
function _applyWorldSwing(B, F, qWorld) {
  const Frot = _rotOf(F);
  const Finv = new Matrix4().copy(Frot).invert();
  const qA = new Quaternion().setFromRotationMatrix(Finv);
  const qB = new Quaternion().setFromRotationMatrix(Frot);
  const qLocal = qA.multiply(qWorld).multiply(qB);
  const R = _rotOf(B);
  _setRot(B, new Matrix4().makeRotationFromQuaternion(qLocal).multiply(R));
}
