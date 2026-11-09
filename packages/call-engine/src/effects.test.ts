import { describe, expect, it } from 'vitest';

import { availableEffects, VIDEO_EFFECTS, videoEffect, effectFragmentShader } from './effects';

describe('video effects (ADR 0038)', () => {
  it('has unique IDs in every group', () => {
    const ids = VIDEO_EFFECTS.map((effect) => effect.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('none');
    for (const kind of ['beauty', 'face', 'color'] as const) {
      expect(VIDEO_EFFECTS.some((effect) => effect.kind === kind)).toBe(true);
    }
    expect(videoEffect('cat')?.face).toBe(true);
    expect(videoEffect('none')).toBeUndefined();
  });

  it('samples only through sample(), which both platforms rewrite the same way', () => {
    for (const effect of VIDEO_EFFECTS) {
      // effectFragmentShader turns every "sample(" into "texture2D(tex, ": an identifier
      // ending in "sample" would break, and a direct texture2D would bypass the prelude.
      expect(effect.shader, effect.id).not.toMatch(/\w+sample\(/);
      expect(effect.shader, effect.id).not.toMatch(/texture2D|precision mediump|uniform sampler/);
      expect(effect.shader, effect.id).toMatch(/void main\(\)/);
      const web = effectFragmentShader(effect);
      expect(
        web.startsWith('precision mediump float;\nvarying vec2 tc;\nuniform sampler2D tex;\n'),
      ).toBe(true);
      expect(web, effect.id).not.toMatch(/\bsample\(/);
    }
  });

  it('keeps face tracking to the face effects, and leaves them out without a tracker', () => {
    for (const effect of VIDEO_EFFECTS) {
      expect(effect.shader.includes('toFace('), effect.id).toBe(effect.face);
    }
    const web = availableEffects({ faceTracking: false });
    expect(web.some((effect) => effect.face)).toBe(false);
    expect(web.length).toBeGreaterThan(5);
    expect(availableEffects({ faceTracking: true })).toHaveLength(VIDEO_EFFECTS.length);
  });

  it('uses only GLSL ES 1.00 constructs the two apps can compile', () => {
    for (const effect of VIDEO_EFFECTS) {
      // No GLSL ES 3 keywords or built-ins, and float literals in loops' bodies stay floats.
      expect(effect.shader, effect.id).not.toMatch(/\b(in|out|texture|layout|smooth|flat)\s+\w/);
      expect(effect.shader, effect.id).not.toMatch(/#version/);
    }
  });
});
