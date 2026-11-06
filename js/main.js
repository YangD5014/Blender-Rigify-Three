// main.js — 猫咪 Rigify 姿态模式（Three.js）
// 引擎（Blender 约束求值）驱动 GLB 蒙皮骨骼；widget 为 Rigify 控制手柄，可拖拽/旋转。
import {
  WebGLRenderer, PerspectiveCamera, Scene, Color, Group, Object3D,
  Matrix4, Vector3, Quaternion, LineSegments, LineBasicMaterial, Mesh,
  MeshBasicMaterial, BufferGeometry, BufferAttribute, DoubleSide, Raycaster,
  HemisphereLight, DirectionalLight, GridHelper, Euler, AxesHelper,
  Texture, Sprite, SpriteMaterial, SphereGeometry, MeshStandardMaterial,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildRigData, defaultPropValues } from './rigdata.js?v=1793520430';
import { RigEngine } from './engine.js?v=1793520430';
import { ThreeIkDelegate } from './ikadapter.js';
import { setupInteraction } from './interact.js';
import { setupUI } from './ui.js';
import { applyWorldPose } from './poseApply.js';

const V3 = Vector3;
const M4 = Matrix4;
let interaction = null;

async function loadJSON(url) { return (await fetch(url)).json(); }

const loadingEl = document.getElementById('loading');

// ---------- 资源加载 ----------
// 资源基址：本地开发用相对路径；部署版由入口页注入 jsDelivr 基址
const ASSET_BASE = window.__ASSET_BASE || './';
const [rigJson, posesJson] = await Promise.all([
  loadJSON(ASSET_BASE + 'data/rig.json'),
  loadJSON(ASSET_BASE + 'data/poses2.json'),
]);

const rigData = buildRigData(rigJson);
const engine = new RigEngine(rigData, new ThreeIkDelegate());
// 初始 props 取文件保存值（数值型）
engine.setProps(defaultPropValues(rigData.bones));

// armature 物体位移（Blender Z-up → glTF Y-up），非骨骼子物件用它归位
const mw = posesJson.matrix_world;
const armOffset = new V3(mw[3], mw[11], -mw[7]);

// GLB 加载
const gltf = await new Promise((res, rej) => {
  new GLTFLoader().load(ASSET_BASE + 'data/cat.glb', res, undefined, rej);
});
const modelRoot = gltf.scene;

const boneByName = new Map();
// GLTFLoader 会清洗节点名（空格→下划线，[] . : / 删除），rigify 的 .L/.001 后缀会被改
// —— 按 GLTF 规则反向匹配并还原原名
const sanitizeNodeName = (n) => n.replace(/\s/g, '_').replace(/[\[\].:\/]/g, '');
const nodeBySanitized = new Map();
modelRoot.traverse((o) => {
  if (o.name) nodeBySanitized.set(o.name, o);
  if (o.isBone) boneByName.set(o.name, o);
});
for (const name of rigData.bones.keys()) {
  if (boneByName.has(name)) continue;
  const node = nodeBySanitized.get(sanitizeNodeName(name));
  if (node && node.isBone) {
    boneByName.delete(node.name);
    node.name = name; // 还原 rigify 原名
    boneByName.set(name, node);
  }
}
if (boneByName.size === 0) throw new Error('GLB 中没有骨骼');
modelRoot.traverse((o) => {
  if (o.name && o.name.startsWith('WGT')) o.visible = false; // widget 用 rig.json 几何重建
});

// ---------- 场景 ----------
const scene = new Scene();
const SCENE_BG = { dark: new Color(0x232323), light: new Color(0xe8eaee) };
scene.background = SCENE_BG.dark;
scene.add(modelRoot);

const camera = new PerspectiveCamera(35, innerWidth / innerHeight, 0.05, 100);
// 猫面朝 glTF +Z，身体跨度约 z -0.5..+1.6 —— 默认前侧 3/4 机位
camera.position.set(5.1595, 2.3524, 3.2293);

const renderer = new WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.getElementById('viewport').appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(-0.0722, 0.5570, 0.0334);
controls.enableDamping = true;
controls.dampingFactor = 0.15;
controls.mouseButtons = { LEFT: 0 /* ROTATE */, MIDDLE: 1 /* DOLLY */, RIGHT: 2 /* PAN */ };

