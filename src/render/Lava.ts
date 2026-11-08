import * as THREE from 'three/webgpu';
import {
  abs,
  float,
  length,
  mix,
  mx_noise_float,
  positionLocal,
  positionWorld,
  sin,
  cos,
  smoothstep,
  time,
  vec2,
  vec3,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { VisualConfig } from './config';
import { PALETTE } from './palette';

/**
 * 熔岩海：半径 55、y = −22 的圆形辐射网格。
 *
 * - 顶点：三层正弦起伏，越远振幅越大（0.35 m 量级）。
 * - 片元：4 octave perlin 驱动 冷区→温区→热区→白热 四段插值，
 *   再用 |n−0.5| 的脊线叠加强发光，形成"结壳-裂隙"的血管感。
 * - 全程 TSL，无 GLSL 字符串。
 */
export class Lava {
  readonly mesh: THREE.Mesh;
  readonly level: number;

  private readonly cfg: VisualConfig;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private octaves: number;

  constructor(cfg: VisualConfig) {
    this.cfg = cfg;
    this.level = cfg.lava.y;
    this.octaves = cfg.lava.octaves;

    this.material = new THREE.MeshBasicNodeMaterial();
    this.material.colorNode = this.buildColor();
    this.material.positionNode = this.buildDisplacement();

    this.mesh = new THREE.Mesh(
      createLavaDisc(cfg.lava.radius, cfg.lava.radialSegments, cfg.lava.angularSegments),
      this.material,
    );
    this.mesh.name = 'lava-sea';
    this.mesh.position.y = cfg.lava.y;
    this.mesh.frustumCulled = false;
  }

  /** M2 熔岩上涨用。 */
  setLevel(y: number): void {
    this.mesh.position.y = y;
  }

  /** 低画质把 fbm 降到 2 octave。 */
  setOctaves(count: number): void {
    if (count === this.octaves) return;
    this.octaves = count;
    this.material.colorNode = this.buildColor();
    this.material.needsUpdate = true;
  }

  private buildDisplacement(): Node<'vec3'> {
    const p = positionLocal;
    const t = time.mul(this.cfg.lava.flowSpeed);
    const radial = length(p.xz);
    const amp = smoothstep(4, this.cfg.lava.radius, radial)
      .mul(this.cfg.lava.waveAmplitude)
      .add(0.04);

    const w1 = sin(p.x.mul(0.105).add(t.mul(0.55))).mul(cos(p.z.mul(0.088).add(t.mul(0.42))));
    const w2 = sin(p.x.mul(0.27).sub(t.mul(0.9))).mul(sin(p.z.mul(0.233).add(t.mul(0.7))));
    const w3 = cos(p.x.mul(0.53).add(p.z.mul(0.47)).sub(t.mul(1.35)));
    const wave = w1.mul(0.62).add(w2.mul(0.28)).add(w3.mul(0.1));

    return vec3(p.x, p.y.add(wave.mul(amp)), p.z);
  }

  private buildColor(): Node<'vec3'> {
    const cold = rgb(PALETTE.lavaCold);
    const warm = rgb(PALETTE.lavaWarm);
    const hot = rgb(PALETTE.lavaHot);
    const white = rgb(PALETTE.lavaWhite);

    const t = time.mul(this.cfg.lava.flowSpeed);
    const world = positionWorld.xz;
    const uvA = world.mul(0.13).add(vec2(t.mul(0.008), t.mul(0.005)));
    const uvB = world.mul(0.27).sub(vec2(t.mul(0.013), t.mul(0.009)));

    const n = fbm(uvA, this.octaves, 0).mul(0.72).add(fbm(uvB, Math.max(2, this.octaves - 1), 19).mul(0.28));
    const ridge = float(1).sub(smoothstep(0, 0.022, abs(n.sub(0.5))));
    const vein = float(1).sub(smoothstep(0, 0.012, abs(fbm(uvB.mul(2.3), 2, 41).sub(0.5))));

    let col = mix(cold, warm, smoothstep(0.46, 0.64, n));
    col = mix(col, hot, smoothstep(0.68, 0.8, n));
    col = mix(col, white, smoothstep(0.9, 0.97, n));
    col = col.add(rgb(0xff5a12).mul(ridge).mul(1.1));
    col = col.add(rgb(0xffd27a).mul(vein).mul(0.4));

    const radial = length(positionWorld.xz);
    const fade = mix(float(1), float(0.35), smoothstep(10, this.cfg.lava.radius, radial));

    return col.mul(this.cfg.lava.emissive * 0.75).mul(fade);
  }
}

function fbm(p: Node<'vec2'>, octaves: number, seed: number): Node<'float'> {
  let sum: Node<'float'> = float(0);
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i += 1) {
    const sample = mx_noise_float(
      vec3(p.x.mul(freq), p.y.mul(freq), time.mul(0.02).add(seed + i * 7.31)),
    );
    sum = sum.add(sample.mul(amp));
    freq *= 2.03;
    amp *= 0.5;
  }
  // mx_noise 的 perlin 输出约在 [−1,1]，这里归一到 [0,1] 并夹住
  return sum.mul(1.15).add(0.5).clamp(0, 1);
}

function rgb(hex: number): Node<'vec3'> {
  const c = new THREE.Color(hex);
  return vec3(c.r, c.g, c.b);
}

/** 圆形辐射网格：中心一个点 + 环带四边形，近处更密。 */
function createLavaDisc(radius: number, rings: number, segments: number): THREE.BufferGeometry {
  const positions: number[] = [0, 0, 0];
  const uvs: number[] = [0.5, 0.5];
  const indices: number[] = [];

  for (let i = 1; i <= rings; i += 1) {
    const t = Math.pow(i / rings, 1.12);
    const r = t * radius;
    for (let j = 0; j < segments; j += 1) {
      const a = (j / segments) * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      positions.push(x, 0, z);
      uvs.push(x / (radius * 2) + 0.5, z / (radius * 2) + 0.5);
    }
  }

  for (let j = 0; j < segments; j += 1) {
    const a = 1 + j;
    const b = 1 + ((j + 1) % segments);
    indices.push(0, b, a);
  }

  for (let i = 1; i < rings; i += 1) {
    const rowA = 1 + (i - 1) * segments;
    const rowB = 1 + i * segments;
    for (let j = 0; j < segments; j += 1) {
      const a = rowA + j;
      const b = rowA + ((j + 1) % segments);
      const c = rowB + j;
      const d = rowB + ((j + 1) % segments);
      indices.push(a, d, c, a, b, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}
