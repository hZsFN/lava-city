#!/usr/bin/env node
// ============================================================================
// M3-04b 道具细节规格 · 校验器（只读，不写任何文件）
// ----------------------------------------------------------------------------
// 父票校验器保证"摆得对"，本脚本保证"长得对、算得对"：
//
//   1. 跨文件一致性：几何 config 的尺寸 == 父票 footprint 尺寸
//   2. 三角数：逐件按几何拼装重算，与 config 声明比对（不是抄结论）
//   3. draw call 增量：按批次去重计数
//   4. 预算：三角 ≤ 18000、draw call ≤ 400
//   5. 语义一致性：光环半径 == 父票 aura.radiusM（防止"判定 3 m 但画 2 m"）
//   6. 破坏性：棱柱/平台必须不可破坏，且给出理由
//   7. 材质：不得新增超过 1 个材质，且不得违反 M1-03 禁令
//   8. 音频：所有引用的素材 ID 必须真实存在于 molten-heart-audio 的 CATALOG
//   9. 平台：描边半径必须 ≤ 平台半径（描边不能超出判定范围）
//  10. 高度：三种平台高度必须与父票 kind 高度一致
//
// 用法：node docs/tickets/M3-04b-validate.mjs
// 退出码：0 全绿 / 1 有失败
// ============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

const geo = JSON.parse(readFileSync(join(HERE, 'M3-04b-props-geometry.config.json'), 'utf8'));
const parent = JSON.parse(readFileSync(join(HERE, 'M3-04-arena-props.config.json'), 'utf8'));

let checks = 0;
let failures = 0;

function ok(label, detail) {
  checks += 1;
  console.log(`  PASS  ${label}${detail ? `  — ${detail}` : ''}`);
}
function fail(label, detail) {
  checks += 1;
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
}
function near(a, b, tol = 1e-6) {
  return Math.abs(a - b) <= tol;
}
function assertNear(label, actual, expected, tol = 1e-6) {
  if (near(actual, expected, tol)) ok(label, `${actual} == ${expected}`);
  else fail(label, `实际 ${actual} ≠ 期望 ${expected}（差 ${(actual - expected).toFixed(6)}）`);
}
function assertLe(label, actual, limit) {
  if (actual <= limit + 1e-9) ok(label, `${actual} ≤ ${limit}`);
  else fail(label, `${actual} > ${limit}`);
}
function assertTrue(label, cond, detail) {
  if (cond) ok(label, detail);
  else fail(label, detail);
}

// ── 1. 跨文件一致性 ──────────────────────────────────────────────────────
console.log('\n[1] 跨文件一致性 · 几何尺寸必须等于父票 footprint');

// 父票把 heightM 放在 kind 顶层，widthM/depthM/radiusM 在 footprint 里 —— 分开取
const pairs = [
  ['slagBulwark', 'w', 'footprint.widthM'],
  ['slagBulwark', 'd', 'footprint.depthM'],
  ['slagBulwark', 'h', 'heightM'],
  ['brokenParapet', 'w', 'footprint.widthM'],
  ['brokenParapet', 'd', 'footprint.depthM'],
  ['brokenParapet', 'h', 'heightM'],
  ['coreWard', 'd', 'footprint.depthM'],
  ['coreWard', 'h', 'heightM'],
  ['obsidianPillar', 'r', 'footprint.radiusM'],
  ['obsidianPillar', 'h', 'heightM'],
  ['frostAnchor', 'r', 'footprint.radiusM'],
  ['frostAnchor', 'h', 'heightM'],
];