// ---------- XYZ 轴示意图（Blender 同款，右上角） ----------
const axisGizmoEl = document.getElementById('axisgizmo');
const axisRenderer = new WebGLRenderer({ antialias: true, alpha: true });
axisRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
axisRenderer.setSize(80, 80);
if (axisGizmoEl) axisGizmoEl.appendChild(axisRenderer.domElement);
const axisScene = new Scene();
const axisCamera = new PerspectiveCamera(50, 1, 0.1, 100);
axisCamera.position.set(0, 0, 3);
axisScene.add(new AxesHelper(1.1));
function makeAxisLabel(text, color, pos) {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.font = 'bold 40px sans-serif';
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 32, 32);
  const tex = new Texture(canvas);
  tex.needsUpdate = true;
  const mat = new SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sp = new Sprite(mat);
  sp.position.copy(pos);
  sp.scale.set(0.35, 0.35, 1);
  return sp;
}
axisScene.add(makeAxisLabel('X', '#ff4444', new V3(1.35, 0, 0)));
axisScene.add(makeAxisLabel('Y', '#44cc44', new V3(0, 1.35, 0)));
axisScene.add(makeAxisLabel('Z', '#4488ff', new V3(0, 0, 1.35)));

scene.add(new HemisphereLight(0xbfbfd8, 0x3a3a35, 1.1));
const sun = new DirectionalLight(0xffffff, 1.6);
sun.position.set(2, 4, 2);
scene.add(sun);
const sun2 = new DirectionalLight(0x8899bb, 0.5);
sun2.position.set(-2, 1.5, -2);
scene.add(sun2);

// Blender 风格地面网格
const grid = new GridHelper(6, 6, 0x555555, 0x3a3a3a);
grid.position.y = -0.001;
scene.add(grid);
function makeAxisLine(a, b, color) {
  const g = new BufferGeometry().setFromPoints([a, b]);
  return new LineSegments(g, new LineBasicMaterial({ color, transparent: true, opacity: 0.55 }));
}
const axisX = makeAxisLine(new V3(-3, 0, 0), new V3(3, 0, 0), 0x9b4a4a);
const axisZ = makeAxisLine(new V3(0, 0, -3), new V3(0, 0, 3), 0x4a7b9b);
scene.add(axisX, axisZ);

// ---------- 非骨骼子物件（眼睛/胡须/耳饰等）----------
// glTF 导出器已保留骨骼父子关系（眼球/胡须/耳饰是骨骼子节点，local 正确）——
// 直接使用，不做任何重挂接（重挂接曾引入恰好一个 armature 偏移的漂移，已踩坑验证）。
// 导出器丢了 armature 物体的世界平移（z=+1.0868，rig 子树在 armature space），
// 整体上移让猫脚落回地面；真正无主的脸部高光等零散物件反向抵消该平移。
modelRoot.position.set(0, armOffset.y, 0);
modelRoot.updateMatrixWorld(true);
modelRoot.traverse((o) => {
  if (!o.isBone && o.isMesh && !o.name.startsWith('WGT')
      && !(o.parent && o.parent.isBone) && o.parent !== modelRoot) {
    // 非骨骼子节点的挂件（挂在其他物体上）——目前场景里没有，保险处理
    o.position.x -= armOffset.x;
    o.position.y -= armOffset.y;
    o.position.z -= armOffset.z;
    o.updateMatrix();
  }
});
// 场景根级的零散物件（眼球高光等，世界坐标已含 armature 平移）：抵消根平移
for (const prop of modelRoot.children) {
  if (prop.isMesh && !prop.isSkinnedMesh && !prop.name.startsWith('WGT')) {
    if (prop.name === 'eyehighlights2' || prop.name === 'NurbsPath038') continue; // 由下方挂接到 head，不抵消
    prop.position.x -= armOffset.x;
    prop.position.y -= armOffset.y;
    prop.position.z -= armOffset.z;
    prop.updateMatrix();
  }
}

// 飘散的根级白色物件（耳部等）：不应用 armOffset 抵消，保持原始位置
// （无需挂接，避免错误偏移）

// ---------- widget 构建 ----------
const widgets = [];
buildWidgets();


