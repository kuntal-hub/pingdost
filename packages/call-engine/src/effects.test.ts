import { describe, expect, it } from 'vitest';

import {
  availableEffects,
  EFFECT_GROUPS,
  VIDEO_EFFECTS,
  videoEffect,
  effectFragmentShader,
} from './effects';

describe('video effects (ADR 0038, 0048)', () => {
  it('has unique IDs and something in every group', () => {
    const ids = VIDEO_EFFECTS.map((effect) => effect.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('none');
    for (const { kind } of EFFECT_GROUPS) {
      expect(VIDEO_EFFECTS.filter((effect) => effect.kind === kind).length).toBeGreaterThan(4);
    }
    expect(videoEffect('puppy')?.face).toBe(true);
    expect(videoEffect('bigeyes')?.face).toBe(true);
    expect(videoEffect('none')).toBeUndefined();
  });

  it('keeps labels short enough for the picker', () => {
    for (const effect of VIDEO_EFFECTS) {
      expect(effect.label.length, effect.id).toBeLessThanOrEqual(12);
    }
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

  it('runs the face tracker only for effects that use it, and leaves face ones out without it', () => {
    for (const effect of VIDEO_EFFECTS) {
      expect(effect.shader.includes('toFace('), effect.id).toBe(effect.tracksFace);
      if (effect.face) expect(effect.tracksFace, effect.id).toBe(true);
    }
    expect(VIDEO_EFFECTS.filter((effect) => effect.kind === 'lens').every((e) => e.face)).toBe(
      true,
    );
    const web = availableEffects({ faceTracking: false });
    expect(web.some((effect) => effect.face)).toBe(false);
    expect(web.some((effect) => effect.kind === 'beauty')).toBe(true);
    expect(web.some((effect) => effect.kind === 'fun')).toBe(true);
    expect(availableEffects({ faceTracking: true })).toHaveLength(VIDEO_EFFECTS.length);
  });

  it('uses only GLSL ES 1.00 constructs the two apps can compile', () => {
    for (const effect of VIDEO_EFFECTS) {
      // No GLSL ES 3 keywords or built-ins.
      expect(effect.shader, effect.id).not.toMatch(/\b(in|out|texture|layout|smooth|flat)\s+\w/);
      expect(effect.shader, effect.id).not.toMatch(/#version|\bround\(|\btanh\(|\btrunc\(/);
      // ES 1.00 has no implicit int-to-float conversion: a bare integer next to an arithmetic
      // operator is a compile error unless it is a loop counter or an index.
      const code = effect.shader.replace(/for \([^)]*\)/g, '').replace(/#define[^\n]*/g, '');
      expect(code, effect.id).not.toMatch(/[-+*/]\s*\d+(?![.\d])(?!\s*[;)]\s*\{)/);
    }
  });
});
