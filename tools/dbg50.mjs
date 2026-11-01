// 浏览器端：道具当前位置 vs Blender 期望位置（C @ blenderWorld，再加 armature 偏移修正与模型根平移）
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
const query = JSON.parse(readFileSync('/tmp/blend_query.json', 'utf8'));
const objs = Object.fromEntries(query.objects.map(o => [o.name, o]));
const armW = objs['rig'].matrix_world;
const armShiftY = armW[11]; // blender z 平移
const V = THREE.Vector3;
window.__dbgProps = () => {
  const app = window.__app;
  const out = [];
  for (const [name, o] of Object.entries(objs)) {
    if (!o.parent_bone || o.type === 'ARMATURE') continue;
    const node = app.modelRoot.getObjectByName(name) || app.modelRoot.getObjectByName(name.replace(/[.\[\]\/:]/g, '').replace(/\s/g, '_'));
    if (!node) { out.push({ n: name, missing: true }); continue; }
    const cur = new V().setFromMatrixPosition(node.matrixWorld).toArray().map(x => +x.toFixed(3));
    // Blender 期望：C @ propWorld_bl；再减 modelRoot 的重复平移?——直接算 C@world 与当前差
    const wp = o.matrix_world;
    const expected = new V(wp[3], wp[11], -wp[7]).toArray().map(x => +x.toFixed(3));
    out.push({ n: name.slice(0, 14), bone: o.parent_bone, cur, expectedNoShift: expected, diffY: +(cur[1] - expected[1]).toFixed(3) });
  }
  return out.slice(0, 20);
};