function buildWidgets() {
  for (const [name, rec] of rigData.bones) {
    if (!rec.shape || !rigData.widgetGeoms[rec.shape]) continue;
    const geo = rigData.widgetGeoms[rec.shape];
    // shape_transform（custom_shape_transform）：widget 画在参考骨的位置而非
    // 控制器自身头部 —— 如 tail_master.001 的 widget 画在 tweak_tail.004（尾尖）。
    // 尺寸缩放仍用 owner 骨长（Blender use_custom_shape_bone_size 语义）。
    const anchorName = rec.shapeTransform || name;
    const bone = boneByName.get(anchorName) || boneByName.get(name);
    if (!bone) continue;
    const holder = new Object3D();
    const s = rec.shapeScale || [1, 1, 1];
    const boneSize = rec.shapeBoneSize ? rec.length : 1;
    const rot = rec.shapeRotation || [0, 0, 0];
    const m = new M4().compose(
      new V3(...(rec.shapeTranslation || [0, 0, 0])),
      new Quaternion().setFromEuler(new Euler(rot[0], rot[1], rot[2])),
      new V3(s[0] * boneSize, s[1] * boneSize, s[2] * boneSize),
    );
    holder.matrixAutoUpdate = false;
    holder.matrix.copy(m);

    const col = rec.colorCustom?.[0] || [0.68, 0.68, 0.68];
    const pos = [];
    for (const e of geo.edges) {
      pos.push(geo.verts[e[0]].x, geo.verts[e[0]].y, geo.verts[e[0]].z,
        geo.verts[e[1]].x, geo.verts[e[1]].y, geo.verts[e[1]].z);
    }
    const lg = new BufferGeometry();
    lg.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    // Blender 姿态模式的 "In Front" 行为：widget 穿透网格画在最上层，
    // 否则尾巴根/身体内部的 widget 会被网格遮挡（tail_master 曾因此不可见）。
    const line = new LineSegments(lg, new LineBasicMaterial({
      color: new Color(col[0], col[1], col[2]), transparent: true, opacity: 0.95,
      depthTest: false,
    }));
    line.renderOrder = 10;
    line.userData.widget = true;
    holder.add(line);

    if (geo.tris && geo.tris.length) {
      const tp = [];
      for (const t of geo.tris) {
        for (const vi of t) tp.push(geo.verts[vi].x, geo.verts[vi].y, geo.verts[vi].z);
      }
      const tg = new BufferGeometry();
      tg.setAttribute('position', new BufferAttribute(new Float32Array(tp), 3));
      tg.computeVertexNormals();
      const mesh = new Mesh(tg, new MeshBasicMaterial({
        color: new Color(col[0], col[1], col[2]),
        transparent: true, opacity: 0.16, side: DoubleSide, depthWrite: false,
        depthTest: false,
      }));
      mesh.renderOrder = 9;
      mesh.userData.widget = true;
      holder.add(mesh);
    }
    bone.add(holder);
    widgets.push({
      name, rec, bone, holder, line,
      edgeList: geo.edges,
      colorNormal: new Color(col[0], col[1], col[2]),
      colorHover: new Color(col[0] * 0.5 + 0.5, col[1] * 0.5 + 0.5, col[2] * 0.5 + 0.5),
      colorSelected: new Color(0xff8c19),
    });
  }
}

// ---------- 求值与姿态写回 ----------
function updateMonitor() {
  const mon = document.getElementById('monitor');
  if (!mon) return;
  if (!interaction) { mon.textContent = '未选中'; return; }
  const sel = interaction.getSelected ? interaction.getSelected() : null;
  if (!sel) { mon.textContent = '未选中'; return; }
  const mb = engine.getBasis(sel);
  const mw = engine.P.get(sel);
  if (!mb) { mon.textContent = sel + '\\n(无姿态)'; return; }
  const pb = new V3(); const qb = new Quaternion(); const sb = new V3();
  mb.decompose(pb, qb, sb);
  const pw = new V3(); const qw = new Quaternion(); const sw = new V3();
  if (mw) mw.decompose(pw, qw, sw);
  mon.innerHTML =
    `<b style="color:var(--accent)">${sel}</b><br>` +
    `basis p: x=${pb.x.toFixed(6)} y=${pb.y.toFixed(6)} z=${pb.z.toFixed(6)}<br>` +
    `basis q: x=${qb.x.toFixed(6)} y=${qb.y.toFixed(6)} z=${qb.z.toFixed(6)} w=${qb.w.toFixed(6)}<br>` +
    `world p: x=${pw.x.toFixed(6)} y=${pw.y.toFixed(6)} z=${pw.z.toFixed(6)}<br>` +
    `world q: x=${qw.x.toFixed(6)} y=${qw.y.toFixed(6)} z=${qw.z.toFixed(6)} w=${qw.w.toFixed(6)}`;
}
function evaluateAndApply() {
  const P = engine.evaluate();
  applyWorldPose(P, boneByName, rigData);
  modelRoot.updateMatrixWorld(true);
  updateMonitor();
}
evaluateAndApply();

