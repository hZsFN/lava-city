#!/usr/bin/env node
// ============================================================================
// M3-04 场地道具 · 设计校验器（只读，不写任何文件）
// ----------------------------------------------------------------------------
// 为什么要有这个脚本：设计票里全是坐标和"跳得上去 / 躲得掉"的断言。
// 断言不能靠眼睛看，必须能重跑。本脚本读取 M3-04-arena-props.config.json，
// 用 src/core/config/player.json 的真实物理参数重算可达性，并逐条断言：
//
//   1. 可达性数学：跳跃高度 / 滞空 / 水平距离，与 config 声明一致
//   2. 平台链：地面 → 低台 → 高台 → 残墩，每一跳都在安全上限内
//   3. 塔位净空：没有道具压到 11 个塔位中的任何一个
//   4. 桥面净空：没有道具压在 4 条石桥上
//   5. 出生点净空：玩家出生点、Boss 出生点
//   6. Boss 可达：所有道具 r ≤ 19（Boss 活动边界），不造无敌外圈
//   7. 三角/实例预算
//   8. 视线遮挡自检：至少有一条吐息射线被 slagBulwark / obsidianPillar 挡住
//
// 用法：node docs/tickets/M3-04-validate.mjs
// 退出码：0 = 全绿；1 = 有断言失败（会打印具体哪条、差多少）
// ============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

const cfg = JSON.parse(readFileSync(join(HERE, 'M3-04-arena-props.config.json'), 'utf8'));
const player = JSON.parse(readFileSync(join(REPO, 'src', 'core', 'config', 'player.json'), 'utf8'));
const arena = JSON.parse(readFileSync(join(REPO, 'src', 'core', 'config', 'arena.json'), 'utf8'));

let failures = 0;
let checks = 0;

function ok(label, detail) {
  checks += 1;
  console.log(`  PASS  ${label}${detail ? `  — ${detail}` : ''}`);
}

function fail(label, detail) {
  checks += 1;
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
}

function assertLe(label, actual, limit) {
  if (actual <= limit + 1e-9) ok(label, `${fmt(actual)} ≤ ${fmt(limit)}`);
  else fail(label, `${fmt(actual)} > ${fmt(limit)}（超出 ${fmt(actual - limit)}）`);
}

function assertGe(label, actual, limit) {
  if (actual >= limit - 1e-9) ok(label, `${fmt(actual)} ≥ ${fmt(limit)}`);
  else fail(label, `${fmt(actual)} < ${fmt(limit)}（差 ${fmt(limit - actual)}）`);
}

