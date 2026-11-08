import * as THREE from 'three/webgpu';

/**
 * 苏尔特 · 霸王版（参考图迭代）
 *
 * 造型取自参考图：一具由**多边形晶体岩板**拼成的熔岩巨人。
 * - 构造法：每个身体部件 = 一颗发光的熔岩内核（椭球）+ 一层贴在表面的斜边多边形岩板。
 *   岩板之间天然留出的缝隙透出内核的熔光，形成参考图里"满身熔岩缝"的效果。
 * - 体态：巨肩巨拳、驼背前压、小头深陷在两肩之间、双腿外八宽站，霸气、压迫。
 * - 肩、背、前臂长出尖锐的晶簇；胸口一颗外露的熔岩心；背部火山口；双膝熔核。
 *
 * 坐标约定：脚底 y = 0，面朝 +Z，+X 为它自己的右手边。
 */

// ---------------------------------------------------------------------------
// 对外接口（与 API契约.md 一致）
// ---------------------------------------------------------------------------

export interface SurtrRig {
  root: THREE.Group;
  rig: THREE.Group;
  hips: THREE.Group;
  torso: THREE.Group;
  chest: THREE.Group;
  head: THREE.Group;
  shoulderL: THREE.Group;
  elbowL: THREE.Group;
  shoulderR: THREE.Group;
  elbowR: THREE.Group;
  legL: THREE.Group;
  kneeL: THREE.Group;
  footL: THREE.Group;
  legR: THREE.Group;
  kneeR: THREE.Group;
  footR: THREE.Group;
}

export interface SurtrMaterials {
  /** 黑曜晶岩板：主体皮肤 */
  rock: THREE.MeshStandardMaterial;
  /** 晶簇 / 焦壳 */
  char: THREE.MeshStandardMaterial;
  /** 熔岩内核（缝隙里透出的光） */
  lava: THREE.MeshStandardMaterial;
  /** 炽白黄：眼、熔流、火冠 */
  lavaHot: THREE.MeshStandardMaterial;
  /** 熔岩心：阶段 I 弱点 */
  core: THREE.MeshStandardMaterial;
  /** 火山口 / 膝核：阶段 II 弱点 */
  vent: THREE.MeshStandardMaterial;
  /** 火山灰浮岩（阶段 II 悬浮碎块） */
  ash: THREE.MeshStandardMaterial;
  /** 暗余烬缝 */
  ember: THREE.MeshStandardMaterial;
}

export interface SurtrWeakPoint {
  key: 'core' | 'back' | 'kneeL' | 'kneeR';
  label: string;
  pos: [number, number, number];
  r: number;
  css: string;
}

export interface SurtrMeta {
  height: number;
  width: number;
  weakPoints: SurtrWeakPoint[];
  joints: Record<string, [number, number, number]>;
  eyes: THREE.Object3D | null;
  crater: THREE.Object3D | null;
  flameCrest: THREE.Object3D[];
  lavaFalls: THREE.Object3D[];
}

export interface SurtrBuild {
  rig: SurtrRig;
  solidMeshes: THREE.Mesh[];
  glowMeshes: THREE.Mesh[];
  phase1Meshes: THREE.Mesh[];
  phase2Meshes: THREE.Mesh[];
  materials: SurtrMaterials;
  meta: SurtrMeta;
}

// ---------------------------------------------------------------------------
// 常量与材质
// ---------------------------------------------------------------------------

const PI = Math.PI;
type V3 = THREE.Vector3Tuple;
const Y_AXIS = new THREE.Vector3(0, 1, 0);

function makeRockMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x3a2219,
    roughness: 0.62,
    metalness: 0.12,
    flatShading: true,
    vertexColors: true,
    emissive: 0x6a1a06,
    emissiveIntensity: 0.55,
  });
}

function makeCharMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x4a2a1c,
    roughness: 0.5,
    metalness: 0.15,
    flatShading: true,
    vertexColors: true,
    emissive: 0x501404,
    emissiveIntensity: 0.4,
  });
}

function makeLavaMaterial(hex: number, intensity: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x140400,
    roughness: 0.55,
    metalness: 0,
    emissive: hex,
    emissiveIntensity: intensity,
    flatShading: true,
    side: THREE.DoubleSide,
  });
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

