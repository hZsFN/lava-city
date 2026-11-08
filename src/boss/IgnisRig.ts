import * as THREE from 'three/webgpu';

/**
 * 伊格纳斯 · 「行走的地脉熔炉」
 *
 * 它不是生物，是地心城遗留下来的一座自走式冶炼炉。
 * 八角窑身是躯干，胸口的炉门后封着一颗冷蓝色地脉结晶（阶段 I 弱点），
 * 背部是被封死的冷却阀门（阶段 II 崩开，露出白金色高温排气口），
 * 头是一只前倾的坩埚（发射口 = 坩埚倾倒口），
 * 左臂是砧锤，右臂是钳夹，双腿是带活塞关节的炉脚支柱。
 *
 * 造型语言（威慑感的来源）：
 * - 头被高耸的肩甲与背后的护颈石板"夹"在中间，显得低头逼视；
 * - 坩埚两侧耳轴伸出前弯的牛角，眉骨铁板压住一对倒八字的炽热眼缝；
 * - 炉门做成獠牙咬合的"兽口"，冷蓝结晶从齿缝间透出；
 * - 肩甲、膝、肘、足跟都有向外的尖刺，剪影边缘不再是平直线；
 * - 岩石按顶点做确定性的凿痕扰动，铁件保持规整，石/铁两种质感对比。
 *
 * 坐标：脚底 y=0，面朝 +Z，+X 为其右手边。阶段 I 躯体全高约 9.1 m（角尖与烟道顶约 9.3 m）。
 */

export interface IgnisRig {
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

export interface IgnisMaterials {
  /** 玄武岩窑体 */
  stone: THREE.MeshStandardMaterial;
  /** 锻铁：箍带、铆钉、活塞、眉甲、爪 */
  iron: THREE.MeshStandardMaterial;
  /** 余烬橙：裂缝、关节、炉底、矿渣 */
  ember: THREE.MeshStandardMaterial;
  /** 炽白橙：眼缝、锤面、钳尖、阶段 II 火冠与上蔓裂缝 */
  emberHot: THREE.MeshStandardMaterial;
  /** 冷蓝：阶段 I 弱点（法术） */
  core: THREE.MeshStandardMaterial;
  /** 白金：阶段 II 弱点（物理） */
  vent: THREE.MeshStandardMaterial;
  /** 半熔矿渣：暗色底 + 余烬自发光，刻面仍受光，阶段 II 悬浮碎块用 */
  slag: THREE.MeshStandardMaterial;
}

export interface IgnisBuild {
  rig: IgnisRig;
  /** 所有"实体"网格（岩石 + 锻铁）：阶段 II 换材质时会整体替换材质 */
  stoneMeshes: THREE.Mesh[];
  /** 所有"自发光"网格：裂缝、核心、关节，保持发光 */
  glowMeshes: THREE.Mesh[];
  /** 阶段 II 才显示、阶段 I 隐藏的网格（比如背部裂缝、膝部核心） */
  phase2Meshes: THREE.Mesh[];
  /** 阶段 I 才显示、阶段 II 应隐藏的网格（背部阀门的封条锁扣） */
  phase1Meshes: THREE.Mesh[];
  materials: IgnisMaterials;
}

type V3 = THREE.Vector3Tuple;
const PI = Math.PI;
/** 八角体相对 CylinderGeometry / LatheGeometry 默认朝向的旋转：让平面朝正前方 */
const OCT = PI / 8;

// ---------------------------------------------------------------------------
// 材质
// ---------------------------------------------------------------------------

/** 玄武岩窑体：几乎不反光，极弱的余烬自发光保证无环境光时不至于一团死黑 */
function makeStoneMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x4a3d37,
    roughness: 0.93,
    metalness: 0.05,
    flatShading: true,
    vertexColors: true,
    emissive: 0x2a0a04,
    emissiveIntensity: 0.2,
  });
}

/** 锻铁：偏金属、半粗糙，刻面在主光下会出硬高光，和哑光岩石拉开质感 */
function makeIronMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x34302d,
    roughness: 0.46,
    metalness: 0.78,
    flatShading: true,
    vertexColors: true,
    emissive: 0x1c0703,
    emissiveIntensity: 0.25,
  });
}

function makeGlowMaterial(hex: number, intensity: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x000000,
    roughness: 1,
    metalness: 0,
    emissive: hex,
    emissiveIntensity: intensity,
    flatShading: true,
    side: THREE.DoubleSide,
  });
}

// ---------------------------------------------------------------------------
// 构建上下文与小工具
// ---------------------------------------------------------------------------

interface Part {
  geo: THREE.BufferGeometry;
  pos?: V3;
  rot?: V3;
  quat?: THREE.Quaternion;
  scale?: V3;
}

interface BuildCtx {
  stone: THREE.Mesh[];
  glow: THREE.Mesh[];
  p2: THREE.Mesh[];
  p1: THREE.Mesh[];
  mats: IgnisMaterials;
  /** 铆钉按父节点收集，最后每个父节点合并成一个网格 */
  rivets: Map<THREE.Object3D, Part[]>;
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** 整数哈希 → [-1, 1]，用于所有确定性的"随机"（同一输入每次构建结果一致） */
function hash(a: number, b: number, c: number, d: number): number {
  let h = (a * 374761393 + b * 668265263 + c * 1440662683 + d * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

/**
 * 凿痕扰动：按量化后的顶点坐标做确定性位移。
 * 重合顶点（接缝、盖面与侧面的公共边）得到相同位移，因此不会开裂。
 */
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

/** 把若干零件烘焙进一个几何体（减少网格数量；flatShading 不需要共享法线） */
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

function yxz(x: number, y: number, z = 0): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'YXZ'));
}

function placeMesh(
  mesh: THREE.Mesh,
  parent: THREE.Object3D,
  pos: V3,
  rot: V3 = [0, 0, 0],
): THREE.Mesh {
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.rotation.set(rot[0], rot[1], rot[2]);
  parent.add(mesh);
  return mesh;
}

function solid(
  ctx: BuildCtx,
  geo: THREE.BufferGeometry,
  parent: THREE.Object3D,
  pos: V3 = [0, 0, 0],
  rot?: V3,
  mat: THREE.MeshStandardMaterial = ctx.mats.stone,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  ctx.stone.push(m);
  return placeMesh(m, parent, pos, rot);
}

