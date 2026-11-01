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
  let drag = null; // { widget, mode:'move'|'rotate', plane, startHit, startP, startBasis, lockAxis, startAngle, screenCenter }

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
    const viewDir = _v1.set(0, 0, -1).applyQuaternion(camera.quaternion).clone().normalize();
    const head = new Vector3().setFromMatrixPosition(w.bone.matrixWorld);
    if (isRotateButton || ev.shiftKey) {
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
      // 移动：视图平面
      drag = {
        widget: w, mode: 'move', viewDir,
        plane: new Plane().setFromNormalAndCoplanarPoint(viewDir, head),
        startHit: rayPlane(ev, new Plane().setFromNormalAndCoplanarPoint(viewDir, head)),
        startP: engine.P.get(w.name).clone(),
        startBasis: engine.getBasis(w.name).clone(),
        lockAxis: null,
      };
    }
    dom.setPointerCapture(ev.pointerId);
  });

  function worldToScreen(v, rect) {
    const p = v.clone().project(camera);
    return { x: (p.x * 0.5 + 0.5) * rect.width + rect.left, y: (-p.y * 0.5 + 0.5) * rect.height + rect.top };
  }

  function rayPlane(ev, plane) {
    const rect = dom.getBoundingClientRect();
    const ndc = {
      x: ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    };
    raycaster.setFromCamera(ndc, camera);
    const hit = new Vector3();
    return raycaster.ray.intersectPlane(plane, hit) ? hit : new Vector3().setFromMatrixPosition(drag.startP);
  }

  function onDrag(ev) {
    const w = drag.widget;
    const rec = rigData.bones.get(w.name);
    if (drag.mode === 'move') {
      const hit = rayPlane(ev, drag.plane);
      const delta = hit.clone().sub(drag.startHit);
      if (drag.lockAxis) {
        delta[drag.lockAxis] = delta.dot(_v2.set(
          drag.lockAxis === 'x' ? 1 : 0,
          drag.lockAxis === 'y' ? 1 : 0,
          drag.lockAxis === 'z' ? 1 : 0,
        ));
        delta.x = drag.lockAxis === 'x' ? delta.x : 0;
        delta.y = drag.lockAxis === 'y' ? delta.y : 0;
        delta.z = drag.lockAxis === 'z' ? delta.z : 0;
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
    if (drag) {
      drag = null;
      controls.enabled = true;
      dom.releasePointerCapture(ev.pointerId);
    }
  });

  // 拖动中轴锁定 / Esc 取消
  addEventListener('keydown', (ev) => {
    if (drag && drag.mode === 'move' && ['x', 'y', 'z'].includes(ev.key.toLowerCase())) {
      const k = ev.key.toLowerCase();
      drag.lockAxis = drag.lockAxis === k ? null : k;
      ev.preventDefault();
    } else if (drag && ev.key === 'Escape') {
      engine.setBasis(drag.widget.name, drag.startBasis.clone());
      drag = null;
      controls.enabled = true;
      onChange();
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