interface Part {
  geo: THREE.BufferGeometry;
  pos?: V3;
  rot?: V3;
  quat?: THREE.Quaternion;
  scale?: V3;
}

interface BuildCtx {
  solid: THREE.Mesh[];
  glow: THREE.Mesh[];
  p1: THREE.Mesh[];
  p2: THREE.Mesh[];
  mats: SurtrMaterials;
}

/** 整数哈希 → [-1,1]，保证每次构建结果一致 */
function hash(a: number, b: number, c: number, d: number): number {
  let h = (a * 374761393 + b * 668265263 + c * 1440662683 + d * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

function rough<T extends THREE.BufferGeometry>(geo: T, amount: number, seed = 0): T {
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const qx = Math.round(x * 500);
    const qy = Math.round(y * 500);
    const qz = Math.round(z * 500);
    pos.setXYZ(
      i,
      x + hash(qx, qy, qz, seed) * amount,
      y + hash(qx, qy, qz, seed + 1) * amount,
      z + hash(qx, qy, qz, seed + 2) * amount,
    );
  }
  geo.computeVertexNormals();
  return geo;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

function merge(parts: Part[]): THREE.BufferGeometry {
  const chunks: Float32Array[] = [];
  let total = 0;
  for (const part of parts) {
    const g = part.geo.index ? part.geo.toNonIndexed() : part.geo.clone();
    const r = part.rot ?? [0, 0, 0];
    const p = part.pos ?? [0, 0, 0];
    const s = part.scale ?? [1, 1, 1];
    const q = part.quat ?? _q.setFromEuler(_e.set(r[0], r[1], r[2]));
    g.applyMatrix4(_m.compose(_p.set(p[0], p[1], p[2]), q, _s.set(s[0], s[1], s[2])));
    const arr = g.getAttribute('position').array as Float32Array;
    chunks.push(arr);
    total += arr.length;
  }
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(out, 3));
  geo.computeVertexNormals();
  return geo;
}

function addMesh(
  ctx: BuildCtx,
  geo: THREE.BufferGeometry,
  mat: THREE.MeshStandardMaterial,
  parent: THREE.Object3D,
  kind: 'solid' | 'glow',
  phase2 = false,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = kind === 'solid';
  m.receiveShadow = kind === 'solid';
  (kind === 'solid' ? ctx.solid : ctx.glow).push(m);
  if (phase2) {
    m.visible = false;
    ctx.p2.push(m);
  }
  parent.add(m);
  return m;
}

/** 关节组：pos 为世界坐标，parentW 为父组世界坐标（所有组都不旋转，局部 = 世界 − 父） */
function group(parent: THREE.Object3D, name: string, world: V3, parentW: V3): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  g.position.set(world[0] - parentW[0], world[1] - parentW[1], world[2] - parentW[2]);
  parent.add(g);
  return g;
}

function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function lerp3(a: V3, b: V3, t: number): V3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** 沿曲线的锥形管：晶簇、尖刺、火舌、熔流 */
function taper(points: V3[], r0: number, r1: number, radial = 5, segs = 6): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  const geo = new THREE.TubeGeometry(curve, segs, 1, radial, false);
  const pos = geo.getAttribute('position');
  const c = new THREE.Vector3();
  const v = new THREE.Vector3();
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    curve.getPointAt(t, c);
    const r = THREE.MathUtils.lerp(r0, r1, Math.pow(t, 0.9));
    for (let j = 0; j <= radial; j++) {
      const k = i * (radial + 1) + j;
      v.fromBufferAttribute(pos, k).sub(c).multiplyScalar(r).add(c);
      pos.setXYZ(k, v.x, v.y, v.z);
    }
  }
  geo.computeVertexNormals();
  return geo;
}

/** 单根晶体尖刺（五棱锥，带一点弯曲） */
function crystal(base: V3, dir: V3, len: number, r: number): Part {
  const d = new THREE.Vector3(...dir).normalize();
  const tip: V3 = [base[0] + d.x * len, base[1] + d.y * len, base[2] + d.z * len];
  const mid = lerp3(base, tip, 0.55);
  return { geo: taper([base, [mid[0], mid[1] + len * 0.04, mid[2]], tip], r, 0, 5, 3) };
}