function iron(ctx: BuildCtx, geo: THREE.BufferGeometry, parent: THREE.Object3D, pos?: V3, rot?: V3): THREE.Mesh {
  return solid(ctx, geo, parent, pos, rot, ctx.mats.iron);
}

function glow(
  ctx: BuildCtx,
  geo: THREE.BufferGeometry,
  mat: THREE.MeshStandardMaterial,
  parent: THREE.Object3D,
  pos: V3 = [0, 0, 0],
  rot?: V3,
  phase2 = false,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = false;
  m.receiveShadow = false;
  ctx.glow.push(m);
  if (phase2) {
    m.visible = false;
    ctx.p2.push(m);
  }
  return placeMesh(m, parent, pos, rot);
}

function rivet(ctx: BuildCtx, parent: THREE.Object3D, pos: V3, r = 0.065): void {
  let list = ctx.rivets.get(parent);
  if (!list) {
    list = [];
    ctx.rivets.set(parent, list);
  }
  list.push({ geo: new THREE.IcosahedronGeometry(r, 0), pos });
}

interface LimbOpts {
  radial?: number;
  mat?: THREE.MeshStandardMaterial;
  roughness?: number;
  /** 箍带位置：沿柱身的比例，-0.5 = 末端，+0.5 = 起端 */
  bands?: number[];
}

/** 在父节点局部坐标系里，从 from 到 to 架一根锥形柱（用于四肢），可选铁箍 */
function limb(
  ctx: BuildCtx,
  parent: THREE.Object3D,
  from: V3,
  to: V3,
  rTop: number,
  rBottom: number,
  opts: LimbOpts = {},
): THREE.Mesh {
  const { radial = 8, mat = ctx.mats.stone, roughness = mat === ctx.mats.stone ? 0.04 : 0, bands = [] } = opts;
  const a = new THREE.Vector3(...from);
  const b = new THREE.Vector3(...to);
  const dir = b.clone().sub(a);
  const len = dir.length();
  const geo = new THREE.CylinderGeometry(rTop, rBottom, len, radial, 2);
  const m = solid(ctx, roughness > 0 ? rough(geo, roughness, Math.round(len * 100)) : geo, parent, [0, 0, 0], undefined, mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(Y_AXIS, dir.normalize().negate());
  for (const f of bands) {
    const r = THREE.MathUtils.lerp(rBottom, rTop, f + 0.5) + 0.06;
    iron(ctx, new THREE.CylinderGeometry(r, r, 0.2, radial, 1), m, [0, f * len, 0]);
  }
  return m;
}

function group(parent: THREE.Object3D, name: string, pos: V3): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  g.position.set(pos[0], pos[1], pos[2]);
  parent.add(g);
  return g;
}

function lathe(points: Array<[number, number]>, segments: number): THREE.LatheGeometry {
  return new THREE.LatheGeometry(
    points.map(([x, y]) => new THREE.Vector2(x, y)),
    segments,
  );
}

/** 斜面箍带：底半径 rb、顶半径 rt、高 h，厚 t（用于贴合锥形表面） */
function band(rb: number, rt: number, h: number, t = 0.1, segs = 8): THREE.LatheGeometry {
  return lathe(
    [
      [rb - 0.03, 0],
      [rb + t, 0.025],
      [rt + t, h - 0.025],
      [rt - 0.03, h],
    ],
    segs,
  );
}

/**
 * 沿曲线的锥形管：用于角、尖刺、爪、火舌。
 * 先生成单位半径 TubeGeometry，再把每一圈按 r0→r1 缩放；r1=0 时尖端闭合。
 */
function taper(points: V3[], r0: number, r1: number, radial = 6, segs = 10): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  const geo = new THREE.TubeGeometry(curve, segs, 1, radial, false);
  const pos = geo.getAttribute('position');
  const c = new THREE.Vector3();
  const v = new THREE.Vector3();
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    curve.getPointAt(t, c);
    const r = THREE.MathUtils.lerp(r0, r1, Math.pow(t, 0.85));
    for (let j = 0; j <= radial; j++) {
      const k = i * (radial + 1) + j;
      v.fromBufferAttribute(pos, k).sub(c).multiplyScalar(r).add(c);
      pos.setXYZ(k, v.x, v.y, v.z);
    }
  }
  geo.computeVertexNormals();
  return geo;
}

function add(a: V3, b: V3, k = 1): V3 {
  return [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
}

// ---------------------------------------------------------------------------
// 窑身轮廓与表面裂缝
// ---------------------------------------------------------------------------

/** 窑身 Lathe 轮廓（torso 局部坐标，[半径, 高]），半径为八角棱线处的半径 */
const KILN: Array<[number, number]> = [
  [0.6, 0.0],
  [1.5, 0.0],
  [1.86, 0.3],
  [2.02, 0.8],
  [2.08, 1.3],
  [2.0, 1.8],
  [1.82, 2.25],
  [1.62, 2.65],
  [1.45, 2.95],
  [0.5, 3.1],
];

function kilnR(y: number): number {
  for (let i = 1; i < KILN.length; i++) {
    const [r0, y0] = KILN[i - 1]!;
    const [r1, y1] = KILN[i]!;
    if (y1 === y0) continue;
    if (y <= y1) return THREE.MathUtils.lerp(r0, r1, THREE.MathUtils.clamp((y - y0) / (y1 - y0), 0, 1));
  }
  return KILN[KILN.length - 1]![0];
}

/** 八角窑身在方位角 ang（x=sin, z=cos）处的表面点 */
function kilnPoint(ang: number, y: number, lift = 0): THREE.Vector3 {
  const e = ang - Math.round(ang / (PI / 4)) * (PI / 4);
  const d = (kilnR(y) * Math.cos(OCT)) / Math.cos(e) + lift;
  return new THREE.Vector3(Math.sin(ang) * d, y, Math.cos(ang) * d);
}

/** 两点之间一段贴面的裂缝块：局部 Y 沿裂缝方向，局部 Z 朝外 */
function crackSegment(a: THREE.Vector3, b: THREE.Vector3, w: number, depth = 0.16): Part {
  const dir = b.clone().sub(a);
  const len = dir.length();
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const yAxis = dir.normalize();
  const out = new THREE.Vector3(mid.x, 0, mid.z).normalize();
  const xAxis = new THREE.Vector3().crossVectors(yAxis, out).normalize();
  const zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis);
  const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis));
  return { geo: new THREE.BoxGeometry(w, len + w * 0.7, depth), pos: [mid.x, mid.y, mid.z], quat };
}

