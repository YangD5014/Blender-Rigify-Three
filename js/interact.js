// interact.js — Blender 姿态模式风格交互
// 左键拖动 = 移动（G，视图平面），Shift+左键拖动 = 旋转（R，绕视图轴过骨骼头），
// 拖动中按 X/Y/Z = 全局轴锁定，Esc 取消。中键/右键交给 OrbitControls。
import {
  Raycaster, Vector3, Quaternion, Matrix4, Plane, LineBasicMaterial, Color,
} from 'three';

export function flatToM4(flat) {
  return new Matrix4().set(
    flat[0], flat[1], flat[2], flat[3],
    flat[4], flat[5], flat[6], flat[7],
    flat[8], flat[9], flat[10], flat[11],
    flat[12], flat[13], flat[14], flat[15],
  );
}

const _v1 = new Vector3();
const _v2 = new Vector3();
const _m1 = new Matrix4();
const _m2 = new Matrix4();

/**
 * 找出「旋转主控 + 尾端手柄」型控件：自身是纯旋转主控（无位置约束），
 * widget 却画在链末端（shape_transform）。这类控件拖动时应解释为 IK 目标，
 * 把位移交给链骨求解（如 tail_master.001 → tail.001-004）。
 * 仅当存在「逐级 Copy Rotation」链且锚点骨是链末端后代时才登记。
 */
function findIkDragChains(rigData) {
  const bones = rigData.bones;
  const result = new Map();
  for (const [master, rec] of bones) {
    const anchor = rec.shapeTransform;
    if (!anchor || !bones.has(anchor)) continue;
    const chain = [];
    const seen = new Set([master]);
    let curName = master;
    while (chain.length <= 64) {
      const next = [...bones.values()].find((b) => !seen.has(b.name)
        && (b.constraints || []).some((c) => c.type === 'COPY_ROTATION'
          && c.subtarget === curName && c.influence > 0 && !c.mute));
      if (!next) break;
      chain.push(next.name);
      seen.add(next.name);
      curName = next.name;
    }
    if (chain.length < 2) continue;
    let a = bones.get(anchor);
    let anchorAtChainEnd = false;
    while (a) {
      if (a.name === chain[chain.length - 1]) { anchorAtChainEnd = true; break; }
      a = a.parent ? bones.get(a.parent) : null;
    }
    if (anchorAtChainEnd) result.set(master, chain);
  }
  return result;
}

