import * as THREE from 'three/webgpu';

/**
 * 熔心孤塔的色彩锚点。
 * 唯一原则：光从熔岩来 —— 暖橙只出现在下表面与发光体上，
 * 天空/穹顶/上表面一律压到近黑，冷青只属于地脉灯塔。
 */
export const PALETTE = {
  background: 0x07050a,
  fog: 0x1a0a06,

  rock: 0x2b2523,
  rockDeep: 0x171311,
  obsidian: 0x141010,

  lavaCold: 0x2a0705,
  lavaWarm: 0x8c1d08,
  lavaHot: 0xff5a12,
  lavaWhite: 0xffd27a,

  core: 0xff6a1e,
  coreHot: 0xffd9a0,
  rune: 0xff9a3c,

  beacon: 0x9fe9ff,
  beaconCore: 0xdff8ff,

  skyLight: 0x1a0d08,
  groundLight: 0xff4a0a,
  keyLight: 0xff7a2a,
  ember: 0xffb060,
} as const;

export function colorOf(hex: number): THREE.Color {
  return new THREE.Color(hex);
}

/** 把 sRGB 十六进制配置转成线性工作色域的 Color（node 材质内部需要线性值）。 */
export function srgb(hex: string): THREE.Color {
  return new THREE.Color(hex);
}