/** 一条自下而上蜿蜒、逐渐变细的裂缝，中途分叉一次 */
function crack(out: Part[], seed: number, ang0: number, y0: number, y1: number, w0: number, bias = 0, branch = true): void {
  const steps = Math.max(3, Math.round((y1 - y0) / 0.19));
  let a = ang0;
  let prev = kilnPoint(a, y0);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    a += bias + hash(seed, i, 1, 7) * 0.12;
    const y = y0 + (y1 - y0) * t + hash(seed, i, 2, 9) * 0.05;
    const cur = kilnPoint(a, y);
    out.push(crackSegment(prev, cur, w0 * (1 - 0.65 * t)));
    if (branch && i === Math.floor(steps * 0.45)) {
      crack(out, seed + 101, a, y, y + (y1 - y0) * 0.4, w0 * 0.6, hash(seed, 3, 3, 3) > 0 ? 0.09 : -0.09, false);
    }
    prev = cur;
  }
}

/**
 * 按世界高度给所有实体顶点烘焙颜色：
 * 脚部偏暖（被熔岩照着），上半身偏冷灰黑；再叠一层细碎明暗，让岩面有"凿过"的斑驳感。
 * 网格可在 userData.tint 放一个 Color 做整体偏色（獠牙、牛角偏骨白）。
 */
