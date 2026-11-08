// 指标校验：在 Node 里直接跑模型（不经过浏览器），统计网格/三角面/包围盒/关节/弱点球，
// 做断言校验，输出 _work/metrics.json 供文档引用。
//
// 用法：
//   node tools/verify.mjs                    # 校验 SurtrRig.ts，写 _work/metrics.json
//   node tools/verify.mjs --model=a.ts --out=_work/m.json
//   node tools/verify.mjs --json             # 只输出 JSON 到 stdout（不打印表格）
//
// 退出码：0 = 全部断言通过；1 = 有 FAIL 或执行失败。

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import * as THREE from 'three';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// —— 断言阈值（契约第 1 节 + 任务书）——
const LIMITS = {
  heightMin: 14.2,
  heightMax: 15.2,
  widthMin: 8.5,
  trianglesMax: 60000,
  weakVisibleMin: 8, // /24
  metaHeightTol: 0.15,
  footTol: 0.15,
};

const RAY_DIRS = 24;

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq < 0) out[a.slice(2)] = true;
    else out[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return out;
}

const f = (n, d = 2) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : 'NaN');
const v3 = (a) => `[${f(a[0])}, ${f(a[1])}, ${f(a[2])}]`;

async function main() {
  const t0 = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const jsonOnly = Boolean(args.json);

  const modelPath = resolve(ROOT, args.model || 'SurtrRig.ts');
  const outPath = resolve(ROOT, args.out || '_work/metrics.json');

  if (!existsSync(modelPath)) {
    console.error(
      `[校验] 找不到模型文件：${modelPath}\n` +
        `  SurtrRig.ts 由 Lead 负责；工具链自测请用 --model=_work/xxx.ts。`,
    );
    process.exit(1);
  }

  // ——————————————————————————————————————————————
  // 1. 转译 + 落盘到 _work/，再 import（Node 能解析裸模块名 three）
  // ——————————————————————————————————————————————
  const tsSource = (await readFile(modelPath, 'utf8')).replace(/^\uFEFF/, '');
  const result = ts.transpileModule(tsSource, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      isolatedModules: true,
      removeComments: false,
      newLine: ts.NewLineKind.LineFeed,
      sourceMap: false,
    },
    fileName: modelPath,
    reportDiagnostics: true,
  });

  const diags = result.diagnostics || [];
  if (diags.length) {
    console.error('[校验] SurtrRig.ts 转译有诊断：');
    for (const d of diags.slice(0, 10)) {
      const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
      let where = '';
      if (d.file && typeof d.start === 'number') {
        const pos = d.file.getLineAndCharacterOfPosition(d.start);
        where = `${modelPath}:${pos.line + 1}:${pos.character + 1} `;
      }
      console.error(`  ${where}TS${d.code}: ${msg}`);
    }
    process.exit(1);
  }

  const js = result.outputText;
  // 契约要求模型只用 `import * as THREE from 'three'`；Node 能解析裸模块名，
  // 所以这里原样保留（不做替换），只校验确实存在。
  if (!/from\s+['"]three['"]/.test(js)) {
    console.warn('[校验警告] 转译产物里没有 `from "three"` 的导入，模型可能没 import THREE。');
  }

  const workDir = resolve(ROOT, '_work');
  await mkdir(workDir, { recursive: true });
  const stamp = `${Date.now()}-${process.pid}`;
  const tmpJs = resolve(workDir, `_surtr_verify_${stamp}.mjs`);
  await writeFile(tmpJs, js, 'utf8');

  let build;
  try {
    const mod = await import(`${pathToFileURL(tmpJs).href}?t=${stamp}`);
    if (typeof mod.createSurtrRig !== 'function') {
      throw new Error('SurtrRig.ts 没有导出 createSurtrRig 函数（契约第 1 节要求 export function）');
    }
    build = mod.createSurtrRig();
  } catch (e) {
    console.error(`[校验] 执行 createSurtrRig() 失败：${e && e.message ? e.message : e}`);
    if (e && e.stack) console.error(e.stack.split('\n').slice(0, 12).join('\n'));
    await rm(tmpJs, { force: true }).catch(() => {});
    process.exit(1);
  } finally {
    // 保留临时文件便于排查；成功后在末尾清理
  }

  // 延迟到用完再删（ESM 已加载进内存，删文件不影响）
  await rm(tmpJs, { force: true }).catch(() => {});

  // ——————————————————————————————————————————————
  // 2. 基本结构校验
  // ——————————————————————————————————————————————
  const problems = [];
  const need = [
    'rig',
    'solidMeshes',
    'glowMeshes',
    'phase1Meshes',
    'phase2Meshes',
    'materials',
    'meta',
  ];
  for (const k of need) {
    if (!(k in build)) problems.push(`build.${k} 缺失`);
  }
  if (problems.length) {
    console.error(`[校验] SurtrBuild 结构不完整：\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }

  const { rig, solidMeshes, glowMeshes, phase1Meshes, phase2Meshes, meta } = build;

  // 关节齐全性（契约第 1 节）
  const JOINT_KEYS = [
    'root',
    'rig',
    'hips',
    'torso',
    'chest',
    'head',
    'shoulderL',
    'elbowL',
    'shoulderR',
    'elbowR',
    'legL',
    'kneeL',
    'footL',
    'legR',
    'kneeR',
    'footR',
  ];
  for (const k of JOINT_KEYS) {
    if (!rig || !rig[k]) problems.push(`rig.${k} 缺失（契约要求 16 个关节组）`);
  }

  // ——————————————————————————————————————————————
  // 3. 遍历网格：统计数量 / 三角面
  // ——————————————————————————————————————————————
  const root = rig.root;
  if (!root) {
    console.error('[校验] rig.root 缺失');
    process.exit(1);
  }
  root.updateMatrixWorld(true);

  const phase2Set = new Set(phase2Meshes || []);
  const glowSet = new Set(glowMeshes || []);
  const allMeshes = [];
  root.traverse((o) => {
    if (o.isMesh) allMeshes.push(o);
  });

  const meshCount = allMeshes.length;
  const phase2Count = phase2Meshes.length;
  const glowCount = glowMeshes.length;

  let triangles = 0;
  let trianglesPhase1 = 0;
  let vertexCount = 0;
  const nonMeshSkipped = [];
  for (const m of allMeshes) {
    const g = m.geometry;
    if (!g) {
      nonMeshSkipped.push(`${m.name || '(无名)'}: 无 geometry`);
      continue;
    }
    const pos = g.getAttribute ? g.getAttribute('position') : null;
    const index = g.getIndex ? g.getIndex() : null;
    let tris = 0;
    if (index && index.count) tris = Math.floor(index.count / 3);
    else if (pos && pos.count) tris = Math.floor(pos.count / 3);
    if (m.isInstancedMesh && m.count) tris *= m.count;
    triangles += tris;
    if (!phase2Set.has(m)) trianglesPhase1 += tris;
    if (pos && pos.count) vertexCount += pos.count;
  }

  // ——————————————————————————————————————————————
  // 4. 阶段 I 精确包围盒（遍历非 phase2 网格顶点 × 世界矩阵）
  // ——————————————————————————————————————————————
  const bbox = {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
  let vertexSampled = 0;
  let phase2ExcludedMeshes = 0;

  for (const m of allMeshes) {
    if (phase2Set.has(m)) {
      phase2ExcludedMeshes += 1;
      continue;
    }
    const g = m.geometry;
    if (!g) continue;
    const pos = g.getAttribute ? g.getAttribute('position') : null;
    if (!pos) continue;
    const arr = pos.array;
    const step = pos.itemSize || 3;
    const isInstanced = Boolean(m.isInstancedMesh);
    const instCount = isInstanced ? m.count : 1;
    const instMat = isInstanced ? m.instanceMatrix : null;
    const instMat4 = new THREE.Matrix4();
    const composed = new THREE.Matrix4();

    for (let inst = 0; inst < instCount; inst += 1) {
      // 组合世界矩阵（实例网格额外乘 instanceMatrix）
      let mw = m.matrixWorld;
      if (isInstanced && instMat && instMat.array) {
        instMat4.fromArray(instMat.array, inst * 16);
        composed.multiplyMatrices(m.matrixWorld, instMat4);
        mw = composed;
      }
      const e = mw.elements;
      for (let i = 0; i + step <= arr.length; i += step) {
        const x = arr[i];
        const y = arr[i + 1];
        const z = arr[i + 2];
        const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
        const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
        const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
        if (wx < bbox.min[0]) bbox.min[0] = wx;
        if (wy < bbox.min[1]) bbox.min[1] = wy;
        if (wz < bbox.min[2]) bbox.min[2] = wz;
        if (wx > bbox.max[0]) bbox.max[0] = wx;
        if (wy > bbox.max[1]) bbox.max[1] = wy;
        if (wz > bbox.max[2]) bbox.max[2] = wz;
        vertexSampled += 1;
      }
    }
  }

  const bboxSize = [
    bbox.max[0] - bbox.min[0],
    bbox.max[1] - bbox.min[1],
    bbox.max[2] - bbox.min[2],
  ];
  const height = bbox.max[1]; // 契约：脚底 y = 0
  const width = bboxSize[0];

  // ——————————————————————————————————————————————
  // 5. 关节世界坐标
  // ——————————————————————————————————————————————
  const joints = {};
  for (const k of JOINT_KEYS) {
    const o = rig[k];
    if (!o) continue;
    const p = new THREE.Vector3();
    o.getWorldPosition(p);
    joints[k] = [round4(p.x), round4(p.y), round4(p.z)];
  }

  // ——————————————————————————————————————————————
  // 6. 四个弱点球：内部发光顶点数 + 24 方向可见性
  // ——————————————————————————————————————————————
  const weakPoints = Array.isArray(meta.weakPoints) ? meta.weakPoints : [];
  const weakStats = [];

  // 遮挡体：阶段 I 的实体网格（solidMeshes 里非 phase2 的）
  const occluders = (solidMeshes || []).filter((m) => m && !phase2Set.has(m) && m.isMesh);

  for (const wp of weakPoints) {
    const center = new THREE.Vector3(wp.pos[0], wp.pos[1], wp.pos[2]);
    const r = Number(wp.r) || 0;

    // (a) 球内发光网格顶点数
    let glowVertsInSphere = 0;
    for (const m of glowMeshes || []) {
      if (!m || !m.geometry || phase2Set.has(m)) continue;
      const pos = m.geometry.getAttribute ? m.geometry.getAttribute('position') : null;
      if (!pos) continue;
      const arr = pos.array;
      const step = pos.itemSize || 3;
      const e = m.matrixWorld.elements;
      for (let i = 0; i + step <= arr.length; i += step) {
        const x = arr[i];
        const y = arr[i + 1];
        const z = arr[i + 2];
        const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
        const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
        const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
        const d2 = (wx - center.x) ** 2 + (wy - center.y) ** 2 + (wz - center.z) ** 2;
        if (d2 <= r * r) glowVertsInSphere += 1;
      }
    }

    // (b) 24 方向射线可见性（不被任何非 phase2 实体网格遮挡）
    const raycaster = new THREE.Raycaster();
    raycaster.far = 1000;
    let visibleDirs = 0;
    const dirDetail = [];
    for (let i = 0; i < RAY_DIRS; i += 1) {
      // Fibonacci 球面均匀分布
      const y = 1 - (2 * (i + 0.5)) / RAY_DIRS;
      const rad = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      const dir = new THREE.Vector3(Math.cos(theta) * rad, y, Math.sin(theta) * rad).normalize();
      raycaster.set(center, dir);
      let blocked = false;
      try {
        const hits = raycaster.intersectObjects(occluders, true);
        for (const h of hits) {
          // 忽略退化自交（距离几乎为 0）
          if (h.distance > 1e-4) {
            blocked = true;
            break;
          }
        }
      } catch {
        blocked = true;
      }
      if (!blocked) visibleDirs += 1;
      dirDetail.push(blocked ? 0 : 1);
    }

    weakStats.push({
      key: wp.key,
      label: wp.label,
      pos: wp.pos.map(round4),
      r: round4(r),
      glowVertsInSphere,
      visibleDirs,
      rayDirs: RAY_DIRS,
      visibleRatio: round4(visibleDirs / RAY_DIRS),
      dirDetail,
    });
  }

  // ——————————————————————————————————————————————
  // 7. 断言
  // ——————————————————————————————————————————————
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });

  add(
    `全高 ${LIMITS.heightMin}~${LIMITS.heightMax} m`,
    height >= LIMITS.heightMin && height <= LIMITS.heightMax,
    `实际 max.y=${f(height)} m（包围盒高 ${f(bboxSize[1])}，min.y=${f(bbox.min[1])}）`,
  );
  add(
    `x 跨度 ≥ ${LIMITS.widthMin} m`,
    width >= LIMITS.widthMin,
    `实际 x 跨度 ${f(width)} m（min.x=${f(bbox.min[0])}, max.x=${f(bbox.max[0])}）`,
  );
  add(
    `三角面 ≤ ${LIMITS.trianglesMax}`,
    triangles <= LIMITS.trianglesMax,
    `实际 ${triangles} 面（阶段 I ${trianglesPhase1} 面，顶点 ${vertexCount}）`,
  );
  add(
    '脚底 y ≈ 0',
    Math.abs(bbox.min[1]) <= LIMITS.footTol,
    `实际 min.y = ${f(bbox.min[1])} m（容差 ±${LIMITS.footTol}）`,
  );
  add(
    '4 个弱点球',
    weakPoints.length === 4,
    `实际 ${weakPoints.length} 个：${weakPoints.map((w) => w.key).join(', ') || '(无)'}`,
  );
  const needKeys = ['core', 'back', 'kneeL', 'kneeR'];
  const gotKeys = weakPoints.map((w) => w.key);
  add(
    '弱点 key 齐全（core/back/kneeL/kneeR）',
    needKeys.every((k) => gotKeys.includes(k)),
    `实际：${gotKeys.join(', ') || '(无)'}`,
  );
  for (const w of weakStats) {
    add(
      `弱点 ${w.key}（${w.label}）可见方向 ≥ ${LIMITS.weakVisibleMin}/${RAY_DIRS}`,
      w.visibleDirs >= LIMITS.weakVisibleMin,
      `实际 ${w.visibleDirs}/${RAY_DIRS}，球内发光顶点 ${w.glowVertsInSphere} 个，r=${f(w.r)}`,
    );
  }
  const metaHeightDiff = Math.abs((Number(meta.height) || 0) - bboxSize[1]);
  add(
    `meta.height 与实际包围盒高度差 < ${LIMITS.metaHeightTol} m`,
    metaHeightDiff < LIMITS.metaHeightTol,
    `meta.height=${f(meta.height)}，实际=${f(bboxSize[1])}，差 ${f(metaHeightDiff, 3)} m`,
  );

  const fails = checks.filter((c) => !c.pass);

  // ——————————————————————————————————————————————
  // 8. 汇总输出
  // ——————————————————————————————————————————————
  const metrics = {
    generatedAt: new Date().toISOString(),
    model: modelPath,
    source: 'SurtrRig.ts',
    counts: {
      meshCount,
      triangles,
      trianglesPhase1,
      vertexCount,
      glowCount,
      phase2Count,
      phase1Count: phase1Meshes.length,
      solidCount: solidMeshes.length,
      phase2ExcludedMeshes,
      vertexSampled,
    },
    bbox: {
      min: bbox.min.map(round4),
      max: bbox.max.map(round4),
      size: bboxSize.map(round4),
    },
    height: round4(height),
    width: round4(width),
    meta: {
      height: round4(Number(meta.height)),
      width: round4(Number(meta.width)),
      heightDiff: round4(metaHeightDiff),
      weakPointCount: weakPoints.length,
    },
    joints,
    weakPoints: weakStats,
    checks,
    pass: fails.length === 0,
    failCount: fails.length,
    elapsedMs: Date.now() - t0,
  };

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(metrics, null, 2) + '\n', 'utf8');

  if (jsonOnly) {
    console.log(JSON.stringify(metrics, null, 2));
    process.exit(fails.length === 0 ? 0 : 1);
  }

  // —— 人类可读摘要 ——
  console.log('================ 苏尔特模型指标 ================');
  console.log(`模型文件：${modelPath}`);
  console.log('');
  console.log('【规模】');
  console.log(`  网格总数    ：${meshCount}`);
  console.log(`  三角面      ：${triangles}  （阶段 I ${trianglesPhase1}）`);
  console.log(`  顶点数      ：${vertexCount}`);
  console.log(`  发光网格    ：${glowCount}`);
  console.log(`  阶段 II 网格：${phase2Count}`);
  console.log(`  阶段 I 网格 ：${phase1Meshes.length}（实体 ${solidMeshes.length}）`);
  console.log('');
  console.log('【阶段 I 包围盒（精确，顶点 × 世界矩阵）】');
  console.log(`  min   ：${v3(bbox.min)}`);
  console.log(`  max   ：${v3(bbox.max)}`);
  console.log(`  size  ：${v3(bboxSize)}`);
  console.log(`  全高  ：${f(bboxSize[1])} m（max.y=${f(bbox.max[1])}，脚底 min.y=${f(bbox.min[1])}）`);
  console.log(`  x 跨度：${f(width)} m`);
  console.log(`  采样顶点：${vertexSampled} 个（排除 phase2 网格 ${phase2ExcludedMeshes} 个）`);
  console.log('');
  console.log('【meta 一致性】');
  console.log(
    `  meta.height=${f(meta.height)} / 实际=${f(bboxSize[1])} / 差=${f(metaHeightDiff, 3)} m`,
  );
  console.log(`  meta.width =${f(meta.width)} / 实际=${f(width)}`);
  console.log('');
  console.log('【关节世界坐标】');
  for (const k of JOINT_KEYS) {
    if (!joints[k]) continue;
    console.log(`  ${k.padEnd(10)} ${v3(joints[k])}`);
  }
  console.log('');
  console.log('【弱点球】');
  console.log('  key      标签        球心                        r     球内发光顶点  可见方向');
  for (const w of weakStats) {
    console.log(
      `  ${String(w.key).padEnd(8)} ${String(w.label || '').padEnd(10)} ` +
        `${v3(w.pos).padEnd(26)} ${f(w.r).padStart(4)}  ${String(w.glowVertsInSphere).padStart(10)}   ` +
        `${String(w.visibleDirs).padStart(2)}/${w.rayDirs}`,
    );
  }
  console.log('');
  console.log('【断言】');
  for (const c of checks) {
    console.log(`  ${c.pass ? '✓ PASS' : '✗ FAIL'}  ${c.name}  —— ${c.detail}`);
  }
  console.log('');
  console.log(`metrics.json → ${outPath}`);
  console.log(`耗时：${((Date.now() - t0) / 1000).toFixed(2)} s`);
  console.log('================================================');

  if (fails.length) {
    console.error(`\n[校验] FAIL —— ${fails.length}/${checks.length} 条断言未通过：`);
    for (const c of fails) console.error(`  ✗ ${c.name}：${c.detail}`);
    process.exit(1);
  }
  console.log(`\n[校验] PASS —— ${checks.length}/${checks.length} 条断言全部通过`);
  process.exit(0);
}

function round4(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return n;
  return Math.round(n * 10000) / 10000;
}

main().catch((e) => {
  console.error(`[校验] 未捕获异常：${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