function dig(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

for (const [kind, geoField, parentPath] of pairs) {
  const g = geo.kinds[kind];
  const p = parent.kinds[kind];
  if (!g || !p) {
    fail(`${kind}.${geoField} 跨文件比对`, '一侧缺少该 kind');
    continue;
  }
  assertNear(`${kind}.${geoField} == 父票 ${parentPath}`, g.dims[geoField], dig(p, parentPath));
}

// coreWard 的 arcLen 父票写 widthM
assertNear('coreWard.arcLen == 父票 widthM', geo.kinds.coreWard.dims.arcLen, parent.kinds.coreWard.footprint.widthM);

// 平台高度：三种 kind 必须与父票一致
for (const [kind, key] of [['jumpLedge', 'jumpLedge'], ['jumpHigh', 'jumpHigh'], ['bridgePier', 'bridgePier']]) {
  assertNear(
    `平台 ${key} 高度 == 父票 heightM`,
    geo.kinds.platform.heights[key],
    parent.kinds[key].heightM,
  );
}
// 平台平面尺寸
assertNear('platform.w == 父票 jumpLedge.widthM', geo.kinds.platform.dims.w, parent.kinds.jumpLedge.footprint.widthM);
assertNear('platform.d == 父票 jumpLedge.depthM', geo.kinds.platform.dims.d, parent.kinds.jumpLedge.footprint.depthM);

// ── 2. 三角数重算 ────────────────────────────────────────────────────────
console.log('\n[2] 三角数重算 · 按几何拼装逐件验算，不抄 config 结论');

/** 单个 primitive 的三角数 */
function trisOfPart(part) {
  const g = part.geo;
  const p = part.params || [];
  if (g === 'box') return 12;
  if (g === 'ring') {
    const seg = p[2];
    return seg * 2; // RingGeometry 每段 2 tri
  }
  if (g === 'cylinder') {
    const radial = p[3];
    // CylinderGeometry(rt, rb, h, radial, 1): 侧面 radial*2，上下盖各 radial
    return radial * 2 + radial * 2;
  }
  throw new Error(`未知 geo: ${g}`);
}

function countTris(kindDef) {
  // 多段布局（arc）要乘段数
  const segs = kindDef.segments || 1;
  let total = 0;
  for (const part of kindDef.parts) {
    total += trisOfPart(part) * (part.layout === 'arc' ? segs : 1);
  }
  return total;
}

let staticTris = 0;
const trisByKind = {};
for (const [kind, def] of Object.entries(geo.kinds)) {
  if (kind === 'platform') continue;
  const recomputed = countTris(def);
  trisByKind[kind] = recomputed;
  assertNear(`${kind} 三角数`, def.tris, recomputed);
}

// 平台 3 种高度共用同一几何 → 96
const platTris = countTris(geo.kinds.platform);
assertNear('platform 三角数', geo.kinds.platform.tris, platTris);

// 按实例数汇总静态三角
const kindCount = {};
for (const inst of parent.instances) {
  const k = inst.kind;
  kindCount[k] = (kindCount[k] || 0) + 1;
}

// platform 类有三种 kind，都用 platform 的几何
const platformKinds = ['jumpLedge', 'jumpHigh', 'bridgePier'];
for (const [kind, count] of Object.entries(kindCount)) {
  if (platformKinds.includes(kind)) continue;
  staticTris += trisByKind[kind] * count;
}
const platCount = platformKinds.reduce((s, k) => s + (kindCount[k] || 0), 0);
staticTris += platTris * platCount;

console.log(`       静态三角重算 = ${staticTris}`);
assertNear('静态三角总数（重算 vs config）', geo.budget.staticTris, staticTris);

// ── 3. draw call 增量 ────────────────────────────────────────────────────
console.log('\n[3] draw call 增量 · 按批次去重');

const batchesUsed = new Set();
for (const [kind, def] of Object.entries(geo.kinds)) {
  for (const part of def.parts) {
    if (part.batch) batchesUsed.add(part.batch);
  }
}
// 道具用到的静态批次
console.log(`       道具用到的批次：${[...batchesUsed].join(', ')}`);
const staticBatchCount = batchesUsed.size;
// 碎片池独立 1 个
const expectedDrawCalls = staticBatchCount + (geo.debris.pool.instancedMesh ? 1 : 0);

assertNear('draw call 增量（重算 vs config）', geo.budget.drawCallDelta, expectedDrawCalls);
assertLe('draw call 增量 ≤ 上限', expectedDrawCalls, 8);

// 逐批核对 config 的 breakdown
const bd = geo.budget.drawCallBreakdown;
const bdSum = Object.values(bd).reduce((a, b) => a + b, 0);
assertNear('drawCallBreakdown 求和 == drawCallDelta', bdSum, geo.budget.drawCallDelta);

// 父票修正声明必须存在
assertTrue(
  '父票 draw call 修正声明存在',
  typeof geo.budget.parentTicketCorrection === 'string' && geo.budget.parentTicketCorrection.includes('+5'),
  geo.budget.parentTicketCorrection,
);

// ── 4. 预算 ──────────────────────────────────────────────────────────────
console.log('\n[4] 预算');

const totalTris = staticTris + geo.budget.debrisTris + geo.budget.damageGlowTris;
assertNear('三角总数（重算 vs config）', geo.budget.totalTris, totalTris);
assertLe('三角总数 ≤ 18000', totalTris, 18000);

const pct = totalTris / 18000;
assertNear('三角占用比例（2 位小数）', Math.round(pct * 100) / 100, geo.budget.trisPct);

// ── 5. 语义一致性：光环半径 ──────────────────────────────────────────────
console.log('\n[5] 语义一致性 · 光环半径必须与实际判定半径一致');

const auraRingPart = geo.kinds.frostAnchor.parts.find((p) => p.name === 'auraRing');
assertTrue('frostAnchor 有 auraRing 部件', Boolean(auraRingPart), auraRingPart ? '存在' : '缺失');

const ringOuter = auraRingPart.params[1];
const parentAura = parent.kinds.frostAnchor.aura.radiusM;
assertNear('光环外径 == 父票 aura.radiusM', ringOuter, parentAura);
console.log('       理由：光环是判定的可视化，画 2 m 判定 3 m 就是骗玩家');

// ── 6. 破坏性规则 ────────────────────────────────────────────────────────
console.log('\n[6] 破坏性规则 · 棱柱与平台必须不可破坏');

for (const kind of ['obsidianPillar', 'platform']) {
  const def = geo.kinds[kind];
  assertTrue(
    `${kind} 不可破坏`,
    def.destroyable === false,
    def.destroyable === false ? 'destroyable=false' : `destroyable=${def.destroyable}`,
  );
  assertTrue(
    `${kind} 给出不可破坏理由`,
    typeof def.destroyableReason === 'string' && def.destroyableReason.length > 10,
    def.destroyableReason || '缺失',
  );
}

// 可破坏的道具必须有 debris 参数
for (const [kind, def] of Object.entries(geo.kinds)) {
  if (def.destroyable === true) {
    assertTrue(
      `${kind} 有碎片参数`,
      Boolean(def.debris && def.debris.count > 0 && def.debris.durationMs > 0),
      def.debris ? `${def.debris.count} 块 / ${def.debris.durationMs} ms` : '缺失',
    );
  }
}

// 碎片池容量必须够
const maxDebrisPerProp = Math.max(
  ...Object.values(geo.kinds).filter((d) => d.destroyable).map((d) => d.debris.count),
);
assertLe('单件最大碎片数 ≤ 池容量', maxDebrisPerProp, geo.debris.pool.maxInstances);

// ── 7. 材质规则 ──────────────────────────────────────────────────────────
console.log('\n[7] 材质规则 · 遵守 M1-03 禁令');

assertLe('新增材质数 ≤ 1', geo.materials.newCount, 1);
assertNear('新增材质列表长度 == newCount', geo.materials.new.length, geo.materials.newCount);

const forbidden = geo.materials.forbidden.join(' ');
assertTrue('禁令含"不许自发光照亮石头"', forbidden.includes('自发光'), '已声明');
assertTrue('禁令含"不许改 bumpScale"', forbidden.includes('bumpScale'), '已声明');

// wardRune 必须是压暗的（防止抢灯塔）
const ward = geo.batches.wardRune.params;
assertLe('护壁符文 emissiveIntensity ≤ 1.0（低于灯塔 2.2+）', ward.emissiveIntensity, 1.0);
assertTrue(
  '护壁符文用调色板 beacon 色 #9fe9ff',
  ward.emissive.toLowerCase() === '#9fe9ff',
  `实际 ${ward.emissive}`,
);

// ── 8. 音频素材真实性 ────────────────────────────────────────────────────
console.log('\n[8] 音频素材真实性 · 引用的素材必须真实存在');

const AUDIO_DIR = join(REPO, '..', 'molten-heart-audio');
const catalogPath = join(AUDIO_DIR, 'CATALOG.md');
if (existsSync(catalogPath)) {
  const catalog = readFileSync(catalogPath, 'utf8');
  const ids = [...catalog.matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]);
  const idSet = new Set(ids);

  for (const m of geo.audio.mappings) {
    if (m.asset === null) {
      ok(`${m.trigger} 刻意无音效`, m.reason || '');
      continue;
    }
    assertTrue(
      `素材 ${m.asset} 存在于 CATALOG`,
      idSet.has(m.asset),
      idSet.has(m.asset) ? '已核实' : 'CATALOG 里找不到这个 ID',
    );
  }
} else {
  console.log('  SKIP  未找到 molten-heart-audio/CATALOG.md，跳过音频真实性校验');
}