function bakeVertexColors(root: THREE.Object3D, meshes: THREE.Mesh[], totalHeight: number): void {
  root.updateMatrixWorld(true);
  const warm = new THREE.Color(1.25, 0.88, 0.72);
  const cold = new THREE.Color(0.74, 0.72, 0.74);
  const v = new THREE.Vector3();
  const c = new THREE.Color();
  for (const mesh of meshes) {
    const tint = mesh.userData.tint as THREE.Color | undefined;
    const pos = mesh.geometry.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const t = THREE.MathUtils.smoothstep(v.y / totalHeight, 0.02, 0.72);
      const n = 1 + hash(Math.round(v.x * 9), Math.round(v.y * 9), Math.round(v.z * 9), 5) * 0.12;
      c.copy(warm).lerp(cold, t).multiplyScalar(n);
      if (tint) c.multiply(tint);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    mesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
}

const BONE = new THREE.Color(1.75, 1.55, 1.35);

// ---------------------------------------------------------------------------
// 身体各部件
// ---------------------------------------------------------------------------

/** 骨盆：八角炉底 + 铁腰带 + 四片垂甲 + 炉底火线与灰栅 */
function buildPelvis(ctx: BuildCtx, hips: THREE.Group) {
  solid(ctx, rough(new THREE.CylinderGeometry(1.75, 1.35, 1.1, 8, 2), 0.05, 1), hips, [0, 0.2, 0], [0, OCT, 0]);
  iron(ctx, band(1.62, 1.71, 0.26), hips, [0, 0.4, 0], [0, OCT, 0]);
  for (let k = 0; k < 8; k++) {
    const a = OCT + (k * PI) / 4;
    rivet(ctx, hips, [Math.sin(a) * 1.8, 0.53, Math.cos(a) * 1.8], 0.075);
  }

  const tassets: Part[] = [];
  for (const a of [0, PI / 2, -PI / 2, PI]) {
    const r = a === 0 || a === PI ? 1.5 : 1.72;
    const q = yxz(-0.22, a);
    tassets.push({ geo: rough(new THREE.BoxGeometry(1.05, 0.95, 0.12, 2, 2, 1), 0.02, 2), pos: [Math.sin(a) * r, -0.2, Math.cos(a) * r], quat: q });
    for (const x of [-0.36, 0.36]) {
      const off = new THREE.Vector3(x, 0.28, 0.08).applyQuaternion(q);
      tassets.push({ geo: new THREE.IcosahedronGeometry(0.06, 0), pos: [Math.sin(a) * r + off.x, -0.2 + off.y, Math.cos(a) * r + off.z] });
    }
  }
  iron(ctx, merge(tassets), hips);

  glow(ctx, band(1.33, 1.37, 0.12, 0.06), ctx.mats.ember, hips, [0, -0.33, 0], [0, OCT, 0]);
  glow(ctx, new THREE.CylinderGeometry(1.2, 1.2, 0.06, 8), ctx.mats.ember, hips, [0, -0.37, 0], [0, OCT, 0]);
}

/** 腿：炉脚支柱。髋 → 膝（活塞关节）→ 胫 → 足爪。膝部核心为阶段 II 弱点。 */
function buildLeg(ctx: BuildCtx, hips: THREE.Group, side: -1 | 1) {
  const sideName = side < 0 ? 'L' : 'R';
  const leg = group(hips, `leg${sideName}`, [side * 0.95, 0, 0]);
  const knee = group(leg, `knee${sideName}`, [0, -1.4, 0.2]);
  const foot = group(knee, `foot${sideName}`, [0, -2.2, -0.2]);

  // 髋球 + 大腿 + 腿甲
  solid(ctx, rough(new THREE.DodecahedronGeometry(0.6, 0), 0.04, 20 + side), leg);
  limb(ctx, leg, [0, 0, 0], [0, -1.4, 0.2], 0.62, 0.52, { bands: [0.32] });
  iron(
    ctx,
    merge([
      { geo: new THREE.BoxGeometry(0.82, 0.9, 0.14, 2, 2, 1), pos: [0, -0.72, 0.7], rot: [-0.14, 0, 0] },
      { geo: new THREE.BoxGeometry(0.14, 0.9, 0.85), pos: [side * 0.68, -0.68, 0.1], rot: [0, 0, side * 0.1] },
    ]),
    leg,
  );
  for (const x of [-0.27, 0.27]) for (const y of [-0.4, -1.02]) rivet(ctx, leg, [x, y, 0.79 + (y + 0.4) * 0.14]);

  // 膝：横置活塞缸 + 铁端盖 + 外侧倒刺
  const kneeCyl = new THREE.CylinderGeometry(0.62, 0.62, 1.15, 10, 1);
  kneeCyl.rotateZ(PI / 2);
  solid(ctx, rough(kneeCyl, 0.02, 30 + side), knee, [0, 0, 0.1]);
  const cap = (x: number): Part => ({ geo: new THREE.CylinderGeometry(0.68, 0.68, 0.14, 10), pos: [x, 0, 0.1], rot: [0, 0, PI / 2] });
  iron(ctx, merge([cap(-0.62), cap(0.62)]), knee);
  solid(ctx, taper([[side * 0.62, 0.05, 0.1], [side * 1.0, 0.28, 0.0], [side * 1.32, 0.62, -0.22]], 0.2, 0), knee);

  // 膝部核心（阶段 II 暴露，白金）
  glow(ctx, new THREE.IcosahedronGeometry(0.44, 1), ctx.mats.vent, knee, [0, 0, 0.5], undefined, true);

  // 胫：向下加粗的支柱 + 胫甲（带中脊）+ 后侧液压杆
  limb(ctx, knee, [0, 0, 0], [0, -2.2, -0.2], 0.46, 0.64, { bands: [0.3] });
  iron(
    ctx,
    merge([
      { geo: new THREE.BoxGeometry(0.84, 1.6, 0.2, 2, 3, 1), pos: [0, -1.2, 0.62], rot: [-0.08, 0, 0] },
      { geo: new THREE.BoxGeometry(0.16, 1.45, 0.14), pos: [0, -1.2, 0.74], rot: [-0.08, 0, 0] },
    ]),
    knee,
  );
  for (const x of [-0.3, 0.3]) for (const y of [-0.55, -1.85]) rivet(ctx, knee, [x, y, 0.75 + (y + 1.2) * 0.08]);
  limb(ctx, knee, [0, -0.3, -0.62], [0, -1.85, -0.88], 0.09, 0.09, { mat: ctx.mats.iron, radial: 6 });
  limb(ctx, knee, [0, -1.15, -0.76], [0, -1.95, -0.88], 0.15, 0.15, { mat: ctx.mats.iron, radial: 6 });

  // 足：踝轴 + 宽底座 + 趾盖 + 三根趾爪 + 足跟刺
  iron(ctx, new THREE.CylinderGeometry(0.42, 0.42, 1.0, 8), foot, [0, 0.55, 0], [0, 0, PI / 2]);
  solid(ctx, rough(new THREE.BoxGeometry(1.5, 0.5, 1.95, 2, 1, 2), 0.04, 40 + side), foot, [0, 0.25, 0.2]);
  solid(ctx, rough(new THREE.BoxGeometry(1.25, 0.3, 0.85, 2, 1, 1), 0.03, 50 + side), foot, [0, 0.6, 0.72], [0.25, 0, 0]);
  const claws: Part[] = [-0.48, 0, 0.48].map((x) => ({
    geo: taper([[x, 0.32, 0.95], [x * 1.12, 0.38, 1.45], [x * 1.22, 0.2, 1.85], [x * 1.28, 0.01, 2.12]], 0.21, 0.02),
  }));
  claws.push({ geo: taper([[0, 0.38, -0.65], [0, 0.24, -1.05], [0, 0.03, -1.38]], 0.22, 0.02) });
  iron(ctx, merge(claws), foot);

  return { leg, knee, foot };
}

/** 窑身：八角 Lathe 躯干 + 两道铁箍 + 下部余烬裂缝（阶段 II 裂缝蔓延到肩下） + 背脊尖刺 */
function buildKiln(ctx: BuildCtx, torso: THREE.Group) {
  solid(ctx, rough(lathe(KILN, 8), 0.035, 2), torso, [0, 0, 0], [0, OCT, 0]);

  for (const [y0, h] of [[0.08, 0.28], [2.3, 0.24]] as const) {
    iron(ctx, band(kilnR(y0), kilnR(y0 + h), h), torso, [0, y0, 0], [0, OCT, 0]);
    for (let k = 0; k < 8; k++) {
      const a = OCT + (k * PI) / 4;
      const r = kilnR(y0 + h / 2) + 0.12;
      rivet(ctx, torso, [Math.sin(a) * r, y0 + h / 2, Math.cos(a) * r], 0.07);
    }
  }

  const cracks: Part[] = [];
  const lows: Array<[number, number]> = [
    [0.95, 1.35],
    [-0.95, 1.2],
    [1.8, 1.55],
    [-1.8, 1.45],
    [2.55, 1.1],
    [-2.55, 1.3],
  ];
  lows.forEach(([a, y1], i) => crack(cracks, 10 + i, a, 0.4, y1, 0.11));
  glow(ctx, merge(cracks), ctx.mats.ember, torso);

  const highs: Part[] = [];
  const ups: Array<[number, number]> = [
    [0.8, 2.25],
    [-0.8, 2.2],
    [1.6, 2.3],
    [-1.6, 2.25],
    [2.35, 2.15],
    [-2.35, 2.2],
    [2.95, 1.6],
  ];
  ups.forEach(([a, y1], i) => crack(highs, 40 + i, a, 1.2, y1, 0.1));
  glow(ctx, merge(highs), ctx.mats.emberHot, torso, undefined, undefined, true);

  const spines: Part[] = [0.45, 1.0].map((y, i) => {
    const d = kilnR(y) * Math.cos(OCT) - 0.1;
    return { geo: taper([[0, y, -d], [0, y - 0.1, -d - 0.45], [0, y - 0.32, -d - 0.85 + i * 0.1]], 0.24, 0) };
  });
  solid(ctx, merge(spines), torso);
}

/** 胸口炉门：深框 + 眉檐 + 铁内框与炉栅 + 上下獠牙 + 冷蓝地脉结晶 */
function buildChest(ctx: BuildCtx, chest: THREE.Group) {
  const fz = 2.03;
  const d = 1.05;
  solid(
    ctx,
    merge([
      { geo: rough(new THREE.BoxGeometry(2.75, 0.36, d, 4, 1, 2), 0.045, 11), pos: [0, 1.15, fz] },
      { geo: rough(new THREE.BoxGeometry(2.75, 0.36, d, 4, 1, 2), 0.045, 12), pos: [0, -1.15, fz] },
      { geo: rough(new THREE.BoxGeometry(0.36, 2.0, d, 1, 4, 2), 0.045, 13), pos: [-1.18, 0, fz] },
      { geo: rough(new THREE.BoxGeometry(0.36, 2.0, d, 1, 4, 2), 0.045, 14), pos: [1.18, 0, fz] },
      // 颊板：门框外缘斜着收回窑身，炉门不再像一只钉上去的箱子
      { geo: rough(new THREE.BoxGeometry(0.22, 2.6, 1.65, 1, 3, 3), 0.04, 16), pos: [-1.52, 0, 1.72], rot: [0, 0.25, 0] },
      { geo: rough(new THREE.BoxGeometry(0.22, 2.6, 1.65, 1, 3, 3), 0.04, 17), pos: [1.52, 0, 1.72], rot: [0, -0.25, 0] },
      { geo: rough(new THREE.BoxGeometry(3.0, 0.22, 1.1, 3, 1, 2), 0.04, 18), pos: [0, -1.5, 1.9], rot: [-0.3, 0, 0] },
    ]),
    chest,
  );
  // 眉檐：前缘下压，让结晶上方始终压着一道阴影；正中一块下垂的楔石
  solid(
    ctx,
    merge([
      { geo: rough(new THREE.BoxGeometry(3.2, 0.42, 0.95, 4, 1, 2), 0.05, 15), pos: [0, 1.5, 1.98], rot: [0.5, 0, 0] },
      { geo: rough(new THREE.ConeGeometry(0.34, 0.75, 4), 0.03, 19), pos: [0, 1.18, 2.62], rot: [PI, PI / 4, 0], scale: [1, 1, 0.6] },
    ]),
    chest,
  );

  iron(
    ctx,
    merge([
      { geo: new THREE.BoxGeometry(2.05, 0.1, 0.12), pos: [0, 0.97, 2.53] },
      { geo: new THREE.BoxGeometry(2.05, 0.1, 0.12), pos: [0, -0.97, 2.53] },
      { geo: new THREE.BoxGeometry(0.1, 1.84, 0.12), pos: [-1.0, 0, 2.53] },
      { geo: new THREE.BoxGeometry(0.1, 1.84, 0.12), pos: [1.0, 0, 2.53] },
      ...[-0.5, 0, 0.5].map((x): Part => ({ geo: new THREE.CylinderGeometry(0.085, 0.085, 1.95, 8), pos: [x, 0, 2.42] })),
      { geo: new THREE.CylinderGeometry(0.07, 0.07, 2.0, 8), pos: [0, -0.38, 2.44], rot: [0, 0, PI / 2] },
      { geo: new THREE.CylinderGeometry(0.13, 0.13, 0.42, 8), pos: [-1.4, 0.55, 2.35] },
      { geo: new THREE.CylinderGeometry(0.13, 0.13, 0.42, 8), pos: [-1.4, -0.55, 2.35] },
    ]),
    chest,
  );
  for (const x of [-1.15, -0.58, 0, 0.58, 1.15]) {
    rivet(ctx, chest, [x, 1.15, 2.58]);
    rivet(ctx, chest, [x, -1.15, 2.58]);
  }
  for (const y of [-0.55, 0.55]) {
    rivet(ctx, chest, [-1.18, y, 2.58]);
    rivet(ctx, chest, [1.18, y, 2.58]);
  }

  // 獠牙：上排下垂、下排上顶，咬住炉门
  const fangs: Part[] = [];
  const top: Array<[number, number]> = [[-0.78, 0.52], [-0.26, 0.4], [0.26, 0.4], [0.78, 0.52]];
  const bottom: Array<[number, number]> = [[-0.75, 0.34], [-0.25, 0.26], [0.25, 0.26], [0.75, 0.34]];
  for (const [x, len] of top) fangs.push({ geo: new THREE.ConeGeometry(0.11, len, 5), pos: [x, 0.97 - len / 2, 2.5], rot: [PI, 0, 0] });
  for (const [x, len] of bottom) fangs.push({ geo: new THREE.ConeGeometry(0.1, len, 5), pos: [x, -0.97 + len / 2, 2.5] });
  const fangMesh = solid(ctx, merge(fangs), chest);
  fangMesh.userData.tint = BONE;

  // 结晶核心：中心 (0,0,1.5)，半径 0.95，前缘到 z≈2.45，正好从炉栅后透出；前方伸出几根晶簇
  glow(ctx, new THREE.IcosahedronGeometry(0.95, 1), ctx.mats.core, chest, [0, 0, 1.5]);
  const shards: Array<[number, number]> = [[0, 0.05], [0.32, 0.24], [-0.32, 0.22], [0.2, -0.3], [-0.22, -0.28]];
  glow(
    ctx,
    merge(
      shards.map(([x, y]): Part => ({
        geo: new THREE.OctahedronGeometry(0.2, 0),
        pos: [x, y, 1.93],
        rot: [-y * 0.6, x * 0.6, 0],
        scale: [0.75, 0.75, 2.3],
      })),
    ),
    ctx.mats.core,
    chest,
  );
}

/** 背部：封死的冷却阀门（阶段 I）→ 崩开的白金排气口 + 放射光刺（阶段 II） */
function buildBack(ctx: BuildCtx, torso: THREE.Group) {
  const y = 2.5;
  const ring = lathe(
    [
      [0.9, 0.0],
      [1.25, 0.12],
      [1.32, 0.42],
      [0.95, 0.5],
      [0.9, 0.0],
    ],
    14,
  );
  ring.rotateX(PI / 2);
  solid(ctx, rough(ring, 0.02, 60), torso, [0, y, -1.75]);
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * PI * 2;
    rivet(ctx, torso, [Math.cos(a) * 1.12, y + Math.sin(a) * 1.12, -1.78], 0.075);
  }

  const plug = new THREE.CylinderGeometry(0.9, 0.9, 0.3, 14, 1);
  plug.rotateX(PI / 2);
  solid(ctx, plug, torso, [0, y, -1.95]);

  // 阶段 I：十字封条 —— 阶段 II 崩飞
  const strap = iron(
    ctx,
    merge([
      { geo: new THREE.BoxGeometry(2.1, 0.2, 0.1), pos: [0, y, -2.14], rot: [0, 0, PI / 4] },
      { geo: new THREE.BoxGeometry(2.1, 0.2, 0.1), pos: [0, y, -2.14], rot: [0, 0, -PI / 4] },
      ...[PI / 4, (3 * PI) / 4, (5 * PI) / 4, (7 * PI) / 4].map((a): Part => ({
        geo: new THREE.IcosahedronGeometry(0.09, 0),
        pos: [Math.cos(a) * 0.86, y + Math.sin(a) * 0.86, -2.2],
      })),
    ]),
    torso,
  );
  ctx.p1.push(strap);

  // 阶段 II：排气口核心，世界坐标约 (0,7.0,-2.1)，后缘到 z≈-3.05
  glow(ctx, new THREE.IcosahedronGeometry(0.95, 2), ctx.mats.vent, torso, [0, y, -2.1], undefined, true);
  const rays: Part[] = [];
  for (let k = 0; k < 6; k++) {
    const a = (k * PI) / 3 + PI / 6;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const L = 2.2 + (k % 2) * 0.45;
    rays.push({ geo: taper([[c * 1.2, y + s * 1.2, -1.86], [c * 1.75, y + s * 1.75, -1.8], [c * L, y + s * L, -1.62]], 0.16, 0, 5, 6) });
  }
  glow(ctx, merge(rays), ctx.mats.vent, torso, undefined, undefined, true);
}

