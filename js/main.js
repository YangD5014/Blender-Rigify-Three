// main.js — 猫咪 Rigify 姿态模式（Three.js）
// 引擎（Blender 约束求值）驱动 GLB 蒙皮骨骼；widget 为 Rigify 控制手柄，可拖拽/旋转。
import {
  WebGLRenderer, PerspectiveCamera, Scene, Color, Group, Object3D,
  Matrix4, Vector3, Quaternion, LineSegments, LineBasicMaterial, Mesh,
  MeshBasicMaterial, BufferGeometry, BufferAttribute, DoubleSide, Raycaster,
  HemisphereLight, DirectionalLight, GridHelper, Euler,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildRigData, defaultPropValues } from './rigdata.js';
import { RigEngine } from './engine.js';
import { ThreeIkDelegate } from './ikadapter.js';
import { setupInteraction } from './interact.js';
import { setupUI } from './ui.js';
import { applyWorldPose } from './poseApply.js';

const V3 = Vector3;
const M4 = Matrix4;

async function loadJSON(url) { return (await fetch(url)).json(); }

const loadingEl = document.getElementById('loading');

// ---------- 资源加载 ----------
const [rigJson, posesJson] = await Promise.all([
  loadJSON('./data/rig.json'),
  loadJSON('./data/poses2.json'),
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
  new GLTFLoader().load('./data/cat.glb', res, undefined, rej);
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
scene.background = new Color(0x232323);
scene.add(modelRoot);

const camera = new PerspectiveCamera(35, innerWidth / innerHeight, 0.05, 100);
// 猫面朝 glTF +Z，身体跨度约 z -0.5..+1.6 —— 默认前侧 3/4 机位
camera.position.set(2.0, 0.9, 3.4);

const renderer = new WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.getElementById('viewport').appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.05, 0.2);
controls.enableDamping = true;
controls.dampingFactor = 0.15;
controls.mouseButtons = { LEFT: 0 /* ROTATE */, MIDDLE: 1 /* DOLLY */, RIGHT: 2 /* PAN */ };

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
scene.add(makeAxisLine(new V3(-3, 0, 0), new V3(3, 0, 0), 0x9b4a4a));
scene.add(makeAxisLine(new V3(0, 0, -3), new V3(0, 0, 3), 0x4a7b9b));

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
    prop.position.x -= armOffset.x;
    prop.position.y -= armOffset.y;
    prop.position.z -= armOffset.z;
    prop.updateMatrix();
  }
}

// ---------- widget 构建 ----------
const widgets = [];
buildWidgets();

function buildWidgets() {
  for (const [name, rec] of rigData.bones) {
    if (!rec.shape || !rigData.widgetGeoms[rec.shape]) continue;
    const geo = rigData.widgetGeoms[rec.shape];
    const bone = boneByName.get(name);
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
function evaluateAndApply() {
  const P = engine.evaluate();
  applyWorldPose(P, boneByName, rigData);
  modelRoot.updateMatrixWorld(true);
}
evaluateAndApply();

// ---------- 交互 ----------
const interaction = setupInteraction({
  renderer, camera, controls, widgets, rigData, engine,
  onChange: evaluateAndApply,
  onSelection: updateHud,
});

// ---------- UI ----------
setupUI({
  rigData, engine, posesJson, widgets,
  onPreset: () => evaluateAndApply(),
  onPropChange: () => evaluateAndApply(),
});

function updateHud(selected) {
  const hud = document.getElementById('hud');
  if (!selected) { hud.innerHTML = '未选中控制器'; return; }
  const rec = rigData.bones.get(selected);
  const props = engine.propValues[selected] || {};
  const propStr = Object.entries(props)
    .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(2) : v}`)
    .join('　');
  hud.innerHTML = `<b>${selected}</b>　<span style="color:#666">${(rec.collections || []).join(' · ')}</span>${propStr ? `<br>${propStr}` : ''}`;
}

// ---------- 渲染循环 ----------
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
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
    for (const [n, rec] of rigData.bones) engine.setBasis(n, new Matrix4());
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