// ---------- 交互 ----------
interaction = setupInteraction({
  renderer, camera, controls, widgets, rigData, engine, boneByName,
  onChange: evaluateAndApply,
  onSelection: (sel) => { updateHud(sel); updateMonitor(); updateRotSliders(sel); },
});

// ---------- 旋转精细调控（侧边栏） ----------
const rotSection = document.createElement('div');
rotSection.className = 'section';
rotSection.innerHTML = '<h2>选中控制器 · 旋转 (°)</h2>';
const rotSlidersEl = document.createElement('div');
rotSection.appendChild(rotSlidersEl);
const panelEl = document.getElementById('panel');
const collectionsEl = document.getElementById('collections');
panelEl.insertBefore(rotSection, collectionsEl);

const rotAxes = ['X', 'Y', 'Z'];
const rotSliderRows = [];
for (const ax of rotAxes) {
  const row = document.createElement('div');
  row.className = 'slider-row';
  const lab = document.createElement('label');
  lab.textContent = `Rotate ${ax}`;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = -180; input.max = 180; input.step = 1;
  input.value = 0;
  const val = document.createElement('span');
  val.className = 'val';
  val.textContent = '0';
  row.append(lab, input, val);
  rotSlidersEl.appendChild(row);
  rotSliderRows.push({ ax, input, val });
}

function basisEuler(name) {
  const b = engine.getBasis(name);
  if (!b) return [0, 0, 0];
  const q = new Quaternion();
  b.decompose(new Vector3(), q, new Vector3());
  const eu = new Euler().setFromQuaternion(q, 'XYZ');
  return [eu.x * 180 / Math.PI, eu.y * 180 / Math.PI, eu.z * 180 / Math.PI];
}

function applyRotSliders() {
  const sel = interaction.getSelected ? interaction.getSelected() : null;
  if (!sel) return;
  const rec = rigData.bones.get(sel);
  const b = engine.getBasis(sel);
  const t = new Vector3(); const s = new Vector3();
  b.decompose(t, new Quaternion(), s);
  const vals = rotSliderRows.map((r) => +r.input.value);
  const q = new Quaternion().setFromEuler(new Euler(
    vals[0] * Math.PI / 180,
    vals[1] * Math.PI / 180,
    vals[2] * Math.PI / 180,
    'XYZ',
  ));
  const newB = new Matrix4().compose(t, q, s);
  engine.setBasis(sel, newB);
  evaluateAndApply();
}

for (const r of rotSliderRows) {
  r.input.oninput = () => {
    r.val.textContent = r.input.value;
    applyRotSliders();
  };
}

function updateRotSliders(sel) {
  if (!sel) {
    for (const r of rotSliderRows) { r.input.value = 0; r.val.textContent = '0'; r.input.disabled = true; }
    return;
  }
  const eu = basisEuler(sel);
  for (let i = 0; i < rotSliderRows.length; i++) {
    rotSliderRows[i].input.value = Math.round(eu[i]);
    rotSliderRows[i].val.textContent = Math.round(eu[i]);
    rotSliderRows[i].input.disabled = false;
  }
}

// ---------- 相机参数记录（侧边栏，动态更新） ----------
const camSection = document.createElement('div');
camSection.className = 'section';
camSection.innerHTML = '<h2>相机参数（实时）</h2>';
const camInfo = document.createElement('div');
camInfo.style.cssText = 'font-family:monospace;font-size:10px;color:var(--text-dim);line-height:1.6;word-break:break-all;';
camSection.appendChild(camInfo);
const camBtns = document.createElement('div');
camBtns.style.cssText = 'margin-top:6px;display:flex;gap:4px;';
const copyCamBtn = document.createElement('button');
copyCamBtn.textContent = '复制参数';
copyCamBtn.style.cssText = 'padding:3px 8px;background:var(--btn-bg);color:var(--btn-text);border:1px solid var(--border);border-radius:3px;cursor:pointer;font-size:11px;';
const saveCamBtn = document.createElement('button');
saveCamBtn.textContent = '设为初始视角';
saveCamBtn.style.cssText = copyCamBtn.style.cssText;
camBtns.append(copyCamBtn, saveCamBtn);
camSection.appendChild(camBtns);
const panelEl2 = document.getElementById('panel');
const collectionsEl2 = document.getElementById('collections');
panelEl2.insertBefore(camSection, collectionsEl2);