// ---------------------------------------------------------------------------
// 核心构造：熔岩内核 + 多边形晶体岩板壳
// ---------------------------------------------------------------------------

interface ShellOpts {
  /** 椭球中心（世界坐标） */
  c: V3;
  /** 椭球半轴 */
  r: V3;
  /** 椭球朝向（局部 Y 轴对齐到该方向） */
  axis?: V3;
  seed: number;
  /** 岩板平均半径 */
  plate?: number;
  /** 岩板厚度 */
  thick?: number;
  /** 不铺岩板的区域（世界坐标球）：给熔岩心、火山口、膝核留口 */
  holes?: Array<[V3, number]>;
  /** 低于该世界高度不铺板（脚底） */
  minY?: number;
  lava?: THREE.MeshStandardMaterial;
}

function shell(ctx: BuildCtx, parent: THREE.Object3D, parentW: V3, o: ShellOpts): THREE.Mesh {
  const plate = o.plate ?? 0.72;
  const thick = o.thick ?? 0.26;
  const [rx, ry, rz] = o.r;
  const q = o.axis ? new THREE.Quaternion().setFromUnitVectors(Y_AXIS, new THREE.Vector3(...o.axis).normalize()) : new THREE.Quaternion();
  const center = new THREE.Vector3(...o.c);
  const pw = new THREE.Vector3(...parentW);

  // 熔岩内核
  const coreGeo = new THREE.IcosahedronGeometry(1, 2);
  coreGeo.scale(rx * 0.9, ry * 0.9, rz * 0.9);
  coreGeo.applyQuaternion(q);
  coreGeo.translate(center.x - pw.x, center.y - pw.y, center.z - pw.z);
  addMesh(ctx, coreGeo, o.lava ?? ctx.mats.lava, parent, 'glow');

  // 岩板：斐波那契球面分布 → 映射到椭球，按局部面积放缩板子尺寸，让缝宽大致均匀
  const p = 1.6;
  const area = 4 * PI * Math.pow((Math.pow(rx * ry, p) + Math.pow(rx * rz, p) + Math.pow(ry * rz, p)) / 3, 1 / p);
  const spacing = plate * 1.42;
  const N = Math.max(10, Math.round(area / (spacing * spacing)));
  const avgDensity = area / (4 * PI);
  const parts: Part[] = [];
  const n = new THREE.Vector3();
  const w = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * (i + 0.5)) / N;
    const rad = Math.sqrt(Math.max(0, 1 - y * y));
    const th = i * 2.399963 + o.seed * 0.37 + hash(o.seed, i, 1, 1) * 0.25;
    const dx = Math.cos(th) * rad;
    const dz = Math.sin(th) * rad;
    n.set(dx / rx, y / ry, dz / rz);
    const local = rx * ry * rz * n.length();
    n.normalize().applyQuaternion(q);
    w.set(dx * rx, y * ry, dz * rz).applyQuaternion(q).add(center);
    if (o.minY !== undefined && w.y < o.minY) continue;
    if (o.holes?.some(([hc, hr]) => w.distanceTo(new THREE.Vector3(...hc)) < hr)) continue;

    const h1 = Math.abs(hash(o.seed, i, 2, 3));
    const h2 = Math.abs(hash(o.seed, i, 4, 5));
    const size = plate * Math.sqrt(local / avgDensity) * (0.88 + h1 * 0.3);
    const t = thick * (0.7 + h2 * 0.7);
    const sides = 5 + (i % 3);
    const g = new THREE.CylinderGeometry(0.86, 1, 1, sides, 1);
    rough(g, 0.1, o.seed * 31 + i);
    g.scale(size, t, size * (0.78 + h2 * 0.4));
    const quat = new THREE.Quaternion().setFromUnitVectors(Y_AXIS, n);
    quat.multiply(new THREE.Quaternion().setFromAxisAngle(Y_AXIS, hash(o.seed, i, 6, 7) * PI));
    const pos = w.clone().addScaledVector(n, t * 0.22).sub(pw);
    parts.push({ geo: g, pos: [pos.x, pos.y, pos.z], quat });
  }
  return addMesh(ctx, merge(parts), ctx.mats.rock, parent, 'solid');
}

