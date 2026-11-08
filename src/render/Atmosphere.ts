import * as THREE from 'three/webgpu';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import type { VisualConfig } from './config';
import { createRng } from '../core/rng';

const TAU = Math.PI * 2;

interface EmberState {
  baseX: number;
  baseZ: number;
  y: number;
  speed: number;
  phase: number;
  scale: number;
  spin: number;
}

/**
 * 地心光照与空气感。
 *
 * 主光是熔岩：HemisphereLight 的 ground 远亮于 sky，方向光从 (0,−30,−20) 往上打，
 * 因此所有朝下的面亮、朝上的面黑。方向光挂 CSMShadowNode（3 级级联，2048 mapSize），
 * 塔心与平台边缘的点光一律不投影（接触阴影交给 GTAO）。
 */
export class Atmosphere {
  private readonly cfg: VisualConfig;
  private readonly embers: THREE.InstancedMesh;
  private readonly states: EmberState[] = [];
  private readonly dummy = new THREE.Object3D();
  private elapsed = 0;

  constructor(scene: THREE.Scene, cfg: VisualConfig) {
    this.cfg = cfg;
    scene.fog = new THREE.FogExp2(new THREE.Color(cfg.scene.fog), cfg.scene.fogDensity);

    this.createLights(scene);
    this.embers = this.createEmbers();
    scene.add(this.embers);
  }

  update(dt: number): void {
    this.elapsed += dt;
    const cfg = this.cfg.embers;
    const t = this.elapsed;
    const top = cfg.baseY + cfg.height;

    for (let i = 0; i < this.states.length; i += 1) {
      const s = this.states[i];
      s.y += s.speed * dt;
      if (s.y > top) s.y = cfg.baseY;

      const sway = cfg.sway * (0.35 + s.speed * 0.6);
      const x = s.baseX + Math.sin(t * 0.62 + s.phase) * sway;
      const z = s.baseZ + Math.cos(t * 0.47 + s.phase * 1.7) * sway;
      const flicker = 0.72 + 0.28 * Math.sin(t * 3.1 + s.phase * 2.3);

      this.dummy.position.set(x, s.y, z);
      this.dummy.rotation.set(t * s.spin, t * s.spin * 1.4, s.phase);
      this.dummy.scale.setScalar(s.scale * flicker);
      this.dummy.updateMatrix();
      this.embers.setMatrixAt(i, this.dummy.matrix);
    }
    this.embers.instanceMatrix.needsUpdate = true;
  }

  private createLights(scene: THREE.Scene): void {
    const l = this.cfg.lights;

    const hemi = new THREE.HemisphereLight(
      new THREE.Color(l.hemisphere.sky),
      new THREE.Color(l.hemisphere.ground),
      l.hemisphere.intensity,
    );
    hemi.name = 'lava-hemisphere';
    scene.add(hemi);

    // 穹顶被熔岩照亮后的极弱冷散射：只让向上的石面有 6–12% 亮度，不投影
    const skyFill = new THREE.DirectionalLight(new THREE.Color(l.skyFill.color), l.skyFill.intensity);
    skyFill.position.set(...l.skyFill.position);
    skyFill.target.position.set(0, 0, 0);
    skyFill.castShadow = false;
    skyFill.name = 'sky-fill';
    scene.add(skyFill);
    scene.add(skyFill.target);

    // 主光：从熔岩海向上斜射
    const key = new THREE.DirectionalLight(new THREE.Color(l.key.color), l.key.intensity);
    key.position.set(...l.key.position);
    key.target.position.set(0, 0, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(l.key.shadow.mapSize, l.key.shadow.mapSize);
    key.shadow.bias = l.key.shadow.bias;
    key.shadow.normalBias = l.key.shadow.normalBias;
    const csm = new CSMShadowNode(key, {
      cascades: l.key.shadow.cascades,
      maxFar: l.key.shadow.maxFar,
      mode: 'practical',
      lightMargin: 60,
    });
    (key.shadow as unknown as { shadowNode: CSMShadowNode }).shadowNode = csm;
    key.name = 'lava-key';
    scene.add(key);
    scene.add(key.target);

    // 四盏低角度熔岩补光：只擦亮竖直石面，仰角在水平线以下，
    // 因此向上表面仍然拿不到任何光（光照铁律），但矮墙/塔身不会糊成纯黑。
    for (const [x, z] of [
      [40, 40],
      [40, -40],
      [-40, 40],
      [-40, -40],
    ]) {
      const fill = new THREE.DirectionalLight(new THREE.Color(0xff5a12), 2);
      fill.position.set(x, -22, z);
      fill.target.position.set(0, 0, 0);
      fill.castShadow = false;
      fill.name = 'lava-fill';
      scene.add(fill);
      scene.add(fill.target);
    }

    const core = new THREE.PointLight(new THREE.Color(l.core.color), l.core.intensity, l.core.distance, 2);
    core.position.set(0, this.cfg.spire.core.y, 0);
    core.name = 'molten-core-light';
    scene.add(core);

    // 熔心底部向上打的光：照亮塔心竖井内壁，不参与阴影
    const up = new THREE.SpotLight(new THREE.Color(0xff5a12), 340, 40, 0.85, 0.7, 1.4);
    up.position.set(0, -0.6, 0);
    up.target.position.set(0, 16, 0);
    up.castShadow = false;
    up.name = 'core-uplight';
    scene.add(up);
    scene.add(up.target);

    for (let i = 0; i < l.edge.count; i += 1) {
      const a = (i / l.edge.count) * TAU;
      const edge = new THREE.PointLight(new THREE.Color(l.edge.color), l.edge.intensity, l.edge.distance, 2);
      edge.position.set(Math.cos(a) * l.edge.radius, 0.7, Math.sin(a) * l.edge.radius);
      edge.name = `edge-fire-${i}`;
      scene.add(edge);
    }
  }

  private createEmbers(): THREE.InstancedMesh {
    const cfg = this.cfg.embers;
    const rng = createRng(0x0e4b_1a7c);
    const geometry = new THREE.OctahedronGeometry(1, 0);
    const material = new THREE.MeshBasicNodeMaterial({
      color: new THREE.Color(cfg.color),
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    material.fog = false;

    const mesh = new THREE.InstancedMesh(geometry, material, cfg.count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.name = 'embers';
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;

    for (let i = 0; i < cfg.count; i += 1) {
      // 半径做幂次偏置：塔附近更密，远处只留稀疏轮廓
      const radius = Math.pow(rng(), 1.7) * cfg.radius;
      const a = rng() * TAU;
      const state: EmberState = {
        baseX: Math.cos(a) * radius,
        baseZ: Math.sin(a) * radius,
        y: cfg.baseY + rng() * cfg.height,
        speed: cfg.speedMin + rng() * (cfg.speedMax - cfg.speedMin),
        phase: rng() * TAU,
        scale: cfg.size * (0.55 + rng() * 1.6),
        spin: 0.4 + rng() * 1.6,
      };
      this.states.push(state);
      this.dummy.position.set(state.baseX, state.y, state.baseZ);
      this.dummy.scale.setScalar(state.scale);
      this.dummy.updateMatrix();
      mesh.setMatrixAt(i, this.dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }
}
