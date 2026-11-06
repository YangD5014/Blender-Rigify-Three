// blenderIK.js — Blender 标准（legacy）IK 求解器的忠实移植
// 源码依据（GPL，Blender main）：
//   intern/iksolver/intern/IK_QJacobianSolver.cpp  —— SDLS 迭代主循环
//   intern/iksolver/intern/IK_QJacobian.cpp        —— InvertSDLS（逐奇异值阻尼）
//   intern/iksolver/intern/IK_QSegment.cpp         —— 球关节段 / 单轴 Revolute 段
//   intern/iksolver/intern/IK_Math.h               —— ComputeTwist / EulerAngleFromMatrix
//   ikplugin/intern/iksolver_plugin.cc             —— execute_posetree（段构建）/ where_is_ik_bone（回写）
//
// 关键语义（GT + Blender 实证）：
//   1. 无 pole 的 2 骨链行为 = SDLS 从 pre-IK 种子迭代收敛的固定点，肘部弯曲分支
//      由迭代路径决定，任何固定平面解析公式都无法复现 —— 必须移植同一算法。
//   2. Rigify 的 _ik 链末端骨 lock_ik_y/z（如 MCH-forearm_ik2.L）→ 末端段是绕局部 X
//      的 1 自由度 Revolute（铰链），弯曲平面由此确定 —— 这是 hand_heel_ik 跟随
//      hand_ik 时姿态正确的关键（球关节假设会收敛到错误分支）。
//   3. ik_stretch（pchan->ikstretch>0）产生的平移段对本求解器数值上无贡献
//      （Jacobian 平移列为零、TranslationChange=0），可省略。

import { Matrix4, Vector3, Quaternion } from 'three';

const EPS = 1e-10;
const MAX_ANGLE_CHANGE = Math.PI / 4;
const IK_EPS = 1e-10;

// ---------- 3x3 小工具（行主序扁平数组） ----------

function m3Identity() {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

function m3Mul(a, b) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return r;
}

function m3Transpose(a) {
  return [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
}

function m3Invert(a) {
  // 正交阵用转置即可，但 basis 可能含缩放噪声 —— 用伴随/行列式兜底
  const det =
    a[0] * (a[4] * a[8] - a[5] * a[7]) -
    a[1] * (a[3] * a[8] - a[5] * a[6]) +
    a[2] * (a[3] * a[7] - a[4] * a[6]);
  if (Math.abs(det) < 1e-12) return m3Identity();
  const inv = new Array(9);
  inv[0] = (a[4] * a[8] - a[5] * a[7]) / det;
  inv[1] = (a[2] * a[7] - a[1] * a[8]) / det;
  inv[2] = (a[1] * a[5] - a[2] * a[4]) / det;
  inv[3] = (a[5] * a[6] - a[3] * a[8]) / det;
  inv[4] = (a[0] * a[8] - a[2] * a[6]) / det;
  inv[5] = (a[2] * a[3] - a[0] * a[5]) / det;
  inv[6] = (a[3] * a[7] - a[4] * a[6]) / det;
  inv[7] = (a[1] * a[6] - a[0] * a[7]) / det;
  inv[8] = (a[0] * a[4] - a[1] * a[3]) / det;
  return inv;
}

function m3Apply(a, v) {
  return new Vector3(
    a[0] * v.x + a[1] * v.y + a[2] * v.z,
    a[3] * v.x + a[4] * v.y + a[5] * v.z,
    a[6] * v.x + a[7] * v.y + a[8] * v.z,
  );
}

/** Matrix4 -> 3x3 行主序旋转（列 = 骨骼局部轴的世界方向），四元数正交化 */
function rot3Of(m) {
  const q = new Quaternion().setFromRotationMatrix(m);
  const { x, y, z, w } = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

function m3Col(a, c) {
  return new Vector3(a[c], a[3 + c], a[6 + c]);
}

/** 行主序 3x3 -> Matrix4（纯旋转） */
function m4FromM3(a) {
  return new Matrix4().set(
    a[0], a[1], a[2], 0,
    a[3], a[4], a[5], 0,
    a[6], a[7], a[8], 0,
    0, 0, 0, 1);
}

// ---------- IK_Math.h 移植 ----------

/** RotationMatrix(angle, axis) */
function rotationMatrix(sine, cosine, axis) {
  if (axis === 0) {
    return [1, 0, 0, 0, cosine, -sine, 0, sine, cosine];
  }
  if (axis === 1) {
    return [cosine, 0, sine, 0, 1, 0, -sine, 0, cosine];
  }
  return [cosine, -sine, 0, sine, cosine, 0, 0, 0, 1];
}

/** EulerAngleFromMatrix（IK_Math.h 原样移植，R 行主序） */
function eulerAngleFromMatrix(R, axis) {
  const t = Math.sqrt(R[0] * R[0] + R[1] * R[1]);
  if (t > 16 * IK_EPS) {
    if (axis === 0) return -Math.atan2(R[5], R[8]);
    if (axis === 1) return Math.atan2(-R[2], t);
    return -Math.atan2(R[1], R[0]);
  }
  if (axis === 0) return -Math.atan2(-R[7], R[4]);
  if (axis === 1) return Math.atan2(-R[2], t);
  return 0;
}

// ---------- 3x3 对称 Jacobi 特征分解（JJᵀ → thin SVD） ----------

function jacobiEigen3(Ain) {
  const a = Ain.slice();
  const v = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
  for (let sweep = 0; sweep < 32; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) off += a[p * 3 + q] * a[p * 3 + q];
    }
    if (off < 1e-18) break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p * 3 + q]) < 1e-15) continue;
        const theta = (a[q * 3 + q] - a[p * 3 + p]) / (2 * a[p * 3 + q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k * 3 + p];
          const akq = a[k * 3 + q];
          a[k * 3 + p] = c * akp - s * akq;
          a[k * 3 + q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p * 3 + k];
          const aqk = a[q * 3 + k];
          a[p * 3 + k] = c * apk - s * aqk;
          a[q * 3 + k] = s * apk + c * aqk;
        }
        const vpx = v[p].x, vpy = v[p].y, vpz = v[p].z;
        const vqx = v[q].x, vqy = v[q].y, vqz = v[q].z;
        v[p].set(c * vpx - s * vqx, c * vpy - s * vqy, c * vpz - s * vqz);
        v[q].set(s * vpx + c * vqx, s * vpy + c * vqy, s * vpz + c * vqz);
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[j * 3 + j] - a[i * 3 + i]);
  return {
    values: order.map((i) => a[i * 3 + i]),
    vectors: order.map((i) => v[i].clone()),
  };
}

