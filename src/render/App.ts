import * as THREE from 'three/webgpu';
import { VISUAL } from './config';
import type { CameraPose, QualityTier } from './config';
import { Lava } from './Lava';
import { Spire } from './Spire';
import { Atmosphere } from './Atmosphere';
import { PostFX } from './PostFX';

export type BackendName = 'WebGPU' | 'WebGL2';

/**
 * 熔心孤塔的渲染总装。
 *
 * 沿用 M0 的 WebGPURenderer 初始化（WebGPU 失败时同一套 TSL 走 WebGL2 后端），
 * 在它上面挂 Spire / Lava / Atmosphere / PostFX 四个子系统。
 */
export class App {
  backendName: BackendName = 'WebGPU';
  onFrame: ((fps: number) => void) | null = null;
  onStats: ((calls: number, triangles: number) => void) | null = null;
  /** 每渲染帧回调，参数是真实 dt（秒）。整合层在这里驱动逻辑。 */
  onTick: ((dtSec: number) => void) | null = null;
  /** 每帧结束后回调，用于把逻辑状态同步到渲染对象 */
  onSync: (() => void) | null = null;

  get scene(): THREE.Scene { return this.sceneRef; }
  get camera(): THREE.PerspectiveCamera { return this.cameraRef; }
  get canvas(): HTMLCanvasElement {
    const el = this.renderer?.domElement;
    if (!el) throw new Error('[render] canvas 尚未创建');
    return el;
  }

  private readonly host: HTMLElement;
  private readonly sceneRef = new THREE.Scene();
  private readonly cameraRef: THREE.PerspectiveCamera;
  private renderer: THREE.WebGPURenderer | null = null;
  private postFX: PostFX | null = null;
  private spire: Spire | null = null;
  private lava: Lava | null = null;
  private atmosphere: Atmosphere | null = null;

  private lastFrameTime = 0;
  private frames = 0;
  private fpsAccum = 0;
  private elapsed = 0;
  private disposed = false;

  private qualityLocked: QualityTier | null = null;
  private qualityProbe = { active: false, sum: 0, count: 0 };
  private rawMode = false;

  constructor(host: HTMLElement) {
    this.host = host;
    this.cameraRef = new THREE.PerspectiveCamera(VISUAL.camera.fov, 1, VISUAL.camera.near, VISUAL.camera.far);

    const params = new URLSearchParams(window.location.search);
    const shot = params.get('shot');
    const pose: CameraPose =
      shot && VISUAL.camera.shots[shot] ? VISUAL.camera.shots[shot] : VISUAL.camera.spawn;
    this.cameraRef.position.set(...pose.position);
    this.cameraRef.lookAt(...pose.target);
    if (pose.fov) {
      this.cameraRef.fov = pose.fov;
      this.cameraRef.updateProjectionMatrix();
    }

    // 调试用：?cam=x,y,z,tx,ty,tz[,fov] 直接摆机位；?raw=1 绕过整条后处理
    const cam = params.get('cam')?.split(',').map(Number);
    if (cam && cam.length >= 6 && cam.every((v) => Number.isFinite(v))) {
      this.cameraRef.position.set(cam[0], cam[1], cam[2]);
      this.cameraRef.lookAt(cam[3], cam[4], cam[5]);
      if (cam.length >= 7 && cam[6] > 1) {
        this.cameraRef.fov = cam[6];
        this.cameraRef.updateProjectionMatrix();
      }
    }
    this.rawMode = params.get('raw') === '1';
    if (params.get('hud') === '0') {
      const style = document.createElement('style');
      style.textContent = '#app ~ div,#boot-tip{display:none!important}';
      document.head.appendChild(style);
    }

    const q = params.get('quality');
    if (q === 'ultra' || q === 'high' || q === 'medium' || q === 'low') {
      this.qualityLocked = q;
    }
  }

  async init(): Promise<void> {
    const { renderer, backend } = await createRenderer();
    this.renderer = renderer;
    this.backendName = backend;

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = VISUAL.exposure;
    renderer.shadowMap.enabled = true;
    // 一帧里有多条内部渲染通道（场景 pass、阴影、后处理），手动 reset 才能统计到全量 draw call
    renderer.info.autoReset = false;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.host.appendChild(renderer.domElement);

    this.buildScene();
    this.handleResize();
    window.addEventListener('resize', this.handleResize);
    (window as unknown as { __render?: unknown }).__render = {
      scene: this.sceneRef,
      renderer,
      camera: this.cameraRef,
    };
  }

  start(): void {
    if (!this.renderer) throw new Error('渲染器尚未初始化');
    this.lastFrameTime = 0;
    void this.renderer.setAnimationLoop(this.tick);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('resize', this.handleResize);
    void this.renderer?.setAnimationLoop(null);
    this.postFX?.dispose();
    void this.renderer?.dispose();
  }

