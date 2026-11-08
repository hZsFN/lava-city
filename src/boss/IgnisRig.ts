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
 * 坐标：脚底 y=0，面朝 +Z，+X 为其右手边。阶段 I 全高约 9.1 m。
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

export interface IgnisBuild {
  rig: IgnisRig;
  /** 所有"岩石主体"网格：阶段 II 换材质时会整体替换材质 */
  stoneMeshes: THREE.Mesh[];
  /** 所有"自发光"网格：裂缝、核心、关节，保持发光 */
  glowMeshes: THREE.Mesh[];
  /** 阶段 II 才显示、阶段 I 隐藏的网格（比如背部裂缝、膝部核心） */
  phase2Meshes: THREE.Mesh[];
}

// ---------------------------------------------------------------------------
// 材质
// ---------------------------------------------------------------------------

/** 玄武岩窑体：几乎不反光，极弱的余烬自发光保证无环境光时不至于一团死黑 */
function makeStoneMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x4a3c36,
    roughness: 0.96,
    metalness: 0.04,
    flatShading: true,
    vertexColors: true,
    emissive: 0x2a0a04,
    emissiveIntensity: 0.22,
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
  });
}

// ---------------------------------------------------------------------------
// 构建上下文与小工具
// ---------------------------------------------------------------------------

interface BuildCtx {
  stone: THREE.Mesh[];
  glow: THREE.Mesh[];
  p2: THREE.Mesh[];
  stoneMat: THREE.MeshStandardMaterial;
  ember: THREE.MeshStandardMaterial; // 橙红余烬：裂缝、关节、炉底
  core: THREE.MeshStandardMaterial; // 冷蓝：阶段 I 弱点（法术）
  vent: THREE.MeshStandardMaterial; // 白金：阶段 II 弱点（物理）
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);

function placeMesh(
  mesh: THREE.Mesh,
  parent: THREE.Object3D,
  pos: THREE.Vector3Tuple,
  rot: THREE.Vector3Tuple = [0, 0, 0],
): THREE.Mesh {
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.rotation.set(rot[0], rot[1], rot[2]);
  parent.add(mesh);
  return mesh;
}

function stone(
  ctx: BuildCtx,
  geo: THREE.BufferGeometry,
  parent: THREE.Object3D,
  pos: THREE.Vector3Tuple,
  rot?: THREE.Vector3Tuple,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, ctx.stoneMat);
  m.castShadow = true;
  m.receiveShadow = true;
  ctx.stone.push(m);
  return placeMesh(m, parent, pos, rot);
}