/** 3×dof Jacobian 的 thin SVD：J = U W Vᵀ（U 列向量、w 降序、V 为 dof 维列向量数组） */
function svdJacobian(J, dof) {
  const jjt = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < dof; k++) s += J[i][k] * J[j][k];
      jjt[i * 3 + j] = s;
    }
  }
  const { values, vectors } = jacobiEigen3(jjt);
  const w = values.map((x) => Math.sqrt(Math.max(x, 0)));
  const U = vectors;
  const V = [];
  for (let i = 0; i < 3; i++) {
    if (w[i] > EPS) {
      const vi = new Array(dof);
      for (let k = 0; k < dof; k++) {
        vi[k] = (J[0][k] * U[i].x + J[1][k] * U[i].y + J[2][k] * U[i].z) / w[i];
      }
      V.push(vi);
    } else {
      V.push(null);
    }
  }
  return { U, w, V };
}

// ---------- 段（IK_QSegment 移植） ----------
// kind: 'spherical'（3 DoF）| 'revolute'（1 DoF，绕局部轴 m_axis）

function makeSeg(kind, axis) {
  return {
    kind,
    axis: axis || 0,
    start: new Vector3(),
    rest: m3Identity(),
    origBasis: m3Identity(), // SetTransform 的输入 basis（BasisChange 基准）
    basis: m3Identity(),
    len: 0,
    angle: 0, // revolute
    parent: -1,
  };
}

function segSetBasis(seg, basis) {
  seg.origBasis = basis.slice();
  if (seg.kind === 'spherical') {
    seg.basis = basis.slice();
  } else {
    // RevoluteSegment::SetBasis（axis != 1 分支；本 rig 无 axis==1 的 revolute）
    seg.angle = eulerAngleFromMatrix(basis, seg.axis);
    seg.basis = rotationMatrix(Math.sin(seg.angle), Math.cos(seg.angle), seg.axis);
  }
}

function segDoF(seg) {
  return seg.kind === 'spherical' ? 3 : 1;
}

function segBasisChange(seg) {
  return m3Mul(m3Invert(seg.origBasis), seg.basis);
}

// ---------- 主求解 ----------