/** 肩梁、护颈石板（把头夹在中间）、带尖刺的分层肩甲、三根烟道 */
function buildUpperTorso(ctx: BuildCtx, torso: THREE.Group) {
  const yoke = new THREE.CylinderGeometry(0.55, 0.55, 5.1, 6, 6);
  yoke.rotateZ(PI / 2);
  yoke.scale(1, 0.9, 1.3);
  solid(ctx, rough(yoke, 0.05, 70), torso, [0, 2.75, 0]);

  // 护颈：头后方一圈外翻的石板，每块顶上一根刺，中间最高
  const collar: Part[] = [];
  for (let i = 0; i < 7; i++) {
    const a = PI * 0.62 + (i * PI * 0.76) / 6;
    const q = yxz(0.28, a);
    const pos: V3 = [Math.sin(a) * 1.15, 3.2, 0.2 + Math.cos(a) * 1.15];
    const h = 0.35 * (1 - Math.abs(i - 3) / 3);
    collar.push({ geo: rough(new THREE.BoxGeometry(0.6, 1.1, 0.2, 2, 2, 1), 0.04, 80 + i), pos, quat: q });
    collar.push({ geo: taper([[0, 0.4, 0], [0, 0.75, 0.06], [0, 1.1 + h, 0.22]], 0.15, 0, 5, 6), pos, quat: q });
  }
  solid(ctx, merge(collar), torso);

  for (const side of [-1, 1] as const) buildPauldron(ctx, torso, side);

  const flues: Array<[V3, number]> = [
    [[-0.75, 3.3, -1.2], 2.0],
    [[0, 3.4, -1.45], 2.1],
    [[0.75, 3.3, -1.2], 2.0],
  ];
  flues.forEach(([pos, h], i) => {
    const g = group(torso, `flue${i}`, pos);
    g.rotation.x = -0.35;
    const rAt = (f: number) => THREE.MathUtils.lerp(0.42, 0.3, f);
    solid(ctx, rough(new THREE.CylinderGeometry(0.3, 0.42, h, 8, 3), 0.03, 90 + i), g);
    iron(
      ctx,
      merge([
        { geo: new THREE.CylinderGeometry(rAt(0.2) + 0.06, rAt(0.2) + 0.06, 0.16, 8), pos: [0, -h * 0.3, 0] },
        { geo: new THREE.CylinderGeometry(0.4, 0.36, 0.22, 8), pos: [0, h / 2 - 0.08, 0] },
        ...[0, 1, 2, 3].map((k): Part => {
          const a = (k * PI) / 2 + PI / 4;
          return { geo: new THREE.ConeGeometry(0.07, 0.3, 4), pos: [Math.sin(a) * 0.36, h / 2 + 0.16, Math.cos(a) * 0.36] };
        }),
      ]),
      g,
    );
    const mouth = glow(ctx, new THREE.CylinderGeometry(0.27, 0.27, 0.05, 8), ctx.mats.ember, g, [0, h / 2 + 0.03, 0]);
    mouth.name = 'flueMouth';
  });
}