function glow(
  ctx: BuildCtx,
  geo: THREE.BufferGeometry,
  mat: THREE.MeshStandardMaterial,
  parent: THREE.Object3D,
  pos: THREE.Vector3Tuple,
  rot?: THREE.Vector3Tuple,
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

/** 在父节点局部坐标系里，从 from 到 to 架一根锥形柱（用于四肢） */
function limb(
  ctx: BuildCtx,
  parent: THREE.Object3D,
  from: THREE.Vector3Tuple,
  to: THREE.Vector3Tuple,
  rTop: number,
  rBottom: number,
  radial = 9,
): THREE.Mesh {
  const a = new THREE.Vector3(...from);
  const b = new THREE.Vector3(...to);
  const dir = b.clone().sub(a);
  const len = dir.length();
  const geo = new THREE.CylinderGeometry(rTop, rBottom, len, radial, 1);
  const m = new THREE.Mesh(geo, ctx.stoneMat);
  m.castShadow = true;
  m.receiveShadow = true;
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(Y_AXIS, dir.normalize().negate());
  ctx.stone.push(m);
  parent.add(m);
  return m;
}

function group(parent: THREE.Object3D, name: string, pos: THREE.Vector3Tuple): THREE.Group {
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

/**
 * 按世界高度给所有岩石顶点烘焙颜色：
 * 脚部偏暖（被熔岩照着），上半身偏冷灰黑。
 * 这样即使没有任何环境光，剪影内部也有自下而上的层次。
 */
function bakeHeightTint(root: THREE.Object3D, stones: THREE.Mesh[], totalHeight: number): void {
  root.updateMatrixWorld(true);
  const warm = new THREE.Color(1.35, 0.92, 0.72);
  const cold = new THREE.Color(0.72, 0.7, 0.7);
  const v = new THREE.Vector3();
  const c = new THREE.Color();
  for (const mesh of stones) {
    const pos = mesh.geometry.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const t = THREE.MathUtils.smoothstep(v.y / totalHeight, 0.05, 0.75);
      c.copy(warm).lerp(cold, t);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    mesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
}

// ---------------------------------------------------------------------------
// 身体各部件
// ---------------------------------------------------------------------------

/** 腿：炉脚支柱。髋 → 膝（活塞关节）→ 胫 → 足爪。膝部核心为阶段 II 弱点。 */
function buildLeg(ctx: BuildCtx, hips: THREE.Group, side: -1 | 1) {
  const sideName = side < 0 ? 'L' : 'R';
  const leg = group(hips, `leg${sideName}`, [side * 0.95, 0, 0]);
  const knee = group(leg, `knee${sideName}`, [0, -1.4, 0.2]);
  const foot = group(knee, `foot${sideName}`, [0, -2.2, -0.2]);

  // 大腿
  limb(ctx, leg, [0, 0, 0], [0, -1.4, 0.2], 0.58, 0.5);

  // 膝：横置活塞缸
  const kneeCyl = new THREE.CylinderGeometry(0.62, 0.62, 1.15, 10, 1);
  kneeCyl.rotateZ(Math.PI / 2);
  stone(ctx, kneeCyl, knee, [0, 0, 0.1]);

  // 膝部核心（阶段 II 暴露，白金）
  glow(ctx, new THREE.IcosahedronGeometry(0.44, 1), ctx.vent, knee, [0, 0, 0.5], undefined, true);

  // 胫：向下加粗的支柱
  limb(ctx, knee, [0, 0, 0], [0, -2.2, -0.2], 0.42, 0.6);

  // 胫前护板
  stone(ctx, new THREE.BoxGeometry(0.72, 1.6, 0.3), knee, [0, -1.15, 0.5], [-0.08, 0, 0]);

  // 足：宽底座 + 前趾楔
  stone(ctx, new THREE.BoxGeometry(1.35, 0.45, 1.7), foot, [0, 0.22, 0.15]);
  stone(ctx, new THREE.BoxGeometry(1.1, 0.34, 0.75), foot, [0, 0.24, 1.15], [0.18, 0, 0]);

  return { leg, knee, foot };
}

/** 窑身：八角 Lathe 躯干 + 下部余烬裂缝 */
function buildKiln(ctx: BuildCtx, torso: THREE.Group) {
  const body = lathe(
    [
      [0.7, 0.0],
      [1.55, 0.0],
      [1.9, 0.45],
      [2.0, 1.05],
      [1.95, 1.6],
      [1.72, 2.2],
      [1.5, 2.7],
      [1.35, 3.05],
      [0.45, 3.1],
    ],
    8,
  );
  stone(ctx, body, torso, [0, 0, 0], [0, Math.PI / 8, 0]);

  // 下部六道余烬裂缝（在棱上）
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const r = 1.93;
    glow(
      ctx,
      new THREE.BoxGeometry(0.14, 1.45, 0.14),
      ctx.ember,
      torso,
      [Math.sin(ang) * r, 0.75, Math.cos(ang) * r],
      [0, ang, (i % 2 === 0 ? 1 : -1) * 0.12],
    );
  }
}

/** 胸口炉门：四块门框 + 三根炉栅 + 冷蓝地脉结晶 */
function buildChest(ctx: BuildCtx, chest: THREE.Group) {
  const fz = 2.3;
  stone(ctx, new THREE.BoxGeometry(2.6, 0.32, 0.5), chest, [0, 1.15, fz]);
  stone(ctx, new THREE.BoxGeometry(2.6, 0.32, 0.5), chest, [0, -1.15, fz]);
  stone(ctx, new THREE.BoxGeometry(0.32, 2.0, 0.5), chest, [-1.15, 0, fz]);
  stone(ctx, new THREE.BoxGeometry(0.32, 2.0, 0.5), chest, [1.15, 0, fz]);
  for (const x of [-0.55, 0, 0.55]) {
    stone(ctx, new THREE.CylinderGeometry(0.09, 0.09, 2.0, 6, 1), chest, [x, 0, 2.52]);
  }
  // 结晶核心：中心 (0,0,1.5)，半径 0.95，前缘到 z≈2.45，正好从炉栅后透出
  glow(ctx, new THREE.IcosahedronGeometry(0.95, 2), ctx.core, chest, [0, 0, 1.5]);
}

/** 背部：封死的冷却阀门（阶段 I）→ 崩开的白金排气口 + 放射裂缝（阶段 II） */
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
    12,
  );
  ring.rotateX(Math.PI / 2);
  stone(ctx, ring, torso, [0, y, -1.75]);

  const plug = new THREE.CylinderGeometry(0.9, 0.9, 0.3, 12, 1);
  plug.rotateX(Math.PI / 2);
  stone(ctx, plug, torso, [0, y, -1.95]);

  // 阶段 II：排气口核心，世界坐标约 (0,7.0,-2.1)，后缘到 z≈-3.05
  glow(ctx, new THREE.IcosahedronGeometry(0.95, 2), ctx.vent, torso, [0, y, -2.1], undefined, true);
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const r = 1.55;
    glow(
      ctx,
      new THREE.BoxGeometry(0.18, 1.3, 0.22),
      ctx.vent,
      torso,
      [Math.cos(ang) * r, y + Math.sin(ang) * r, -1.95],
      [0, 0, ang - Math.PI / 2],
      true,
    );
  }
}