/** 两点之间的肢体段：椭球沿 from→to 方向 */
function limbShell(ctx: BuildCtx, parent: THREE.Object3D, parentW: V3, from: V3, to: V3, rSide: number, seed: number, extra: Partial<ShellOpts> = {}): THREE.Mesh {
  const half = new THREE.Vector3(...sub(to, from)).length() / 2;
  return shell(ctx, parent, parentW, {
    c: lerp3(from, to, 0.5),
    r: [rSide, half + rSide * 0.35, rSide * 0.95],
    axis: sub(to, from),
    seed,
    ...extra,
  });
}

/**
 * 按世界高度烘焙顶点色：下半身被脚下火焰烤得偏红亮，上半身偏深褐；
 * 再叠一层岩板之间的明暗差，让每块板读得出来。
 */
function bakeVertexColors(root: THREE.Object3D, meshes: THREE.Mesh[], totalHeight: number): void {
  root.updateMatrixWorld(true);
  const warm = new THREE.Color(1.45, 0.85, 0.6);
  const cold = new THREE.Color(0.85, 0.72, 0.68);
  const v = new THREE.Vector3();
  const c = new THREE.Color();
  for (const mesh of meshes) {
    const pos = mesh.geometry.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const t = THREE.MathUtils.smoothstep(v.y / totalHeight, 0.0, 0.7);
      const nz = 1 + hash(Math.round(v.x * 2.2), Math.round(v.y * 2.2), Math.round(v.z * 2.2), 5) * 0.28;
      c.copy(warm).lerp(cold, t).multiplyScalar(nz);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    mesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
}

// ---------------------------------------------------------------------------
// 骨架（世界坐标）
// ---------------------------------------------------------------------------

const W = {
  hips: [0, 6.4, 0] as V3,
  torso: [0, 7.4, 0] as V3,
  chest: [0, 9.8, 0.2] as V3,
  head: [0, 12.15, 1.25] as V3,
  shoulder: (s: number): V3 => [s * 3.7, 11.0, 0],
  elbow: (s: number): V3 => [s * 4.75, 7.9, 0.75],
  wrist: (s: number): V3 => [s * 4.95, 5.55, 1.45],
  leg: (s: number): V3 => [s * 1.65, 6.2, 0],
  knee: (s: number): V3 => [s * 2.35, 3.45, 0.6],
  foot: (s: number): V3 => [s * 2.75, 1.0, 0.3],
};

const ROOT0: V3 = [0, 0, 0];

// ---------------------------------------------------------------------------
// 身体各部件
// ---------------------------------------------------------------------------

function buildTorso(ctx: BuildCtx, torso: THREE.Group, chest: THREE.Group) {
  const TW = W.torso;
  const CW = W.chest;
  const heart: V3 = [0, 10.0, 2.45];
  const crater: V3 = [0, 11.05, -2.55];

  // 腹部 + 胸腔 + 驼峰上背
  shell(ctx, torso, TW, { c: [0, 8.0, 0.25], r: [2.25, 1.55, 1.75], seed: 11 });
  shell(ctx, chest, CW, { c: [0, 10.0, 0.15], r: [3.15, 2.25, 2.1], seed: 12, plate: 0.8, holes: [[heart, 1.25]] });
  shell(ctx, torso, TW, { c: [0, 11.0, -0.95], r: [2.6, 1.55, 1.6], seed: 13, plate: 0.8, holes: [[crater, 1.35]] });
  // 胸大肌两块：夹住熔岩心
  for (const s of [-1, 1]) {
    shell(ctx, chest, CW, { c: [s * 1.55, 10.35, 1.55], r: [1.45, 1.15, 0.85], seed: 20 + s, plate: 0.62, holes: [[heart, 1.2]] });
  }

  // 熔岩心：外露的八面晶体，内核炽白
  const heartGeo = new THREE.OctahedronGeometry(1, 0);
  heartGeo.scale(0.95, 1.2, 0.75);
  heartGeo.translate(...sub(heart, CW));
  const hm = addMesh(ctx, heartGeo, ctx.mats.core, chest, 'glow');
  hm.name = 'lavaHeart';
  const inner = new THREE.OctahedronGeometry(0.55, 0);
  inner.translate(heart[0] - CW[0], heart[1] - CW[1], heart[2] + 0.35 - CW[2]);
  addMesh(ctx, inner, ctx.mats.lavaHot, chest, 'glow');

  // 火山口：背部一圈晶刺围着一口熔岩
  const craterGeo = new THREE.IcosahedronGeometry(0.95, 1);
  craterGeo.scale(1, 1, 0.6);
  craterGeo.translate(...sub(crater, TW));
  addMesh(ctx, craterGeo, ctx.mats.vent, torso, 'glow').name = 'crater';
  const rim: Part[] = [];
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * PI * 2;
    const base: V3 = [crater[0] + Math.cos(a) * 1.35, crater[1] + Math.sin(a) * 1.15, crater[2] + 0.35];
    rim.push(crystal(sub(base, TW), [Math.cos(a) * 0.55, Math.sin(a) * 0.55 + 0.25, -1], 1.0 + (k % 2) * 0.5, 0.26));
  }
  // 上背脊晶簇：驼峰上一排向后上方的大晶刺
  for (let k = 0; k < 5; k++) {
    const x = (k - 2) * 0.95;
    rim.push(crystal(sub([x, 12.1 - Math.abs(x) * 0.25, -1.6], TW), [x * 0.25, 1.0, -0.75], 1.7 - Math.abs(k - 2) * 0.35, 0.36));
  }
  addMesh(ctx, merge(rim), ctx.mats.char, torso, 'solid');

  // 阶段 II：胸口向下的熔岩瀑布
  for (const s of [-1, 1]) {
    const pts: V3[] = [
      [s * 0.55, 9.2, 2.35],
      [s * 0.75, 8.4, 2.05],
      [s * 0.6, 7.6, 2.05],
      [s * 0.8, 6.8, 1.85],
    ];
    const fall = addMesh(ctx, taper(pts.map((p) => sub(p, CW)), 0.28, 0.1, 6, 10), ctx.mats.lavaHot, chest, 'glow', true);
    fall.name = 'lavaFall';
  }
}

