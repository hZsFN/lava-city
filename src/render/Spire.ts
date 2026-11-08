import * as THREE from 'three/webgpu';
import {
  abs,
  cameraPosition,
  dot,
  float,
  mix,
  mx_noise_float,
  normalWorld,
  normalize,
  positionWorld,
  smoothstep,
  time,
  uv,
  vec3,
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { VisualConfig } from './config';
import { PALETTE } from './palette';
import { createRng } from '../core/rng';

type GeometryList = THREE.BufferGeometry[];

const TAU = Math.PI * 2;

/**
 * 熔心孤塔的全部程序化几何。
 * 所有尺寸来自 visual.json 的硬约束表，本文件不允许再缩放任何关键半径/高度。
 *
 * 几何按材质合并成三批（岩体 / 黑曜石 / 发光体），配合少量动态对象
 * （塔心、护罩环、升降石台、光柱），把 draw call 压在个位数。
 */
export class Spire {
  readonly group = new THREE.Group();

  private readonly cfg: VisualConfig;
  private readonly elevator: THREE.Mesh;
  private readonly shield = new THREE.Group();
  private coreRoot!: THREE.Group;
  private coreMesh!: THREE.Mesh;
  private elapsed = 0;

  constructor(cfg: VisualConfig) {
    this.cfg = cfg;

    const rock: GeometryList = [];
    const obsidian: GeometryList = [];
    const rune: GeometryList = [];

    this.buildTower(rock, obsidian, rune);
    this.buildTopPlatform(rock, obsidian, rune);
    this.buildSecondFloor(rock, obsidian, rune);
    this.buildRings(rock, obsidian, rune);
    this.buildBridges(rock, obsidian, rune);
    this.buildCantilevers(rock, obsidian, rune);
    this.buildSpiral(rock, obsidian, rune);
    this.buildElevatorShaft(rock, obsidian);
    this.buildCavern(rock);

    const rockMaterial = createRockMaterial();
    const obsidianMaterial = new THREE.MeshStandardNodeMaterial({
      color: new THREE.Color(PALETTE.obsidian),
      roughness: 0.22,
      metalness: 0.5,
      flatShading: true,
    });
    const runeMaterial = createRuneMaterial();

    const rockMesh = new THREE.Mesh(mergeOrThrow(rock), rockMaterial);
    rockMesh.name = 'spire-rock';
    rockMesh.castShadow = true;
    rockMesh.receiveShadow = true;
    this.group.add(rockMesh);

    const obsidianMesh = new THREE.Mesh(mergeOrThrow(obsidian), obsidianMaterial);
    obsidianMesh.name = 'spire-obsidian';
    obsidianMesh.castShadow = true;
    obsidianMesh.receiveShadow = true;
    this.group.add(obsidianMesh);

    const runeMesh = new THREE.Mesh(mergeOrThrow(rune), runeMaterial);
    runeMesh.name = 'spire-runes';
    this.group.add(runeMesh);

    this.coreRoot = this.buildCore();
    this.group.add(this.coreRoot);
    this.group.add(this.buildShield());
    this.group.add(this.buildBeacon());

    this.elevator = new THREE.Mesh(
      new THREE.BoxGeometry(cfg.spire.elevator.size, cfg.spire.elevator.thickness, cfg.spire.elevator.size),
      rockMaterial,
    );
    this.elevator.name = 'spire-elevator';
    this.elevator.castShadow = true;
    this.elevator.receiveShadow = true;
    this.elevator.position.set(cfg.spire.elevator.x, cfg.spire.elevator.minY, 0);
    this.group.add(this.elevator);
  }

  update(dt: number): void {
    this.elapsed += dt;
    const t = this.elapsed;

    const e = this.cfg.spire.elevator;
    const cycle = 12;
    const phase = t % cycle;
    const span = e.maxY - e.minY;
    let y = e.minY;
    if (phase < 4.5) {
      y = e.minY + span * easeInOut(phase / 4.5);
    } else if (phase < 5.5) {
      y = e.maxY;
    } else if (phase < 10) {
      y = e.maxY - span * easeInOut((phase - 5.5) / 4.5);
    }
    this.elevator.position.y = y;

    this.shield.rotation.y = t * 0.22;
    this.shield.rotation.z = Math.sin(t * 0.31) * 0.12;

    const pulse = 1 + Math.sin(t * 1.7) * 0.014;
    this.coreMesh.scale.setScalar(pulse);
  }

  // ───────────────────────────── 塔身 ─────────────────────────────

  private buildTower(rock: GeometryList, obsidian: GeometryList, rune: GeometryList): void {
    const t = this.cfg.spire.tower;
    const sides = t.sides;
    const apothem = t.circumradius * Math.cos(Math.PI / sides);
    const side = 2 * t.circumradius * Math.sin(Math.PI / sides);
    const wall = t.wallThickness;
    const height = t.topY - t.baseY;

    for (let i = 0; i < sides; i += 1) {
      const a = (i + 0.5) * (TAU / sides);
      const nx = Math.cos(a);
      const nz = Math.sin(a);
      const tx = Math.sin(a);
      const tz = -Math.cos(a);
      const rotY = Math.PI / 2 - a;
      const radius = apothem - wall / 2;
      const cx = nx * radius;
      const cz = nz * radius;
      const width = side + 0.16;

      // 基座（拱门以下）
      rock.push(
        place(
          new THREE.BoxGeometry(width, t.archBottom - t.baseY, wall),
          [cx, (t.archBottom + t.baseY) / 2, cz],
          rotY,
        ),
      );

      // 拱门两侧墙垛
      const pillar = (side - t.archWidth) / 2;
      const offset = (t.archWidth + pillar) / 2;
      for (const sign of [-1, 1]) {
        rock.push(
          place(
            new THREE.BoxGeometry(pillar, t.archTop - t.archBottom, wall),
            [cx + tx * offset * sign, (t.archTop + t.archBottom) / 2, cz + tz * offset * sign],
            rotY,
          ),
        );
      }

      // 拱门过梁以上到塔顶
      rock.push(
        place(new THREE.BoxGeometry(width, t.topY - t.archTop, wall), [cx, (t.topY + t.archTop) / 2, cz], rotY),
      );

      // 拱门发光符文（内缘一圈）
      rune.push(
        place(
          new THREE.BoxGeometry(t.archWidth * 0.96, 0.04, 0.05),
          [cx - nx * (wall * 0.55), t.archTop - 0.12, cz - nz * (wall * 0.55)],
          rotY,
        ),
      );
    }

    // 塔身竖棱：黑曜石嵌条
    for (let i = 0; i < sides; i += 1) {
      const a = i * (TAU / sides);
      obsidian.push(
        place(
          new THREE.BoxGeometry(0.52, height, 0.52),
          [Math.cos(a) * (t.circumradius - 0.12), (t.baseY + t.topY) / 2, Math.sin(a) * (t.circumradius - 0.12)],
          Math.PI / 2 - a,
        ),
      );
    }

    // 两道水平腰箍
    for (const bandY of [8.02, 23.25]) {
      for (let i = 0; i < sides; i += 1) {
        const a = (i + 0.5) * (TAU / sides);
        obsidian.push(
          place(
            new THREE.BoxGeometry(side + 0.5, 0.24, wall + 0.16),
            [Math.cos(a) * (apothem - wall / 2), bandY, Math.sin(a) * (apothem - wall / 2)],
            Math.PI / 2 - a,
          ),
        );
      }
    }
  }

  // ───────────────────────────── 塔顶 ─────────────────────────────

  private buildTopPlatform(rock: GeometryList, obsidian: GeometryList, rune: GeometryList): void {
    const p = this.cfg.spire.topPlatform;
    const y = p.y;

    rock.push(
      new THREE.CylinderGeometry(p.radius, p.radius * 0.9, p.thickness, 48, 1)
        .translate(0, y - p.thickness / 2, 0)
        .toNonIndexed(),
    );

    const segments = p.parapetSegments;
    const arc = (TAU * p.parapetRadius) / segments;
    for (let i = 0; i < segments; i += 1) {
      const a = i * (TAU / segments);
      const rotY = Math.PI / 2 - a;
      const cx = Math.cos(a) * p.parapetRadius;
      const cz = Math.sin(a) * p.parapetRadius;
      const length = arc * 0.78;

      rock.push(place(new THREE.BoxGeometry(length, p.parapetHeight, p.parapetWidth), [cx, y + p.parapetHeight / 2, cz], rotY));
      obsidian.push(
        place(
          new THREE.BoxGeometry(length + 0.04, 0.12, p.parapetWidth + 0.1),
          [cx, y + p.parapetHeight + 0.06, cz],
          rotY,
        ),
      );
      // 压顶上的符文灯带：从上往下看时勾出塔顶边界
      rune.push(
        place(
          new THREE.BoxGeometry(length * 0.7, 0.011, 0.09),
          [cx, y + p.parapetHeight + 0.135, cz],
          rotY,
        ),
      );
      // 矮墙外侧符文槽
      rune.push(
        place(
          new THREE.BoxGeometry(length * 0.66, 0.038, 0.028),
          [
            Math.cos(a) * (p.parapetRadius + p.parapetWidth / 2 + 0.02),
            y + p.parapetHeight * 0.56,
            Math.sin(a) * (p.parapetRadius + p.parapetWidth / 2 + 0.02),
          ],
          rotY,
        ),
      );
      // 矮墙内侧符文（站在塔顶时的主要视觉线索）
      rune.push(
        place(
          new THREE.BoxGeometry(length * 0.58, 0.05, 0.028),
          [
            Math.cos(a) * (p.parapetRadius - p.parapetWidth / 2 - 0.02),
            y + p.parapetHeight * 0.6,
            Math.sin(a) * (p.parapetRadius - p.parapetWidth / 2 - 0.02),
          ],
          rotY,
        ),
      );
      // 内侧面两端的竖向符文，暗示矮墙的块体分节
      for (const sign of [-1, 1]) {
        const ta = a + (sign * (length * 0.4)) / p.parapetRadius;
        rune.push(
          place(
            new THREE.BoxGeometry(0.03, p.parapetHeight * 0.55, 0.025),
            [
              Math.cos(ta) * (p.parapetRadius - p.parapetWidth / 2 - 0.03),
              y + p.parapetHeight * 0.36,
              Math.sin(ta) * (p.parapetRadius - p.parapetWidth / 2 - 0.03),
            ],
            Math.PI / 2 - ta,
          ),
        );
      }
    }

    // 矮墙与地面的交接灯带
    rune.push(
      new THREE.TorusGeometry(p.parapetRadius - 0.36, 0.018, 4, 96)
        .rotateX(Math.PI / 2)
        .translate(0, y + 0.012, 0)
        .toNonIndexed(),
    );

    // 塔顶地面符文：两个同心环 + 10 道放射槽（自发光，不违反"向上的面黑"）
    for (const r of [3.1, 5.35]) {
      rune.push(new THREE.TorusGeometry(r, 0.028, 4, 72).rotateX(Math.PI / 2).translate(0, y + 0.012, 0).toNonIndexed());
    }
    for (let i = 0; i < 10; i += 1) {
      const a = (i / 10) * TAU + Math.PI / 10;
      const r0 = 2.1;
      const r1 = 6.6;
      rune.push(
        place(
          new THREE.BoxGeometry(r1 - r0, 0.014, 0.03),
          [Math.cos(a) * ((r0 + r1) / 2), y + 0.01, Math.sin(a) * ((r0 + r1) / 2)],
          -a,
        ),
      );
    }

    // 塔顶中央：灯座
    rock.push(new THREE.CylinderGeometry(2.05, 2.35, 0.5, 8, 1).translate(0, y + 0.25, 0).toNonIndexed());
    obsidian.push(new THREE.CylinderGeometry(2.1, 2.1, 0.16, 8, 1).translate(0, y + 0.54, 0).toNonIndexed());
  }

  // ───────────────────────────── 二层 / 底层 ─────────────────────────────

  private buildSecondFloor(rock: GeometryList, obsidian: GeometryList, rune: GeometryList): void {
    const f = this.cfg.spire.secondFloor;
    ringSlab(rock, f.inner, f.outer, f.y, f.thickness, 64);

    // 外沿防护栏
    const posts = 24;
    for (let i = 0; i < posts; i += 1) {
      const a = (i / posts) * TAU;
      obsidian.push(
        place(
          new THREE.BoxGeometry(0.12, 0.95, 0.12),
          [Math.cos(a) * (f.outer - 0.1), f.y + 0.48, Math.sin(a) * (f.outer - 0.1)],
          Math.PI / 2 - a,
        ),
      );
    }
    const rail = new THREE.TorusGeometry(f.outer - 0.1, 0.06, 6, 72).rotateX(Math.PI / 2).translate(0, f.y + 0.96, 0);
    obsidian.push(rail.toNonIndexed());

    // 底部斜撑
    const struts = f.struts;
    for (let i = 0; i < struts; i += 1) {
      const a = (i + 0.5) * (TAU / struts);
      const from = new THREE.Vector3(Math.cos(a) * 6.85, f.y - 3.05, Math.sin(a) * 6.85);
      const to = new THREE.Vector3(Math.cos(a) * 9.45, f.y - f.thickness - 0.05, Math.sin(a) * 9.45);
      rock.push(beam(from, to, 0.34, 0.34));
    }

    // 二层外沿符文
    rune.push(
      new THREE.TorusGeometry(f.outer - 0.28, 0.025, 4, 84).rotateX(Math.PI / 2).translate(0, f.y + 0.012, 0).toNonIndexed(),
    );
  }

  private buildRings(rock: GeometryList, obsidian: GeometryList, rune: GeometryList): void {
    const g = this.cfg.spire.groundFloor;
    const mid = this.cfg.spire.midRing;
    const outer = this.cfg.spire.outerRing;

    ringSlab(rock, g.inner, g.outer, g.y, g.thickness, 96);
    ringSlab(rock, mid.inner, mid.outer, mid.y, mid.thickness, 112);
    ringSlab(rock, outer.inner, outer.outer, outer.y, outer.thickness, 112);

    addRim(rock, obsidian, rune, g.outer);
    addRim(rock, obsidian, rune, mid.outer);
    addRim(rock, obsidian, rune, outer.outer);

    // 平台顶面的符文环与放射槽：向上不被照亮，只能靠自发光把布局读出来
    for (const r of [9.4, 12.3]) addRuneRing(rune, r, 0.012);
    for (const r of [15.2, 18.6]) addRuneRing(rune, r, 0.012);
    for (const r of [33.3, 35.1]) addRuneRing(rune, r, 0.012);
    addRuneSpokes(rune, 8, 8.2, 12.9, Math.PI / 8);
    addRuneSpokes(rune, 8, 14.2, 19.2, Math.PI / 8);
    addRuneSpokes(rune, 8, 32.6, 35.4, 0);

    addSpikes(rock, g.inner, g.outer, g.y - g.thickness, g.undersideSpikes);
    addSpikes(rock, mid.inner, mid.outer, mid.y - mid.thickness, mid.undersideSpikes);

    for (const deg of mid.slotAngles) {
      addSlotPedestal(rock, obsidian, rune, deg, mid.slotRadius, mid.slotRadiusSize);
    }
    for (const deg of outer.slotAngles) {
      addSlotPedestal(rock, obsidian, rune, deg, outer.slotRadius, outer.slotRadiusSize);
    }
  }

  // ───────────────────────────── 石桥 ─────────────────────────────

  private buildBridges(rock: GeometryList, obsidian: GeometryList, rune: GeometryList): void {
    const b = this.cfg.spire.bridges;
    const span = b.outer - b.inner;
    const half = b.width / 2;

    for (const deg of b.angles) {
      const a = (deg * Math.PI) / 180;
      const parts: { list: GeometryList; geo: THREE.BufferGeometry }[] = [];
      const push = (list: GeometryList, geo: THREE.BufferGeometry): void => {
        geo.rotateY(a);
        parts.push({ list, geo });
      };

      push(
        rock,
        new THREE.BoxGeometry(span, b.slabThickness, b.width)
          .translate(b.inner + span / 2, -b.slabThickness / 2, 0)
          .toNonIndexed(),
      );

      const posts = 5;
      for (let i = 0; i < posts; i += 1) {
        const x = b.inner + 1 + (i / (posts - 1)) * (span - 2);
        for (const sign of [-1, 1]) {
          push(
            obsidian,
            new THREE.BoxGeometry(0.1, 1, 0.1).translate(x, 0.5, sign * (half - 0.1)).toNonIndexed(),
          );
        }
      }
      for (const sign of [-1, 1]) {
        push(
          obsidian,
          new THREE.BoxGeometry(span - 0.5, 0.08, 0.08).translate(b.inner + span / 2, 1.02, sign * (half - 0.1)).toNonIndexed(),
        );
        push(
          rune,
          new THREE.BoxGeometry(span - 1.2, 0.015, 0.035).translate(b.inner + span / 2, 0.015, sign * (half - 0.42)).toNonIndexed(),
        );
      }

      // 桥下拱肋
      const ribs = 12;
      for (let i = 0; i < ribs; i += 1) {
        const t = (i + 0.5) / ribs;
        const x = b.inner + span * t;
        const y = -b.slabThickness - 0.3 - Math.sin(t * Math.PI) * 1.5;
        push(
          obsidian,
          new THREE.BoxGeometry((span / ribs) * 1.08, 0.24, b.width * 0.55).translate(x, y, 0).toNonIndexed(),
        );
      }

      for (const part of parts) part.list.push(part.geo);
    }
  }

  // ───────────────────────────── 塔身悬臂 ─────────────────────────────

  private buildCantilevers(rock: GeometryList, obsidian: GeometryList, rune: GeometryList): void {
    const c = this.cfg.spire.cantilevers;

    for (const deg of c.angles) {
      const a = (deg * Math.PI) / 180;
      const inner = c.inner;
      const outer = c.outer;
      const halfInner = 1.35;
      const halfOuter = 1.95;

      const shape = new THREE.Shape();
      shape.moveTo(inner, -halfInner);
      shape.lineTo(outer, -halfOuter);
      shape.lineTo(outer, halfOuter);
      shape.lineTo(inner, halfInner);
      shape.closePath();

      const slab = new THREE.ExtrudeGeometry(shape, { depth: c.thickness, bevelEnabled: false, steps: 1 });
      slab.rotateX(-Math.PI / 2);
      slab.translate(0, c.y - c.thickness, 0);

      const local: { list: GeometryList; geo: THREE.BufferGeometry }[] = [
        { list: rock, geo: slab.toNonIndexed() },
        {
          list: rock,
          geo: new THREE.ConeGeometry(0.9, 2.6, 5)
            .rotateX(Math.PI)
            .translate(outer - 0.9, c.y - c.thickness - 1.3, 0)
            .toNonIndexed(),
        },
      ];

      for (const sign of [-1, 1]) {
        local.push({
          list: rock,
          geo: beam(
            new THREE.Vector3(6.9, c.y - 2.5, sign * 0.7),
            new THREE.Vector3(9.7, c.y - c.thickness + 0.05, sign * 1.15),
            0.3,
            0.3,
          ),
        });
      }

      local.push({
        list: obsidian,
        geo: new THREE.BoxGeometry(0.14, 0.1, halfOuter * 2 + 0.1).translate(outer + 0.02, c.y + 0.04, 0).toNonIndexed(),
      });
      local.push({
        list: rune,
        geo: new THREE.BoxGeometry(0.05, 0.018, halfOuter * 1.5).translate(outer - 0.55, c.y + 0.025, 0).toNonIndexed(),
      });

      for (const part of local) {
        part.geo.rotateY(a);
        part.list.push(part.geo);
      }
    }
  }

  // ───────────────────────────── 螺旋外廊 ─────────────────────────────

  private buildSpiral(rock: GeometryList, obsidian: GeometryList, rune: GeometryList): void {
    const s = this.cfg.spire.spiral;
    const segments = s.segments;
    const a0 = (s.startAngle * Math.PI) / 180;
    const total = s.turns * TAU;
    const rIn = s.radius - s.width / 2;
    const rOut = s.radius + s.width / 2;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    const index = (i: number, outer: number, lower: number): number => i * 4 + outer * 2 + lower;

    for (let i = 0; i <= segments; i += 1) {
      const t = i / segments;
      const a = a0 + total * t;
      const y = s.bottom + (s.top - s.bottom) * t;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      for (const r of [rIn, rOut]) {
        positions.push(ca * r, y, sa * r);
        positions.push(ca * r, y - s.thickness, sa * r);
        uvs.push(i / segments, r === rIn ? 0 : 1);
        uvs.push(i / segments, r === rIn ? 0 : 1);
      }
    }

    for (let i = 0; i < segments; i += 1) {
      const a = index(i, 0, 0);
      const b = index(i, 1, 0);
      const c = index(i + 1, 0, 0);
      const d = index(i + 1, 1, 0);
      indices.push(a, c, b, b, c, d); // 顶面

      const e = index(i, 1, 1);
      const f = index(i, 0, 1);
      const g = index(i + 1, 1, 1);
      const h = index(i + 1, 0, 1);
      indices.push(e, g, f, f, g, h); // 底面

      const oa = index(i, 1, 0);
      const ob = index(i, 1, 1);
      const oc = index(i + 1, 1, 0);
      const od = index(i + 1, 1, 1);
      indices.push(oa, ob, oc, oc, ob, od); // 外立面
    }

    const walk = new THREE.BufferGeometry();
    walk.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    walk.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    walk.setIndex(indices);
    walk.computeVertexNormals();
    const walkFlat = walk.toNonIndexed();
    walk.dispose();
    rock.push(walkFlat);

    // 外侧扶手
    const posts = 24;
    for (let i = 0; i <= posts; i += 1) {
      const t = i / posts;
      const a = a0 + total * t;
      const y = s.bottom + (s.top - s.bottom) * t;
      obsidian.push(
        place(
          new THREE.BoxGeometry(0.09, 0.95, 0.09),
          [Math.cos(a) * (rOut - 0.08), y + 0.48, Math.sin(a) * (rOut - 0.08)],
          Math.PI / 2 - a,
        ),
      );
      if (i < posts) {
        const t2 = (i + 1) / posts;
        const a2 = a0 + total * t2;
        const y2 = s.bottom + (s.top - s.bottom) * t2;
        obsidian.push(
          beam(
            new THREE.Vector3(Math.cos(a) * (rOut - 0.08), y + 0.96, Math.sin(a) * (rOut - 0.08)),
            new THREE.Vector3(Math.cos(a2) * (rOut - 0.08), y2 + 0.96, Math.sin(a2) * (rOut - 0.08)),
            0.07,
            0.07,
          ),
        );
      }
    }

    // 外廊符文槽
    for (let i = 0; i < 36; i += 1) {
      const t = (i + 0.5) / 36;
      const a = a0 + total * t;
      const y = s.bottom + (s.top - s.bottom) * t;
      rune.push(
        place(
          new THREE.BoxGeometry(0.55, 0.015, 0.028),
          [Math.cos(a) * (rOut + 0.005), y + 0.3, Math.sin(a) * (rOut + 0.005)],
          Math.PI / 2 - a,
        ),
      );
    }
  }

  // ───────────────────────────── 升降石台竖井 ─────────────────────────────

  private buildElevatorShaft(rock: GeometryList, obsidian: GeometryList): void {
    const e = this.cfg.spire.elevator;
    const half = e.size / 2 + 0.18;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        obsidian.push(
          new THREE.BoxGeometry(0.14, 24, 0.14)
            .translate(e.x + sx * half, 12, sz * half)
            .toNonIndexed(),
        );
      }
    }
    obsidian.push(new THREE.BoxGeometry(e.size + 0.7, 0.2, e.size + 0.7).translate(e.x, 23.9, 0).toNonIndexed());
    rock.push(new THREE.CylinderGeometry(1.1, 1.35, 0.5, 8, 1).translate(e.x, 0.25, 0).toNonIndexed());
  }

  // ───────────────────────────── 熔心与护罩 ─────────────────────────────

  private buildCore(): THREE.Group {
    const c = this.cfg.spire.core;
    const group = new THREE.Group();

    // 中层核心：半透明发光壳，能透出里面的黑核，读到"壳"而不是实心球
    const shellMaterial = new THREE.MeshStandardNodeMaterial({
      color: new THREE.Color(0x1a0802),
      emissive: new THREE.Color(0xff8a3a),
      emissiveIntensity: 2.2,
      roughness: 0.42,
      metalness: 0.08,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    const core = new THREE.Mesh(new THREE.SphereGeometry(c.radius, 48, 32), shellMaterial);
    core.name = 'molten-core';
    core.position.y = c.y;
    core.renderOrder = 2;
    group.add(core);
    this.coreMesh = core;

    // 内层黑核：让核心中心是暗的
    const inner = new THREE.Mesh(
      new THREE.SphereGeometry(c.innerRadius, 32, 20),
      new THREE.MeshStandardNodeMaterial({
        color: new THREE.Color(0x050302),
        roughness: 0.92,
        metalness: 0,
      }),
    );
    inner.position.y = c.y;
    group.add(inner);

    const dais = new THREE.Mesh(
      new THREE.CylinderGeometry(c.daisRadius, c.daisRadius + 0.5, 0.95, 36, 1),
      createRockMaterial(),
    );
    dais.position.y = 0.05;
    dais.castShadow = true;
    dais.receiveShadow = true;
    group.add(dais);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(c.daisRadius - 0.55, 0.03, 4, 72).rotateX(Math.PI / 2),
      createRuneMaterial(),
    );
    ring.position.y = 0.42;
    group.add(ring);

    return group;
  }

  private buildShield(): THREE.Group {
    const c = this.cfg.spire.core;
    this.shield.position.y = 0;

    // 外层护罩：半透明球壳，菲涅尔边缘亮
    const shieldMaterial = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const fresnel = float(1).sub(abs(dot(normalWorld, viewDir))).pow(2.2);
    shieldMaterial.colorNode = vec3(0.5, 0.13, 0.03);
    shieldMaterial.opacityNode = float(c.shieldOpacity).add(fresnel.mul(0.5));
    const bubble = new THREE.Mesh(new THREE.SphereGeometry(c.shieldRadius, 40, 24), shieldMaterial);
    bubble.position.y = c.y;
    bubble.renderOrder = 3;
    this.shield.add(bubble);

    // 一圈竖直悬浮石柱，替代原来的面条环
    const pillarMaterial = new THREE.MeshStandardNodeMaterial({
      color: new THREE.Color(0x191513),
      roughness: 0.86,
      metalness: 0.04,
      flatShading: true,
    });
    const pillars: THREE.BufferGeometry[] = [];
    for (let i = 0; i < c.pillarCount; i += 1) {
      const a = (i / c.pillarCount) * TAU;
      pillars.push(
        new THREE.BoxGeometry(c.pillarWidth, c.pillarHeight, c.pillarWidth)
          .translate(Math.cos(a) * c.pillarRadius, c.y + 0.3, Math.sin(a) * c.pillarRadius)
          .toNonIndexed(),
      );
    }
    const pillarMesh = new THREE.Mesh(mergeOrThrow(pillars), pillarMaterial);
    pillarMesh.castShadow = true;
    pillarMesh.receiveShadow = true;
    this.shield.add(pillarMesh);

    return this.shield;
  }

  private buildBeacon(): THREE.Group {
    const b = this.cfg.spire.beacon;
    const g = new THREE.Group();
    const height = b.top - b.y;

    const beamMaterial = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    beamMaterial.fog = false;
    const v = uv().y;
    const streak = mx_noise_float(vec3(uv().x.mul(22), v.mul(2.4).sub(time.mul(0.55)), 0)).mul(0.5).add(0.5);
    // 视角软边：正对镜头处穿过的发光体积最多，掠射边缘渐隐，避免圆柱硬边
    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const soft = abs(dot(normalWorld, viewDir)).pow(1.6);
    beamMaterial.colorNode = vec3(0.24, 0.6, 0.76).mul(float(0.78).add(streak.mul(0.42)));
    beamMaterial.opacityNode = smoothstep(0, 0.035, v)
      .mul(float(1).sub(smoothstep(0.55, 1, v)))
      .mul(float(0.085).add(streak.mul(0.07)))
      .mul(soft);

    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(b.radiusTop, b.radiusBottom, height, 28, 1, true),
      beamMaterial,
    );
    beam.position.y = b.y + height / 2;
    beam.renderOrder = 2;
    g.add(beam);

    const coreMaterial = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    coreMaterial.fog = false;
    coreMaterial.colorNode = vec3(0.55, 1.15, 1.4);
    coreMaterial.opacityNode = smoothstep(0, 0.02, v).mul(float(1).sub(smoothstep(0.6, 1, v))).mul(0.055);
    const coreBeam = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, height, 10, 1, true), coreMaterial);
    coreBeam.position.y = b.y + height / 2;
    coreBeam.renderOrder = 3;
    g.add(coreBeam);

    const discMaterial = new THREE.MeshBasicNodeMaterial();
    discMaterial.colorNode = vec3(0.42, 0.9, 1.15);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.78, 0.78, 0.06, 32, 1), discMaterial);
    disc.position.y = b.y + 0.66;
    g.add(disc);

    // 灯塔基座的冷青符文环：把光柱与塔顶地面接起来
    const cyanMaterial = new THREE.MeshBasicNodeMaterial();
    cyanMaterial.colorNode = vec3(0.16, 0.44, 0.55);
    for (const radius of [2.36, 2.88]) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(radius, 0.024, 4, 80).rotateX(Math.PI / 2),
        cyanMaterial,
      );
      ring.position.y = b.y + 0.018;
      g.add(ring);
    }

    return g;
  }

  // ───────────────────────────── 熔岩穹顶 ─────────────────────────────

  private buildCavern(rock: GeometryList): void {
    const c = this.cfg.spire.cavern;
    const rng = createRng(0x5eed_1a7a);

    const domeMaterial = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
    domeMaterial.fog = false;
    const dir = positionWorld.normalize();
    const n = mx_noise_float(dir.mul(14)).mul(0.5).add(0.5);
    const gate = mx_noise_float(dir.mul(3.2).add(vec3(11, 5, 7))).mul(0.5).add(0.5);
    const ridge = float(1).sub(smoothstep(0, 0.02, abs(n.sub(0.5))));
    const sparse = smoothstep(0.42, 0.72, gate);
    const horizon = float(1).sub(smoothstep(-0.05, 0.42, dir.y));
    const glow = ridge.mul(sparse).mul(horizon).mul(0.75).add(0.012);
    domeMaterial.colorNode = mix(vec3(0.014, 0.006, 0.005), vec3(0.62, 0.16, 0.045), glow);

    const dome = new THREE.Mesh(new THREE.SphereGeometry(c.radius, 48, 28), domeMaterial);
    dome.name = 'cavern-dome';
    dome.renderOrder = -1;
    this.group.add(dome);

    // 远处岩柱剪影
    for (let i = 0; i < c.spires; i += 1) {
      const a = (i / c.spires) * TAU + rng() * 0.16;
      const r = 78 + rng() * 34;
      const h = 16 + rng() * 34;
      const rad = 2.6 + rng() * 4.2;
      rock.push(
        new THREE.ConeGeometry(rad, h, 5 + Math.floor(rng() * 3), 1)
          .translate(Math.cos(a) * r, -22 + h / 2, Math.sin(a) * r)
          .toNonIndexed(),
      );
    }

    // 熔岩湖外圈的冷却结壳，遮住圆形熔岩面的硬边
    rock.push(
      new THREE.RingGeometry(54.4, 86, 96, 1)
        .rotateX(-Math.PI / 2)
        .translate(0, -22.08, 0)
        .toNonIndexed(),
    );
  }
}

