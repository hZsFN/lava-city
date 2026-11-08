import * as THREE from 'three/webgpu';
import { createBus } from '../core/events';
import { BossEntity } from './BossEntity';
import { BossDebugPanel } from '../ui/BossDebugPanel';
import type { BossSkillId } from './types';

/**
 * M3-01 临时验收页：不接 M0 的 App（渲染 Agent 的场景），
 * 自建最小场景验证 Boss 模型/动画/破绽/事件流。接线方式见交付说明。
 *
 * ?demo=<name>&sim=<ms>  以固定 16ms 步长快进到指定时刻后冻结画面，便于截图/复现。
 */

declare global {
  interface Window {
    __bossPreview?: { boss: BossEntity; bus: ReturnType<typeof createBus> };
  }
}

interface DemoAction {
  at: number;
  run: () => void;
}

async function createRenderer(): Promise<THREE.WebGPURenderer> {
  try {
    const gpu = new THREE.WebGPURenderer({ antialias: true, powerPreference: 'high-performance' });
    await gpu.init();
    return gpu;
  } catch (error) {
    console.warn('[preview] WebGPU 初始化失败，回落到 WebGL2', error);
    const fallback = new THREE.WebGPURenderer({
      antialias: true,
      powerPreference: 'high-performance',
      forceWebGL: true,
    });
    await fallback.init();
    return fallback;
  }
}

async function boot(): Promise<void> {
  const host = document.getElementById('app');
  if (!host) throw new Error('preview.html 缺少 #app');

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07050a);
  scene.fog = new THREE.FogExp2(0x2b0d05, 0.006);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 400);
  const params = new URLSearchParams(location.search);
  const camPreset = params.get('cam') ?? 'default';
  if (camPreset === 'high') {
    camera.position.set(8, 34, 42);
    camera.lookAt(0, 0, 9);
  } else if (camPreset === 'top') {
    camera.position.set(0, 62, 9.5);
    camera.lookAt(0, 0, 9.5);
  } else {
    camera.position.set(12.5, 7.5, 23.5);
    camera.lookAt(0, 4.8, 11.5);
  }
  camera.updateProjectionMatrix();

  const renderer = await createRenderer();
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setPixelRatio(1);
  host.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0x6a7fa8, 0x2a0a04, 1.2));
  const key = new THREE.DirectionalLight(0xffd7b8, 3.1);
  key.position.set(14, 20, 10);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x4b7fff, 1.0);
  rim.position.set(-12, 8, -16);
  scene.add(rim);
  const fill = new THREE.DirectionalLight(0x9fc0ff, 0.9);
  fill.position.set(-16, 12, 18);
  scene.add(fill);
  const lavaLight = new THREE.PointLight(0xff5a12, 420, 120, 2);
  lavaLight.position.set(0, 1.6, 0);
  scene.add(lavaLight);

  const ground = new THREE.Mesh(
    new THREE.BoxGeometry(40, 1.4, 40),
    new THREE.MeshStandardMaterial({ color: 0x3c3b44, roughness: 0.92, metalness: 0.06 }),
  );
  ground.position.y = -0.7;
  scene.add(ground);

  const lava = new THREE.Mesh(
    new THREE.PlaneGeometry(150, 150),
    new THREE.MeshStandardMaterial({
      color: 0x1b0603,
      roughness: 0.35,
      metalness: 0,
      emissive: 0xff5a12,
      emissiveIntensity: 1.1,
    }),
  );
  lava.rotation.x = -Math.PI / 2;
  lava.position.y = -1.8;
  scene.add(lava);

  const tower = new THREE.Mesh(
    new THREE.CylinderGeometry(7, 7.8, 24, 14),
    new THREE.MeshStandardMaterial({
      color: 0x2b2a30,
      roughness: 0.85,
      metalness: 0.12,
      flatShading: true,
    }),
  );
  tower.position.y = 12;
  scene.add(tower);
  for (const y of [7, 13, 19]) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(7.15, 0.14, 6, 48),
      new THREE.MeshBasicMaterial({ color: 0xff6a2a }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = y;
    scene.add(ring);
  }

  const boundary = new THREE.Mesh(
    new THREE.RingGeometry(18.85, 19, 96),
    new THREE.MeshBasicMaterial({ color: 0x6a3a28, side: THREE.DoubleSide }),
  );
  boundary.rotation.x = -Math.PI / 2;
  boundary.position.y = 0.03;
  scene.add(boundary);

  const player = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.4, 0.9, 4, 10),
    new THREE.MeshStandardMaterial({
      color: 0xdfe8ff,
      emissive: 0x4aa8ff,
      emissiveIntensity: 0.6,
      roughness: 0.4,
    }),
  );
  player.position.set(0, 0.85, 18);
  scene.add(player);

  const bus = createBus();
  bus.emit('PlayerSpawned', { pos: [0, 0, 18] });
  bus.emit('PlayerDamaged', { amount: 0, hp: 100, maxHp: 100, source: 'preview' });
  bus.emit('PlayerMoved', { pos: [0, 0, 18], yaw: 0 });
  bus.on('PlayerMoved', (p) => {
    player.position.set(p.pos[0], 0.85, p.pos[2]);
  });

  const boss = new BossEntity(bus);
  boss.attachTo(scene);
  let simClock = 0;
  new BossDebugPanel(bus, boss, () => simClock);
  window.__bossPreview = { boss, bus };

  const demo = params.get('demo') ?? 'idle';
  const simMs = Number(params.get('sim') ?? 0);
  const caption = document.getElementById('caption');
  if (caption) {
    const extra = caption.querySelector('span');
    if (extra) {
      extra.textContent = `demo=${demo}${simMs > 0 ? ` · sim=${simMs}ms` : ''}${camPreset === 'high' ? ' · cam=high' : ''}`;
    }
  }

  boss.setAiEnabled(demo === 'auto30');
  const actions = buildActions(boss, demo);

  const resize = (): void => {
    const width = host.clientWidth || window.innerWidth;
    const height = host.clientHeight || window.innerHeight;
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  };
  resize();
  window.addEventListener('resize', () => {
    resize();
    renderer.render(scene, camera);
  });

  // 检视按钮：Boss 初始背对玩家，这个按钮把相机绕到它正前方看脸
  {
    const btn = document.createElement('button');
    btn.textContent = '看正面';
    btn.style.cssText =
      'position:fixed;top:16px;right:16px;z-index:9999;padding:9px 16px;' +
      'background:#7a2a12;color:#ffd9b0;border:1px solid #ff6a1e;border-radius:6px;' +
      'font:13px/1 system-ui,sans-serif;cursor:pointer;letter-spacing:.05em';
    let facing = false;
    btn.onclick = () => {
      facing = !facing;
      if (facing) {
        camera.position.set(0, 8.5, -13);
        camera.lookAt(0, 6.5, 9.5);
      } else {
        camera.position.set(12.5, 7.5, 23.5);
        camera.lookAt(0, 4.8, 11.5);
      }
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      btn.textContent = facing ? '看背面' : '看正面';
    };
    document.body.appendChild(btn);
  }

  if (simMs > 0) {
    const step = 16;
    let next = 0;
    for (let t = 0; t <= simMs; t += step) {
      simClock = t;
      while (next < actions.length && actions[next].at <= t) {
        actions[next].run();
        next += 1;
      }
      boss.update(step);
    }
    simClock = simMs;
    renderer.render(scene, camera);
    return;
  }

  for (const action of actions) {
    window.setTimeout(action.run, action.at);
  }

  let last = 0;
  renderer.setAnimationLoop((time: number) => {
    const dtMs = last === 0 ? 0 : Math.min(time - last, 100);
    last = time;
    simClock += dtMs;
    boss.update(dtMs);
    renderer.render(scene, camera);
  });
}

