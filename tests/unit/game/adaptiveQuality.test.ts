import { describe, expect, it } from 'vitest';
import { AdaptiveQuality } from '../../../src/render/AdaptiveQuality';
import type { QualityTier } from '../../../src/render/config';

function feed(q: AdaptiveQuality, frames: number, dt: number, tier: QualityTier = 'high') {
  const changes: QualityTier[] = [];
  for (let i = 0; i < frames; i += 1) {
    const next = q.sample(dt, tier, 18, 30);
    if (next) changes.push(next);
  }
  return changes;
}

describe('sustained-load quality control', () => {
  it('keeps a stable 60 Hz scene at high quality', () => {
    expect(feed(new AdaptiveQuality(), 1800, 1 / 60)).toEqual([]);
  });
  it('steps down under sustained combat load after warmup', () => {
    expect(feed(new AdaptiveQuality(), 270, 1 / 30)).toEqual(['medium']);
  });
  it('ignores an isolated long compile/GC frame', () => {
    const q = new AdaptiveQuality();
    feed(q, 360, 1 / 60);
    expect(q.sample(1, 'high', 18, 30)).toBeNull();
    expect(feed(q, 600, 1 / 60)).toEqual([]);
  });
  it('does not immediately cascade through multiple tiers', () => {
    const q = new AdaptiveQuality();
    expect(feed(q, 270, 1 / 30)).toEqual(['medium']);
    expect(feed(q, 50, 1 / 30, 'medium')).toEqual([]);
  });
  it('lowers medium only above its own threshold and stops at low', () => {
    expect(feed(new AdaptiveQuality(), 600, 0.025, 'medium')).toEqual([]);
    expect(feed(new AdaptiveQuality(), 180, 0.05, 'medium')).toEqual(['low']);
    expect(feed(new AdaptiveQuality(), 600, 0.1, 'low')).toEqual([]);
  });
  it('resets load history and warmup after a background interruption', () => {
    const q = new AdaptiveQuality();
    feed(q, 140, 0.05);
    q.reset();
    expect(feed(q, 120, 0.05)).toEqual([]);
  });
  it('ignores invalid intervals without poisoning subsequent sampling', () => {
    const q = new AdaptiveQuality();
    for (const dt of [NaN, Infinity, -1, 0]) expect(q.sample(dt, 'high', 18, 30)).toBeNull();
    expect(feed(q, 270, 1 / 30)).toEqual(['medium']);
  });
});