/** 肩梁、肩甲、烟道 */
function buildUpperTorso(ctx: BuildCtx, torso: THREE.Group) {
  stone(ctx, new THREE.BoxGeometry(5.4, 0.7, 0.95), torso, [0, 2.7, 0]);
  stone(ctx, new THREE.DodecahedronGeometry(0.95, 0), torso, [-2.7, 2.8, 0], [0.3, 0.2, 0]);
  stone(ctx, new THREE.DodecahedronGeometry(0.95, 0), torso, [2.7, 2.8, 0], [0.3, -0.2, 0]);

  const flues: Array<[THREE.Vector3Tuple, number]> = [
    [[-0.75, 3.4, -1.2], 1.9],
    [[0, 3.7, -1.45], 2.1],
    [[0.75, 3.4, -1.2], 1.9],
  ];
  for (const [pos, h] of flues) {
    stone(ctx, new THREE.CylinderGeometry(0.3, 0.4, h, 8, 1), torso, pos, [-0.35, 0, 0]);
  }
}

/** 头：前倾坩埚，倾倒口即发射口；内有熔液面；两侧观火孔；阶段 II 冒出火冠 */
function buildHead(ctx: BuildCtx, head: THREE.Group) {
  head.rotation.x = 0.28;
  const bowl = lathe(
    [
      [0.3, 0.0],
      [0.58, 0.08],
      [0.78, 0.6],
      [0.98, 1.15],
      [0.82, 1.15],
      [0.66, 0.65],
      [0.5, 0.22],
      [0.3, 0.18],
    ],
    10,
  );
  stone(ctx, bowl, head, [0, 0, 0]);
  // 倾倒口
  stone(ctx, new THREE.BoxGeometry(0.55, 0.3, 0.8), head, [0, 1.05, 1.05], [-0.35, 0, 0]);
  // 熔液面
  glow(ctx, new THREE.CylinderGeometry(0.72, 0.72, 0.12, 10, 1), ctx.ember, head, [0, 0.95, 0]);
  // 观火孔
  glow(ctx, new THREE.IcosahedronGeometry(0.14, 0), ctx.ember, head, [-0.68, 0.6, 0.45]);
  glow(ctx, new THREE.IcosahedronGeometry(0.14, 0), ctx.ember, head, [0.68, 0.6, 0.45]);

  // 阶段 II：火冠
  const crest: Array<[THREE.Vector3Tuple, number]> = [
    [[-0.5, 1.15, -0.35], 1.4],
    [[0, 1.3, -0.55], 1.9],
    [[0.5, 1.15, -0.35], 1.4],
  ];
  for (const [pos, h] of crest) {
    glow(
      ctx,
      new THREE.CylinderGeometry(0.03, 0.2, h, 6, 1),
      ctx.ember,
      head,
      [pos[0], pos[1] + h / 2, pos[2]],
      [-0.25, 0, 0],
      true,
    );
  }
}

