import raw from '../core/config/visual.json';

export type QualityTier = 'ultra' | 'high' | 'medium' | 'low';

export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
  fov?: number;
}

export interface QualityPreset {
  pixelRatio: number;
  gtao: boolean;
  ssr: boolean;
  motionBlur: boolean;
  gtaoScale: number;
  gtaoSamples: number;
  ssrQuality: number;
  volumetricTaps: number;
  bloomScale: number;
  motionSamples: number;
  lavaOctaves: number;
}

export interface VisualConfig {
  exposure: number;
  quality: {
    default: QualityTier;
    auto: boolean;
    sampleSeconds: number;
    lowAboveMs: number;
    mediumAboveMs: number;
  };
  scene: { background: string; fog: string; fogDensity: number };
  camera: {
    fov: number;
    near: number;
    far: number;
    spawn: CameraPose;
    shots: Record<string, CameraPose>;
  };
  lava: {
    radius: number;
    y: number;
    radialSegments: number;
    angularSegments: number;
    waveAmplitude: number;
    emissive: number;
    flowSpeed: number;
    octaves: number;
  };
  spire: {
    tower: {
      circumradius: number;
      baseY: number;
      topY: number;
      sides: number;
      wallThickness: number;
      archBottom: number;
      archTop: number;
      archWidth: number;
    };
    topPlatform: {
      radius: number;
      y: number;
      thickness: number;
      parapetSegments: number;
      parapetHeight: number;
      parapetWidth: number;
      parapetRadius: number;
    };
    secondFloor: { inner: number; outer: number; y: number; thickness: number; struts: number };
    groundFloor: { inner: number; outer: number; y: number; thickness: number; undersideSpikes: number };
    core: {
      y: number;
      radius: number;
      daisRadius: number;
      shieldRadius: number;
      shieldOpacity: number;
      innerRadius: number;
      pillarCount: number;
      pillarRadius: number;
      pillarHeight: number;
      pillarWidth: number;
    };
    midRing: {
      inner: number;
      outer: number;
      y: number;
      thickness: number;
      slotAngles: number[];
      slotRadius: number;
      slotRadiusSize: number;
      undersideSpikes: number;
    };
    outerRing: {
      inner: number;
      outer: number;
      y: number;
      thickness: number;
      slotAngles: number[];
      slotRadius: number;
      slotRadiusSize: number;
    };
    bridges: { angles: number[]; inner: number; outer: number; width: number; slabThickness: number };
    cantilevers: { y: number; angles: number[]; inner: number; outer: number; thickness: number };
    elevator: { x: number; size: number; thickness: number; minY: number; maxY: number; speed: number };
    spiral: {
      radius: number;
      width: number;
      bottom: number;
      top: number;
      turns: number;
      startAngle: number;
      segments: number;
      thickness: number;
    };
    beacon: { y: number; top: number; radiusBottom: number; radiusTop: number };
    cavern: { radius: number; spires: number };
  };
  lights: {
    hemisphere: { sky: string; ground: string; intensity: number };
    skyFill: { color: string; intensity: number; position: [number, number, number] };
    key: {
      color: string;
      intensity: number;
      position: [number, number, number];
      shadow: {
        cascades: number;
        maxFar: number;
        mapSize: number;
        bias: number;
        normalBias: number;
      };
    };
    core: { color: string; intensity: number; distance: number };
    edge: { color: string; intensity: number; distance: number; radius: number; count: number };
  };
  embers: {
    count: number;
    radius: number;
    height: number;
    baseY: number;
    size: number;
    speedMin: number;
    speedMax: number;
    sway: number;
    color: string;
  };
  post: {
    gtao: {
      enabled: boolean;
      radius: number;
      thickness: number;
      samples: number;
      resolutionScale: number;
      intensity: number;
    };
    ssr: { enabled: boolean; quality: number; maxDistance: number; thickness: number; intensity: number };
    traa: { enabled: boolean };
    volumetric: {
      enabled: boolean;
      taps: number;
      maxDistance: number;
      warmIntensity: number;
      beamIntensity: number;
    };
    bloom: {
      enabled: boolean;
      threshold: number;
      strength: number;
      radius: number;
      resolutionScale: number;
    };
    motionBlur: { enabled: boolean; samples: number; intensity: number };
    dof: { enabled: boolean; focusDistance: number; focalLength: number; bokehScale: number };
    grade: { enabled: boolean; chromatic: number; vignette: number; grain: number };
    lut: { enabled: boolean; size: number; intensity: number };
    heatHaze: { enabled: boolean; amplitude: number; speed: number };
  };
  qualityPresets: Record<QualityTier, QualityPreset>;
}

export const VISUAL = raw as unknown as VisualConfig;