/** 所有演示都写成「时刻 -> 动作」，同一套脚本既可用于快进截图，也可用于实时点按。 */
function buildActions(boss: BossEntity, demo: string): DemoAction[] {
  const cast = (at: number, id: BossSkillId): DemoAction => ({
    at,
    run: () => boss.forceSkill(id),
  });
  switch (demo) {
    case 'rocksweep':
    case 'rocksweepWeak':
      return [cast(400, 'rockSweep')];
    case 'leapslam':
      return [cast(400, 'leapSlam')];
    case 'coredrain':
      return [
        { at: 100, run: () => boss.damageSelf() },
        cast(300, 'coreDrain'),
        { at: 4200, run: () => boss.interrupt() },
      ];
    case 'coredrainActive':
      return [{ at: 100, run: () => boss.damageSelf() }, cast(300, 'coreDrain')];
    case 'pillars':
      return [cast(400, 'stonePillars')];
    case 'phase2':
      return [{ at: 300, run: () => boss.setPhase(2) }];
    case 'breathback':
      return [
        { at: 200, run: () => boss.setPhase(2) },
        {
          at: 8200,
          run: () => {
            boss.setTaunt(true);
            boss.forceSkill('magmaBreath');
          },
        },
      ];
    case 'charge':
      return [
        { at: 200, run: () => boss.setPhase(2) },
        { at: 3400, run: () => boss.setPlayerDistance(5) },
        cast(3600, 'lavaCharge'),
      ];
    case 'firerain':
      return [cast(400, 'fireRain')];
    case 'rage':
      return [
        { at: 100, run: () => boss.enterRage() },
        cast(300, 'fireRain'),
      ];
    case 'ignite':
      return [
        { at: 400, run: () => boss.freezeFull() },
        cast(600, 'selfIgnite'),
      ];
    case 'igniteOk':
      return [cast(400, 'selfIgnite')];
    case 'director':
      // 空转 26 s（无破绽），再放开 AI：Director 应强制下一次技能带破绽
      return [{ at: 26000, run: () => boss.setAiEnabled(true) }];
    case 'auto30':
    default:
      return [];
  }
}

void boot().catch((error: unknown) => {
  console.error('[preview] 启动失败', error);
  const caption = document.getElementById('caption');
  if (caption) {
    caption.textContent = '预览启动失败：' + (error instanceof Error ? error.message : String(error));
  }
});