function buildPelvis(ctx: BuildCtx, hips: THREE.Group) {
  shell(ctx, hips, W.hips, { c: [0, 6.35, 0], r: [2.35, 1.25, 1.75], seed: 30 });
}

function buildHead(ctx: BuildCtx, head: THREE.Group) {
  const H = W.head;
  // 小而硬的头颅：深陷在两肩之间、向前探
  shell(ctx, head, H, { c: [0, 12.2, 1.2], r: [1.0, 1.1, 1.05], seed: 40, plate: 0.42, thick: 0.26 });
  // 下颌：更宽更方，咬合线发光
  shell(ctx, head, H, { c: [0, 11.55, 1.6], r: [1.05, 0.55, 0.85], seed: 41, plate: 0.38, thick: 0.24 });

  // 眉骨：两块下压的厚岩板
  const brow: Part[] = [];
  const eyes: Part[] = [];
  for (const s of [-1, 1]) {
    const g = new THREE.CylinderGeometry(0.74, 1, 1, 5, 1);
    rough(g, 0.08, 42 + s);
    brow.push({ geo: g, pos: sub([s * 0.42, 12.55, 2.1], H), rot: [PI / 2 - 0.35, 0, s * 0.42], scale: [0.62, 0.32, 0.32] });
    const e = new THREE.OctahedronGeometry(1, 0);
    eyes.push({ geo: e, pos: sub([s * 0.38, 12.3, 2.18], H), rot: [0, 0, -s * 0.35], scale: [0.3, 0.075, 0.12] });
  }
  addMesh(ctx, merge(brow), ctx.mats.rock, head, 'solid');
  addMesh(ctx, merge(eyes), ctx.mats.lavaHot, head, 'glow').name = 'eyes';
  // 嘴：一道发光的横缝
  const mouth = new THREE.OctahedronGeometry(1, 0);
  mouth.scale(0.55, 0.07, 0.15);
  mouth.translate(...sub([0, 11.7, 2.42], H));
  addMesh(ctx, mouth, ctx.mats.lavaHot, head, 'glow');

  // 头顶晶冠（阶段 I 岩晶）+ 阶段 II 火冠
  const crown: Part[] = [];
  const flames: Part[] = [];
  for (let k = 0; k < 5; k++) {
    const x = (k - 2) * 0.38;
    const base = sub([x, 12.95, 0.95 - Math.abs(x) * 0.2], H);
    crown.push(crystal(base, [x * 0.5, 1, -0.35], 0.65 - Math.abs(k - 2) * 0.12, 0.17));
    flames.push({ geo: taper([base, [base[0] * 1.2, base[1] + 0.9, base[2] - 0.3], [base[0] * 1.1, base[1] + 1.7 - Math.abs(k - 2) * 0.3, base[2] - 0.8]], 0.22, 0, 6, 6) });
  }
  addMesh(ctx, merge(crown), ctx.mats.char, head, 'solid');
  addMesh(ctx, merge(flames), ctx.mats.lavaHot, head, 'glow', true).name = 'flameCrest';
}