function updateCamInfo() {
  const p = camera.position;
  const t = controls.target;
  camInfo.innerHTML =
    `position: [${p.x.toFixed(4)}, ${p.y.toFixed(4)}, ${p.z.toFixed(4)}]<br>` +
    `target:   [${t.x.toFixed(4)}, ${t.y.toFixed(4)}, ${t.z.toFixed(4)}]`;
}
controls.addEventListener('change', updateCamInfo);
updateCamInfo();

copyCamBtn.onclick = () => {
  const p = camera.position, t = controls.target;
  const txt = `camera.position.set(${p.x.toFixed(4)}, ${p.y.toFixed(4)}, ${p.z.toFixed(4)});\ncontrols.target.set(${t.x.toFixed(4)}, ${t.y.toFixed(4)}, ${t.z.toFixed(4)});`;
  navigator.clipboard.writeText(txt).then(() => { copyCamBtn.textContent = '已复制'; setTimeout(() => copyCamBtn.textContent = '复制参数', 1200); });
};
saveCamBtn.onclick = () => {
  const p = camera.position, t = controls.target;
  localStorage.setItem('petTwinCamPos', JSON.stringify([p.x, p.y, p.z]));
  localStorage.setItem('petTwinCamTarget', JSON.stringify([t.x, t.y, t.z]));
  saveCamBtn.textContent = '已保存'; setTimeout(() => saveCamBtn.textContent = '设为初始视角', 1200);
};

// 应用已保存的初始视角
try {
  const sp = JSON.parse(localStorage.getItem('petTwinCamPos'));
  const st = JSON.parse(localStorage.getItem('petTwinCamTarget'));
  if (Array.isArray(sp) && Array.isArray(st)) {
    camera.position.set(sp[0], sp[1], sp[2]);
    controls.target.set(st[0], st[1], st[2]);
    controls.update();
    camera.updateMatrixWorld(true);
    updateCamInfo();
  }
} catch {}

// ---------- UI ----------
setupUI({
  rigData, engine, posesJson, widgets,
  onPreset: () => evaluateAndApply(),
  onPropChange: () => evaluateAndApply(),
});

