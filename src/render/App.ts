import * as THREE from 'three/webgpu';
import { texture, uniform, uv, vec2 } from 'three/tsl';
import visual from '../core/config/visual.json';
import { createRng } from '../core/rng';

export type BackendName = 'WebGPU' | 'WebGL2';

/**
 * M0 渲染骨架：WebGPU 渲染器 + 灰盒地面 + 一块程序化流动的熔岩平面。
 * 本文件不承载任何玩法，只证明「渲染器初始化 -> 场景呈现 -> 逐帧更新」链路成立。
 */
export class App {
  backendName: BackendName = 'WebGPU';
  onFrame: ((fps: number) => void) | null = null;

  private readonly host: HTMLElement;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly clock = new THREE.Clock();
  private readonly flowTime = uniform(0);
  private renderer: THREE.WebGPURenderer | null = null;
  private frames = 0;
  private fpsAccum = 0;
  private disposed = false;

  constructor(host: HTMLElement) {
    this.host = host;
    this.camera = new THREE.PerspectiveCamera(visual.camera.fov, 1, 0.1, 400);
    this.camera.position.set(...(visual.camera.position as [number, number, number]));
    this.camera.lookAt(...(visual.camera.target as [number, number, number]));
  }

  async init(): Promise<void> {
    const { renderer, backend } = await createRenderer();
    this.renderer = renderer;
    this.backendName = backend;

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = visual.exposure;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(this.host.clientWidth || window.innerWidth, this.host.clientHeight || window.innerHeight, false);
    this.host.appendChild(renderer.domElement);

    this.buildScene();
    this.handleResize();
    window.addEventListener('resize', this.handleResize);
  }

  start(): void {
    if (!this.renderer) throw new Error('渲染器尚未初始化');
    this.clock.start();
    void this.renderer.setAnimationLoop(this.tick);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('resize', this.handleResize);
    void this.renderer?.setAnimationLoop(null);
    void this.renderer?.dispose();
  }

  private buildScene(): void {
    this.scene.background = new THREE.Color(visual.scene.background);
    this.scene.fog = new THREE.FogExp2(visual.scene.fog, visual.scene.fogDensity);

    const ground = new THREE.Mesh(
      new THREE.BoxGeometry(40, 1.4, 40),
      new THREE.MeshStandardNodeMaterial({
        color: new THREE.Color(visual.scene.ground),
        roughness: 0.92,
        metalness: 0.06,
      }),
    );
    ground.position.y = -0.7;
    this.scene.add(ground);

    const lavaTexture = createLavaTexture();
    const baseUv = uv().mul(6);
    const flowA = baseUv.add(vec2(this.flowTime.mul(0.02), this.flowTime.mul(0.008)));
    const flowB = baseUv.mul(1.9).add(vec2(this.flowTime.mul(-0.012), this.flowTime.mul(0.016)));
    const sampleA = texture(lavaTexture, flowA).rgb;
    const sampleB = texture(lavaTexture, flowB).rgb;
    const lavaGlow = sampleA.mul(0.95).add(sampleB.mul(0.55));

    const lavaMaterial = new THREE.MeshStandardNodeMaterial({
      color: new THREE.Color(visual.scene.lavaBase),
      roughness: 0.35,
      metalness: 0,
    });
    lavaMaterial.emissiveNode = lavaGlow.mul(visual.lava.emissive);

    const lava = new THREE.Mesh(new THREE.PlaneGeometry(visual.lava.size, visual.lava.size), lavaMaterial);
    lava.rotation.x = -Math.PI / 2;
    lava.position.y = visual.lava.y;
    this.scene.add(lava);

    // 冷暖对比：暖色主光 + 熔岩点光，补一盏冷色轮廓光
    this.scene.add(new THREE.HemisphereLight(0x6a7fa8, 0x2a0a04, 0.9));
    const key = new THREE.DirectionalLight(0xffd7b8, 2.4);
    key.position.set(14, 20, 10);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x4b7fff, 0.7);
    rim.position.set(-12, 8, -16);
    this.scene.add(rim);
    const lavaLight = new THREE.PointLight(0xff5a12, 420, 120, 2);
    lavaLight.position.set(0, 1.6, 0);
    this.scene.add(lavaLight);
  }

  private readonly handleResize = (): void => {
    const width = this.host.clientWidth || window.innerWidth;
    const height = this.host.clientHeight || window.innerHeight;
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.renderer?.setSize(width, height, false);
  };

  private readonly tick = (): void => {
    const renderer = this.renderer;
    if (!renderer || this.disposed) return;

    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.flowTime.value += dt * visual.lava.flowSpeed;
    renderer.render(this.scene, this.camera);

    this.frames += 1;
    this.fpsAccum += dt;
    if (this.fpsAccum >= 0.5) {
      this.onFrame?.(this.frames / this.fpsAccum);
      this.frames = 0;
      this.fpsAccum = 0;
    }
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

/** 用 Canvas 2D 程序化生成可平铺的熔岩贴图：无外部资产、无禁止扩展名。 */
function createLavaTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');

  ctx.fillStyle = '#120301';
  ctx.fillRect(0, 0, size, size);

  const rng = createRng(0x1a7e4b);
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 130; i += 1) {
    const heat = rng();
    const inner = heat > 0.72 ? '#ffe3ae' : heat > 0.4 ? '#ff8a24' : '#7d1c03';
    const outer = heat > 0.72 ? 'rgba(255,138,36,0.45)' : 'rgba(90,18,2,0.35)';
    drawWrappedBlob(ctx, size, rng() * size, rng() * size, 6 + rng() * 40, inner, outer);
  }

  // 冷却结壳：压暗高光，避免整面均匀发光
  ctx.globalCompositeOperation = 'multiply';
  for (let i = 0; i < 40; i += 1) {
    drawWrappedBlob(ctx, size, rng() * size, rng() * size, 10 + rng() * 34, 'rgba(28,10,6,0.9)', 'rgba(120,60,30,0)');
  }
  ctx.globalCompositeOperation = 'source-over';

  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 4;
  return map;
}

/** 在九宫格偏移上重复绘制，保证贴图四边可无缝平铺。 */
function drawWrappedBlob(
  ctx: CanvasRenderingContext2D,
  size: number,
  x: number,
  y: number,
  radius: number,
  inner: string,
  outer: string,
): void {
  for (const dx of [-size, 0, size]) {
    for (const dy of [-size, 0, size]) {
      const cx = x + dx;
      const cy = y + dy;
      const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      gradient.addColorStop(0, inner);
      gradient.addColorStop(1, outer);
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