function buildArm(ctx: BuildCtx, torso: THREE.Group, side: -1 | 1) {
  const n = side < 0 ? 'L' : 'R';
  const SW = W.shoulder(side);
  const EW = W.elbow(side);
  const WW = W.wrist(side);
  const shoulder = group(torso, `shoulder${n}`, SW, W.torso);
  const elbow = group(shoulder, `elbow${n}`, EW, SW);

  // 巨肩：两块叠压的大岩团，顶部生出晶簇
  shell(ctx, shoulder, SW, { c: [side * 3.85, 11.45, 0.0], r: [2.0, 1.75, 1.95], seed: 50 + side, plate: 0.85, thick: 0.42 });
  shell(ctx, shoulder, SW, { c: [side * 4.55, 10.35, 0.15], r: [1.35, 1.25, 1.45], seed: 52 + side, plate: 0.7 });
  const spikes: Part[] = [
    crystal(sub([side * 3.6, 12.85, -0.2], SW), [side * 0.25, 1, -0.2], 1.85, 0.45),
    crystal(sub([side * 4.5, 12.55, 0.35], SW), [side * 0.65, 1, 0.1], 1.4, 0.38),
    crystal(sub([side * 4.2, 12.5, -0.95], SW), [side * 0.4, 0.9, -0.6], 1.25, 0.34),
    crystal(sub([side * 5.45, 11.6, -0.1], SW), [side * 1, 0.55, -0.1], 1.0, 0.3),
  ];
  addMesh(ctx, merge(spikes), ctx.mats.char, shoulder, 'solid');

  // 上臂
  limbShell(ctx, shoulder, SW, [side * 4.1, 10.4, 0.1], EW, 1.2, 54 + side);
  // 前臂：比上臂更粗（参考图的"大前臂"），外侧生晶刺
  limbShell(ctx, elbow, EW, EW, WW, 1.45, 56 + side, { plate: 0.68 });
  addMesh(
    ctx,
    merge([
      crystal(sub([side * 5.9, 7.2, 0.6], EW), [side * 1, 0.25, -0.3], 1.1, 0.3),
      crystal(sub([side * 6.0, 6.3, 1.0], EW), [side * 1, -0.05, -0.2], 0.9, 0.26),
      crystal(sub([side * 4.9, 8.2, -0.5], EW), [side * 0.3, 0.4, -1], 1.0, 0.3),
    ]),
    ctx.mats.char,
    elbow,
    'solid',
  );
  // 巨拳：拳体 + 四个指节岩块
  const fist: V3 = [side * 5.0, 4.35, 1.65];
  shell(ctx, elbow, EW, { c: fist, r: [1.4, 1.3, 1.4], seed: 58 + side, plate: 0.6, lava: ctx.mats.lavaHot });
  for (let k = 0; k < 4; k++) {
    shell(ctx, elbow, EW, {
      c: [fist[0] - side * 0.15 + (k - 1.5) * 0.12 * side, 3.65 + k * 0.42, fist[2] + 1.05],
      r: [0.62, 0.32, 0.5],
      seed: 60 + k + side * 10,
      plate: 0.36,
      thick: 0.24,
    });
  }
  return { shoulder, elbow };
}