/**
 * Blender 标准 IK（SDLS）求解。
 * @param chain [{ rec, P, parentP, locks? }] 从链根到末端；P/parentP 为 pre-IK
 *        armature-space 姿态（可含缩放，旋转部分正交化）。parentP 为链根父骨的
 *        pre-IK 姿态（链外）。locks: {x,y,z} lock_ik 标志（缺省全自由 → 球关节）。
 * @param opts { goal: Vector3（目标骨 HEAD，armature space）,
 *               polePos?: Vector3|null, poleAngle?: number, iterations?: number }
 * @returns Matrix4[] 与 chain 对齐的求解后 armature-space 姿态
 *          （where_is_ik_bone 的 basis_change 回写语义），失败返回 null。
 */
export function solveBlenderIK(chain, opts = {}) {
  const n = chain.length;
  if (n < 1) return null;
  const iterations = opts.iterations || 200;

  // ---- 段构建（execute_posetree）----
  const segs = [];
  for (let i = 0; i < n; i++) {
    const { rec, P, parentP, locks } = chain[i];
    const Rcur = rot3Of(P);
    const Rpar = parentP ? rot3Of(parentP) : m3Identity();
    // rest_basis = bone->bone_mat。本 rig（脚本化绑定）实测：运行时 bone_mat 的旋转
    // 与 restLocal 一致（GT rest 保持 + SA5 独立骨架双重验证），故取 restLocal 的
    // 旋转部分（无父骨时 restLocal = rest，与根骨 bone_mat = arm_mat 旋转一致）。
    const rest = rot3Of(rec.restLocal || rec.rest);
    let start;
    if (i === 0) {
      start = new Vector3(); // 链根段 start=0（origin = 根头）
    } else {
      const prevP = chain[i - 1].P;
      const prevR = rot3Of(prevP);
      const prevHead = new Vector3().setFromMatrixPosition(prevP);
      const prevTail = prevHead.clone().addScaledVector(m3Col(prevR, 1), chain[i - 1].rec.length);
      const head = new Vector3().setFromMatrixPosition(P);
      start = m3Apply(m3Invert(Rpar), head.sub(prevTail));
    }
    const basis = m3Mul(m3Mul(m3Invert(rest), m3Invert(Rpar)), Rcur);
    // lock_ik → 自由 DoF 决定段类型（CreateSegment）
    const freeX = !(locks && locks.x);
    const freeY = !(locks && locks.y);
    const freeZ = !(locks && locks.z);
    const ndof = (freeX ? 1 : 0) + (freeY ? 1 : 0) + (freeZ ? 1 : 0);
    let seg;
    if (ndof === 3) {
      seg = makeSeg('spherical');
    } else if (ndof === 1) {
      seg = makeSeg('revolute', freeX ? 0 : freeY ? 1 : 2);
    } else if (ndof === 2) {
      // 本 rig 未出现（swing 段）；按绕第一自由轴的 revolute 兜底
      seg = makeSeg('revolute', freeX ? 0 : 1);
    } else {
      // 全锁：退化段（不参与求解）
      seg = makeSeg('revolute', 0);
      seg.basis = basis.slice();
      seg.origBasis = basis.slice();
    }
    seg.start = start;
    seg.rest = rest;
    seg.len = rec.length;
    seg.parent = i > 0 ? i - 1 : -1;
    segSetBasis(seg, basis);
    segs.push(seg);
  }

  // ---- Scale（IK_QJacobianSolver::ComputeScale/Scale）----
  let total = 0;
  for (const s of segs) total += s.start.length() + s.len;
  const scale = total > 1e-9 ? 1 / total : 1;
  for (const s of segs) {
    s.start.multiplyScalar(scale);
    s.len *= scale;
  }

  // ---- 目标（rootmat 局部系：旋转 = 链根父骨旋转，原点 = 链根头）----
  const parentP0 = chain[0].parentP;
  const rootR = parentP0 ? rot3Of(parentP0) : m3Identity();
  const rootHead = new Vector3().setFromMatrixPosition(chain[0].P);
  const iRootR = m3Invert(rootR);
  const goalLocal = m3Apply(iRootR, new Vector3().subVectors(opts.goal, rootHead)).multiplyScalar(scale);

  // ---- 极点（ConstrainPoleVector pre-pass；无 pole 时 rootmatrix = I）----
  let rootMatrixR = m3Identity();
  const hasPole = !!opts.polePos;
  if (hasPole) {
    const polegoalLocal = m3Apply(iRootR, new Vector3().subVectors(opts.polePos, rootHead)).multiplyScalar(scale);
    rootMatrixR = _constrainPoleVectorPre(segs, rootMatrixR, goalLocal, polegoalLocal, opts.poleAngle || 0);
  }

  // ---- 迭代（IK_QJacobianSolver::Solve）----
  const dof = segs.reduce((s, g) => s + segDoF(g), 0);
  const J = [new Array(dof), new Array(dof), new Array(dof)];
  const dTheta = new Array(dof);
  const beta = new Vector3();
  const gR = new Array(n);
  const gStart = new Array(n);
  const gEnd = new Array(n);
  const dofBase = new Array(n);
  {
    let acc = 0;
    for (let i = 0; i < n; i++) { dofBase[i] = acc; acc += segDoF(segs[i]); }
  }

  const updateTransform = () => {
    let parentR = rootMatrixR;
    let parentEnd = new Vector3();
    for (let i = 0; i < n; i++) {
      const s = segs[i];
      gStart[i] = parentEnd.clone().add(m3Apply(parentR, s.start));
      gR[i] = m3Mul(parentR, m3Mul(s.rest, s.basis));
      gEnd[i] = gStart[i].clone().addScaledVector(m3Col(gR[i], 1), s.len);
      parentR = gR[i];
      parentEnd = gEnd[i];
    }
  };

  updateTransform();
  // clamp_length（IK_QPositionTask 构造：Parent 链 = 全部段）
  let clampLength = 0;
  for (const s of segs) clampLength += s.start.length() + s.len;
  clampLength /= 2 * n;

  let solved = false;
  for (let iter = 0; iter < iterations; iter++) {
    updateTransform();
    const endPos = gEnd[n - 1];

    // ---- Jacobian（IK_QPositionTask::ComputeJacobian）----
    beta.subVectors(goalLocal, endPos);
    const dlen = beta.length();
    if (dlen > clampLength) beta.multiplyScalar(clampLength / dlen);
    for (let k = 0; k < dof; k++) { J[0][k] = 0; J[1][k] = 0; J[2][k] = 0; }
    for (let i = n - 1; i >= 0; i--) {
      const s = segs[i];
      const p = gStart[i].clone().sub(endPos);
      const ndf = segDoF(s);
      for (let a = 0; a < ndf; a++) {
        const ax = s.kind === 'spherical' ? a : s.axis;
        const axis = m3Col(gR[i], ax);
        const pa = new Vector3().crossVectors(p, axis);
        const id = dofBase[i] + a;
        J[0][id] = pa.x; J[1][id] = pa.y; J[2][id] = pa.z;
      }
    }

    // ---- SDLS 求逆（IK_QJacobian::InvertSDLS）----
    dTheta.fill(0);
    const { U, w, V } = svdJacobian(J, dof);
    const norm = new Array(dof);
    for (let k = 0; k < dof; k++) {
      norm[k] = Math.sqrt(J[0][k] * J[0][k] + J[1][k] * J[1][k] + J[2][k] * J[2][k]);
    }
    for (let si = 0; si < 3; si++) {
      if (w[si] <= EPS) continue;
      const vi = V[si];
      const wInv = 1 / w[si];
      const alpha = U[si].dot(beta) * wInv;
      const N = 1; // 单 3 行任务恒为 1
      let M = 0;
      const dTmp = new Array(dof);
      let maxDTheta = 0;
      for (let k = 0; k < dof; k++) {
        M += Math.abs(vi[k]) * norm[k];
        dTmp[k] = vi[k] * alpha;
        maxDTheta = Math.max(maxDTheta, Math.abs(dTmp[k]));
      }
      M *= wInv;
      let gamma = MAX_ANGLE_CHANGE;
      if (N < M) gamma *= N / M;
      const damp = gamma < maxDTheta ? gamma / maxDTheta : 1;
      const dofdamp = Math.min(damp, 1);
      for (let k = 0; k < dof; k++) {
        dTheta[k] += 0.80 * dofdamp * dTmp[k];
      }
    }
    let maxAngle = 0;
    for (let k = 0; k < dof; k++) maxAngle = Math.max(maxAngle, Math.abs(dTheta[k]));
    if (maxAngle > MAX_ANGLE_CHANGE) {
      const damp2 = MAX_ANGLE_CHANGE / (MAX_ANGLE_CHANGE + maxAngle);
      for (let k = 0; k < dof; k++) dTheta[k] *= damp2;
    }

    // ---- 应用（UpdateAngle / UpdateAngleApply；本 rig 无关节限位）----
    for (let i = 0; i < n; i++) {
      const s = segs[i];
      if (s.kind === 'spherical') {
        const dq = new Vector3(dTheta[dofBase[i]], dTheta[dofBase[i] + 1], dTheta[dofBase[i] + 2]);
        const theta = dq.length();
        if (theta > 1e-15) {
          const q = new Quaternion().setFromAxisAngle(dq.multiplyScalar(1 / theta), theta);
          const { x, y, z, w: qw } = q;
          const M = [
            1 - 2 * (y * y + z * z), 2 * (x * y - z * qw), 2 * (x * z + y * qw),
            2 * (x * y + z * qw), 1 - 2 * (x * x + z * z), 2 * (y * z - x * qw),
            2 * (x * z - y * qw), 2 * (y * z + x * qw), 1 - 2 * (x * x + y * y),
          ];
          s.basis = m3Mul(s.basis, M);
        }
      } else {
        s.angle += dTheta[dofBase[i]];
        s.basis = rotationMatrix(Math.sin(s.angle), Math.cos(s.angle), s.axis);
      }
    }

    // ---- 收敛（AngleUpdateNorm < 1e-3 且 >10 次迭代）----
    const maxnorm = dTheta.reduce((m, d) => Math.max(m, Math.abs(d)), 0);
    if (maxnorm < 1e-3 && iter > 10) {
      solved = true;
      break;
    }
  }

  // ---- 极点 post-pass（PrependBasis）----
  if (hasPole) {
    const s0 = segs[0];
    s0.basis = m3Mul(m3Mul(m3Mul(m3Invert(s0.rest), rootMatrixR), s0.rest), s0.basis);
  }

  // ---- 结果回写（where_is_ik_bone：pose = parent_final @ inv(parent_pre) @ pre @ basisChange）----
  const out = [];
  let parentFinal = null;
  for (let i = 0; i < n; i++) {
    const change = segBasisChange(segs[i]);
    const pre = chain[i].P;
    let m;
    if (i === 0) {
      m = pre.clone(); // 链根父级不在链内（pre = final）
    } else {
      m = parentFinal.clone()
        .multiply(new Matrix4().copy(chain[i - 1].P).invert())
        .multiply(pre);
    }
    m.multiply(m4FromM3(change));
    parentFinal = m;
    out.push(m);
  }

  return out;
}