// ───────────────────────────── 材质 ─────────────────────────────

function createRockMaterial(): THREE.MeshStandardNodeMaterial {
  const map = createRockTexture();
  const material = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(PALETTE.rock),
    roughness: 0.9,
    metalness: 0.02,
    flatShading: true,
  });
  material.map = map;
  material.bumpMap = map;
  material.bumpScale = 0.18;
  return material;
}

function createRuneMaterial(): THREE.MeshStandardNodeMaterial {
  // 槽底一线光：Standard + 自发光强度 1.6，不再用恒定满亮的 Basic
  return new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(0x0a0706),
    roughness: 0.78,
    metalness: 0.15,
    emissive: new THREE.Color(0xc4400e),
    emissiveIntensity: 1.6,
    flatShading: true,
  });
}

/** 512² 程序化岩石噪声：大块斑驳（3–5 m 尺度）+ 细颗粒 + 裂纹，只做 map / bumpMap。 */
function createRockTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');

  ctx.fillStyle = '#2b2523';
  ctx.fillRect(0, 0, size, size);

  const rng = createRng(0x2a15_9b3c);
  // 大块斑驳：波长约为原来的 4 倍，明度差压到 ±5（对比度 ~0.6）
  for (let i = 0; i < 34; i += 1) {
    const shade = 38 + Math.floor(rng() * 11);
    const radius = 150 + rng() * 160;
    drawWrapped(ctx, size, rng() * size, rng() * size, radius, `rgba(${shade},${shade - 3},${shade - 4},0.5)`, 'rgba(0,0,0,0)');
  }
  for (let i = 0; i < 22; i += 1) {
    const shade = 34 + Math.floor(rng() * 13);
    const radius = 70 + rng() * 120;
    drawWrapped(ctx, size, rng() * size, rng() * size, radius, `rgba(${shade},${shade - 2},${shade - 3},0.4)`, 'rgba(0,0,0,0)');
  }

  // 稀疏裂纹：只留作 bump 细节，不参与发光
  ctx.lineCap = 'round';
  for (let i = 0; i < 26; i += 1) {
    let x = rng() * size;
    let y = rng() * size;
    ctx.beginPath();
    ctx.strokeStyle = `rgba(16,13,11,${0.25 + rng() * 0.25})`;
    ctx.lineWidth = 0.8 + rng() * 1.6;
    ctx.moveTo(x, y);
    const steps = 4 + Math.floor(rng() * 6);
    for (let s = 0; s < steps; s += 1) {
      x += (rng() - 0.5) * 70;
      y += (rng() - 0.5) * 70;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  const image = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < image.data.length; i += 4) {
    const grain = (rng() - 0.5) * 8;
    image.data[i] = clampByte(image.data[i] + grain);
    image.data[i + 1] = clampByte(image.data[i + 1] + grain);
    image.data[i + 2] = clampByte(image.data[i + 2] + grain);
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1, 1);
  texture.anisotropy = 8;
  return texture;
}

