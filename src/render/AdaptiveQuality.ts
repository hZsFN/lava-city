import type { QualityTier } from './config';

/** Allocation-free sustained-load detector. Only downgrades; manual choices win. */
export class AdaptiveQuality {
  private elapsed = 0;
  private slow = 0;
  private frames = 0;
  private cooldown = 5;

  reset(): void {
    this.elapsed = 0;
    this.slow = 0;
    this.frames = 0;
    this.cooldown = 5;
  }

  sample(dt: number, tier: QualityTier, mediumMs: number, lowMs: number): QualityTier | null {
    if (!Number.isFinite(dt) || dt <= 0 || tier === 'low') return null;
    if (this.cooldown > 0) {
      this.cooldown -= dt;
      return null;
    }
    const threshold = tier === 'medium' ? lowMs : mediumMs;
    this.elapsed += dt;
    this.frames += 1;
    if (dt * 1000 > threshold) this.slow += 1;
    if (this.elapsed < 3 || this.frames < 3) return null;
    // A solitary compile/GC stall must not lower image quality.
    const overloaded = this.slow / this.frames >= 0.75;
    this.elapsed = 0;
    this.slow = 0;
    this.frames = 0;
    if (!overloaded) return null;
    this.cooldown = 5;
    return tier === 'medium' ? 'low' : tier === 'high' ? 'medium' : 'high';
  }
}