function buildLeg(ctx: BuildCtx, hips: THREE.Group, side: -1 | 1) {
  const n = side < 0 ? 'L' : 'R';
  const LW = W.leg(side);
  const KW = W.knee(side);
  const FW = W.foot(side);
  const leg = group(hips, `leg${n}`, LW, W.hips);
  const knee = group(leg, `knee${n}`, KW, LW);
  const foot = group(knee, `foot${n}`, FW, KW);
  const kneeCore: V3 = [KW[0], KW[1], KW[2] + 1.55];

  limbShell(ctx, leg, LW, LW, KW, 1.5, 70 + side, { holes: [[kneeCore, 0.95]] });
  limbShell(ctx, knee, KW, KW, FW, 1.55, 72 + side, { holes: [[kneeCore, 0.95]] });
  const kc = new THREE.IcosahedronGeometry(0.58, 1);
  kc.translate(...sub(kneeCore, KW));
  addMesh(ctx, kc, ctx.mats.vent, knee, 'glow').name = `kneeCore${n}`;
  // 膝前晶刺 + 小腿外侧晶刺
  addMesh(
    ctx,
    merge([
      crystal(sub([KW[0] + side * 1.2, KW[1] + 0.3, KW[2] + 0.4], KW), [side * 1, 0.6, 0.2], 1.0, 0.3),
      crystal(sub([KW[0] + side * 1.45, 2.2, 0.4], KW), [side * 1, 0.3, -0.2], 0.9, 0.28),
    ]),
    ctx.mats.char,
    knee,
    'solid',
  );

  // 脚：宽厚的岩足 + 平底 + 三块趾岩
  shell(ctx, foot, FW, { c: [FW[0] + side * 0.1, 0.78, FW[2] + 0.55], r: [1.55, 0.62, 1.95], seed: 74 + side, minY: 0.3, plate: 0.6 });
  const sole = new THREE.CylinderGeometry(1, 1.04, 0.32, 9, 1);
  rough(sole, 0.04, 76 + side);
  sole.scale(1.6, 1, 2.0);
  sole.translate(FW[0] + side * 0.1 - FW[0], 0.17 - FW[1], 0.55);
  addMesh(ctx, sole, ctx.mats.rock, foot, 'solid');
  for (let k = 0; k < 3; k++) {
    shell(ctx, foot, FW, { c: [FW[0] + (k - 1) * 0.75, 0.55, FW[2] + 2.3], r: [0.5, 0.42, 0.6], seed: 80 + k + side * 10, plate: 0.34, thick: 0.22, minY: 0.18 });
  }
  return { leg, knee, foot };
}

