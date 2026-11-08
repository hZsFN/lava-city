import * as THREE from 'three/webgpu';
import type { Node, TextureNode } from 'three/webgpu';
import {
  cameraProjectionMatrixInverse,
  cameraWorldMatrix,
  convertToTexture,
  cos,
  dot,
  exp,
  float,
  Fn,
  getViewPosition,
  int,
  length,
  Loop,
  max,
  metalness,
  min,
  mix,
  mrt,
  mx_noise_float,
  normalView,
  output,
  pass,
  renderOutput,
  screenUV,
  smoothstep,
  sin,
  texture3D,
  time,
  vec2,
  vec3,
  vec4,
  velocity,
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { motionBlur } from 'three/addons/tsl/display/MotionBlur.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { chromaticAberration } from 'three/addons/tsl/display/ChromaticAberrationNode.js';
import { film } from 'three/addons/tsl/display/FilmNode.js';
import { lut3D } from 'three/addons/tsl/display/Lut3DNode.js';
import type { QualityPreset, QualityTier, VisualConfig } from './config';

type EffectKey =
  | 'gtao'
  | 'ssr'
  | 'traa'
  | 'volumetric'
  | 'bloom'
  | 'motionBlur'
  | 'dof'
  | 'grade'
  | 'lut'
  | 'heatHaze';

type ColorNode = Node<'vec4'>;

const EFFECTS: { key: EffectKey; label: string }[] = [
  { key: 'gtao', label: 'GTAO 环境光遮蔽' },
  { key: 'ssr', label: 'SSR 屏幕空间反射' },
  { key: 'traa', label: 'TRAA 时序抗锯齿' },
  { key: 'volumetric', label: '体积光雾' },
  { key: 'bloom', label: 'Bloom' },
  { key: 'motionBlur', label: '运动模糊' },
  { key: 'dof', label: '景深' },
  { key: 'grade', label: '色差 / 暗角 / 颗粒' },
  { key: 'lut', label: '3D LUT 16³' },
  { key: 'heatHaze', label: '热浪扰动' },
];

interface PassWithViewZ {
  getViewZNode(name?: string): Node<'float'>;
}

/**
 * 后处理：GTAO → SSR → TRAA → 体积光雾 → Bloom → 运动模糊 → 景深 → 色差/暗角/颗粒 → 3D LUT。
 * 每一项都可单独开关、单独计时（12 帧开 / 12 帧关的差值测量），并显示在左上角调试面板。
 */
export class PostFX {
  private readonly renderer: THREE.WebGPURenderer;
  private readonly cfg: VisualConfig;
  private readonly pipeline: THREE.RenderPipeline;
  private readonly scenePass: ReturnType<typeof pass>;
  private readonly beauty: Node<'vec4'>;
  private readonly depth: TextureNode;
  private readonly normal: TextureNode;
  private readonly metal: TextureNode;
  private readonly velocity: TextureNode;
  private readonly lut: THREE.Data3DTexture;

  private toggles: Record<EffectKey, boolean>;
  private quality: QualityTier;
  private preset: QualityPreset;
  private cameraMotion = 0;
  private rebuiltNodes: { dispose?: () => void }[] = [];

  private frameMs = 16.7;
  private lastNow = 0;
  private panel: HTMLDivElement | null = null;
  private rows = new Map<EffectKey, HTMLSpanElement>();
  private boxes = new Map<EffectKey, HTMLInputElement>();
  private readonly locked = new Set<EffectKey>();
  private statsEl: HTMLSpanElement | null = null;
  private qualitySelect: HTMLSelectElement | null = null;
  private tick = 0;

  private profile: {
    queue: EffectKey[];
    index: number;
    phase: 'off' | 'on';
    frame: number;
    sum: number;
    count: number;
    offAvg: number;
    saved: Record<EffectKey, boolean>;
  } | null = null;
  private readonly costs = new Map<EffectKey, number>();

  /** 外部（击破慢镜等）可调的运动模糊强度。 */
  private motionScale = 0.15;

  onQualityChanged: ((tier: QualityTier) => void) | null = null;
  onManualQualityChanged: ((tier: QualityTier) => void) | null = null;

  isProfiling(): boolean { return this.profile !== null; }

  resetFrameTime(): void {
    this.lastNow = 0;
    this.frameMs = 16.7;
  }

  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, cfg: VisualConfig) {
    this.renderer = renderer;
    this.cfg = cfg;
    this.motionScale = cfg.post.motionBlur.intensity;
    this.quality = cfg.quality.default;
    this.preset = cfg.qualityPresets[this.quality];

    this.toggles = {
      gtao: cfg.post.gtao.enabled && this.preset.gtao,
      ssr: cfg.post.ssr.enabled && this.preset.ssr,
      traa: cfg.post.traa.enabled,
      volumetric: cfg.post.volumetric.enabled,
      bloom: cfg.post.bloom.enabled,
      motionBlur: cfg.post.motionBlur.enabled && this.preset.motionBlur,
      dof: cfg.post.dof.enabled,
      grade: cfg.post.grade.enabled,
      lut: cfg.post.lut.enabled,
      heatHaze: cfg.post.heatHaze.enabled,
    };

    // 调试/截图用：?off=motionBlur,lut 临时关闭个别效果；?off=all 全关
    const offList = new URLSearchParams(window.location.search).get('off')?.split(',') ?? [];
    const allOff = offList.includes('all');
    for (const key of Object.keys(this.toggles) as EffectKey[]) {
      if (allOff || offList.includes(key)) {
        this.toggles[key] = false;
        this.locked.add(key);
      }
    }

    patchMaterials(scene);

    this.scenePass = pass(scene, camera, { samples: 0 });
    // 4 张 RGBA16F = 32 bytes/sample，正好卡在 WebGPU 默认上限内；
    // roughness 只用于 SSR，而场景里唯一的高金属材质就是黑曜石（0.22），直接给常量。
    this.scenePass.setMRT(
      mrt({
        output,
        normal: normalView,
        metalness,
        velocity,
      }),
    );

    this.beauty = this.scenePass.getTextureNode('output');
    this.depth = this.scenePass.getTextureNode('depth');
    this.normal = this.scenePass.getTextureNode('normal');
    this.metal = this.scenePass.getTextureNode('metalness');
    this.velocity = this.scenePass.getTextureNode('velocity');
    this.lut = createLut(cfg.post.lut.size);

    this.pipeline = new THREE.RenderPipeline(renderer);
    this.pipeline.outputColorTransform = false;
    this.rebuild();
    this.buildPanel();
  }

  render(): void {
    const now = performance.now();
    if (this.lastNow > 0) {
      const delta = now - this.lastNow;
      this.frameMs = this.frameMs * 0.86 + delta * 0.14;
    }
    this.lastNow = now;

    this.pipeline.render();
    this.tickProfile();
    this.tick += 1;
    if (this.tick % 8 === 0) this.updatePanel();
  }

  setQuality(tier: QualityTier): void {
    if (tier === this.quality) return;
    this.quality = tier;
    this.preset = this.cfg.qualityPresets[tier];
    // 档位决定高开销项默认开关；被 ?off= 锁定的项保持关闭
    for (const key of ['gtao', 'ssr', 'motionBlur'] as const) {
      if (!this.locked.has(key)) this.toggles[key] = this.preset[key];
    }
    this.rebuild();
    this.onQualityChanged?.(tier);
    if (this.qualitySelect) this.qualitySelect.value = tier;
    this.syncPanel();
    this.updatePanel(true);
  }

  getQuality(): QualityTier {
    return this.quality;
  }

  /** 镜头角速度（rad/s）。超过阈值时 TRAA 回落 SMAA。 */
  setCameraMotion(radPerSec: number): void {
    const fast = radPerSec > 1.4;
    const wasFast = this.cameraMotion > 1.4;
    this.cameraMotion = radPerSec;
    if (fast !== wasFast) this.rebuild();
  }

  /** 外部（击破慢镜等）调节运动模糊强度。 */
  setMotionBlurIntensity(value: number): void {
    this.motionScale = value;
  }

  dispose(): void {
    this.panel?.remove();
    this.disposeChain();
    this.pipeline.dispose();
    this.lut.dispose();
    this.scenePass.dispose();
  }

  // ───────────────────────────── 节点链 ─────────────────────────────

  private rebuild(): void {
    this.disposeChain();
    this.pipeline.outputNode = this.buildChain();
    this.pipeline.needsUpdate = true;
  }

  private disposeChain(): void {
    for (const node of this.rebuiltNodes) node.dispose?.();
    this.rebuiltNodes = [];
  }

  private track<T extends { dispose?: () => void }>(node: T): T {
    this.rebuiltNodes.push(node);
    return node;
  }

  private buildChain(): ColorNode {
    let node: ColorNode = this.beauty;

    // ① GTAO
    if (this.toggles.gtao) {
      const c = this.cfg.post.gtao;
      const gtao = this.track(ao(this.depth, this.normal, this.scenePass.camera));
      gtao.resolutionScale = this.preset.gtaoScale;
      gtao.radius.value = c.radius;
      gtao.thickness.value = c.thickness;
      gtao.samples.value = this.preset.gtaoSamples;
      gtao.scale.value = 1;
      gtao.useTemporalFiltering = this.toggles.traa;
      const occlusion = gtao.getTextureNode().sample(screenUV).r;
      node = node.mul(mix(float(1), occlusion, c.intensity));
    }

    // ② SSR（只有 metalness > 0 的黑曜石/湿岩会留下）
    if (this.toggles.ssr) {
      const c = this.cfg.post.ssr;
      const reflections = this.track(
        ssr(convertToTexture(node), this.depth, this.normal as unknown as Node<'vec3'>, {
          camera: this.scenePass.camera,
          metalnessNode: this.metal as unknown as Node<'float'>,
          roughnessNode: float(0.22),
          reflectNonMetals: false,
        }),
      );
      reflections.quality.value = clamp01(this.preset.ssrQuality * c.quality * 2);
      reflections.maxDistance.value = c.maxDistance;
      reflections.thickness.value = c.thickness;
      reflections.intensity.value = c.intensity;
      node = node.add(reflections);
    }

    // ③ TRAA（高速镜头回落 SMAA）
    if (this.toggles.traa) {
      if (this.cameraMotion > 1.4) {
        node = this.track(smaa(node)) as unknown as ColorNode;
      } else {
        node = this.track(traa(node, this.depth, this.velocity, this.scenePass.camera));
      }
    }

    // ④ 体积光 / 雾
    if (this.toggles.volumetric) {
      node = node.add(this.buildVolumetric());
    }

    // ⑤ Bloom（BloomNode 只输出泛光本身，需要叠加回原图）
    if (this.toggles.bloom) {
      const c = this.cfg.post.bloom;
      const b = this.track(bloom(node, c.strength, c.radius, c.threshold));
      b.setResolutionScale(this.preset.bloomScale);
      node = node.add(b);
    }

    // ⑥ 运动模糊
    if (this.toggles.motionBlur) {
      const tex = convertToTexture(node);
      node = motionBlur(tex, this.velocity.mul(this.motionScale), int(this.preset.motionSamples)) as unknown as ColorNode;
    }

    // ⑦ 景深
    if (this.toggles.dof) {
      const c = this.cfg.post.dof;
      const viewZ = (this.scenePass as unknown as PassWithViewZ).getViewZNode();
      node = this.track(dof(node, viewZ, c.focusDistance, c.focalLength, c.bokehScale)) as unknown as ColorNode;
    }

    // ⑧ 热浪：屏幕空间 UV 扰动，越靠下越强
    if (this.toggles.heatHaze) {
      const c = this.cfg.post.heatHaze;
      const tex = convertToTexture(node);
      const strength = float(c.amplitude).mul(float(1).sub(smoothstep(0.12, 0.9, screenUV.y)));
      const offset = vec2(
        sin(screenUV.y.mul(46).add(time.mul(c.speed))),
        cos(screenUV.x.mul(33).sub(time.mul(c.speed * 0.7))),
      ).mul(strength);
      node = tex.sample(screenUV.add(offset));
    }

    // ⑨ 色差 + 暗角 + 胶片颗粒
    if (this.toggles.grade) {
      const c = this.cfg.post.grade;
      node = this.track(chromaticAberration(node, float(c.chromatic), vec2(0.5, 0.5), float(1.15))) as unknown as ColorNode;
      const vignette = float(1).sub(
        smoothstep(0.32, 1.05, length(screenUV.sub(0.5)).mul(1.45)).mul(c.vignette),
      );
      node = node.mul(vignette);
      node = this.track(film(node, float(c.grain))) as unknown as ColorNode;
    }

    // 显示空间后再走 LUT，避免 HDR 高光被 0–1 采样裁掉
    let graded: ColorNode = renderOutput(node, THREE.ACESFilmicToneMapping, THREE.SRGBColorSpace);

    // 暗部压向 #05070a：只压最深的黑，不吞掉补光后的石头中间调
    const luma = dot(graded.rgb, vec3(0.2126, 0.7152, 0.0722));
    const shadow = float(1).sub(smoothstep(0, 0.1, luma)).mul(0.12);
    graded = mix(graded, vec3(0.0196, 0.0275, 0.0392), shadow) as unknown as ColorNode;

    if (this.toggles.lut) {
      const c = this.cfg.post.lut;
      graded = this.track(lut3D(graded, texture3D(this.lut), c.size, c.intensity)) as unknown as ColorNode;
    }

    return graded;
  }

  private buildVolumetric(): Node<'vec4'> {
    const c = this.cfg.post.volumetric;
    const taps = this.preset.volumetricTaps;
    const depth = this.depth;

    const fn = Fn(() => {
      const uv0 = screenUV;
      const rawDepth = depth.sample(uv0).r;
      const viewPos = getViewPosition(uv0, rawDepth, cameraProjectionMatrixInverse);
      const farPos = getViewPosition(uv0, float(1), cameraProjectionMatrixInverse);
      const dir = farPos.normalize();
      const distance = min(length(viewPos), float(c.maxDistance));
      const step = distance.div(taps);
      const accum = vec3(0).toVar();

      Loop({ start: int(0), end: int(taps), type: 'int' }, ({ i }) => {
        const t = float(i).add(0.5).mul(step);
        const view = dir.mul(t);
        const world = cameraWorldMatrix.mul(vec4(view, 1)).xyz;

        const heat = exp(max(world.y.add(22), 0).mul(-0.075));
        // 密度场保持静态：若随时间滚动，整幅暗部占比会来回摆动
        const noise = mx_noise_float(world.mul(0.075))
          .mul(0.5)
          .add(0.5);
        const density = heat.mul(float(0.55).add(noise.mul(0.9))).mul(step);
        accum.addAssign(vec3(1, 0.33, 0.09).mul(density).mul(c.warmIntensity));

        const beamDist = length(world.xz);
        const beamHeight = smoothstep(22.5, 24.5, world.y).mul(float(1).sub(smoothstep(56, 62, world.y)));
        const beam = float(1).sub(smoothstep(0, 2.8, beamDist)).mul(beamHeight);
        accum.addAssign(vec3(0.42, 1.15, 1.45).mul(beam).mul(step).mul(c.beamIntensity));
      });

      return vec4(accum, 1);
    });

    return fn();
  }

  // ───────────────────────────── 调试面板 ─────────────────────────────

  private buildPanel(): void {
    const panel = document.createElement('div');
    panel.style.cssText = [
      'position:fixed',
      'left:14px',
      'top:14px',
      'z-index:30',
      'width:268px',
      'padding:10px 12px',
      'border:1px solid rgba(255,138,76,0.26)',
      'border-radius:8px',
      'background:rgba(8,5,6,0.84)',
      'box-shadow:0 10px 30px rgba(0,0,0,0.5)',
      'color:#d8d2c8',
      'font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
      'letter-spacing:0.03em',
      'user-select:none',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = '渲染调试 · H 隐藏';
    title.style.cssText = 'color:#ff8a4c;letter-spacing:0.14em;margin-bottom:5px';

    this.statsEl = document.createElement('span');
    this.statsEl.style.cssText = 'display:block;color:#8ee6b0;margin-bottom:6px;white-space:pre';
    this.statsEl.textContent = 'draw --  tri --  ms --';

    const select = document.createElement('select');
    select.style.cssText =
      'width:100%;margin-bottom:6px;background:#1a1214;color:#ffd7b8;border:1px solid rgba(255,138,76,0.3);border-radius:4px;font:11px ui-monospace,monospace;padding:2px 4px';
    for (const tier of ['ultra', 'high', 'medium', 'low'] as QualityTier[]) {
      const option = document.createElement('option');
      option.value = tier;
      option.textContent = `画质 ${tier}`;
      select.appendChild(option);
    }
    select.value = this.quality;
    select.onchange = () => {
      const tier = select.value as QualityTier;
      this.onManualQualityChanged?.(tier);
      this.setQuality(tier);
    };
    this.qualitySelect = select;

    panel.append(title, this.statsEl, select);

    for (const effect of EFFECTS) {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;line-height:1.75';

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = this.toggles[effect.key];
      box.style.cssText = 'accent-color:#ff7a2a;margin:0';
      box.onchange = () => {
        this.toggles[effect.key] = box.checked;
        this.rebuild();
      };
      this.boxes.set(effect.key, box);

      const name = document.createElement('span');
      name.textContent = effect.label;
      name.style.cssText = 'flex:1;color:#c7bfb4';

      const ms = document.createElement('span');
      ms.textContent = '--';
      ms.style.cssText = 'color:#7f7468;min-width:44px;text-align:right';
      this.rows.set(effect.key, ms);

      row.append(box, name, ms);
      panel.appendChild(row);
    }

    const button = document.createElement('button');
    button.textContent = '计时（12 帧开 / 关）';
    button.style.cssText =
      'width:100%;margin-top:7px;padding:3px 0;background:#2a1512;color:#ffb37a;border:1px solid rgba(255,138,76,0.35);border-radius:4px;font:11px ui-monospace,monospace;cursor:pointer';
    button.onclick = () => this.startProfile();
    panel.appendChild(button);

    document.body.appendChild(panel);
    // 默认收起：M4-01 的 HUD 占用左上角；按 H 随时呼出渲染调试面板
    panel.style.display = 'none';
    this.panel = panel;

    window.addEventListener('keydown', (event) => {
      if (event.code === 'KeyH' && !event.repeat) {
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      }
    });
  }

  private syncPanel(): void {
    for (const [key, box] of this.boxes) box.checked = this.toggles[key];
  }

  private updatePanel(force = false): void {
    if (!this.statsEl || (!force && this.panel?.style.display === 'none')) return;
    const info = this.renderer.info.render;
    this.statsEl.textContent =
      `draw ${info.drawCalls}   tri ${(info.triangles / 1000).toFixed(1)}k\n` +
      `${this.quality}   ${this.frameMs.toFixed(1)} ms/f  后端 ${
        (this.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2'
      }`;

    for (const effect of EFFECTS) {
      const el = this.rows.get(effect.key);
      if (!el) continue;
      const cost = this.costs.get(effect.key);
      el.textContent = cost === undefined ? '--' : `${cost.toFixed(2)} ms`;
      el.style.color = cost === undefined ? '#7f7468' : '#8ee6b0';
    }

    if (this.profile && force) {
      const done = this.profile.index;
      this.statsEl.textContent += `\n计时中 ${done}/${EFFECTS.length}`;
    }
  }

  private startProfile(): void {
    if (this.profile) return;
    const saved = { ...this.toggles };
    this.profile = {
      queue: EFFECTS.map((e) => e.key),
      index: 0,
      phase: 'off',
      frame: 0,
      sum: 0,
      count: 0,
      offAvg: 0,
      saved,
    };
    this.toggles[this.profile.queue[0]] = false;
    this.rebuild();
    this.updatePanel(true);
  }

  private tickProfile(): void {
    const p = this.profile;
    if (!p) return;

    p.frame += 1;
    if (p.frame > 10 && this.frameMs < 150) {
      p.sum += this.frameMs;
      p.count += 1;
    }
    if (p.frame < 20) return;

    const avg = p.sum / Math.max(1, p.count);
    const key = p.queue[p.index];

    if (p.phase === 'off') {
      p.offAvg = avg;
      p.phase = 'on';
      this.toggles[key] = true;
    } else {
      this.costs.set(key, Math.max(0, avg - p.offAvg));
      p.index += 1;
      if (p.index >= p.queue.length) {
        this.toggles = { ...p.saved };
        this.profile = null;
        this.rebuild();
        this.syncPanel();
        this.updatePanel(true);
        return;
      }
      p.phase = 'off';
      this.toggles[p.queue[p.index]] = false;
    }

    p.frame = 0;
    p.sum = 0;
    p.count = 0;
    this.rebuild();
    this.updatePanel(true);
  }
}

// ───────────────────────────── 工具 ─────────────────────────────

/** MRT 需要每份材质都产出 metalness / roughness；基础材质补默认值，避免 NaN 写进反射通道。 */
function patchMaterials(scene: THREE.Scene): void {
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh & { material?: THREE.Material | THREE.Material[] };
    const material = mesh.material;
    if (!material) return;
    const list = Array.isArray(material) ? material : [material];
    for (const item of list) {
      const m = item as THREE.Material & { metalness?: number; roughness?: number };
      if (m.metalness === undefined) m.metalness = 0;
      if (m.roughness === undefined) m.roughness = 1;
    }
  });
}