/** 肩甲：刻面穹顶 + 铁镶边 + 两层垂片 + 三根向上外翻的尖刺 */
function buildPauldron(ctx: BuildCtx, torso: THREE.Group, side: -1 | 1) {
  const g = group(torso, `pauldron${side < 0 ? 'L' : 'R'}`, [side * 2.75, 2.92, 0]);
  g.rotation.z = -side * 0.22;
  const dome = new THREE.SphereGeometry(1.2, 9, 5, 0, PI * 2, 0, PI * 0.55);
  dome.scale(1.05, 0.8, 1.0);
  solid(ctx, rough(dome, 0.06, 100 + side), g);
  const trim = lathe([[1.17, 0], [1.28, 0.03], [1.28, 0.2], [1.15, 0.22]], 9);
  trim.scale(1.05, 1, 1);
  iron(ctx, trim, g, [0, -0.32, 0]);
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * PI * 2;
    rivet(ctx, g, [Math.sin(a) * 1.36, -0.21, Math.cos(a) * 1.29], 0.07);
  }
  solid(
    ctx,
    merge([
      { geo: rough(new THREE.BoxGeometry(1.55, 0.26, 1.75, 2, 1, 2), 0.03, 110), pos: [side * 0.35, -0.55, 0], rot: [0, 0, -side * 0.32] },
      { geo: rough(new THREE.BoxGeometry(1.25, 0.24, 1.5, 2, 1, 2), 0.03, 111), pos: [side * 0.62, -0.85, 0], rot: [0, 0, -side * 0.5] },
    ]),
    g,
  );
  const spikes: Array<[V3, number]> = [
    [[side * 0.15, 0.82, -0.25], 1.0],
    [[side * 0.6, 0.62, 0.3], 0.8],
    [[side * 0.72, 0.5, -0.6], 0.65],
  ];
  solid(
    ctx,
    merge(
      spikes.map(([b, k]): Part => ({
        geo: taper([b, add(b, [side * 0.3, 0.45, -0.1], k), add(b, [side * 0.75, 0.82, -0.38], k)], 0.22 * k + 0.04, 0, 6, 8),
      })),
    ),
    g,
  );
}