function updateHud(selected) {
  const hud = document.getElementById('hud');
  if (!hud) return; // 纯净版页面无 HUD
  if (!selected) { hud.innerHTML = '未选中控制器'; return; }
  const rec = rigData.bones.get(selected);
  const props = engine.propValues[selected] || {};
  const propStr = Object.entries(props)
    .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(2) : v}`)
    .join('　');
  hud.innerHTML = `<b>${selected}</b>　<span style="color:#666">${(rec.collections || []).join(' · ')}</span>${propStr ? `<br>${propStr}` : ''}`;
}

// ---------- 明暗主题 ----------
let lightTheme = localStorage.getItem('petTwinTheme') === 'light';
const widgetBaseColors = widgets.map(w => w.colorNormal.clone());

function applyTheme(light) {
  lightTheme = light;
  document.body.classList.toggle('light', light);
  const themeBtnEl = document.getElementById('themeBtn');
  if (themeBtnEl) themeBtnEl.textContent = light ? '🌙' : '☀';
  scene.background = light ? SCENE_BG.light : SCENE_BG.dark;
  grid.material.color.set(light ? 0x9aa0a8 : 0xffffff);
  axisX.material.color.set(light ? 0xc07070 : 0x9b4a4a);
  axisZ.material.color.set(light ? 0x7090c0 : 0x4a7b9b);
  for (let i = 0; i < widgets.length; i++) {
    const w = widgets[i];
    w.colorNormal.copy(widgetBaseColors[i]);
    w.colorHover.copy(w.colorNormal).multiplyScalar(0.5).addScalar(light ? 0.22 : 0.5);
    if (light) w.colorNormal.multiplyScalar(0.55);
    if (appSelected() === w.name) w.line.material.color.copy(w.colorSelected);
    else w.line.material.color.copy(w.colorNormal);
  }
}
function appSelected() { return window.__app ? window.__app.interaction.getSelected() : null; }

const themeBtn = document.getElementById('themeBtn');
if (themeBtn) themeBtn.addEventListener('click', () => {
  applyTheme(!lightTheme);
  localStorage.setItem('petTwinTheme', lightTheme ? 'light' : 'dark');
});
applyTheme(lightTheme);

// ---------- 框选物体 ----------
let boxMode = false;
const boxBtn = document.createElement('button');
boxBtn.textContent = '框选物体';
const toolsEl = document.getElementById('tools');
if (toolsEl) toolsEl.appendChild(boxBtn);
const boxOverlay = document.createElement('div');
boxOverlay.style.cssText = 'position:fixed;border:1px solid #e87d0d;background:rgba(232,125,13,0.15);pointer-events:none;display:none;z-index:20;';
document.body.appendChild(boxOverlay);
function setBoxMode(on) {
  boxMode = on;
  boxBtn.classList.toggle('active', on);
  renderer.domElement.style.cursor = on ? 'crosshair' : '';
  controls.enabled = !on;
}
boxBtn.onclick = () => setBoxMode(!boxMode);
addEventListener('keydown', (ev) => {
  if (ev.key.toLowerCase() === 'b' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    if (!dragging) setBoxMode(!boxMode);
  }
});
let boxStart = null;
let dragging = false;
renderer.domElement.addEventListener('pointerdown', (ev) => {
  if (!boxMode) return;
  dragging = true;
  boxStart = { x: ev.clientX, y: ev.clientY };
  boxOverlay.style.left = ev.clientX + 'px';
  boxOverlay.style.top = ev.clientY + 'px';
  boxOverlay.style.width = '0px';
  boxOverlay.style.height = '0px';
  boxOverlay.style.display = 'block';
  ev.stopPropagation();
  ev.stopImmediatePropagation();
}, true);
renderer.domElement.addEventListener('pointermove', (ev) => {
  if (!boxMode || !dragging || !boxStart) return;
  const x = Math.min(boxStart.x, ev.clientX);
  const y = Math.min(boxStart.y, ev.clientY);
  const w = Math.abs(ev.clientX - boxStart.x);
  const h = Math.abs(ev.clientY - boxStart.y);
  boxOverlay.style.left = x + 'px';
  boxOverlay.style.top = y + 'px';
  boxOverlay.style.width = w + 'px';
  boxOverlay.style.height = h + 'px';
  ev.stopPropagation();
  ev.stopImmediatePropagation();
}, true);
renderer.domElement.addEventListener('pointerup', (ev) => {
  if (!boxMode || !dragging || !boxStart) return;
  dragging = false;
  const x1 = boxStart.x, y1 = boxStart.y;
  const x2 = ev.clientX, y2 = ev.clientY;
  boxOverlay.style.display = 'none';
  const names = new Set();
  const rect = renderer.domElement.getBoundingClientRect();
  modelRoot.traverse((o) => {
    if (!o.isMesh || !o.name) return;
    if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
    const bs = o.geometry.boundingSphere;
    if (!bs) return;
    const center = bs.center.clone().applyMatrix4(o.matrixWorld);
    const proj = center.clone().project(camera);
    const sx = (proj.x * 0.5 + 0.5) * rect.width + rect.left;
    const sy = (-proj.y * 0.5 + 0.5) * rect.height + rect.top;
    if (sx >= Math.min(x1, x2) && sx <= Math.max(x1, x2) &&
        sy >= Math.min(y1, y2) && sy <= Math.max(y1, y2)) {
      names.add(o.name);
    }
  });
  const mon = document.getElementById('monitor');
  if (mon) mon.textContent = names.size ? [...names].join('\\n') : '未框选到物体';
  boxStart = null;
  setBoxMode(false);
  ev.stopPropagation();
  ev.stopImmediatePropagation();
}, true);

// ---------- 渲染循环 ----------
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
  // XYZ 轴示意图同步相机朝向
  const q = camera.quaternion;
  const p = new V3(0, 0, 3).applyQuaternion(q);
  axisCamera.position.copy(p);
  axisCamera.quaternion.copy(q);
  axisCamera.updateMatrixWorld();
  axisRenderer.render(axisScene, axisCamera);
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

loadingEl.remove();

// 调试句柄（自动化测试用）
window.__app = {
  engine, rigData, boneByName, widgets, camera, controls, modelRoot,
  evaluateAndApply, interaction,
  resetPose() {
    engine.resetBases();
    evaluateAndApply();
  },
  /** 侧视/正视机位 */
  setCamera(pos, target) {
    camera.position.set(...pos);
    controls.target.set(...target);
    controls.update(); // lookAt 在此发生
    camera.updateMatrixWorld(true); // 之后再刷矩阵，保证投影即时有效
  },
  /** canvas 客户区坐标拾取（0,0 = canvas 左上角） */
  debugPick(cx, cy) { return interaction.debugPick(cx + 250, cy); },
};
