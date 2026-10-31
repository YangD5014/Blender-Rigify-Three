// rigdata.js — 加载 rig.json，转换为 glTF 坐标系（Y-up）下的引擎数据结构
// rig.json 的矩阵是行主序扁平数组（Blender matrix_local / matrix_basis，Z-up）
// 转换：M_gltf = C · M_blender · C⁻¹，C 为 Z-up→Y-up 旋转
import { Matrix4, Vector3, Quaternion } from 'three';

// Z-up -> Y-up: (x, y, z)_bl -> (x, z, -y)_gltf
export const CONV = new Matrix4().set(
  1, 0, 0, 0,
  0, 0, 1, 0,
  0, -1, 0, 0,
  0, 0, 0, 1);
const CONV_INV = new Matrix4().copy(CONV).invert();

export function m4FromFlat(flat) {
  return new Matrix4().set(
    flat[0], flat[1], flat[2], flat[3],
    flat[4], flat[5], flat[6], flat[7],
    flat[8], flat[9], flat[10], flat[11],
    flat[12], flat[13], flat[14], flat[15]);
}

/**
 * Blender armature-space 矩阵 -> glTF 坐标系（左乘 C）。
 * 注意：骨骼 rest 是 bone-space → armature-space 的映射，bone-space 不随全局坐标系
 * 重定基，所以只需左乘 C；bone-space 内部的 restLocal / matrix_basis 保持原值不变。
 * （共轭 C·M·C⁻¹ 会把 restLocal 转坏 90°——已踩坑验证。）
 */
export function convMat(mBl) {
  return new Matrix4().multiplyMatrices(CONV, mBl);
}

/** bone-space 矩阵：原样保留 */
export function boneMat(mBl) {
  return mBl.clone();
}

export function flatToGltf(flat) {
  return convMat(m4FromFlat(flat));
}

export function vecToGltf(v) {
  return new Vector3(v[0], v[2], -v[1]);
}

/**
 * 构建引擎用的骨骼记录。
 * 返回 { bones: Map<name, rec>, order: [name...], collections, widgetGeoms, driverRules }
 */
export function buildRigData(rigJson) {
  const bones = new Map();
  for (const [name, rb] of Object.entries(rigJson.bones)) {
    const rest = convMat(m4FromFlat(rb.matrix_local)); // armature-space rest（左乘 C）
    const rec = {
      name,
      parent: rb.parent,
      head: vecToGltf(rb.head),
      tail: vecToGltf(rb.tail),
      length: rb.length,
      rest,
      restLocal: null, // inv(parent.rest) @ rest，root 时 = rest
      basisDefault: m4FromFlat(rb.matrix_basis), // bone-space，原样保留
      useDeform: rb.use_deform,
      collections: rb.collections,
      hide: rb.hide,
      connect: rb.connect,
      useLocalLocation: rb.use_local_location,
      shape: rb.shape,
      shapeTransform: rb.shape_transform,
      shapeScale: rb.shape_scale,
      shapeTranslation: rb.shape_translation,
      shapeRotation: rb.shape_rotation,
      shapeBoneSize: rb.shape_bone_size,
      color: rb.color,
      colorCustom: rb.color_custom,
      props: rb.props || {},
      constraints: rb.constraints || [],
    };
    bones.set(name, rec);
  }
  // restLocal
  for (const rec of bones.values()) {
    if (rec.parent) {
      const p = bones.get(rec.parent);
      if (!p) throw new Error(`骨骼 ${rec.name} 的父级 ${rec.parent} 不存在`);
      rec.restLocal = new Matrix4().copy(p.rest).invert().multiply(rec.rest);
    } else {
      rec.restLocal = rec.rest.clone();
    }
  }
  // 拓扑排序：父级优先 + 约束目标依赖
  const order = topoSort(bones);
  // 收集 widget 几何（顶点在 WGT 物体局部空间 = bone-space，原样保留，不做坐标转换）
  const widgetGeoms = {};
  for (const [wname, w] of Object.entries(rigJson.widgets || {})) {
    widgetGeoms[wname] = {
      verts: w.verts.map((v) => new Vector3(v[0], v[1], v[2])),
      edges: w.edges,
      tris: w.tris,
      materials: w.materials,
    };
  }
  return {
    bones,
    order,
    collections: rigJson.collections || [],
    widgetGeoms,
    driverRules: rigJson.driverRules || [],
    drivers: rigJson.drivers || [],
    armatureName: rigJson.armature,
  };
}