// 规则数量
assertTrue('音频规则 ≥ 3 条', geo.audio.rules.length >= 3, `${geo.audio.rules.length} 条`);

// ── 9. 平台描边不得超出轮廓 ──────────────────────────────────────────────
console.log('\n[9] 平台描边 · 不得超出判定轮廓');

const platDef = geo.kinds.platform;
const rimPart = platDef.parts.find((p) => p.name === 'rim');
assertTrue('platform 有 rim 部件', Boolean(rimPart), rimPart ? '存在' : '缺失');
const rimOuter = rimPart.params[1];
const platRadius = platDef.parts.find((p) => p.name === 'top').params[0];
assertTrue(
  '描边外径 ≤ 台面半径',
  rimOuter <= platRadius + 1e-9,
  `描边 ${rimOuter} ≤ 台面 ${platRadius}`,
);
assertTrue(
  '描边只有边没有面（batch 是 rune 但几何是 ring）',
  rimPart.geo === 'ring',
  `geo=${rimPart.geo}`,
);

// ── 10. 视觉语法完整性 ───────────────────────────────────────────────────
console.log('\n[10] 视觉语法完整性');

const silhouettes = geo.visualGrammar.silhouetteTable;
for (const kind of ['slagBulwark', 'obsidianPillar', 'brokenParapet', 'coreWard', 'frostAnchor', 'platform']) {
  assertTrue(
    `${kind} 有剪影描述`,
    typeof silhouettes[kind] === 'string' && silhouettes[kind].length > 8,
    silhouettes[kind] || '缺失',
  );
}

// 六种剪影必须互不相同（这是"一眼认出"的前提）
const silValues = Object.values(silhouettes);
assertTrue('六种剪影描述互不相同', new Set(silValues).size === silValues.length, `${silValues.length} 种`);

// ── 汇总 ─────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(70));
if (failures === 0) {
  console.log(`[M3-04b 校验] ===== 全部通过 =====  ${checks} 项断言，0 失败`);
  console.log(`  静态三角 ${staticTris} / 总三角 ${totalTris}（占上限 ${(pct * 100).toFixed(1)}%）`);
  console.log(`  draw call 增量 +${expectedDrawCalls}（${[...batchesUsed].join(' + ')} + debris）`);
  process.exit(0);
} else {
  console.log(`[M3-04b 校验] ===== 失败 =====  ${checks} 项断言，${failures} 失败`);
  process.exit(1);
}