function fmt(v) {
  return Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function deg2rad(d) {
  return (d * Math.PI) / 180;
}

function polar(angleDeg, radiusM) {
  return [Math.cos(deg2rad(angleDeg)) * radiusM, Math.sin(deg2rad(angleDeg)) * radiusM];
}

function dist2(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

// ── 1. 可达性数学（用 player.json 真实值重算，不抄 config 的结论）──────────
console.log('\n[1] 可达性数学 · 由 player.json 真实值重算');

const g = Math.abs(player.physics.gravity);
const jumpH = player.movement.jumpHeight;
const v0 = Math.sqrt(2 * g * jumpH);
const airTime = (2 * v0) / g;
const walkGap = player.movement.moveSpeed * airTime;
// 冲刺**替换**该窗口内的走速，不是叠加：剩余滞空用走速，冲刺窗口用冲刺速。
const dashSec = player.movement.dashIFramesSec;
const dashGap =
  player.movement.moveSpeed * Math.max(0, airTime - dashSec) +
  player.movement.sprintSpeed * dashSec;

console.log(`       gravity=${g}  jumpHeight=${jumpH}  → v0=${v0.toFixed(4)} m/s`);
console.log(`       滞空=${airTime.toFixed(4)} s  走跳水平=${walkGap.toFixed(3)} m  冲刺跳水平=${dashGap.toFixed(3)} m`);

const R = cfg.reach;
if (Math.abs(R.jumpVelocity - v0) < 1e-3) ok('jumpVelocity 与重算一致', v0.toFixed(4));
else fail('jumpVelocity 与重算不一致', `config=${R.jumpVelocity} 重算=${v0.toFixed(4)}`);

if (Math.abs(R.airTimeSec - airTime) < 1e-3) ok('airTimeSec 与重算一致', airTime.toFixed(4));
else fail('airTimeSec 与重算不一致', `config=${R.airTimeSec} 重算=${airTime.toFixed(4)}`);

if (Math.abs(R.hardMaxWalkGap - walkGap) < 1e-2) ok('hardMaxWalkGap 与重算一致', walkGap.toFixed(3));
else fail('hardMaxWalkGap 与重算不一致', `config=${R.hardMaxWalkGap} 重算=${walkGap.toFixed(3)}`);

if (Math.abs(R.hardMaxDashGap - dashGap) < 1e-2) ok('hardMaxDashGap 与重算一致', dashGap.toFixed(3));
else fail('hardMaxDashGap 与重算不一致', `config=${R.hardMaxDashGap} 重算=${dashGap.toFixed(3)}`);

// 冲刺是地面动作还是空中动作？读 PlayerController 的 handleDash：
// 它只检查 dashTimer / dashCooldown，不检查 grounded —— 所以空中也能冲。
// 但 dash 会覆盖水平速度（sprintSpeed），所以"冲刺跳"的水平距离 = 走跳 + 冲刺窗口位移。
console.log('       注：handleDash() 不检查 grounded，空中冲刺合法 → dashGap 计算成立');

// ── 2. 平台链：每一跳都要在安全上限内 ────────────────────────────────────
console.log('\n[2] 平台链可达性 · 地面 → 低台 → 高台 → 残墩');

const kindById = cfg.kinds;
const instances = cfg.instances.map((inst) => {
  const k = kindById[inst.kind];
  if (!k) throw new Error(`未知 kind: ${inst.kind}`);
  const [x, z] = polar(inst.angleDeg, inst.radiusM);
  return { ...inst, kindDef: k, x, z, r: inst.radiusM };
});

const platforms = instances.filter((i) => i.kindDef.category === 'platform');

// 按链分组：同 angleDeg 的 L 链
const chains = new Map();
for (const p of platforms) {
  const key = p.angleDeg;
  if (!chains.has(key)) chains.set(key, []);
  chains.get(key).push(p);
}

let chainCount = 0;
for (const [angle, list] of chains) {
  list.sort((a, b) => a.r - b.r);
  chainCount += 1;
  const label = `链 @${angle}°`;
  let prevTop = 0;
  let prevHalf = null; // null = 地面起步，没有"前一块平台"
  for (const p of list) {
    const h = p.kindDef.heightM;
    const stepUp = h - prevTop;
    const halfSpan = p.kindDef.footprint.widthM / 2;
    const tag = `${label} ${p.id}(${p.kind}, h=${h})`;

    // 抬升：每一跳都不能超过安全上限（第一段从地面算起）
    assertLe(`${tag} 抬升`, stepUp, R.safeStepUp);

    // 间隙：只有"平台到平台"才量边到边距离；第一块是从地面走过去的，不量
    if (prevHalf !== null) {
      const centerDist = p.r - list[list.indexOf(p) - 1].r;
      const gap = Math.max(0, centerDist - prevHalf - halfSpan);
      assertLe(`${tag} 平台间隙`, gap, R.safeWalkGap);
    } else {
      ok(`${tag} 从地面起步，不量间隙`);
    }

    prevTop = h;
    prevHalf = halfSpan;
  }
}

// 高台从地面直上必须做不到（否则设计意图"必须两段跳"失效）
const highs = platforms.filter((p) => p.kind === 'jumpHigh');
for (const h of highs) {
  assertGe(`高台 ${h.id} 高度必须 > 单跳上限`, h.kindDef.heightM, R.jumpHeight + 0.2);
}

// 残墩从地面直上必须做不到
const piers = platforms.filter((p) => p.kind === 'bridgePier');
for (const p of piers) {
  assertGe(`残墩 ${p.id} 高度必须 > 单跳上限`, p.kindDef.heightM, R.jumpHeight + 0.2);
}

console.log(`       ${chainCount} 条平台链，共 ${platforms.length} 块平台`);

// ── 3. 塔位净空 ──────────────────────────────────────────────────────────
console.log('\n[3] 塔位净空 · 不得压住 11 个塔位');

const avoid = cfg.mustAvoid;
for (const inst of instances) {
  const p = [inst.x, inst.z];
  let worst = Infinity;
  let worstSlot = null;
  for (const slot of avoid.logicalSlots) {
    const d = dist2(p, [slot[0], slot[2]]);
    if (d < worst) {
      worst = d;
      worstSlot = slot;
    }
  }
  // 道具等效半径：圆形取 radius，矩形取对角线一半
  const fp = inst.kindDef.footprint;
  const propR = fp.shape === 'circle' ? fp.radiusM : Math.hypot(fp.widthM, fp.depthM) / 2;
  const clearance = worst - propR;
  if (clearance >= avoid.slotClearanceM) {
    ok(`${inst.id}(${inst.kind}) 塔位净空`, `最近塔位 [${worstSlot[0]},${worstSlot[2]}] 净空 ${fmt(clearance)} m`);
  } else {
    fail(`${inst.id}(${inst.kind}) 塔位净空`, `最近塔位 [${worstSlot[0]},${worstSlot[2]}] 净空只有 ${fmt(clearance)} m < ${avoid.slotClearanceM}`);
  }
}

// ── 4. 石桥净空 ──────────────────────────────────────────────────────────
console.log('\n[4] 石桥净空 · 不得压在 4 条桥上');

const br = avoid.bridges;
for (const inst of instances) {
  let hit = null;
  for (const a of br.anglesDeg) {
    // 把道具点投影到桥的局部坐标：桥沿角度 a 的径向延伸
    const ux = Math.cos(deg2rad(a));
    const uz = Math.sin(deg2rad(a));
    const along = inst.x * ux + inst.z * uz;
    const across = Math.abs(-inst.x * uz + inst.z * ux);
    if (along >= br.innerM && along <= br.outerM && across <= br.widthM / 2) {
      hit = { a, along, across };
      break;
    }
  }
  if (!hit) ok(`${inst.id} 不压石桥`);
  else fail(`${inst.id} 压在 ${hit.a}° 石桥上`, `along=${fmt(hit.along)} across=${fmt(hit.across)}`);
}

// ── 5. 出生点净空 ────────────────────────────────────────────────────────
console.log('\n[5] 出生点净空 · 玩家 spawn 与 Boss spawn');

for (const inst of instances) {
  const p = [inst.x, inst.z];
  const fp = inst.kindDef.footprint;
  const propR = fp.shape === 'circle' ? fp.radiusM : Math.hypot(fp.widthM, fp.depthM) / 2;

  const dPlayer = dist2(p, [avoid.playerSpawn[0], avoid.playerSpawn[2]]) - propR;
  if (dPlayer >= avoid.playerSpawnClearanceM) ok(`${inst.id} 玩家出生点净空`, fmt(dPlayer));
  else fail(`${inst.id} 玩家出生点净空`, `只有 ${fmt(dPlayer)} m`);

  const dBoss = dist2(p, [avoid.bossSpawn[0], avoid.bossSpawn[2]]) - propR;
  if (dBoss >= avoid.bossSpawnClearanceM) ok(`${inst.id} Boss 出生点净空`, fmt(dBoss));
  else fail(`${inst.id} Boss 出生点净空`, `只有 ${fmt(dBoss)} m`);
}

// ── 6. Boss 可达边界 ─────────────────────────────────────────────────────
console.log('\n[6] Boss 可达边界 · 不造追不到的无敌外圈');

for (const inst of instances) {
  const fp = inst.kindDef.footprint;
  const propR = fp.shape === 'circle' ? fp.radiusM : Math.hypot(fp.widthM, fp.depthM) / 2;
  assertLe(`${inst.id} 外缘 r`, inst.r + propR, avoid.bossBoundaryRadiusM);
}

// ── 7. 预算 ──────────────────────────────────────────────────────────────
console.log('\n[7] 实例与三角预算');

assertLe('实例总数', instances.length, cfg.budget.maxInstances);

// 本脚本只做粗筛（防止出现"每件都按最贵几何"的极端情况）。
// 精确三角数由子票 M3-04b-validate.mjs 逐件按几何拼装重算并断言：
//   静态 3216 + 碎片 768 + 破坏前兆 348 = 4332
function trisFor(inst) {
  const fp = inst.kindDef.footprint;
  if (fp.shape === 'circle') return 32;
  return 12;
}
const roughTris = instances.reduce((s, i) => s + trisFor(i), 0);
assertLe('三角粗筛', roughTris, cfg.budget.maxTrianglesAdded);
console.log(`       粗筛 ${roughTris}（精确值见 M3-04b：静态 3216 / 合计 4332）`);

// ── 8. 视线遮挡自检 ──────────────────────────────────────────────────────
console.log('\n[8] 视线遮挡自检 · 吐息锥内的射线必须被实体挡住');

const losY = cfg.damageModel.losRayHeightY;

/** 道具的 2D 轴对齐半径（保守外包圆，够用于"挡不挡得住"判定） */
function propRadius(inst) {
  const fp = inst.kindDef.footprint;
  return fp.shape === 'circle' ? fp.radiusM : Math.hypot(fp.widthM, fp.depthM) / 2;
}

/** 线段 (a→b) 与圆 (c, r) 是否相交（2D） */
function segmentHitsCircle(a, b, c, r) {
  const abx = b[0] - a[0];
  const abz = b[1] - a[1];
  const acx = c[0] - a[0];
  const acz = c[1] - a[1];
  const len2 = abx * abx + abz * abz;
  if (len2 < 1e-12) return Math.hypot(acx, acz) <= r;
  let t = (acx * abx + acz * abz) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = a[0] + abx * t;
  const pz = a[1] + abz * t;
  return Math.hypot(c[0] - px, c[1] - pz) <= r;
}

for (const sc of cfg.losScenarios) {
  const from = sc.from;
  const to = sc.toward;
  const blockers = [];

  for (const inst of instances) {
    // 只有"在该高度上真的是一堵墙"的道具才挡
    if (!inst.kindDef.blocksLos) continue;
    if (inst.kindDef.losTopY < losY || inst.kindDef.losBottomY > losY) continue;
    if (segmentHitsCircle(from, to, [inst.x, inst.z], propRadius(inst))) {
      blockers.push(inst.id);
    }
  }

  const expectBlocked = sc.expectBlocked !== false;

  if (expectBlocked) {
    if (blockers.length > 0) {
      ok(`${sc.id} 射线被挡住`, `挡住它的：${blockers.join(', ')}`);
    } else {
      fail(`${sc.id} 射线没有任何遮挡物`, `需要 ${sc.mustBeBlockedBy.join('/')} 落在 ${JSON.stringify(from)}→${JSON.stringify(to)} 连线上`);
    }

    for (const want of sc.mustBeBlockedBy) {
      if (blockers.includes(want)) ok(`${sc.id} 关键遮挡物 ${want} 生效`);
      else fail(`${sc.id} 关键遮挡物 ${want} 没挡住`, `实际挡住的是 ${blockers.join(', ') || '无'}`);
    }
  } else {
    // 反向场景：必须挡不住，证明掩体有方向、不是全罩
    if (blockers.length === 0) {
      ok(`${sc.id} 正确地挡不住（掩体有方向性）`, '没有任何道具遮挡此射线');
    } else {
      fail(`${sc.id} 不该被挡住却挡住了`, `挡住它的：${blockers.join(', ')}`);
    }
  }

  // 反向自检：矮墙在任何场景下都不得挡住胸口射线
  for (const p of instances.filter((i) => i.kind === 'brokenParapet')) {
    if (blockers.includes(p.id)) {
      fail(`矮墙 ${p.id} 不该挡住胸口射线`, `losTopY=${p.kindDef.losTopY} < ${losY}`);
    }
  }
}

// ── 9. 阶段 II 膝弱点工具链 ──────────────────────────────────────────────
console.log('\n[9] 阶段 II 膝弱点工具链 · 必须有可撞的柱');

const pillarCount = instances.filter((i) => i.kind === 'obsidianPillar').length;
assertGe('黑曜石棱柱数量', pillarCount, 4);
const pillarAngles = instances.filter((i) => i.kind === 'obsidianPillar').map((i) => i.angleDeg).sort((a, b) => a - b);
console.log(`       柱位角度：${pillarAngles.join('°, ')}°`);
// 冲撞路线需要柱子不都在同一条直径上，否则只有一个撞点
const distinctQuadrants = new Set(pillarAngles.map((a) => Math.floor((a % 360) / 90))).size;
assertGe('柱子分布在 ≥3 个象限', distinctQuadrants, 3);

// ── 汇总 ─────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(70));
if (failures === 0) {
  console.log(`[M3-04 校验] ===== 全部通过 =====  ${checks} 项断言，0 失败`);
  console.log(`  实例 ${instances.length} 件 / 三角粗筛 ${roughTris} / 平台链 ${chainCount} 条`);
  console.log('  精确三角与 draw call 见 M3-04b-validate.mjs（静态 3216 / 合计 4332 / draw call +5）');
  process.exit(0);
} else {
  console.log(`[M3-04 校验] ===== 失败 =====  ${checks} 项断言，${failures} 失败`);
  process.exit(1);
}