export function setupInteraction({ renderer, camera, controls, widgets, rigData, engine, boneByName, onChange, onSelection }) {
  const raycaster = new Raycaster();
  raycaster.params.Line = { threshold: 0.03 };
  raycaster.params.Mesh = {};
  const dom = renderer.domElement;
  // 线框 + 半透明面都参与拾取（Blender 同款行为：点和面都能选中）
  const objects = widgets.flatMap((w) => {
    const objs = [w.line];
    const mesh = w.holder.children.find((c) => c.isMesh);
    if (mesh) objs.push(mesh);
    return objs;
  });

  let hovered = null;
  let selected = null;
  let drag = null; // { widget, mode:'move'|'rotate', modal, plane, startHit, startP, startBasis, lockAxis, startAngle, screenCenter }
  let lastMouse = null; // 视口坐标，供 G/R 模态起点使用

  // 拖尾端手柄 = 尾部 IK 目标（见 findIkDragChains）
  const ikDragChains = findIkDragChains(rigData);

  function ikChainFor(name) { return ikDragChains.get(name); }

  function snapshotIk(chain) {
    return chain.map((n) => ({
      name: n,
      basis: engine.getBasis(n).clone(),
      overridden: engine.overrides.has(n),
    }));
  }

  function restoreIk(snapshot) {
    if (!snapshot) return;
    for (const s of snapshot) {
      engine.setBasis(s.name, s.basis.clone());
      if (s.overridden) engine.overrides.add(s.name);
      else engine.overrides.delete(s.name);
    }
  }

  /** 从尾部 IK 覆写状态回到主控旋转语义（拖动/旋转主控前调用） */
  function releaseIkChain(name) {
    const chain = ikChainFor(name);
    if (!chain) return false;
    if (!chain.some((n) => engine.overrides.has(n))) return false;
    engine.clearOverrides(chain);
    onChange();
    return true;
  }

  /** 把拖动位移当作 IK 目标，求解链并把结果写回各骨 basis（覆写约束） */
  function applyIkDrag(w, startAnchor, delta) {
    const chainNames = ikChainFor(w.name);
    if (!chainNames) return false;
    const recs = chainNames.map((n) => rigData.bones.get(n));
    const chain = recs.map((r) => ({
      rec: r,
      P: engine.P.get(r.name),
      F: r.parent
        ? new Matrix4().multiplyMatrices(engine.P.get(r.parent), r.restLocal)
        : r.rest.clone(),
    }));
    const target = startAnchor.clone().add(delta);
    const solved = engine.ikDelegate?.solve(chain, target, { useStretch: false });
    if (!solved) return false;
    let parentP = recs[0].parent ? engine.P.get(recs[0].parent) : null;
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      const F = parentP
        ? new Matrix4().multiplyMatrices(parentP, r.restLocal)
        : r.rest.clone();
      engine.setOverrideBasis(r.name, new Matrix4().copy(F).invert().multiply(solved[i]));
      parentP = solved[i];
    }
    return true;
  }


  // ---------- Blender 式模态操作 ----------
  // G = 移动模式（控制器跟随鼠标，无需按住按钮）；R = 旋转模式。
  // 移动中 X/Y/Z 锁轴；左键/Enter 确认；Esc/右键取消。
  function startModal(type) {
    if (drag) return;
    const w = selected || (lastMouse ? pick({ clientX: lastMouse.x, clientY: lastMouse.y }) : null);
    if (!w) return;
    if (selected !== w) {
      if (selected) setVisual(selected, 'normal');
      selected = w;
      onSelection(w.name);
    }
    setVisual(w, 'selected');
    controls.enabled = false;
    if (type === 'rotate') releaseIkChain(w.name); // 旋转主控 → 回到主控旋转语义
    const viewDir = _v1.set(0, 0, -1).applyQuaternion(camera.quaternion).clone().normalize();
    const head = new Vector3().setFromMatrixPosition(w.bone.matrixWorld);
    const rect = dom.getBoundingClientRect();
    const mouse = lastMouse || { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    if (type === 'move') {
      const chain = ikChainFor(w.name);
      drag = {
        widget: w, mode: 'move', modal: true, viewDir,
        plane: new Plane().setFromNormalAndCoplanarPoint(viewDir, head),
        startHit: rayPlane(mouse, new Plane().setFromNormalAndCoplanarPoint(viewDir, head), head),
        startP: engine.P.get(w.name).clone(),
        startBasis: engine.getBasis(w.name).clone(),
        startAnchor: new Vector3().setFromMatrixPosition(w.bone.matrixWorld),
        ikSnapshot: chain ? snapshotIk(chain) : null,
        lockAxis: null,
      };
    } else {
      drag = {
        widget: w, mode: 'rotate', modal: true, viewDir,
        center: head.clone(),
        screenCenter: worldToScreen(head, rect),
        startAngle: Math.atan2(mouse.y - worldToScreen(head, rect).y, mouse.x - worldToScreen(head, rect).x),
        startP: engine.P.get(w.name).clone(),
        startBasis: engine.getBasis(w.name).clone(),
      };
    }
  }

  function endModal(apply) {
    if (!drag) return;
    if (!apply) {
      engine.setBasis(drag.widget.name, drag.startBasis.clone());
      restoreIk(drag.ikSnapshot);
      onChange();
    }
    drag = null;
    controls.enabled = true;
  }

  // 屏幕空间拾取：把 widget 的边投影到屏幕，取光标附近（<PICK_PX）最近者。
  // 线框 widget 的中部没有可 raycast 的几何，屏幕空间法对 Blender 式 widget 最稳。
  const PICK_PX = 16;
  const _proj = new Vector3();
  function pick(ev) {
    const rect = dom.getBoundingClientRect();
    const cx = ev.clientX - rect.left;
    const cy = ev.clientY - rect.top;
    let best = null;
    let bestD = PICK_PX;
    let bestDepth = Infinity;
    for (const w of widgets) {
      // 可见性（沿父链检查）
      let o = w.holder;
      let vis = true;
      while (o) { if (o.visible === false) { vis = false; break; } o = o.parent; }
      if (!vis) continue;
      const geo = w.line.geometry;
      const pos = geo.getAttribute('position');
      let dMin = Infinity;
      let zAtMin = Infinity;
      const pts = [];
      for (let i = 0; i < pos.count; i++) {
        _proj.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(w.line.matrixWorld).project(camera);
        pts.push([(_proj.x * 0.5 + 0.5) * rect.width, (-_proj.y * 0.5 + 0.5) * rect.height, _proj.z]);
      }
      for (const [a, b] of w.edgeList) {
        const [x1, y1, z1] = pts[a];
        const [x2, y2, z2] = pts[b];
        const dx = x2 - x1; const dy = y2 - y1;
        const lenSq = dx * dx + dy * dy;
        let t = lenSq > 0 ? ((cx - x1) * dx + (cy - y1) * dy) / lenSq : 0;
        t = Math.max(0, Math.min(1, t));
        const px = x1 + dx * t; const py = y1 + dy * t;
        const d = Math.hypot(cx - px, cy - py);
        if (d < dMin) { dMin = d; zAtMin = z1 + (z2 - z1) * t; }
      }
      if (dMin < bestD || (dMin === bestD && zAtMin < bestDepth)) {
        bestD = dMin; best = w; bestDepth = zAtMin;
      }
    }
    return best;
  }

  function setVisual(w, state) {
    if (!w) return;
    const mat = w.line.material;
    mat.color.copy(state === 'selected' ? w.colorSelected : state === 'hover' ? w.colorHover : w.colorNormal);
  }

  // ---------- 指针事件 ----------
  dom.addEventListener('pointermove', (ev) => {
    lastMouse = { x: ev.clientX, y: ev.clientY };
    if (drag) { onDrag(ev); return; }
    const w = pick(ev);
    if (w !== hovered) {
      if (hovered && hovered !== selected) setVisual(hovered, 'normal');
      hovered = w;
      if (hovered && hovered !== selected) setVisual(hovered, 'hover');
      dom.style.cursor = hovered ? 'pointer' : 'default';
    }
  });

  // 右键用于 widget 旋转 → 阻止浏览器右键菜单
  dom.addEventListener('contextmenu', (ev) => ev.preventDefault());

  dom.addEventListener('pointerdown', (ev) => {
    // 模态进行中：左键/Enter=确认（保持当前姿态），右键=取消（还原）
    if (drag && drag.modal) {
      if (ev.button === 0) endModal(true);
      else if (ev.button === 2) endModal(false);
      return;
    }
    const isRotateButton = ev.button === 2; // 右键 = 旋转
    if (ev.button !== 0 && ev.button !== 2) return; // 中键 → OrbitControls 缩放
    const w = pick(ev);
    if (!w) {
      if (ev.button === 0 && selected) { setVisual(selected, 'normal'); selected = null; onSelection(null); }
      return; // 空处：左键旋转视图 / 右键平移（OrbitControls 接管）
    }
    if (selected && selected !== w) setVisual(selected, 'normal');
    selected = w;
    setVisual(w, 'selected');
    onSelection(w.name);
    controls.enabled = false; // 挂住 widget 时屏蔽视图操作
    const isRotate = isRotateButton || ev.shiftKey;
    if (isRotate) releaseIkChain(w.name); // 旋转主控 → 回到主控旋转语义
    const viewDir = _v1.set(0, 0, -1).applyQuaternion(camera.quaternion).clone().normalize();
    const head = new Vector3().setFromMatrixPosition(w.bone.matrixWorld);
    if (isRotate) {
      // 旋转：绕视图轴过骨骼头
      const rect = dom.getBoundingClientRect();
      drag = {
        widget: w, mode: 'rotate', viewDir,
        center: head.clone(),
        screenCenter: worldToScreen(head, rect),
        startAngle: Math.atan2(ev.clientY - worldToScreen(head, rect).y, ev.clientX - worldToScreen(head, rect).x),
        startP: engine.P.get(w.name).clone(),
        startBasis: engine.getBasis(w.name).clone(),
      };
    } else {
      // 移动：视图平面；尾端手柄则作为尾部 IK 目标
      const chain = ikChainFor(w.name);
      drag = {
        widget: w, mode: 'move', viewDir,
        plane: new Plane().setFromNormalAndCoplanarPoint(viewDir, head),
        startHit: rayPlane(ev, new Plane().setFromNormalAndCoplanarPoint(viewDir, head), head),
        startP: engine.P.get(w.name).clone(),
        startBasis: engine.getBasis(w.name).clone(),
        startAnchor: new Vector3().setFromMatrixPosition(w.bone.matrixWorld),
        ikSnapshot: chain ? snapshotIk(chain) : null,
        lockAxis: null,
      };
    }
    try { dom.setPointerCapture(ev.pointerId); } catch { /* 合成事件无活动指针 */ }
  });

  function worldToScreen(v, rect) {
    const p = v.clone().project(camera);
    return { x: (p.x * 0.5 + 0.5) * rect.width + rect.left, y: (-p.y * 0.5 + 0.5) * rect.height + rect.top };
  }

  function rayPlane(ev, plane, fallback) {
    const rect = dom.getBoundingClientRect();
    const ndc = {
      x: ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    };
    raycaster.setFromCamera(ndc, camera);
    const hit = new Vector3();
    // 相交失败（平行/背向）时退回调用方给定的参考点
    return raycaster.ray.intersectPlane(plane, hit) ? hit : (fallback ? fallback.clone() : new Vector3());
  }

  function onDrag(ev) {
    const w = drag.widget;
    const rec = rigData.bones.get(w.name);
    if (drag.mode === 'move') {
      const hit = rayPlane(ev, drag.plane, drag.startHit);
      const delta = hit.clone().sub(drag.startHit);
      if (drag.lockAxis) {
        // 轴名 = Blender 轴：X→右，Y→前，Z→上。映射到 glTF：X→X，Y→−Z，Z→Y
        const g = { x: delta.x, y: -delta.z, z: delta.y };
        const keep = g[drag.lockAxis];
        delta.set(
          drag.lockAxis === 'x' ? keep : 0,
          drag.lockAxis === 'z' ? keep : 0,
          drag.lockAxis === 'y' ? -keep : 0,
        );
      }
      // 尾端手柄：位移解释为尾部 IK 目标（求解后写回链骨 basis）
      if (drag.startAnchor && ikDragChains.has(w.name)) {
        if (applyIkDrag(w, drag.startAnchor, delta)) { onChange(); return; }
      }
      // P' = P0 + Δ（世界平移），basis = inv(parentP @ restLocal) @ P'
      const Pnew = drag.startP.clone().setPosition(
        drag.startP.elements[12] + delta.x,
        drag.startP.elements[13] + delta.y,
        drag.startP.elements[14] + delta.z,
      );
      const F = rec.parent
        ? new Matrix4().multiplyMatrices(engine.P.get(rec.parent), rec.restLocal)
        : rec.rest.clone();
      engine.setBasis(w.name, new Matrix4().copy(F).invert().multiply(Pnew));
    } else {
      // 旋转：屏幕角度绕视图轴
      const rect = dom.getBoundingClientRect();
      const c = drag.screenCenter;
      const a = Math.atan2(ev.clientY - c.y, ev.clientX - c.x);
      let dA = a - drag.startAngle;
      // 屏幕角 → 世界角（视图轴指向观察者时为正）
      const q = new Quaternion().setFromAxisAngle(drag.viewDir, -dA);
      const head = new Vector3().setFromMatrixPosition(drag.startP);
      const R = new Matrix4().makeRotationFromQuaternion(q);
      const Pnew = new Matrix4().makeTranslation(head.x, head.y, head.z)
        .multiply(R)
        .multiply(new Matrix4().makeTranslation(-head.x, -head.y, -head.z))
        .multiply(drag.startP);
      const F = rec.parent
        ? new Matrix4().multiplyMatrices(engine.P.get(rec.parent), rec.restLocal)
        : rec.rest.clone();
      engine.setBasis(w.name, new Matrix4().copy(F).invert().multiply(Pnew));
    }
    onChange();
  }

  dom.addEventListener('pointerup', (ev) => {
    if (drag && !drag.modal) { // 模态不受 pointerup 结束（由确认/取消结束）
      drag = null;
      controls.enabled = true;
      try { dom.releasePointerCapture(ev.pointerId); } catch { /* 合成事件 */ }
    }
  });

  // Blender 式模态键：G/R 启动 · 拖动中 X/Y/Z 轴锁定 · Enter/左键 确认 · Esc/右键 取消
  addEventListener('keydown', (ev) => {
    if (!drag) {
      if (ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const k = ev.key.toLowerCase();
      if (k === 'g') startModal('move');
      else if (k === 'r') startModal('rotate');
      return;
    }
    if (drag.mode === 'move' && ['x', 'y', 'z'].includes(ev.key.toLowerCase())) {
      const k = ev.key.toLowerCase();
      drag.lockAxis = drag.lockAxis === k ? null : k;
      ev.preventDefault();
    } else if (ev.key === 'Escape') {
      if (drag.modal) endModal(false);
      else {
        engine.setBasis(drag.widget.name, drag.startBasis.clone());
        restoreIk(drag.ikSnapshot);
        drag = null;
        controls.enabled = true;
        onChange();
      }
    } else if (drag.modal && ev.key === 'Enter') {
      endModal(true);
    }
  });

  return {
    flatToM4,
    getSelected: () => selected && selected.name,
    /** 调试：指定 canvas 客户区坐标处的拾取结果（不含 panel 偏移） */
    debugPick(cx, cy) {
      const w = pick({ clientX: cx, clientY: cy });
      return w ? w.name : null;
    },
  };
}
