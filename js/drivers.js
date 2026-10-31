// drivers.js — Blender 驱动器求值（约束 influence / mute / ARMATURE target weight）
// 支持：常量表达式（'1.0' / 'True' / 'False'）、'var'、'var == N'、四则运算与括号、GENERATOR 多项式修正

const SAFE_EXPR = /^[0-9eE+\-*/(). ,a-zA-Z_]*$/;

/**
 * 求值单个驱动规则。
 * rule: { kind, bone, con, prop_bone, prop, coefs, expr, index? }
 * propValues: { propBone: { prop: value } }
 * 返回 [0,1] 范围内数值（weight 驱动会二值化）。
 */
export function evalRule(rule, propValues) {
  let varVal = 0;
  if (rule.prop_bone) {
    varVal = propValues[rule.prop_bone]?.[rule.prop] ?? 0;
  }
  let v;
  if (rule.coefs && rule.coefs.length) {
    v = 0;
    for (let i = 0; i < rule.coefs.length; i++) v += rule.coefs[i] * Math.pow(varVal, i);
  } else {
    v = evalExpr(rule.expr, varVal);
  }
  if (rule.kind === 'mute' || rule.kind === 'weight') v = v > 0.5 ? 1 : 0;
  return v;
}

function evalExpr(expr, varVal) {
  if (expr === undefined || expr === null) return 0;
  const e = String(expr).trim();
  if (e === 'True') return 1;
  if (e === 'False') return 0;
  // 快路径
  const m = e.match(/^var\s*==\s*([0-9.eE+-]+)$/);
  if (m) return Math.abs(varVal - parseFloat(m[1])) < 1e-6 ? 1 : 0;
  const m2 = e.match(/^[0-9.eE+-]+$/);
  if (m2) return parseFloat(e);
  if (e === 'var') return varVal;
  if (!SAFE_EXPR.test(e)) { console.warn('拒绝不安全的驱动表达式:', e); return 0; }
  try {
    // var 替换后用受限 Function 求值（本地演示，无远端输入）
    const js = e.replace(/\bvar\b/g, `(${varVal})`).replace(/\bTrue\b/g, '1').replace(/\bFalse\b/g, '0');
    return Function(`"use strict"; return (${js});`)();
  } catch (err) {
    console.warn('驱动表达式求值失败:', e, err.message);
    return 0;
  }
}

/** 构建 (bone, conName) -> rules[] 索引 */
export function indexDriverRules(rules) {
  const idx = new Map(); // key `${bone}\u0000${con}` -> [rule...]
  for (const r of rules) {
    const key = `${r.bone}\u0000${r.con}`;
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push(r);
  }
  return idx;
}