/** 代码生成 16³ LUT：暗部压向深红褐、亮部推向冷青，整体加一点 S 曲线对比。 */
function createLut(size: number): THREE.Data3DTexture {
  const data = new Uint8Array(size * size * size * 4);
  const last = size - 1;
  const sCurve = (x: number): number => x * x * (3 - 2 * x);

  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        const rr = r / last;
        const gg = g / last;
        const bb = b / last;

        let R = rr + (sCurve(rr) - rr) * 0.42;
        let G = gg + (sCurve(gg) - gg) * 0.42;
        let B = bb + (sCurve(bb) - bb) * 0.42;

        const luma = R * 0.299 + G * 0.587 + B * 0.114;
        const shadow = 1 - smoothstepJs(0.0, 0.48, luma);
        const high = smoothstepJs(0.52, 1.0, luma);

        R += shadow * -0.006 + high * 0.012;
        G += shadow * 0.004 + high * 0.028;
        B += shadow * 0.028 + high * 0.055;

        // 亮部轻微去饱和，保留冷青
        const grey = (R + G + B) / 3;
        R += (grey - R) * high * 0.18;
        G += (grey - G) * high * 0.1;
        B += (grey - B) * high * 0.02;

        const i = ((b * size + g) * size + r) * 4;
        data[i] = toByte(R);
        data[i + 1] = toByte(G);
        data[i + 2] = toByte(B);
        data[i + 3] = 255;
      }
    }
  }

  const lut = new THREE.Data3DTexture(data, size, size, size);
  lut.format = THREE.RGBAFormat;
  lut.type = THREE.UnsignedByteType;
  lut.minFilter = THREE.LinearFilter;
  lut.magFilter = THREE.LinearFilter;
  lut.wrapS = THREE.ClampToEdgeWrapping;
  lut.wrapT = THREE.ClampToEdgeWrapping;
  lut.wrapR = THREE.ClampToEdgeWrapping;
  lut.generateMipmaps = false;
  lut.needsUpdate = true;
  return lut;
}

function smoothstepJs(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function toByte(value: number): number {
  return Math.round(clamp01(value) * 255);
}
