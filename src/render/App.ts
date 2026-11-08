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
  /** 每帧渲染前回调，用于把逻辑状态同步到渲染对象 */
  onSync: (() => void) | null = null;

  get scene(): THREE.Scene { return this.sceneRef; }
  get camera(): THREE.PerspectiveCamera { return this.cameraRef; }
  /** 熔岩海的初始高度（M4-01 的转场/狂暴演出基于它做相对上涨） */
  get lavaBaseY(): number { return VISUAL.lava.y; }
  get canvas(): HTMLCanvasElement {
    const el = this.renderer?.domElement;
    if (!el) throw new Error('[render] canvas 尚未创建');
    return el;
  }

  /** M4-01 演出：把熔岩海整体抬高（不重建材质/管线） */
  setLavaY(y: number): void {
    this.lava?.setLevel(y);
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
  private firstFrameTime = 0;
  private frames = 0;
  private fpsAccum = 0;
  private disposed = false;

  private qualityLocked: QualityTier | null = null;
  /** 自动选档探测：窗口按真实墙钟开合，样本是未钳制的真实帧间隔 */
  private qualityProbe: { start: number; skip: number; done: boolean; samples: number[] } = {
    start: 0,
    skip: 3,
    done: false,
    samples: [],
  };
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
    document.addEventListener('visibilitychange', this.handleVisibility);
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
    document.removeEventListener('visibilitychange', this.handleVisibility);
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
    const rawDt = this.lastFrameTime === 0 ? 0 : (time - this.lastFrameTime) / 1000;
    // 逻辑层要钳制（慢机器单帧 500ms 不能让物体瞬移一大截），测量层必须用 rawDt
    const dt = Math.min(rawDt, 0.1);
    this.lastFrameTime = time;
    if (this.firstFrameTime === 0) this.firstFrameTime = time;

    this.onTick?.(dt);

    this.spire?.update(dt);
    this.atmosphere?.update(dt);
    this.onSync?.();

    renderer.info.reset();
    if (this.rawMode) {
      renderer.render(this.sceneRef, this.cameraRef);
    } else {
      postFX.render();
    }

    this.autoQuality(time, rawDt);
    this.onStats?.(renderer.info.render.drawCalls, renderer.info.render.triangles);

    this.frames += 1;
    this.fpsAccum += rawDt;
    if (this.fpsAccum >= 0.5) {
      this.onFrame?.(this.frames / this.fpsAccum);
      this.frames = 0;
      this.fpsAccum = 0;
    }
  };

  /**
   * 启动 1 秒后按真实帧时间自动选一档（ultra 只能手动选）。
   *
   * 窗口与采样都必须走真实墙钟：慢机器单帧可能超过 1 秒，用钳制到 0.1s 的 dt
   * 累计会把 "3 秒窗口" 拖成几十秒，判决被无限推迟，玩家永远停在默认 high 档。
   */
  private autoQuality(now: number, rawDt: number): void {
    const probe = this.qualityProbe;
    if (probe.done || this.qualityLocked || !VISUAL.quality.auto || !this.postFX) return;

    // 开头这一秒是着色器编译与贴图上传，不计入
    if (now - this.firstFrameTime < 1000) return;
    if (probe.start === 0) probe.start = now;

    // 只跳过开头几帧的编译卡顿，慢机器上 100ms+ 的稳定帧时间也要计入
    if (probe.skip > 0) {
      probe.skip -= 1;
      return;
    }

    if (rawDt > 0.0005 && probe.samples.length < 512) probe.samples.push(rawDt);

    const windowMs = VISUAL.quality.sampleSeconds * 1000;
    const sampledMs = now - probe.start;
    const count = probe.samples.length;
    // 正常情况收满窗口且够 3 帧就判；慢机器 3 秒只够拍一两帧，窗口翻倍后有几帧就判
    const settled = sampledMs >= windowMs && count >= 3;
    const starved = sampledMs >= windowMs * 2 && count >= 1;
    if (!settled && !starved) return;

    // 用 P90 而不是均值：一次卡顿（切档重建、GC）不该被摊薄成"这台机器还行"
    const sorted = probe.samples.slice().sort((a, b) => a - b);
    const p90Ms = sorted[Math.min(count - 1, Math.floor(count * 0.9))] * 1000;
    const tier: QualityTier =
      p90Ms > VISUAL.quality.lowAboveMs ? 'low' : p90Ms > VISUAL.quality.mediumAboveMs ? 'medium' : 'high';
    probe.done = true;
    this.postFX.setQuality(tier);
  }

  /** 重新开窗采样。只用于"回前台"这种采样前提被打断的时刻，判决本身只做一次。 */
  private resetQualityProbe(): void {
    const probe = this.qualityProbe;
    if (probe.done) return;
    probe.start = 0;
    probe.skip = 3;
    probe.samples.length = 0;
  }

  /** 后台标签页的帧间隔不代表设备性能：回前台重新采样，而不是过滤所有长帧。 */
  private readonly handleVisibility = (): void => {
    this.resetQualityProbe();
  };
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
