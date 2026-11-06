// ui.js — 面板 UI：姿态预设、IK/FK 滑杆、集合可见性、显示开关
import { Matrix4 } from 'three';
import { defaultPropValues } from './rigdata.js';

const PRESET_NAMES = [
  ['rest', '站立 rest'],
  ['torso_down', '压躯干'],
  ['torso_down_more', '深压躯干'],
  ['combo_prone', '趴下'],
  ['combo_sit', '坐下'],
  ['combo_walk', '行走'],
  ['head_down', '低头'],
  ['tail_rot', '甩尾'],
];

// 自动生成的滑杆：propBone → prop（顺序即显示顺序）
const SLIDER_PROPS = [
  ['IK_FK', 'IK ←→ FK', 0, 1],
  ['pole_vector', 'pole_vector', 0, 1],
  ['IK_Stretch', 'IK_Stretch', 0, 1],
  ['FK_limb_follow', 'FK_limb_follow', 0, 1],
  ['neck_follow', 'neck_follow', 0, 1],
  ['head_follow', 'head_follow', 0, 1],
  ['tail_follow', 'tail_follow', 0, 1],
];

export function setupUI({ rigData, engine, posesJson, widgets, onPreset, onPropChange }) {
  const poses = new Map(posesJson.poses.map((p) => [p.name, p]));

  // ---- 姿态预设 ----
  const presetsEl = document.getElementById('presets');
  if (presetsEl) for (const [key, label] of PRESET_NAMES) {
    if (!poses.has(key)) continue;
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.onclick = () => {
      const pose = poses.get(key);
      engine.resetBases();
      for (const [n, f] of Object.entries(pose.basis)) {
        if (n === 'hand_heel_ik.L' || n === 'hand_heel_ik.R') continue; // 保留默认 67° 旋转
        engine.setBasis(n, flatToM4(f));
      }
      const props = defaultPropValues(rigData.bones);
      for (const [bone, kv] of Object.entries(pose.props || {})) {
        props[bone] = { ...(props[bone] || {}) };
        for (const [k, v] of Object.entries(kv)) if (typeof v === 'number') props[bone][k] = v;
      }
      engine.setProps(props);
      for (const el of presetsEl.children) el.classList.remove('active');
      btn.classList.add('active');
      refreshSliders();
      onPreset();
    };
    presetsEl.appendChild(btn);
  }

  // ---- IK/FK 滑杆 ----
  const slidersEl = document.getElementById('sliders');
  const sliderRows = []; // {propBone, prop, input, val}
  if (slidersEl) {
  for (const [recName, rec] of rigData.bones) {
    if (!engine.propValues[recName]) continue;
    for (const [prop, label, min, max] of SLIDER_PROPS) {
      if (!(prop in engine.propValues[recName])) continue;
      const row = document.createElement('div');
      row.className = 'slider-row';
      const lab = document.createElement('label');
      lab.textContent = `${recName.replace(/\.[LR]$/, '')}${recName.match(/\.[LR]$/) ? recName.slice(-2) : ''} · ${label}`;
      lab.title = `${recName}["${prop}"]`;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = min; input.max = max; input.step = 0.01;
      input.value = engine.propValues[recName][prop];
      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = (+engine.propValues[recName][prop]).toFixed(2);
      input.oninput = () => {
        engine.setProp(recName, prop, +input.value);
        val.textContent = (+input.value).toFixed(2);
        onPropChange();
      };
      row.append(lab, input, val);
      slidersEl.appendChild(row);
      sliderRows.push({ recName, prop, input, val });
      break; // 每根 prop 骨骼只建一个滑杆（IK_FK 优先）
    }
  }
  // 若没有任何 IK_FK 骨骼（理论不会），滑杆区隐藏
  if (!sliderRows.length) slidersEl.parentElement.style.display = 'none';
  }

  function refreshSliders() {
    for (const r of sliderRows) {
      const v = engine.getProp(r.recName, r.prop) ?? 0;
      r.input.value = v;
      r.val.textContent = (+v).toFixed(2);
    }
  }

  // ---- 骨骼集合可见性 ----
  const collEl = document.getElementById('collections');
  if (collEl) {
  const collCounts = new Map();
  for (const w of widgets) {
    for (const c of w.rec.collections || []) collCounts.set(c, (collCounts.get(c) || 0) + 1);
  }
  const collState = new Map();
  for (const c of rigData.collections) {
    if (!collCounts.has(c.name)) continue;
    collState.set(c.name, true);
  }
  for (const [name, count] of [...collCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const row = document.createElement('div');
    row.className = 'coll-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.onchange = () => {
      collState.set(name, cb.checked);
      for (const w of widgets) {
        const inColl = (w.rec.collections || []).includes(name);
        const visible = [...collState.entries()].some(([cn, on]) => on && (w.rec.collections || []).includes(cn));
        w.holder.visible = visible;
      }
    };
    const nm = document.createElement('span');
    nm.className = 'name';
    nm.textContent = name;
    const ct = document.createElement('span');
    ct.className = 'count';
    ct.textContent = count;
    row.append(cb, nm, ct);
    collEl.appendChild(row);
  }
  }
}

function flatToM4(flat) {
  return new Matrix4().set(
    flat[0], flat[1], flat[2], flat[3],
    flat[4], flat[5], flat[6], flat[7],
    flat[8], flat[9], flat[10], flat[11],
    flat[12], flat[13], flat[14], flat[15],
  );
}