// ───────────────────────────── 几何工具 ─────────────────────────────

function place(geo: THREE.BufferGeometry, pos: [number, number, number], rotY = 0): THREE.BufferGeometry {
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(...pos),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY),
    new THREE.Vector3(1, 1, 1),
  );
  const out = geo.toNonIndexed();
  out.applyMatrix4(matrix);
  geo.dispose();
  return out;
}

function beam(from: THREE.Vector3, to: THREE.Vector3, w: number, h: number): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(to, from);
  const len = dir.length();
  const z = dir.clone().normalize();
  const x = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), z);
  if (x.lengthSq() < 1e-4) x.set(1, 0, 0);
  x.normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  const matrix = new THREE.Matrix4().makeBasis(x, y, z).setPosition(from.clone().add(to).multiplyScalar(0.5));
  return new THREE.BoxGeometry(w, h, len).applyMatrix4(matrix).toNonIndexed();
}

function ringSlab(
  list: GeometryList,
  inner: number,
  outer: number,
  topY: number,
  thickness: number,
  segments: number,
): void {
  list.push(new THREE.RingGeometry(inner, outer, segments, 1).rotateX(-Math.PI / 2).translate(0, topY, 0).toNonIndexed());
  list.push(
    new THREE.RingGeometry(inner, outer, segments, 1).rotateX(Math.PI / 2).translate(0, topY - thickness, 0).toNonIndexed(),
  );
  list.push(
    new THREE.CylinderGeometry(outer, outer * 0.97, thickness, segments, 1, true)
      .translate(0, topY - thickness / 2, 0)
      .toNonIndexed(),
  );
  list.push(
    new THREE.CylinderGeometry(inner, inner, thickness, segments, 1, true)
      .scale(-1, 1, 1)
      .translate(0, topY - thickness / 2, 0)
      .toNonIndexed(),
  );
}