/** 头：前倾坩埚，倾倒口即发射口；铁眉压着倒八字眼缝；耳轴伸出牛角；阶段 II 冒出火冠 */
function buildHead(ctx: BuildCtx, head: THREE.Group) {
  head.rotation.x = 0.28;
  const bowl = lathe(
    [
      [0.3, 0.0],
      [0.6, 0.08],
      [0.8, 0.6],
      [1.0, 1.15],
      [0.84, 1.15],
      [0.68, 0.65],
      [0.5, 0.22],
      [0.3, 0.18],
    ],
    12,
  );
  solid(ctx, rough(bowl, 0.022, 120), head);
  iron(ctx, lathe([[0.96, 1.08], [1.08, 1.1], [1.08, 1.24], [0.92, 1.24]], 12), head);

  // 倾倒口 + 口内熔流
  const spout = solid(ctx, rough(new THREE.BoxGeometry(0.6, 0.3, 0.85, 2, 1, 2), 0.02, 121), head, [0, 1.05, 1.05], [-0.35, 0, 0]);
  glow(ctx, new THREE.BoxGeometry(0.24, 0.04, 0.82), ctx.mats.ember, spout, [0, 0.16, 0]);
  // 熔液面
  glow(ctx, new THREE.CylinderGeometry(0.76, 0.76, 0.1, 12, 1), ctx.mats.ember, head, [0, 0.95, 0]);

  // 耳轴 + 牛角（前弯上挑，尖端略内收）
  iron(
    ctx,
    merge([-1, 1].map((s): Part => ({ geo: new THREE.CylinderGeometry(0.21, 0.21, 0.34, 8), pos: [s * 0.9, 0.65, 0], rot: [0, 0, PI / 2] }))),
    head,
  );
  const horns = solid(
    ctx,
    merge(
      [-1, 1].map((s): Part => ({
        geo: taper(
          [
            [s * 0.95, 0.65, 0],
            [s * 1.45, 0.74, -0.06],
            [s * 1.86, 1.12, 0.2],
            [s * 1.96, 1.58, 0.58],
            [s * 1.74, 1.88, 1.02],
          ],
          0.27,
          0,
          7,
          14,
        ),
      })),
    ),
    head,
  );
  horns.userData.tint = BONE;

  // 眼缝：内端下压的倒八字，上方铁眉更陡，形成怒目
  const eyes: Part[] = [];
  const brows: Part[] = [];
  for (const s of [-1, 1]) {
    const x = s * 0.31;
    const ry = Math.atan2(x, 0.72);
    eyes.push({ geo: new THREE.BoxGeometry(0.36, 0.075, 0.14), pos: [x, 0.62, 0.72], quat: yxz(0, ry, s * 0.38) });
    brows.push({ geo: new THREE.BoxGeometry(0.52, 0.13, 0.32), pos: [s * 0.3, 0.8, 0.77], quat: yxz(0.25, ry, s * 0.5) });
  }
  glow(ctx, merge(eyes), ctx.mats.emberHot, head).name = 'eyes';
  iron(ctx, merge(brows), head);

  // 口：栅栏后的熔光 + 两颗下突獠牙
  glow(ctx, new THREE.BoxGeometry(0.5, 0.2, 0.1), ctx.mats.ember, head, [0, 0.3, 0.58]);
  iron(
    ctx,
    merge([-0.18, -0.06, 0.06, 0.18].map((x): Part => ({ geo: new THREE.CylinderGeometry(0.028, 0.028, 0.28, 5), pos: [x, 0.3, 0.64] }))),
    head,
  );
  const tusks = solid(
    ctx,
    merge([-1, 1].map((s): Part => ({ geo: taper([[s * 0.3, 0.26, 0.55], [s * 0.36, 0.08, 0.72], [s * 0.3, -0.16, 0.8]], 0.08, 0, 5, 6) }))),
    head,
  );
  tusks.userData.tint = BONE;

  // 阶段 II：火冠（五支后掠火舌）
  const crest: Array<[number, number, number]> = [
    [-0.55, -0.2, 1.3],
    [-0.25, -0.4, 1.7],
    [0, -0.5, 2.0],
    [0.25, -0.4, 1.7],
    [0.55, -0.2, 1.3],
  ];
  glow(
    ctx,
    merge(
      crest.map(([x, z, h]): Part => ({
        geo: taper([[x, 0.95, z], [x * 1.15, 0.95 + h * 0.45, z - 0.15], [x * 1.05, 0.95 + h, z - 0.5]], 0.2, 0, 6, 8),
      })),
    ),
    ctx.mats.emberHot,
    head,
    undefined,
    undefined,
    true,
  );
}