/** 拓扑排序：父级边必须满足；target 边成环时按优先级打破 */
function topoSort(bones) {
  const parentDeps = new Map(); // 仅父级（必无环）
  const targetDeps = new Map(); // target 依赖（可能成环）
  for (const rec of bones.values()) {
    const p = new Set();
    const t = new Set();
    if (rec.parent) p.add(rec.parent);
    for (const c of rec.constraints) {
      // _track 骨的 DAMPED_TRACK target 边丢弃（读上一帧值，Blender 在此断环）
      if (rec.name.includes('_track') && c.type === 'DAMPED_TRACK') continue;
      if (c.subtarget && bones.has(c.subtarget)) t.add(c.subtarget);
      if (c.type === 'IK' && c.pole_subtarget && bones.has(c.pole_subtarget)) t.add(c.pole_subtarget);
      if (c.type === 'ARMATURE') {
        for (const tt of (c.targets || [])) {
          if (tt.subtarget && bones.has(tt.subtarget)) t.add(tt.subtarget);
        }
      }
    }
    if (rec.shapeTransform && bones.has(rec.shapeTransform)) t.add(rec.shapeTransform);
    parentDeps.set(rec.name, p);
    targetDeps.set(rec.name, t);
  }
  // 关键：IK 约束会覆写链骨的最终姿态，链骨的所有后代必须排在 IK owner 之后
  // （Blender depsgraph 语义；否则链骨后代读到 IK 前的矩阵，级联全错——已踩坑验证）
  const ikOwnerDeps = new Map(); // bone -> Set(IK owner)
  for (const rec of bones.values()) {
    for (const c of rec.constraints) {
      if (c.type !== 'IK' || c.mute) continue;
      // 链 = owner 往上 chain_count 根
      const chainBones = new Set([rec.name]);
      let cur = rec;
      for (let i = 1; i < (c.chain_count || 0); i++) {
        if (!cur.parent || !bones.has(cur.parent)) break;
        cur = bones.get(cur.parent);
        chainBones.add(cur.name);
      }
      // 所有链骨的后代（链骨本身与 owner 除外，避免自环）
      for (const other of bones.values()) {
        if (chainBones.has(other.name)) continue;
        let a = other;
        while (a && a.parent) {
          if (chainBones.has(a.parent)) {
            if (!ikOwnerDeps.has(other.name)) ikOwnerDeps.set(other.name, new Set());
            ikOwnerDeps.get(other.name).add(rec.name);
            break;
          }
          a = bones.get(a.parent);
        }
      }
    }
  }
  // 打环优先级：_track 骨的 target 出边最先断（与 Blender 一致），其余按遇到顺序
  const visited = new Set();
  const visiting = new Set();
  const order = [];
  const broken = new Set();
  function visit(name) {
    if (visited.has(name)) return;
    visiting.add(name);
    const deps = [...parentDeps.get(name), ...(ikOwnerDeps.get(name) || []), ...targetDeps.get(name)];
    // _track 的 target 边排最后（最先被断）
    deps.sort((a, b) => {
      const aTrack = a.includes('_track') && targetDeps.get(name).has(a) ? 1 : 0;
      const bTrack = b.includes('_track') && targetDeps.get(name).has(b) ? 1 : 0;
      return aTrack - bTrack;
    });
    for (const dep of deps) {
      if (visiting.has(dep)) {
        // 成环：若这是 _track 的 target 边，记录为断点（跳过）
        broken.add(`${name}->${dep}`);
        continue;
      }
      if (!visited.has(dep)) visit(dep);
    }
    visiting.delete(name);
    visited.add(name);
    order.push(name);
  }
  for (const name of bones.keys()) visit(name);
  if (broken.size) console.warn('断开的环依赖边:', [...broken].join(', '));
  return order;
}

/** 默认自定义属性值（数值型） */
export function defaultPropValues(bones) {
  const props = {}; // propBone -> { prop: value }
  for (const rec of bones.values()) {
    const vals = {};
    for (const [k, v] of Object.entries(rec.props)) {
      if (typeof v === 'number' || typeof v === 'boolean') vals[k] = typeof v === 'boolean' ? (v ? 1 : 0) : v;
    }
    if (Object.keys(vals).length) props[rec.name] = vals;
  }
  return props;
}