  private buildScene(): void {
    const renderer = this.renderer;
    if (!renderer) return;

    this.sceneRef.background = new THREE.Color(VISUAL.scene.background);

    this.lava = new Lava(VISUAL);
    this.sceneRef.add(this.lava.mesh);

    this.spire = new Spire(VISUAL);
    this.sceneRef.add(this.spire.group);

    this.atmosphere = new Atmosphere(this.sceneRef, VISUAL);

    const postFX = new PostFX(renderer, this.sceneRef, this.cameraRef, VISUAL);
    postFX.onQualityChanged = (tier) => {
      this.lava?.setOctaves(VISUAL.qualityPresets[tier].lavaOctaves);
      this.applyPixelRatio(tier);
    };
    this.postFX = postFX;

    const quality = this.qualityLocked ?? VISUAL.quality.default;
    if (this.qualityLocked) postFX.setQuality(this.qualityLocked);
    this.applyPixelRatio(quality);
    this.lava.setOctaves(VISUAL.qualityPresets[quality].lavaOctaves);
  }

  private applyPixelRatio(tier: QualityTier): void {
    const renderer = this.renderer;
    if (!renderer) return;
    const ratio = Math.min(window.devicePixelRatio || 1, VISUAL.qualityPresets[tier].pixelRatio);
    renderer.setPixelRatio(ratio);
    this.handleResize();
  }

  private readonly handleResize = (): void => {
    const width = this.host.clientWidth || window.innerWidth;
    const height = this.host.clientHeight || window.innerHeight;
    this.cameraRef.aspect = width / Math.max(1, height);
    this.cameraRef.updateProjectionMatrix();
    this.renderer?.setSize(width, height, false);
  };

  private readonly tick = (time: number): void => {
    const renderer = this.renderer;
    const postFX = this.postFX;
    if (!renderer || !postFX || this.disposed) return;

    // 首帧只记录时间戳，避免把页面加载耗时算进 dt
    const dt = this.lastFrameTime === 0 ? 0 : Math.min((time - this.lastFrameTime) / 1000, 0.1);
    this.lastFrameTime = time;
    this.elapsed += dt;

    this.onTick?.(dt);

    this.spire?.update(dt);
    this.atmosphere?.update(dt);

    renderer.info.reset();
    if (this.rawMode) {
      renderer.render(this.sceneRef, this.cameraRef);
    } else {
      postFX.render();
    }

    this.onSync?.();
    this.autoQuality(dt);
    this.onStats?.(renderer.info.render.drawCalls, renderer.info.render.triangles);

    this.frames += 1;
    this.fpsAccum += dt;
    if (this.fpsAccum >= 0.5) {
      this.onFrame?.(this.frames / this.fpsAccum);
      this.frames = 0;
      this.fpsAccum = 0;
    }
  };

  /** 首 3 秒平均帧时间自动选档；跳过首帧编译卡顿与超过 100ms 的离群帧。 */
  private autoQuality(dt: number): void {
    if (this.qualityLocked || !VISUAL.quality.auto || !this.postFX) return;
    if (this.elapsed < 1) return;

    const probe = this.qualityProbe;
    probe.active = true;

    if (dt > 0.0005 && dt < 0.1) {
      probe.sum += dt;
      probe.count += 1;
    }

    if (this.elapsed >= 1 + VISUAL.quality.sampleSeconds && probe.count > 20) {
      const avgMs = (probe.sum / probe.count) * 1000;
      const tier: QualityTier =
        avgMs > VISUAL.quality.lowAboveMs ? 'low' : avgMs > VISUAL.quality.mediumAboveMs ? 'medium' : 'high';
      this.postFX.setQuality(tier);
      this.qualityProbe = { active: false, sum: 0, count: 0 };
    }
  }
}

async function createRenderer(): Promise<{ renderer: THREE.WebGPURenderer; backend: BackendName }> {
  try {
    const gpu = new THREE.WebGPURenderer({ antialias: true, powerPreference: 'high-performance' });
    await gpu.init();
    const backend = (gpu.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
    return { renderer: gpu, backend };
  } catch (error) {
    // 保险丝：init 抛错时用同一套 WebGPURenderer 强制走 WebGL2 后端，
    // TSL 材质会自动编译成 GLSL，避免逻辑层与材质层分叉。
    console.warn('[render] WebGPU 初始化失败，回落到 WebGL2 后端', error);
    const fallback = new THREE.WebGPURenderer({
      antialias: true,
      powerPreference: 'high-performance',
      forceWebGL: true,
    });
    await fallback.init();
    return { renderer: fallback, backend: 'WebGL2' };
  }
}