/** 臂：左砧锤 / 右钳夹 */
function buildArm(ctx: BuildCtx, torso: THREE.Group, side: -1 | 1) {
  const sideName = side < 0 ? 'L' : 'R';
  const shoulder = group(torso, `shoulder${sideName}`, [side * 2.6, 2.6, 0]);
  const elbowPos: V3 = [side * 0.45, -2.1, 0.3];
  const elbow = group(shoulder, `elbow${sideName}`, elbowPos);
  const handPos: V3 = [side * 0.1, -2.4, 0.5];

  solid(ctx, rough(new THREE.DodecahedronGeometry(0.66, 0), 0.04, 130 + side), shoulder);
  limb(ctx, shoulder, [0, 0, 0], elbowPos, 0.5, 0.42, { bands: [0.15, -0.3] });

  // 肘：余烬关节球 + 两片铰链盘 + 向后的肘刺
  glow(ctx, new THREE.IcosahedronGeometry(0.38, 1), ctx.mats.ember, elbow);
  iron(
    ctx,
    merge([-1, 1].map((s): Part => ({ geo: new THREE.CylinderGeometry(0.44, 0.44, 0.14, 8), pos: [s * 0.36, 0, 0], rot: [0, 0, PI / 2] }))),
    elbow,
  );
  solid(ctx, taper([[0, 0.1, -0.2], [0, 0.06, -0.75], [0, -0.22, -1.25]], 0.24, 0), elbow);

  // 前臂 + 外侧液压杆
  limb(ctx, elbow, [0, 0, 0], handPos, 0.56, 0.48, { bands: [0.3, -0.3] });
  limb(ctx, elbow, [side * 0.72, -0.25, -0.05], [side * 0.6, -1.9, 0.35], 0.08, 0.08, { mat: ctx.mats.iron, radial: 6 });
  limb(ctx, elbow, [side * 0.71, -0.3, -0.04], [side * 0.66, -1.0, 0.12], 0.14, 0.14, { mat: ctx.mats.iron, radial: 6 });

  if (side < 0) {
    // 砧锤：石芯铁箍，前伸砧角，后部钉刺，底面烧红
    const hammer = group(elbow, 'hammer', [handPos[0], handPos[1] - 0.45, handPos[2] + 0.1]);
    hammer.rotation.set(0.1, 0.15, 0);
    solid(ctx, rough(new THREE.BoxGeometry(1.3, 1.0, 1.55, 2, 2, 2), 0.04, 140), hammer);
    iron(
      ctx,
      merge([
        { geo: new THREE.BoxGeometry(1.4, 1.08, 0.16), pos: [0, 0, 0.42] },
        { geo: new THREE.BoxGeometry(1.4, 1.08, 0.16), pos: [0, 0, -0.42] },
        { geo: new THREE.CylinderGeometry(0.55, 0.64, 0.3, 8), pos: [0, 0.62, 0] },
        { geo: taper([[0, 0.1, 0.7], [0, 0.05, 1.25], [0, -0.15, 1.75], [0, -0.35, 2.0]], 0.42, 0.02, 8, 10) },
      ]),
      hammer,
    );
    solid(
      ctx,
      merge(
        [[-0.36, 0.25], [0.36, 0.25], [-0.36, -0.22], [0.36, -0.22]].map(([x, y]): Part => ({
          geo: new THREE.ConeGeometry(0.17, 0.5, 4),
          pos: [x!, y!, -0.98],
          rot: [-PI / 2, 0, 0],
        })),
      ),
      hammer,
    );
    glow(ctx, new THREE.BoxGeometry(1.12, 0.06, 1.36), ctx.mats.emberHot, hammer, [0, -0.52, 0]);
  } else {
    // 钳夹：铁枢 + 三根内弯钳爪，爪尖烧红
    const hub: V3 = [handPos[0], handPos[1] - 0.1, handPos[2]];
    iron(ctx, rough(new THREE.DodecahedronGeometry(0.6, 0), 0.02, 150), elbow, hub);
    iron(ctx, new THREE.CylinderGeometry(0.52, 0.56, 0.24, 8), elbow, [handPos[0] - 0.01, handPos[1] + 0.3, handPos[2] - 0.06]);
    const claws: Part[] = [];
    const tips: Part[] = [];
    for (let k = -1; k <= 1; k++) {
      const phi = PI / 2 + k * 2.15;
      const o: V3 = [Math.cos(phi), 0, Math.sin(phi)];
      const b = add(add(hub, o, 0.32), [0, -0.2, 0]);
      const tip = add(add(b, o, 0.02), [0, -1.6, 0]);
      claws.push({ geo: taper([b, add(add(b, o, 0.5), [0, -0.5, 0]), add(add(b, o, 0.42), [0, -1.15, 0]), tip], 0.21, 0.05, 6, 12) });
      tips.push({ geo: new THREE.OctahedronGeometry(0.1, 0), pos: tip, scale: [1, 1.8, 1] });
    }
    iron(ctx, merge(claws), elbow);
    glow(ctx, merge(tips), ctx.mats.emberHot, elbow);
  }

  return { shoulder, elbow };
}

/** 阶段 II：绕肩悬浮的矿渣碎块（name = 'slag'，预览里会缓慢漂浮） */
function buildSlagShards(ctx: BuildCtx, torso: THREE.Group) {
  for (let i = 0; i < 7; i++) {
    const ang = (i / 7) * PI * 2 + 0.3;
    const r = 4.3 + (i % 2) * 0.4;
    const m = glow(
      ctx,
      rough(new THREE.IcosahedronGeometry(0.3 + (i % 3) * 0.1, 0), 0.1, 160 + i),
      ctx.mats.slag,
      torso,
      [Math.sin(ang) * r, 2.6 + Math.sin(i * 2.1) * 0.8, Math.cos(ang) * r],
      [i * 0.7, i * 1.3, 0],
      true,
    );
    m.name = 'slag';
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export function createIgnisRig(): IgnisBuild {
  const mats: IgnisMaterials = {
    stone: makeStoneMaterial(),
    iron: makeIronMaterial(),
    ember: makeGlowMaterial(0xff5a14, 2.4),
    emberHot: makeGlowMaterial(0xff9a3c, 3.4),
    // 结晶：带一点底色和低粗糙度，刻面会接住冷光高光，不再是一块平涂的蓝
    core: Object.assign(makeGlowMaterial(0x2f8cff, 1.7), { color: new THREE.Color(0x1d5fb0), roughness: 0.18, metalness: 0.1 }),
    vent: makeGlowMaterial(0xffe2a0, 1.9),
    slag: new THREE.MeshStandardMaterial({
      color: 0x3a2620,
      roughness: 0.6,
      metalness: 0.2,
      emissive: 0xff4a10,
      emissiveIntensity: 0.9,
      flatShading: true,
    }),
  };
  const ctx: BuildCtx = { stone: [], glow: [], p2: [], p1: [], mats, rivets: new Map() };

  const root = new THREE.Group();
  root.name = 'Ignis';
  const rig = group(root, 'rig', [0, 0, 0]);
  const hips = group(rig, 'hips', [0, 3.6, 0]);
  const torso = group(hips, 'torso', [0, 0.9, 0]);
  const chest = group(torso, 'chest', [0, 1.1, 0]);
  const head = group(torso, 'head', [0, 3.2, 0.2]);

  buildPelvis(ctx, hips);
  buildKiln(ctx, torso);
  buildChest(ctx, chest);
  buildBack(ctx, torso);
  buildUpperTorso(ctx, torso);
  buildHead(ctx, head);
  buildSlagShards(ctx, torso);

  const armL = buildArm(ctx, torso, -1);
  const armR = buildArm(ctx, torso, 1);
  const legL = buildLeg(ctx, hips, -1);
  const legR = buildLeg(ctx, hips, 1);

  for (const [parent, parts] of ctx.rivets) iron(ctx, merge(parts), parent);

  bakeVertexColors(root, ctx.stone, 9.1);

  return {
    rig: {
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
    },
    stoneMeshes: ctx.stone,
    glowMeshes: ctx.glow,
    phase2Meshes: ctx.p2,
    phase1Meshes: ctx.p1,
    materials: mats,
  };
}