/** ConstrainPoleVector pre-pass：旋转 rootMatrixR 使链根朝向极点方向 */
function _constrainPoleVectorPre(segs, rootMatrixR, goal, polegoal, poleAngle) {
  const n = segs.length;
  const computeGlobals = (rootR) => {
    const gR = new Array(n);
    const gStart = new Array(n);
    const gEnd = new Array(n);
    let parentR = rootR;
    let parentEnd = new Vector3();
    for (let i = 0; i < n; i++) {
      const s = segs[i];
      gStart[i] = parentEnd.clone().add(m3Apply(parentR, s.start));
      gR[i] = m3Mul(parentR, m3Mul(s.rest, s.basis));
      gEnd[i] = gStart[i].clone().addScaledVector(m3Col(gR[i], 1), s.len);
      parentR = gR[i];
      parentEnd = gEnd[i];
    }
    return { gR, gStart, gEnd };
  };
  const { gR, gStart, gEnd } = computeGlobals(rootMatrixR);

  const rootpos = gStart[0];
  const endpos = gEnd[n - 1];
  const rootbasis = gR[0];
  const dir = endpos.clone().sub(rootpos).normalize();
  const rootx = m3Col(rootbasis, 0);
  const rootz = m3Col(rootbasis, 2);
  const up = rootx.clone().multiplyScalar(Math.cos(poleAngle))
    .addScaledVector(rootz, Math.sin(poleAngle));
  const poledir = goal.clone().sub(rootpos).normalize();
  const poleup = polegoal.clone().sub(rootpos).normalize();

  const normed = (v) => {
    const len = v.length();
    return len > 1e-12 ? v.clone().multiplyScalar(1 / len) : v.clone();
  };
  const matR0 = normed(new Vector3().crossVectors(dir, up));
  const matR1 = normed(new Vector3().crossVectors(matR0, dir));
  const mat = [matR0.x, matR0.y, matR0.z, matR1.x, matR1.y, matR1.z, -dir.x, -dir.y, -dir.z];
  const poleR0 = normed(new Vector3().crossVectors(poledir, poleup));
  const poleR1 = normed(new Vector3().crossVectors(poleR0, poledir));
  const polemat = [poleR0.x, poleR0.y, poleR0.z, poleR1.x, poleR1.y, poleR1.z, -poledir.x, -poledir.y, -poledir.z];

  return m3Mul(m3Transpose(polemat), mat);
}