function addRim(rock: GeometryList, obsidian: GeometryList, rune: GeometryList, radius: number): void {
  obsidian.push(new THREE.TorusGeometry(radius - 0.06, 0.1, 6, 96).rotateX(Math.PI / 2).translate(0, 0.02, 0).toNonIndexed());
  rune.push(new THREE.TorusGeometry(radius - 0.42, 0.025, 4, 96).rotateX(Math.PI / 2).translate(0, 0.012, 0).toNonIndexed());
  // 内侧再压一圈暗色收边
  rock.push(new THREE.TorusGeometry(radius - 0.62, 0.06, 5, 96).rotateX(Math.PI / 2).translate(0, -0.02, 0).toNonIndexed());
}

function addRuneRing(rune: GeometryList, radius: number, y: number): void {
  rune.push(new THREE.TorusGeometry(radius, 0.025, 4, 96).rotateX(Math.PI / 2).translate(0, y, 0).toNonIndexed());
}

function addRuneSpokes(rune: GeometryList, count: number, r0: number, r1: number, offset: number): void {
  const length = r1 - r0;
  const mid = (r0 + r1) / 2;
  for (let i = 0; i < count; i += 1) {
    const a = offset + (i / count) * TAU;
    rune.push(
      place(
        new THREE.BoxGeometry(length, 0.013, 0.028),
        [Math.cos(a) * mid, 0.01, Math.sin(a) * mid],
        -a,
      ),
    );
  }
}