/** 阶段 II：绕身悬浮的火山灰碎块 */
function buildSlag(ctx: BuildCtx, torso: THREE.Group) {
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * PI * 2 + 0.4;
    const r = 6.6 + (i % 2) * 0.8;
    const g = rough(new THREE.IcosahedronGeometry(0.35 + (i % 3) * 0.14, 0), 0.1, 90 + i);
    g.translate(Math.sin(a) * r, 9.0 + Math.sin(i * 2.3) * 1.6 - W.torso[1], Math.cos(a) * r);
    addMesh(ctx, g, ctx.mats.ash, torso, 'glow', true).name = 'slag';
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function worldPos(o: THREE.Object3D): [number, number, number] {
  o.updateWorldMatrix(true, false);
  if (o instanceof THREE.Mesh) {
    o.geometry.computeBoundingSphere();
    const c = o.geometry.boundingSphere!.center.clone().applyMatrix4(o.matrixWorld);
    return [Number(c.x.toFixed(3)), Number(c.y.toFixed(3)), Number(c.z.toFixed(3))];
  }
  const v = new THREE.Vector3();
  o.getWorldPosition(v);
  return [Number(v.x.toFixed(3)), Number(v.y.toFixed(3)), Number(v.z.toFixed(3))];
}

export function createSurtrRig(): SurtrBuild {
  const mats: SurtrMaterials = {
    rock: makeRockMaterial(),
    char: makeCharMaterial(),
    lava: makeLavaMaterial(0xff7a14, 3.4),
    lavaHot: makeLavaMaterial(0xffb02a, 2.8),
    core: Object.assign(makeLavaMaterial(0xff5a0c, 3.0), { roughness: 0.3, metalness: 0.1 }),
    vent: makeLavaMaterial(0xffa040, 2.2),
    ash: new THREE.MeshStandardMaterial({
      color: 0x352a24,
      roughness: 0.72,
      metalness: 0.15,
      emissive: 0xff4a10,
      emissiveIntensity: 1.0,
      flatShading: true,
    }),
    ember: makeLavaMaterial(0xff5a14, 2.2),
  };
  const ctx: BuildCtx = { solid: [], glow: [], p1: [], p2: [], mats };

  const root = new THREE.Group();
  root.name = 'Surtr';
  const rig = group(root, 'rig', ROOT0, ROOT0);
  const hips = group(rig, 'hips', W.hips, ROOT0);
  const torso = group(hips, 'torso', W.torso, W.hips);
  const chest = group(torso, 'chest', W.chest, W.torso);
  const head = group(torso, 'head', W.head, W.torso);

  buildPelvis(ctx, hips);
  buildTorso(ctx, torso, chest);
  buildHead(ctx, head);
  buildSlag(ctx, torso);
  const armL = buildArm(ctx, torso, -1);
  const armR = buildArm(ctx, torso, 1);
  const legL = buildLeg(ctx, hips, -1);
  const legR = buildLeg(ctx, hips, 1);

  const p2set = new Set<THREE.Object3D>(ctx.p2);
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  const measure = () => {
    root.updateMatrixWorld(true);
    box.makeEmpty();
    for (const m of ctx.solid.concat(ctx.glow)) {
      if (p2set.has(m)) continue;
      const posAttr = m.geometry.getAttribute('position');
      for (let i = 0; i < posAttr.count; i++) box.expandByPoint(v.fromBufferAttribute(posAttr, i).applyMatrix4(m.matrixWorld));
    }
  };
  measure();
  // 岩板会略微探出脚底：整体抬到最低点正好贴地
  rig.position.y = -box.min.y;
  measure();
  bakeVertexColors(root, ctx.solid, Math.max(1, box.max.y));

  const find = (name: string): THREE.Object3D => root.getObjectByName(name) ?? root;
  const weakPoints: SurtrWeakPoint[] = [
    { key: 'core', label: '熔岩心', pos: worldPos(find('lavaHeart')), r: 1.2, css: '#ff7a2f' },
    { key: 'back', label: '火山口', pos: worldPos(find('crater')), r: 1.1, css: '#ffe0a8' },
    { key: 'kneeL', label: '左膝熔核', pos: worldPos(find('kneeCoreL')), r: 0.62, css: '#ffb347' },
    { key: 'kneeR', label: '右膝熔核', pos: worldPos(find('kneeCoreR')), r: 0.62, css: '#ffb347' },
  ];

  const rigOut: SurtrRig = {
    root,
    rig,
    hips,
    torso,
    chest,
    head,
    shoulderL: armL.shoulder,
    elbowL: armL.elbow,
    shoulderR: armR.shoulder,
    elbowR: armR.elbow,
    legL: legL.leg,
    kneeL: legL.knee,
    footL: legL.foot,
    legR: legR.leg,
    kneeR: legR.knee,
    footR: legR.foot,
  };
  const joints: Record<string, [number, number, number]> = {};
  for (const [k, o] of Object.entries(rigOut)) if (k !== 'root' && k !== 'rig') joints[k] = worldPos(o);

  const flameCrest: THREE.Object3D[] = [];
  const lavaFalls: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (o.name === 'flameCrest') flameCrest.push(o);
    if (o.name === 'lavaFall') lavaFalls.push(o);
  });

  return {
    rig: rigOut,
    solidMeshes: ctx.solid,
    glowMeshes: ctx.glow,
    phase1Meshes: ctx.p1,
    phase2Meshes: ctx.p2,
    materials: mats,
    meta: {
      height: Number(box.max.y.toFixed(3)),
      width: Number((box.max.x - box.min.x).toFixed(3)),
      weakPoints,
      joints,
      eyes: root.getObjectByName('eyes') ?? null,
      crater: root.getObjectByName('crater') ?? null,
      flameCrest,
      lavaFalls,
    },
  };
}
