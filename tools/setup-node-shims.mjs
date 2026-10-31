// tools/setup-node-shims.mjs — 为 node 端校验脚本创建裸导入 shim
// 浏览器端通过 importmap 使用 vendor/；node 端（validate/analyze/trace）
// 需要 node_modules/three 与 node_modules/three-ik 指向 vendor 里的本地副本。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const shims = [
  { name: 'three', main: 'three.module.js' },
  { name: 'three-ik', main: 'three-ik.module.js' },
];

for (const { name, main } of shims) {
  const dir = path.join(root, 'node_modules', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(root, 'vendor', main), path.join(dir, main));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name, version: '0-local', type: 'module', main,
  }, null, 2));
  console.log('shim ok:', name);
}
console.log('done — 现在可以运行: node tools/validate.mjs');