function addSpikes(rock: GeometryList, inner: number, outer: number, baseY: number, count: number): void {
  const rng = createRng(Math.floor(inner * 1000 + outer * 37));
  for (let i = 0; i < count; i += 1) {
    const a = (i / count) * TAU + rng() * 0.2;
    const r = inner + 1 + rng() * Math.max(0.4, outer - inner - 2);
    const h = 2.4 + rng() * 6.2;
    const rad = 1 + rng() * 2.2;
    rock.push(
      new THREE.ConeGeometry(rad, h, 5 + Math.floor(rng() * 3), 1)
        .rotateX(Math.PI)
        .translate(Math.cos(a) * r, baseY - h / 2, Math.sin(a) * r)
        .toNonIndexed(),
    );
  }
}

function addSlotPedestal(
  rock: GeometryList,
  obsidian: GeometryList,
  rune: GeometryList,
  deg: number,
  radius: number,
  size: number,
): void {
  const a = (deg * Math.PI) / 180;
  const x = Math.cos(a) * radius;
  const z = Math.sin(a) * radius;
  const rotY = Math.PI / 2 - a;
  rock.push(place(new THREE.CylinderGeometry(size, size + 0.22, 0.72, 8, 1), [x, 0.36, z], rotY));
  obsidian.push(place(new THREE.CylinderGeometry(size + 0.12, size + 0.12, 0.12, 8, 1), [x, 0.76, z], rotY));
  rune.push(place(new THREE.TorusGeometry(size * 0.66, 0.022, 4, 40).rotateX(Math.PI / 2), [x, 0.79, z], rotY));
}

function mergeOrThrow(list: GeometryList): THREE.BufferGeometry {
  if (list.length === 0) return new THREE.BufferGeometry();
  const merged = mergeGeometries(list, false);
  if (!merged) throw new Error('几何合并失败：属性不一致');
  merged.computeBoundingSphere();
  for (const geo of list) geo.dispose();
  return merged;
}

function easeInOut(t: number): number {
  return t * t * (3 - 2 * t);
}

function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

function drawWrapped(
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
      ctx.arc(cx, cy, radius, 0, TAU);
      ctx.fill();
    }
  }
}