/** 臂：左砧锤 / 右钳夹 */
function buildArm(ctx: BuildCtx, torso: THREE.Group, side: -1 | 1) {
  const sideName = side < 0 ? 'L' : 'R';
  const shoulder = group(torso, `shoulder${sideName}`, [side * 2.6, 2.6, 0]);
  const elbowPos: THREE.Vector3Tuple = [side * 0.45, -2.1, 0.3];
  const elbow = group(shoulder, `elbow${sideName}`, elbowPos);
  const handPos: THREE.Vector3Tuple = [side * 0.1, -2.4, 0.5];

  limb(ctx, shoulder, [0, 0, 0], elbowPos, 0.44, 0.38);
  glow(ctx, new THREE.IcosahedronGeometry(0.34, 1), ctx.ember, elbow, [0, 0, 0]);
  limb(ctx, elbow, [0, 0, 0], handPos, 0.52, 0.44);

  if (side < 0) {
    // 砧锤
    stone(
      ctx,
      new THREE.BoxGeometry(1.5, 1.05, 1.35),
      elbow,
      [handPos[0], handPos[1] - 0.35, handPos[2] + 0.1],
      [0.1, 0.15, 0],
    );
  } else {
    // 钳夹：中枢 + 两根钳齿
    stone(ctx, new THREE.DodecahedronGeometry(0.58, 0), elbow, [handPos[0], handPos[1] - 0.1, handPos[2]]);
    stone(
      ctx,
      new THREE.BoxGeometry(0.32, 1.5, 0.36),
      elbow,
      [handPos[0] - 0.45, handPos[1] - 0.85, handPos[2] + 0.1],
      [0, 0, -0.3],
    );
    stone(
      ctx,
      new THREE.BoxGeometry(0.32, 1.5, 0.36),
      elbow,
      [handPos[0] + 0.45, handPos[1] - 0.85, handPos[2] + 0.1],
      [0, 0, 0.3],
    );
  }

  return { shoulder, elbow };
}

/** 阶段 II：绕肩悬浮的矿渣碎块 */
function buildSlagShards(ctx: BuildCtx, torso: THREE.Group) {
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2 + 0.3;
    const r = 3.5;
    glow(
      ctx,
      new THREE.IcosahedronGeometry(0.28 + (i % 3) * 0.08, 0),
      ctx.ember,
      torso,
      [Math.sin(ang) * r, 3.0 + Math.sin(i * 2.1) * 0.45, Math.cos(ang) * r],
      [i * 0.7, i * 1.3, 0],
      true,
    );
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export function createIgnisRig(): IgnisBuild {
  const ctx: BuildCtx = {
    stone: [],
    glow: [],
    p2: [],
    stoneMat: makeStoneMaterial(),
    ember: makeGlowMaterial(0xff6a1a, 2.6),
    core: makeGlowMaterial(0x5ab8ff, 3.2),
    vent: makeGlowMaterial(0xfff0c0, 3.6),
  };

  const root = new THREE.Group();
  root.name = 'Ignis';
  const rig = group(root, 'rig', [0, 0, 0]);
  const hips = group(rig, 'hips', [0, 3.6, 0]);
  const torso = group(hips, 'torso', [0, 0.9, 0]);
  const chest = group(torso, 'chest', [0, 1.1, 0]);
  const head = group(torso, 'head', [0, 3.2, 0.2]);

  // 骨盆：八角炉底 + 炉底火线
  stone(ctx, new THREE.CylinderGeometry(1.7, 1.3, 1.1, 8, 1), hips, [0, 0.2, 0], [0, Math.PI / 8, 0]);
  const fireline = new THREE.CylinderGeometry(1.5, 1.5, 0.18, 8, 1, true);
  const firelineMat = makeGlowMaterial(0xff6a1a, 2.6);
  firelineMat.side = THREE.DoubleSide;
  glow(ctx, fireline, firelineMat, hips, [0, -0.3, 0], [0, Math.PI / 8, 0]);

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

  bakeHeightTint(root, ctx.stone, 9.1);

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
  };
}
