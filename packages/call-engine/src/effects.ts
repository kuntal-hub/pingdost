/**
 * Camera filters and effects for video calls (ADR 0038, 0048). Each effect is one GLSL ES 1.00
 * fragment shader that both apps run on the camera picture before it is encoded, so the
 * frames never leave the device unprocessed and E2EE is unchanged. `effectFragmentShader`
 * gives the complete source (a prelude declaring `precision mediump float; varying vec2 tc;
 * uniform sampler2D tex;`, and every `sample(` turned into `texture2D(tex, `); Android's
 * PingdostCalls module and the web compile exactly that with `EFFECT_VERTEX_SHADER`.
 *
 * The picture is upright and `tc` runs from (0, 0) at its bottom left to (1, 1) at its top
 * right. Uniforms: `uSize` (pixels), `uTime` (seconds), `uFace` (between the eyes in pixels
 * from the bottom left, the distance between the eyes in pixels, the head's roll in radians)
 * and `uFaceOn` (0 without a face, 1 with one; it fades in between).
 *
 * Face units (`toFace`): the eyes sit at (±0.5, 0) and up is up. Roughly: nose tip (0, -0.6),
 * mouth (0, -1.2), chin (0, -2), cheeks (±0.8, -0.85), top of the head (0, 1.5).
 *
 * Groups: beauty (skin smoothing, tone, and a light face shape where a face is tracked), lens
 * (shaded, animated face decorations), fun (face warps, and picture-wide toys) and color
 * (graded looks). Lenses and face warps need the face tracker: Android's built-in
 * `FaceDetector` (no library, nothing sent anywhere). The web has none, so it offers the rest;
 * beauty there smooths and tones without reshaping.
 *
 * Writing a shader: no `#version`, ES 3 keywords or integer-to-float shortcuts (write `2.0`);
 * no identifier that ends in `sample`; keep words like `in`, `out`, `flat` out of comments in
 * shader code (tests reject them). After a change, compile them all in Chrome (CLAUDE.md).
 */

export type VideoEffectKind = 'beauty' | 'lens' | 'fun' | 'color';

/** Lucide icon names (both apps map them to their icon components). */
export type EffectIcon =
  | 'aperture'
  | 'bubbles'
  | 'camera'
  | 'candy'
  | 'cat'
  | 'circle-dot'
  | 'clapperboard'
  | 'cloud'
  | 'contrast'
  | 'crown'
  | 'dog'
  | 'drama'
  | 'droplet'
  | 'eye'
  | 'film'
  | 'flame'
  | 'flip-horizontal-2'
  | 'flower-2'
  | 'gem'
  | 'ghost'
  | 'glasses'
  | 'grid-2x2'
  | 'grid-3x3'
  | 'haze'
  | 'heart'
  | 'hexagon'
  | 'laugh'
  | 'layers'
  | 'maximize'
  | 'minimize'
  | 'moon'
  | 'move-horizontal'
  | 'move-vertical'
  | 'palette'
  | 'paw-print'
  | 'pen-tool'
  | 'rabbit'
  | 'rainbow'
  | 'scan-face'
  | 'smile'
  | 'snowflake'
  | 'sparkle'
  | 'sparkles'
  | 'star'
  | 'sun'
  | 'sun-medium'
  | 'sunset'
  | 'thermometer'
  | 'tornado'
  | 'tv'
  | 'waves'
  | 'zap';

export interface VideoEffect {
  id: string;
  label: string;
  kind: VideoEffectKind;
  icon: EffectIcon;
  /** Needs the face tracker: left out where there is none (the web). */
  face: boolean;
  /** Uses the face when one is tracked (the tracker runs); true for every `face` effect. */
  tracksFace: boolean;
  /** The fragment shader body (see the file comment). */
  shader: string;
}

/** The picker's groups, in order. */
export const EFFECT_GROUPS: readonly { kind: VideoEffectKind; label: string }[] = [
  { kind: 'beauty', label: 'Beauty' },
  { kind: 'lens', label: 'Lenses' },
  { kind: 'fun', label: 'Fun' },
  { kind: 'color', label: 'Filters' },
];

/** Declarations and helpers every effect can use. */
const COMMON = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#endif
uniform vec2 uSize;
uniform float uTime;
uniform vec4 uFace;
uniform float uFaceOn;

float luma(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

vec3 saturation(vec3 c, float s) {
  return mix(vec3(luma(c)), c, s);
}

vec3 hue(float h) {
  vec3 k = abs(fract(vec3(h) + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return clamp(k - 1.0, 0.0, 1.0);
}

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

vec2 rot(vec2 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

float edgeAt(vec2 p, vec2 px) {
  float tl = luma(sample(p + px * vec2(-1.0, 1.0)).rgb);
  float t = luma(sample(p + px * vec2(0.0, 1.0)).rgb);
  float tr = luma(sample(p + px * vec2(1.0, 1.0)).rgb);
  float l = luma(sample(p + px * vec2(-1.0, 0.0)).rgb);
  float r = luma(sample(p + px * vec2(1.0, 0.0)).rgb);
  float bl = luma(sample(p + px * vec2(-1.0, -1.0)).rgb);
  float b = luma(sample(p + px * vec2(0.0, -1.0)).rgb);
  float br = luma(sample(p + px * vec2(1.0, -1.0)).rgb);
  float gx = tr + 2.0 * r + br - tl - 2.0 * l - bl;
  float gy = tl + 2.0 * t + tr - bl - 2.0 * b - br;
  return length(vec2(gx, gy));
}

void finish(vec3 col) {
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/** Colour grading: curves, split toning, glow, grain, vignette. */
const GRADE = `
vec3 sCurve(vec3 c, float k) {
  vec3 x = clamp(c, 0.0, 1.0);
  return mix(c, x * x * (3.0 - 2.0 * x), k);
}

vec3 vibrance(vec3 c, float v) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  return mix(vec3(luma(c)), c, 1.0 + v * (1.0 - clamp(mx - mn, 0.0, 1.0)));
}

vec3 splitTone(vec3 c, vec3 shadows, vec3 highlights, float amount) {
  vec3 tint = mix(shadows, highlights, smoothstep(0.05, 0.95, luma(c)));
  return c + (tint - vec3(luma(tint))) * amount;
}

vec3 lift(vec3 c, float black) {
  return vec3(black) + c * (1.0 - black);
}

vec3 screen(vec3 a, vec3 b) {
  return 1.0 - (1.0 - clamp(a, 0.0, 1.0)) * (1.0 - clamp(b, 0.0, 1.0));
}

float vignette(vec2 t, float amount) {
  vec2 d = (t - 0.5) * 2.0;
  return 1.0 - amount * smoothstep(0.3, 2.0, dot(d, d));
}

float grain(vec2 t) {
  return hash(floor(t * uSize) + vec2(floor(uTime * 24.0) * 37.0, 0.0)) - 0.5;
}

vec3 glowAt(vec2 t, float radius, float threshold) {
  vec2 px = radius / uSize;
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 6; i++) {
    float a = float(i) * 1.0471976 + 0.3;
    vec2 o = vec2(cos(a), sin(a)) * px;
    sum += max(sample(t + o).rgb - threshold, 0.0);
    sum += max(sample(t + rot(o, 0.52) * 0.45).rgb - threshold, 0.0);
  }
  return sum / (12.0 * (1.0 - threshold));
}

vec3 blurAt(vec2 t, float radius) {
  vec2 px = radius / uSize;
  vec3 sum = sample(t).rgb;
  for (int i = 0; i < 12; i++) {
    float fi = float(i);
    float a = fi * 2.3999632;
    sum += sample(t + vec2(cos(a), sin(a)) * px * sqrt((fi + 0.5) / 12.0)).rgb;
  }
  return sum / 13.0;
}
`;

/** Face-local coordinates (eyes at (±0.5, 0), up is up), shapes and warps. */
const FACE = `
vec2 toFace(vec2 t) {
  vec2 v = t * uSize - uFace.xy;
  float c = cos(uFace.w);
  float s = sin(uFace.w);
  return vec2(c * v.x + s * v.y, -s * v.x + c * v.y) / max(uFace.z, 1.0);
}

vec2 fromFace(vec2 q) {
  float c = cos(uFace.w);
  float s = sin(uFace.w);
  vec2 v = vec2(c * q.x - s * q.y, s * q.x + c * q.y) * max(uFace.z, 1.0);
  return (uFace.xy + v) / uSize;
}

float fill(float d) {
  float aa = 1.5 / max(uFace.z, 1.0);
  return 1.0 - smoothstep(-aa, aa, d);
}

float sdCircle(vec2 p, float r) {
  return length(p) - r;
}

float sdEllipse(vec2 p, vec2 r) {
  return (length(p / r) - 1.0) * min(r.x, r.y);
}

float sdBox(vec2 p, vec2 b, float r) {
  vec2 d = abs(p) - b + vec2(r);
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}

float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

float sdTri(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
  vec2 e0 = p1 - p0;
  vec2 e1 = p2 - p1;
  vec2 e2 = p0 - p2;
  vec2 v0 = p - p0;
  vec2 v1 = p - p1;
  vec2 v2 = p - p2;
  vec2 q0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  vec2 q1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  vec2 q2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  vec2 d = min(
    min(vec2(dot(q0, q0), s * (v0.x * e0.y - v0.y * e0.x)),
        vec2(dot(q1, q1), s * (v1.x * e1.y - v1.y * e1.x))),
    vec2(dot(q2, q2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}

vec3 over(vec3 col, vec3 paint, float alpha) {
  return mix(col, paint, clamp(alpha, 0.0, 1.0) * uFaceOn);
}

vec2 bulge(vec2 q, vec2 c, float radius, float a) {
  vec2 d = q - c;
  float r = length(d) / radius;
  if (r >= 1.0) return q;
  float w = 1.0 - r * r;
  return c + d * (1.0 + a * w * w * uFaceOn);
}
`;

/** Skin smoothing and tone; the face shape and under-eye light need FACE. */
const BEAUTY = `
float skinMask(vec3 c) {
  float cb = 0.5 - 0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b;
  float cr = 0.5 + 0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b;
  float m = 1.0 - smoothstep(0.06, 0.12, abs(cb - 0.41));
  m *= 1.0 - smoothstep(0.05, 0.1, abs(cr - 0.59));
  return m * smoothstep(0.06, 0.2, luma(c));
}

vec3 smoothSkin(vec2 t, vec3 c, float radius) {
  vec2 px = radius / uSize;
  vec3 sum = c;
  float total = 1.0;
  for (int i = 0; i < 14; i++) {
    float fi = float(i);
    float a = fi * 2.3999632;
    vec3 s = sample(t + vec2(cos(a), sin(a)) * px * sqrt((fi + 0.5) / 14.0)).rgb;
    vec3 e = s - c;
    float w = exp(-dot(e, e) * 50.0);
    sum += s * w;
    total += w;
  }
  return sum / total;
}

vec3 beautify(vec2 t, float amount, float bright) {
  vec3 c = sample(t).rgb;
  float radius = min(mix(uSize.y / 100.0, uFace.z * 0.075, uFaceOn), uSize.y / 45.0);
  vec3 s = smoothSkin(t, c, radius);
  float skin = skinMask(c);
  vec3 col = mix(c, s, amount * (0.2 + 0.8 * skin));
  col += (c - s) * 0.35 * (1.0 - skin);
  return col + col * (1.0 - col) * bright;
}

vec2 beautyWarp(vec2 t, float slim, float eyes) {
  vec2 q = toFace(t);
  vec2 p = bulge(q, vec2(-0.5, 0.0), 0.42, -eyes);
  p = bulge(p, vec2(0.5, 0.0), 0.42, -eyes);
  float wy = smoothstep(0.1, -0.6, q.y) * smoothstep(-2.7, -1.9, q.y);
  float wx = smoothstep(1.8, 0.4, abs(q.x));
  p.x *= 1.0 + slim * uFaceOn * wy * wx;
  return fromFace(p);
}

vec3 underEyes(vec3 col, vec2 q, float amount) {
  vec2 m = vec2(abs(q.x), q.y);
  float u = 1.0 - smoothstep(0.0, 1.0, length((m - vec2(0.5, -0.27)) / vec2(0.28, 0.12)));
  return col + (1.0 - col) * u * amount * uFaceOn;
}

vec3 blush(vec3 col, vec2 q, vec3 tint, float amount) {
  vec2 m = vec2(abs(q.x), q.y);
  float b = 1.0 - smoothstep(0.0, 0.36, length((m - vec2(0.8, -0.82)) * vec2(1.0, 1.25)));
  return mix(col, col * tint, b * amount * uFaceOn);
}
`;

/** Shading for lens decorations: bevelled normals, light, fur, metal, sparkles. */
const LENS = `
vec2 dir(vec2 g) {
  return g / max(length(g), 0.00001);
}

#define GRAD(F, P) dir(vec2(F(P + vec2(0.01, 0.0)) - F(P - vec2(0.01, 0.0)), F(P + vec2(0.0, 0.01)) - F(P - vec2(0.0, 0.01))))

vec3 bump(vec2 g, float d, float bevel) {
  float k = clamp(-d / bevel, 0.0, 1.0);
  float tilt = pow(1.0 - k, 1.6) * 2.4;
  return normalize(vec3(g * tilt, 1.0));
}

float diffuse(vec3 n) {
  return max(dot(n, vec3(-0.32, 0.58, 0.75)), 0.0);
}

float shine(vec3 n, float power) {
  return pow(max(dot(n, vec3(-0.171, 0.31, 0.935)), 0.0), power);
}

float shadowAt(float d, float soft) {
  return 1.0 - smoothstep(-soft * 0.3, soft, d);
}

float strands(vec2 p, vec2 along, float scale) {
  vec2 a = vec2(dot(p, vec2(along.y, -along.x)), dot(p, along));
  return noise(vec2(a.x * scale * 3.0, a.y * scale * 0.35)) * 0.6
    + noise(vec2(a.x * scale * 7.0, a.y * scale * 0.7) + 17.0) * 0.4;
}

vec3 tube(vec2 g, float x, vec3 base) {
  float xc = clamp(x, -1.0, 1.0);
  vec3 n = vec3(g * xc, sqrt(1.0 - xc * xc));
  return base * (0.3 + 0.85 * diffuse(n)) + vec3(1.0, 0.96, 0.85) * shine(n, 28.0) * 0.9;
}

float star(vec2 p, float s) {
  vec2 a = abs(p / s);
  float core = exp(-length(a) * 7.0);
  float rays = max(0.0, 1.0 - a.x * a.y * 40.0 - (a.x + a.y) * 0.6);
  return core + rays * 0.6 * (1.0 - smoothstep(0.0, 1.0, length(a)));
}
`;

function make(
  kind: VideoEffectKind,
  preludes: string,
  face: boolean,
  tracksFace: boolean,
): (id: string, label: string, icon: EffectIcon, body: string) => VideoEffect {
  return (id, label, icon, body) => ({
    id,
    label,
    kind,
    icon,
    face,
    tracksFace,
    shader: preludes + body,
  });
}

const beauty = make('beauty', COMMON + GRADE + FACE + BEAUTY, false, true);
const lens = make('lens', COMMON + GRADE + FACE + BEAUTY + LENS, true, true);
const warp = make('fun', COMMON + GRADE + FACE + BEAUTY, true, true);
const fun = make('fun', COMMON + GRADE, false, false);
const color = make('color', COMMON + GRADE, false, false);

const BEAUTY_EFFECTS: VideoEffect[] = [
  beauty(
    'natural',
    'Natural',
    'sparkle',
    `
void main() {
  vec3 col = beautify(beautyWarp(tc, 0.06, 0.06), 0.65, 0.1);
  col = underEyes(col, toFace(tc), 0.1);
  finish(sCurve(col * vec3(1.02, 1.0, 0.99), 0.06));
}
`,
  ),
  beauty(
    'glam',
    'Glam',
    'gem',
    `
void main() {
  vec3 col = beautify(beautyWarp(tc, 0.13, 0.14), 0.85, 0.12);
  vec2 q = toFace(tc);
  col = underEyes(col, q, 0.14);
  col = blush(col, q, vec3(1.0, 0.82, 0.82), 0.35);
  col = vibrance(col, 0.15);
  finish(sCurve(col, 0.22) * vignette(tc, 0.15));
}
`,
  ),
  beauty(
    'glow',
    'Glow',
    'sparkles',
    `
void main() {
  vec2 t = beautyWarp(tc, 0.08, 0.08);
  vec3 col = beautify(t, 0.75, 0.14);
  col = screen(col, glowAt(t, uSize.y / 30.0, 0.5) * vec3(1.0, 0.85, 0.85) * 0.7);
  col = underEyes(col, toFace(tc), 0.12);
  finish(splitTone(col, vec3(0.5, 0.4, 0.55), vec3(1.0, 0.88, 0.85), 0.08));
}
`,
  ),
  beauty(
    'porcelain',
    'Porcelain',
    'droplet',
    `
void main() {
  vec2 t = beautyWarp(tc, 0.08, 0.1);
  vec3 c = sample(t).rgb;
  vec3 col = beautify(t, 0.95, 0.2);
  col = mix(col, saturation(col, 0.75) * vec3(0.99, 1.0, 1.03), skinMask(c) * 0.6);
  col = underEyes(col, toFace(tc), 0.15);
  finish(lift(col, 0.02));
}
`,
  ),
  beauty(
    'bronze',
    'Bronze',
    'sun-medium',
    `
void main() {
  vec2 t = beautyWarp(tc, 0.08, 0.06);
  vec3 col = beautify(t, 0.7, 0.04);
  col = splitTone(col, vec3(0.45, 0.25, 0.15), vec3(1.0, 0.8, 0.5), 0.16);
  col = vibrance(col * vec3(1.05, 0.99, 0.9), 0.2);
  col = screen(col, glowAt(t, uSize.y / 40.0, 0.62) * vec3(1.0, 0.7, 0.35) * 0.45);
  finish(sCurve(col, 0.25));
}
`,
  ),
  beauty(
    'softfocus',
    'Soft focus',
    'haze',
    `
void main() {
  vec2 t = beautyWarp(tc, 0.06, 0.06);
  vec3 col = beautify(t, 0.7, 0.08);
  vec3 blur = blurAt(t, uSize.y / 45.0);
  col = mix(screen(col, blur * 0.35), blur, 0.1);
  finish(lift(col, 0.025) * vec3(1.02, 1.0, 1.0));
}
`,
  ),
];

const LENS_EFFECTS: VideoEffect[] = [
  lens(
    'puppy',
    'Puppy',
    'dog',
    `
float earSd(vec2 m) {
  vec2 p = rot(m - vec2(0.85, 1.45), -0.5 + 0.06 * sin(uTime * 2.3)) + vec2(0.0, 0.7);
  float w = mix(0.27, 0.47, smoothstep(0.6, -0.5, p.y));
  return (length(vec2(p.x / w, p.y / 0.8)) - 1.0) * w;
}

float noseSd(vec2 q) {
  vec2 p = q - vec2(0.0, -0.55);
  float w = mix(0.12, 0.25, smoothstep(-0.15, 0.07, p.y));
  return (length(vec2(p.x / w, p.y / 0.15)) - 1.0) * min(w, 0.15);
}

void main() {
  vec3 col = beautify(beautyWarp(tc, 0.05, 0.06), 0.55, 0.08);
  vec2 q = toFace(tc);
  float side = q.x < 0.0 ? -1.0 : 1.0;
  vec2 m = vec2(abs(q.x), q.y);
  col *= 1.0 - 0.4 * uFaceOn * shadowAt(earSd(m + vec2(0.05, 0.1)), 0.28);
  float d = earSd(m);
  if (d < 0.08) {
    vec3 n = bump(GRAD(earSd, m) * vec2(side, 1.0), d, 0.22);
    float f = strands(m, vec2(-0.48, 0.88), 13.0);
    vec3 fur = mix(vec3(0.42, 0.25, 0.12), vec3(0.74, 0.52, 0.3), f);
    fur = mix(fur, vec3(0.86, 0.68, 0.48), (1.0 - smoothstep(-0.3, -0.1, d)) * 0.35);
    fur *= mix(0.4, 1.0, smoothstep(0.0, -0.08, d));
    fur = mix(fur, fur * 0.62, smoothstep(0.7, 0.1, m.y));
    vec3 lit = fur * (0.4 + 0.8 * diffuse(n)) + vec3(0.12) * shine(n, 16.0);
    float edge = d + (noise(m * 14.0) - 0.5) * 0.025;
    col = over(col, lit, 1.0 - smoothstep(-0.012, 0.01, edge));
  }
  col *= 1.0 - 0.3 * uFaceOn * shadowAt(noseSd(q + vec2(0.02, 0.06)), 0.12);
  float nd = noseSd(q);
  if (nd < 0.04) {
    vec3 n = bump(GRAD(noseSd, q), nd, 0.12);
    vec3 nose = vec3(0.06, 0.05, 0.055) * (0.5 + 0.9 * diffuse(n)) + vec3(0.85) * shine(n, 36.0);
    vec2 h = (q - vec2(-0.06, -0.485)) * vec2(1.0, 1.7);
    nose += vec3(0.4) * (1.0 - smoothstep(0.0, 0.05, length(h)));
    float nostril = sdEllipse(rot(m - vec2(0.085, -0.605), 0.55), vec2(0.05, 0.022));
    nose = mix(nose, vec3(0.0), fill(nostril) * 0.85);
    col = over(col, nose, fill(nd));
  }
  finish(sCurve(col * vec3(1.03, 1.0, 0.97), 0.12));
}
`,
  ),
  lens(
    'kitty',
    'Kitty',
    'cat',
    `
float earSd(vec2 m) {
  return sdTri(m, vec2(1.28, 0.92), vec2(0.42, 1.3), vec2(1.1, 2.12)) - 0.07;
}

float innerSd(vec2 m) {
  return sdTri(m, vec2(1.1, 1.08), vec2(0.66, 1.32), vec2(1.02, 1.8)) - 0.05;
}

float noseSd(vec2 q) {
  return sdTri(q, vec2(-0.13, -0.5), vec2(0.13, -0.5), vec2(0.0, -0.64)) - 0.035;
}

float whisker(vec2 m, vec2 a, vec2 b, float bend) {
  vec2 pa = m - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  vec2 v = pa - ba * h;
  v.y += bend * h * (1.0 - h);
  return length(v) - mix(0.013, 0.003, h);
}

void main() {
  vec3 col = beautify(beautyWarp(tc, 0.06, 0.08), 0.6, 0.1);
  vec2 q = toFace(tc);
  float side = q.x < 0.0 ? -1.0 : 1.0;
  vec2 m = vec2(abs(q.x), q.y);
  col = blush(col, q, vec3(1.0, 0.8, 0.82), 0.45);
  col *= 1.0 - 0.38 * uFaceOn * shadowAt(earSd(m + vec2(0.04, 0.1)), 0.25);
  float d = earSd(m);
  if (d < 0.08) {
    vec3 n = bump(GRAD(earSd, m) * vec2(side, 1.0), d, 0.2);
    float f = strands(m, vec2(0.2, 0.98), 10.0);
    float stripe = smoothstep(0.35, 0.7, sin(m.y * 11.0 + m.x * 3.0 + noise(m * 5.0) * 2.5));
    vec3 fur = mix(vec3(0.95, 0.62, 0.32), vec3(0.56, 0.3, 0.12), stripe * 0.7) * (0.75 + 0.4 * f);
    vec3 lit = fur * (0.42 + 0.75 * diffuse(n)) + vec3(0.12) * shine(n, 14.0);
    float id = innerSd(m);
    vec3 pink = mix(vec3(0.93, 0.52, 0.6), vec3(1.0, 0.76, 0.8), smoothstep(-0.12, 0.0, id));
    float tuft = strands(m, vec2(0.3, 0.95), 14.0) * smoothstep(1.55, 1.1, m.y);
    pink = mix(pink, vec3(1.0, 0.97, 0.94), tuft * 0.75);
    lit = mix(lit, pink * (0.55 + 0.5 * diffuse(n)), 1.0 - smoothstep(-0.02, 0.03, id));
    float edge = d + (noise(m * 14.0) - 0.5) * 0.025;
    col = over(col, lit, 1.0 - smoothstep(-0.012, 0.01, edge));
  }
  float nd = noseSd(q);
  if (nd < 0.04) {
    vec3 n = bump(GRAD(noseSd, q), nd, 0.08);
    vec3 nose = vec3(0.93, 0.5, 0.58) * (0.55 + 0.6 * diffuse(n)) + vec3(1.0) * shine(n, 30.0) * 0.6;
    col = over(col, nose, fill(nd));
  }
  float w = min(whisker(m, vec2(0.42, -0.74), vec2(1.3, -0.58), 0.05),
    min(whisker(m, vec2(0.42, -0.82), vec2(1.34, -0.84), 0.04),
        whisker(m, vec2(0.42, -0.9), vec2(1.26, -1.1), 0.03)));
  col = over(col, vec3(0.12), (1.0 - smoothstep(0.0, 0.03, w)) * 0.35);
  col = over(col, vec3(0.98), fill(w) * 0.9);
  col = splitTone(col, vec3(0.45, 0.35, 0.5), vec3(1.0, 0.85, 0.8), 0.06);
  finish(sCurve(col, 0.1));
}
`,
  ),
  lens(
    'bunny',
    'Bunny',
    'rabbit',
    `
vec2 earSpace(vec2 m) {
  return rot(m - vec2(0.42, 1.2), 0.16 + 0.06 * sin(uTime * 2.1));
}

float earSd(vec2 m) {
  return sdEllipse(earSpace(m) - vec2(0.0, 0.84), vec2(0.32, 0.88));
}

float innerSd(vec2 m) {
  return sdEllipse(earSpace(m) - vec2(0.0, 0.8), vec2(0.16, 0.64));
}

float noseSd(vec2 q) {
  return sdEllipse(q - vec2(0.0, -0.57), vec2(0.13, 0.09));
}

void main() {
  vec3 col = beautify(beautyWarp(tc, 0.05, 0.08), 0.6, 0.12);
  vec2 q = toFace(tc);
  float side = q.x < 0.0 ? -1.0 : 1.0;
  vec2 m = vec2(abs(q.x), q.y);
  col = blush(col, q, vec3(1.0, 0.78, 0.82), 0.5);
  col *= 1.0 - 0.35 * uFaceOn * shadowAt(earSd(m + vec2(0.04, 0.1)), 0.25);
  float d = earSd(m);
  if (d < 0.08) {
    vec3 n = bump(GRAD(earSd, m) * vec2(side, 1.0), d, 0.2);
    float f = strands(m, vec2(0.16, 0.99), 10.0);
    vec3 fur = vec3(0.97, 0.95, 0.94) * (0.86 + 0.18 * f);
    vec3 lit = fur * (0.5 + 0.6 * diffuse(n)) + vec3(0.08) * shine(n, 12.0);
    float id = innerSd(m);
    vec3 pink = mix(vec3(0.94, 0.58, 0.66), vec3(1.0, 0.8, 0.84), smoothstep(-0.09, 0.0, id));
    lit = mix(lit, pink * (0.6 + 0.45 * diffuse(n)), 1.0 - smoothstep(-0.03, 0.03, id));
    float edge = d + (noise(m * 14.0) - 0.5) * 0.025;
    col = over(col, lit, 1.0 - smoothstep(-0.012, 0.01, edge));
  }
  float nd = noseSd(q);
  if (nd < 0.04) {
    vec3 n = bump(GRAD(noseSd, q), nd, 0.07);
    vec3 nose = vec3(0.95, 0.55, 0.64) * (0.55 + 0.6 * diffuse(n)) + vec3(1.0) * shine(n, 30.0) * 0.6;
    col = over(col, nose, fill(nd));
  }
  col = splitTone(lift(col, 0.015), vec3(0.4, 0.7, 0.7), vec3(1.0, 0.85, 0.88), 0.08);
  finish(sCurve(col, 0.06));
}
`,
  ),
  lens(
    'teddy',
    'Teddy',
    'paw-print',
    `
float earSd(vec2 m) {
  return sdCircle(m - vec2(1.0, 1.42), 0.4);
}

float noseSd(vec2 q) {
  vec2 p = q - vec2(0.0, -0.58);
  float w = mix(0.1, 0.19, smoothstep(-0.1, 0.05, p.y));
  return (length(vec2(p.x / w, p.y / 0.11)) - 1.0) * min(w, 0.11);
}

void main() {
  vec3 col = beautify(beautyWarp(tc, 0.05, 0.06), 0.6, 0.1);
  vec2 q = toFace(tc);
  float side = q.x < 0.0 ? -1.0 : 1.0;
  vec2 m = vec2(abs(q.x), q.y);
  col = blush(col, q, vec3(1.0, 0.8, 0.8), 0.4);
  col *= 1.0 - 0.35 * uFaceOn * shadowAt(earSd(m + vec2(0.04, 0.1)), 0.25);
  float d = earSd(m);
  if (d < 0.1) {
    vec3 n = bump(GRAD(earSd, m) * vec2(side, 1.0), d, 0.25);
    float f = strands(m, dir(m - vec2(1.0, 1.42)), 9.0);
    vec3 fur = mix(vec3(0.3, 0.18, 0.09), vec3(0.66, 0.45, 0.26), f);
    float inner = sdCircle(m - vec2(0.97, 1.38), 0.22) + (noise(m * 22.0) - 0.5) * 0.05;
    fur = mix(fur, vec3(0.88, 0.7, 0.5) * (0.8 + 0.25 * f), 1.0 - smoothstep(-0.03, 0.03, inner));
    vec3 lit = fur * (0.42 + 0.75 * diffuse(n)) + vec3(0.08) * shine(n, 12.0);
    float edge = d + (noise(m * 12.0) - 0.5) * 0.045;
    col = over(col, lit, 1.0 - smoothstep(-0.015, 0.012, edge));
  }
  float nd = noseSd(q);
  if (nd < 0.04) {
    vec3 n = bump(GRAD(noseSd, q), nd, 0.09);
    vec3 nose = vec3(0.17, 0.09, 0.05) * (0.5 + 0.8 * diffuse(n)) + vec3(0.9) * shine(n, 34.0) * 0.8;
    col = over(col, nose, fill(nd));
  }
  col = over(col, vec3(0.2, 0.1, 0.06), fill(sdSegment(q, vec2(0.0, -0.66), vec2(0.0, -0.8)) - 0.012) * 0.8);
  finish(sCurve(col * vec3(1.04, 1.0, 0.95), 0.1));
}
`,
  ),
  lens(
    'aviators',
    'Aviators',
    'glasses',
    `
float lensSd(vec2 m) {
  vec2 p = m - vec2(0.56, -0.07);
  float body = sdEllipse(p - vec2(0.03, -0.05), vec2(0.42, 0.36));
  float top = p.y - 0.2 - 0.06 * p.x;
  float k = 0.08;
  float h = clamp(0.5 - 0.5 * (top - body) / k, 0.0, 1.0);
  return mix(top, body, h) + k * h * (1.0 - h);
}

void main() {
  vec3 col = beautify(tc, 0.45, 0.06);
  vec2 q = toFace(tc);
  float side = q.x < 0.0 ? -1.0 : 1.0;
  vec2 m = vec2(abs(q.x), q.y);
  col *= 1.0 - 0.18 * uFaceOn * shadowAt(lensSd(m + vec2(0.0, 0.1)), 0.16);
  float d = lensSd(m);
  vec2 g = GRAD(lensSd, m) * vec2(side, 1.0);
  if (d < 0.01) {
    float k = clamp(-d / 0.3, 0.0, 1.0);
    float ty = smoothstep(0.2, -0.4, q.y);
    vec3 tint = mix(vec3(0.05, 0.04, 0.035), vec3(0.45, 0.3, 0.15), ty);
    float trans = mix(0.03, 0.24, ty);
    vec3 glass = col * vec3(0.95, 0.72, 0.45) * trans + tint * (1.0 - trans);
    vec3 env = sample(vec2(1.0 - tc.x, tc.y) * 0.7 + 0.15 + g * 0.04).rgb;
    glass = mix(glass, env * vec3(0.6, 0.56, 0.5), 0.08 + 0.3 * pow(1.0 - k, 3.0));
    vec2 hl = (q - vec2(side * 0.56 - 0.14, 0.1)) * vec2(1.0, 1.6);
    glass += vec3(1.0, 0.95, 0.85) * 0.45 * (1.0 - smoothstep(0.0, 0.12, length(hl)));
    float sweep = fract(uTime / 7.0) * 3.5 - 1.2;
    glass += vec3(0.35) * (1.0 - smoothstep(0.0, 0.05, abs(q.x * 0.6 + q.y - sweep)));
    col = over(col, glass, fill(d));
  }
  vec3 gold = vec3(0.86, 0.68, 0.36);
  float ring = abs(d) - 0.025;
  if (ring < 0.03) col = over(col, tube(g, d / 0.025, gold), fill(ring));
  float bar = sdSegment(q, vec2(-0.27, 0.19), vec2(0.27, 0.19)) - 0.02;
  col = over(col, tube(vec2(0.0, 1.0), (q.y - 0.19) / 0.02, gold), fill(bar));
  vec2 b = vec2(q.x, q.y - 0.05 - 0.07 * (1.0 - (q.x / 0.22) * (q.x / 0.22)));
  float bridge = sdSegment(b, vec2(-0.22, 0.0), vec2(0.22, 0.0)) - 0.018;
  col = over(col, tube(vec2(0.0, 1.0), b.y / 0.018, gold), fill(bridge));
  float temple = sdSegment(m, vec2(0.9, 0.12), vec2(1.25, 0.18)) - 0.022;
  col = over(col, tube(vec2(0.0, 1.0), (m.y - 0.12 - (m.x - 0.9) * 0.17) / 0.022, gold), fill(temple));
  col = vibrance(col * vec3(1.03, 1.0, 0.96), 0.2);
  finish(sCurve(col, 0.18));
}
`,
  ),
  lens(
    'hearts',
    'Hearts',
    'heart',
    `
float dot2(vec2 v) {
  return dot(v, v);
}

float sdHeart(vec2 p) {
  p.x = abs(p.x);
  if (p.y + p.x > 1.0) return sqrt(dot2(p - vec2(0.25, 0.75))) - 0.3535534;
  return sqrt(min(dot2(p - vec2(0.0, 1.0)), dot2(p - 0.5 * max(p.x + p.y, 0.0)))) * sign(p.x - p.y);
}

float heartAt(vec2 p) {
  return sdHeart(p + vec2(0.0, 0.5));
}

void main() {
  vec3 col = beautify(beautyWarp(tc, 0.06, 0.08), 0.6, 0.1);
  vec2 q = toFace(tc);
  col = blush(col, q, vec3(1.0, 0.74, 0.8), 0.55);
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float a = fi * 1.0471976 + uTime * 0.7;
    float depth = 0.5 + 0.5 * sin(a);
    vec2 c = vec2(cos(a) * 1.45, 1.65 + sin(a) * 0.36);
    float s = mix(0.34, 0.22, depth);
    vec2 p = rot(q - c, 0.25 * sin(uTime * 2.0 + fi)) / s;
    if (dot(p, p) > 2.5) continue;
    col *= 1.0 - 0.22 * uFaceOn * shadowAt(heartAt(p + vec2(0.12, 0.25)) * s, 0.06);
    float d = heartAt(p);
    vec3 n = bump(GRAD(heartAt, p), d, 0.35);
    vec3 base = mix(vec3(0.92, 0.1, 0.28), vec3(1.0, 0.42, 0.62), mod(fi, 2.0));
    vec3 lit = base * (0.45 + 0.7 * diffuse(n)) + vec3(1.0) * shine(n, 40.0) * 0.8;
    col = over(col, lit * mix(1.0, 0.82, depth), fill(d * s));
  }
  col = screen(col, glowAt(tc, uSize.y / 40.0, 0.6) * vec3(1.0, 0.7, 0.8) * 0.5);
  col = splitTone(col, vec3(0.5, 0.3, 0.5), vec3(1.0, 0.8, 0.85), 0.08);
  finish(sCurve(col, 0.08));
}
`,
  ),
  lens(
    'flowers',
    'Flower crown',
    'flower-2',
    `
float flowerSd(vec2 p) {
  float a = atan(p.y, p.x);
  return length(p) - (0.68 + 0.32 * abs(cos(2.5 * a)));
}

float leafSd(vec2 p) {
  return sdEllipse(p, vec2(1.0, 0.36));
}

void main() {
  vec3 col = beautify(beautyWarp(tc, 0.05, 0.07), 0.6, 0.12);
  vec2 q = toFace(tc);
  col = blush(col, q, vec3(1.0, 0.82, 0.82), 0.35);
  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    float ph = mix(0.1, 0.9, (fi + 0.5) / 9.0) * 3.1415927;
    vec2 c = vec2(cos(ph) * 1.42, 0.5 + sin(ph) * 1.2);
    vec2 lp = rot(q - c, -(ph + 1.5708)) / 0.17;
    if (dot(lp, lp) < 2.0) {
      float ld = leafSd(lp);
      vec3 ln = bump(GRAD(leafSd, lp), ld, 0.5);
      vec3 leaf = vec3(0.25, 0.55, 0.22) * (0.45 + 0.7 * diffuse(ln));
      leaf *= 1.0 - 0.35 * (1.0 - smoothstep(0.0, 0.08, abs(lp.y)));
      col = over(col, leaf, fill(ld * 0.17));
    }
  }
  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    float ph = mix(0.1, 0.9, fi / 8.0) * 3.1415927;
    vec2 c = vec2(cos(ph) * 1.42, 0.5 + sin(ph) * 1.2);
    float s = mix(0.17, 0.23, mod(fi, 2.0));
    vec2 p = rot(q - c, fi * 1.7 + 0.15 * sin(uTime * 1.5 + fi)) / s;
    if (dot(p, p) > 2.4) continue;
    col *= 1.0 - 0.22 * uFaceOn * shadowAt(flowerSd(p + vec2(0.12, 0.3)) * s, 0.06);
    float d = flowerSd(p);
    vec3 n = bump(GRAD(flowerSd, p), d, 0.5);
    float k = mod(fi, 4.0);
    vec3 petal = k < 1.0 ? vec3(1.0, 0.62, 0.74) : k < 2.0 ? vec3(1.0, 0.95, 0.92)
      : k < 3.0 ? vec3(1.0, 0.75, 0.55) : vec3(0.82, 0.7, 1.0);
    float r = length(p);
    float crease = sqrt(abs(cos(2.5 * atan(p.y, p.x))));
    vec3 lit = petal * (0.5 + 0.55 * diffuse(n)) * mix(0.72, 1.0, crease) * mix(0.82, 1.06, r);
    vec3 heart = mix(vec3(1.0, 0.82, 0.25), vec3(0.85, 0.5, 0.1), noise(p * 9.0));
    lit = mix(lit, heart * (0.6 + 0.5 * diffuse(n)), 1.0 - smoothstep(0.22, 0.3, r));
    col = over(col, lit + vec3(0.12) * shine(n, 20.0), fill(d * s));
  }
  col = screen(col, glowAt(tc, uSize.y / 40.0, 0.62) * vec3(1.0, 0.85, 0.75) * 0.45);
  col = splitTone(col, vec3(0.45, 0.35, 0.5), vec3(1.0, 0.86, 0.75), 0.1);
  finish(sCurve(lift(col, 0.015), 0.08));
}
`,
  ),
  lens(
    'halo',
    'Halo',
    'sparkles',
    `
void main() {
  vec3 col = beautify(beautyWarp(tc, 0.05, 0.07), 0.65, 0.14);
  vec2 q = toFace(tc);
  vec3 dreamy = blurAt(tc, uSize.y / 60.0);
  col = screen(col, max(dreamy - 0.45, 0.0) * vec3(1.0, 0.92, 0.8) * 0.8);
  vec2 p = q - vec2(0.0, 2.0);
  float ring = abs(sdEllipse(p, vec2(0.82, 0.21)));
  float ang = atan(p.y / 0.21, p.x / 0.82);
  float shimmer = 0.75 + 0.25 * sin(ang * 3.0 - uTime * 3.0);
  float core = 1.0 - smoothstep(0.012, 0.045, ring);
  float halo = exp(-ring * 10.0) * 0.55 + core;
  col = screen(col, vec3(1.0, 0.84, 0.45) * halo * shimmer * uFaceOn);
  for (int i = 0; i < 8; i++) {
    float fi = float(i);
    float a = mix(-0.5, 3.64, fi / 7.0);
    vec2 c = vec2(cos(a) * 1.85, sin(a) * 2.0 + fract(uTime * 0.05 + fi * 0.13) * 0.4);
    float tw = pow(0.5 + 0.5 * sin(uTime * 2.6 + fi * 2.1), 3.0);
    col = screen(col, vec3(1.0, 0.95, 0.8) * star(q - c, 0.14) * tw * uFaceOn);
  }
  col = splitTone(lift(col, 0.03), vec3(0.6, 0.65, 0.9), vec3(1.0, 0.92, 0.8), 0.08);
  finish(col);
}
`,
  ),
  lens(
    'devil',
    'Devil',
    'flame',
    `
float hornSd(vec2 m) {
  vec2 p = rot(m - vec2(0.5, 1.1), 0.42);
  float h = clamp(p.y / 0.92, 0.0, 1.0);
  p.x += 0.3 * h * h;
  float r = mix(0.24, 0.015, pow(h, 0.75));
  return max(abs(p.x) - r, max(-p.y, p.y - 0.92));
}

void main() {
  vec3 col = beautify(tc, 0.5, 0.04);
  vec2 q = toFace(tc);
  float side = q.x < 0.0 ? -1.0 : 1.0;
  vec2 m = vec2(abs(q.x), q.y);
  col *= 1.0 - 0.35 * uFaceOn * shadowAt(hornSd(m + vec2(0.04, 0.08)), 0.2);
  float d = hornSd(m);
  if (d < 0.05) {
    vec3 n = bump(GRAD(hornSd, m) * vec2(side, 1.0), d, 0.12);
    float h = clamp(rot(m - vec2(0.5, 1.1), 0.42).y / 0.92, 0.0, 1.0);
    vec3 base = mix(vec3(0.32, 0.02, 0.03), vec3(0.85, 0.08, 0.1), smoothstep(0.0, 0.6, h));
    base *= 0.88 + 0.12 * sin(h * 38.0);
    vec3 lit = base * (0.35 + 0.8 * diffuse(n)) + vec3(1.0, 0.85, 0.85) * shine(n, 32.0) * 0.8;
    col = over(col, lit, fill(d));
  }
  vec2 g = tc * uSize / (uSize.y / 14.0) - vec2(0.0, uTime * 1.5);
  vec2 cell = floor(g);
  float e = hash(cell);
  vec2 o = vec2(hash(cell + 3.7), hash(cell + 9.1)) * 0.6 + 0.2;
  float spark = step(0.88, e) * (1.0 - smoothstep(0.0, 0.08, length((fract(g) - o) * vec2(1.0, 0.6))));
  spark *= (0.6 + 0.4 * sin(uTime * 9.0 + e * 40.0)) * smoothstep(0.7, 0.0, tc.y);
  col = screen(col, vec3(1.0, 0.45, 0.12) * spark);
  col = splitTone(col, vec3(0.55, 0.0, 0.08), vec3(1.0, 0.75, 0.6), 0.14);
  finish(sCurve(col, 0.3) * vignette(tc, 0.5));
}
`,
  ),
  lens(
    'crown',
    'Crown',
    'crown',
    `
float crownSd(vec2 p) {
  p.y += 0.14 * (p.x / 0.95) * (p.x / 0.95);
  float d = sdBox(p, vec2(0.95, 0.13), 0.03);
  for (int i = 0; i < 5; i++) {
    float k = float(i) - 2.0;
    float x = k * 0.4;
    float top = 0.62 - abs(k) * 0.1;
    d = min(d, sdTri(p, vec2(x - 0.17, 0.05), vec2(x + 0.17, 0.05), vec2(x, top)) - 0.02);
    d = min(d, sdCircle(p - vec2(x, top + 0.04), 0.055));
  }
  return d;
}

void main() {
  vec3 col = beautify(beautyWarp(tc, 0.05, 0.06), 0.55, 0.08);
  vec2 q = toFace(tc);
  vec2 p = q - vec2(0.0, 1.38);
  if (abs(p.x) < 1.2 && p.y > -0.45 && p.y < 0.9) {
    col *= 1.0 - 0.35 * uFaceOn * shadowAt(crownSd(p + vec2(0.03, 0.12)), 0.22);
    float d = crownSd(p);
    vec3 n = bump(GRAD(crownSd, p), d, 0.08);
    float cyl = sqrt(max(1.0 - (p.x / 1.05) * (p.x / 1.05), 0.0));
    vec3 gold = vec3(0.95, 0.74, 0.3) * (0.35 + 0.55 * cyl + 0.45 * diffuse(n));
    gold += vec3(1.0, 0.95, 0.8) * (shine(n, 24.0) * 0.7 + pow(cyl, 8.0) * 0.25);
    gold += vec3(0.6) * (1.0 - smoothstep(0.0, 0.06, abs(p.x - (fract(uTime / 5.0) * 3.0 - 1.5))));
    vec2 pb = vec2(p.x, p.y + 0.14 * (p.x / 0.95) * (p.x / 0.95));
    for (int i = 0; i < 3; i++) {
      vec2 gp = pb - vec2((float(i) - 1.0) * 0.5, 0.0);
      vec3 gem = i == 0 ? vec3(0.1, 0.35, 0.9) : i == 1 ? vec3(0.9, 0.08, 0.2) : vec3(0.1, 0.7, 0.35);
      vec3 gn = normalize(vec3(gp / 0.075 * 0.9, 1.0));
      float facet = 0.75 + 0.25 * cos(atan(gp.y, gp.x) * 6.0);
      vec3 gemCol = gem * (0.35 + 0.7 * diffuse(gn)) * facet + vec3(1.0) * shine(gn, 50.0);
      gold = mix(gold, gemCol, fill(sdCircle(gp, 0.075)));
    }
    col = over(col, gold, fill(d));
  }
  finish(sCurve(col * vec3(1.04, 1.0, 0.94), 0.15) * vignette(tc, 0.25));
}
`,
  ),
  lens(
    'freckles',
    'Freckles',
    'sun',
    `
float freckleField(vec2 q) {
  vec2 g = q * 13.0;
  vec2 cell = floor(g);
  float f = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 c = cell + vec2(float(i), float(j));
      vec2 o = c + vec2(hash(c + 3.1), hash(c + 7.7));
      float r = 0.12 + 0.2 * hash(c + 11.3);
      float spot = 1.0 - smoothstep(r * 0.4, r, length(g - o));
      f = max(f, step(0.45, hash(c)) * spot * (0.45 + 0.55 * hash(c + 5.5)));
    }
  }
  return f;
}

void main() {
  vec3 col = beautify(beautyWarp(tc, 0.05, 0.06), 0.55, 0.1);
  vec2 q = toFace(tc);
  float skin = skinMask(sample(tc).rgb);
  float region = exp(-q.x * q.x / 0.7 - (q.y + 0.62) * (q.y + 0.62) / 0.06);
  region *= smoothstep(0.18, 0.32, length(vec2(abs(q.x) - 0.5, q.y)));
  float f = freckleField(q) * region * skin * uFaceOn;
  col *= mix(vec3(1.0), vec3(0.74, 0.55, 0.42), f * 0.8);
  float ax = abs(q.x) - 0.7;
  float dew = exp(-q.x * q.x / 0.004 - (q.y + 0.45) * (q.y + 0.45) / 0.03)
    + exp(-ax * ax / 0.03 - (q.y + 0.5) * (q.y + 0.5) / 0.01);
  col = screen(col, vec3(1.0, 0.9, 0.75) * dew * 0.18 * uFaceOn * skin);
  col = screen(col, glowAt(tc, uSize.y / 35.0, 0.55) * vec3(1.0, 0.7, 0.4) * 0.55);
  col = splitTone(col, vec3(0.4, 0.25, 0.35), vec3(1.0, 0.75, 0.45), 0.14);
  finish(sCurve(vibrance(col, 0.15) * vignette(tc, 0.2), 0.12));
}
`,
  ),
  lens(
    'glitter',
    'Glitter',
    'star',
    `
void main() {
  vec3 col = beautify(beautyWarp(tc, 0.06, 0.08), 0.65, 0.12);
  vec2 q = toFace(tc);
  col = blush(col, q, vec3(1.0, 0.8, 0.86), 0.35);
  float skin = skinMask(sample(tc).rgb);
  vec2 m = vec2(abs(q.x), q.y);
  float zone = exp(-(m.x - 0.62) * (m.x - 0.62) / 0.08 - (m.y + 0.38) * (m.y + 0.38) / 0.02)
    + exp(-(m.x - 0.55) * (m.x - 0.55) / 0.05 - (m.y - 0.2) * (m.y - 0.2) / 0.006);
  vec2 g = q * 32.0;
  vec2 cell = floor(g);
  float h = hash(cell);
  vec2 o = cell + 0.5 + (vec2(hash(cell + 1.3), hash(cell + 4.1)) - 0.5) * 0.6;
  float tw = 0.25 + 0.75 * pow(max(sin(uTime * 4.0 + h * 60.0), 0.0), 3.0);
  float pt = (1.0 - smoothstep(0.0, 0.4, length(g - o))) * step(0.45, h) * tw;
  pt += star(g - o, 1.6) * step(0.9, h) * tw * 0.8;
  vec3 iri = mix(vec3(1.0), hue(fract(h * 7.0 + uTime * 0.1)), 0.4);
  col = screen(col, iri * pt * min(zone, 1.0) * skin * uFaceOn * 1.6);
  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    float a = mix(-0.25, 3.39, fi / 8.0) + 0.15 * sin(uTime * 0.6 + fi);
    vec2 c = vec2(cos(a) * 1.75, 0.2 + sin(a) * 1.95);
    float tw2 = 0.3 + 0.7 * pow(0.5 + 0.5 * sin(uTime * 3.0 + fi * 1.7), 2.0);
    float s = 0.2 + 0.08 * hash(vec2(fi, 2.0));
    col = screen(col, vec3(1.0, 0.9, 1.0) * star(q - c, s) * tw2 * 1.3 * uFaceOn);
  }
  col = screen(col, glowAt(tc, uSize.y / 40.0, 0.6) * vec3(1.0, 0.8, 0.95) * 0.5);
  col = splitTone(col, vec3(0.45, 0.4, 0.7), vec3(1.0, 0.85, 0.95), 0.1);
  finish(sCurve(col, 0.08));
}
`,
  ),
];

const FACE_FUN: VideoEffect[] = [
  warp(
    'bigeyes',
    'Big eyes',
    'eye',
    `
void main() {
  vec2 q = toFace(tc);
  vec2 eye = vec2(q.x < 0.0 ? -0.5 : 0.5, 0.0);
  vec2 d = q - eye;
  float r = length(d) / 0.45;
  float k = r < 1.0 ? mix(0.55, 1.0, r * r) : 1.0;
  vec2 t = mix(tc, fromFace(eye + d * k), uFaceOn);
  finish(sample(t).rgb);
}
`,
  ),
  warp(
    'bobble',
    'Bobble head',
    'maximize',
    `
void main() {
  vec2 p = bulge(toFace(tc), vec2(0.0, -0.25), 2.7, -0.36);
  finish(sample(fromFace(p)).rgb);
}
`,
  ),
  warp(
    'tiny',
    'Tiny face',
    'minimize',
    `
void main() {
  vec2 p = bulge(toFace(tc), vec2(0.0, -0.45), 2.0, 0.8);
  finish(sample(fromFace(p)).rgb);
}
`,
  ),
  warp(
    'alien',
    'Alien',
    'ghost',
    `
void main() {
  vec2 q = toFace(tc);
  vec2 p = bulge(q, vec2(0.0, 0.9), 1.4, -0.3);
  p = bulge(p, vec2(-0.5, 0.0), 0.5, -0.55);
  p = bulge(p, vec2(0.5, 0.0), 0.5, -0.55);
  float chin = smoothstep(-0.6, -2.2, q.y) * smoothstep(1.9, 0.2, abs(q.x));
  p.x *= 1.0 + 0.55 * chin * uFaceOn;
  vec3 col = sample(fromFace(p)).rgb;
  vec3 green = vec3(luma(col)) * vec3(0.62, 1.12, 0.62) + vec3(0.02, 0.06, 0.02);
  float head = 1.0 - smoothstep(0.9, 1.15, length((q - vec2(0.0, -0.5)) / vec2(1.35, 2.1)));
  col = mix(col, green, skinMask(col) * head * 0.8 * uFaceOn);
  vec2 m = vec2(abs(q.x), q.y);
  float eye = sdEllipse(rot(m - vec2(0.52, 0.02), -0.35), vec2(0.27, 0.16));
  float shineSpot = 1.0 - smoothstep(0.0, 0.05, length(m - vec2(0.44, 0.08)));
  col = over(col, vec3(0.02, 0.02, 0.03) + vec3(0.75) * shineSpot, fill(eye) * 0.94);
  finish(col);
}
`,
  ),
  warp(
    'chipmunk',
    'Chipmunk',
    'smile',
    `
void main() {
  vec2 p = bulge(toFace(tc), vec2(-0.78, -0.95), 0.62, -0.5);
  p = bulge(p, vec2(0.78, -0.95), 0.62, -0.5);
  p = bulge(p, vec2(-0.5, 0.0), 0.4, -0.2);
  p = bulge(p, vec2(0.5, 0.0), 0.4, -0.2);
  finish(sample(fromFace(p)).rgb);
}
`,
  ),
  warp(
    'bignose',
    'Big nose',
    'scan-face',
    `
void main() {
  vec2 p = bulge(toFace(tc), vec2(0.0, -0.6), 0.6, -0.6);
  finish(sample(fromFace(p)).rgb);
}
`,
  ),
  warp(
    'bigmouth',
    'Big mouth',
    'laugh',
    `
void main() {
  vec2 p = bulge(toFace(tc), vec2(0.0, -1.2), 0.7, -0.55);
  finish(sample(fromFace(p)).rgb);
}
`,
  ),
  warp(
    'long',
    'Long face',
    'move-vertical',
    `
void main() {
  vec2 c = vec2(0.0, -0.5);
  vec2 d = toFace(tc) - c;
  float r = length(d / vec2(1.7, 2.6));
  float w = r < 1.0 ? (1.0 - r * r) * (1.0 - r * r) : 0.0;
  d.y *= 1.0 - 0.4 * w * uFaceOn;
  d.x *= 1.0 + 0.18 * w * uFaceOn;
  finish(sample(fromFace(c + d)).rgb);
}
`,
  ),
  warp(
    'wide',
    'Wide face',
    'move-horizontal',
    `
void main() {
  vec2 c = vec2(0.0, -0.5);
  vec2 d = toFace(tc) - c;
  float r = length(d / vec2(1.7, 2.6));
  float w = r < 1.0 ? (1.0 - r * r) * (1.0 - r * r) : 0.0;
  d.x *= 1.0 - 0.4 * w * uFaceOn;
  d.y *= 1.0 + 0.1 * w * uFaceOn;
  finish(sample(fromFace(c + d)).rgb);
}
`,
  ),
  warp(
    'swirl',
    'Swirl',
    'tornado',
    `
void main() {
  vec2 c = vec2(0.0, -0.4);
  vec2 d = toFace(tc) - c;
  float r = length(d) / 2.3;
  float w = r < 1.0 ? (1.0 - r) * (1.0 - r) : 0.0;
  d = rot(d, 2.4 * w * sin(uTime * 1.3) * uFaceOn);
  finish(sample(fromFace(c + d)).rgb);
}
`,
  ),
  warp(
    'jelly',
    'Jelly',
    'bubbles',
    `
void main() {
  vec2 c = vec2(0.0, -0.4);
  vec2 d = toFace(tc) - c;
  float r = length(d / vec2(1.6, 2.2));
  float w = r < 1.0 ? (1.0 - r * r) * (1.0 - r * r) : 0.0;
  d += vec2(sin(d.y * 3.5 + uTime * 7.0), sin(d.x * 3.0 + uTime * 6.0)) * 0.09 * w * uFaceOn;
  d.y *= 1.0 + 0.08 * sin(uTime * 7.0) * w * uFaceOn;
  finish(sample(fromFace(c + d)).rgb);
}
`,
  ),
  warp(
    'symmetry',
    'Symmetry',
    'drama',
    `
void main() {
  vec2 q = toFace(tc);
  float r = length((q - vec2(0.0, -0.5)) / vec2(1.25, 1.7));
  float w = (1.0 - smoothstep(0.75, 1.0, r)) * uFaceOn;
  vec3 mirrored = sample(fromFace(vec2(-abs(q.x), q.y))).rgb;
  finish(mix(sample(tc).rgb, mirrored, w));
}
`,
  ),
];

const PICTURE_FUN: VideoEffect[] = [
  fun(
    'fisheye',
    'Fisheye',
    'aperture',
    `
void main() {
  vec2 a = vec2(uSize.x / uSize.y, 1.0);
  vec2 d = (tc - 0.5) * a;
  float rn = length(d) / length(a * 0.5);
  vec2 t = 0.5 + d * (0.6 + 0.4 * rn * rn) / a;
  finish(sample(t).rgb * vignette(tc, 0.35));
}
`,
  ),
  fun(
    'kaleido',
    'Kaleido',
    'hexagon',
    `
void main() {
  vec2 a = vec2(uSize.x / uSize.y, 1.0);
  vec2 d = (tc - 0.5) * a;
  float ang = atan(d.y, d.x) + uTime * 0.15;
  float seg = 1.0471976;
  ang = abs(mod(ang, seg) - seg * 0.5);
  vec2 p = vec2(sin(ang), cos(ang)) * length(d);
  finish(vibrance(sample(vec2(0.5, 0.45) + p / a * 0.85).rgb, 0.25));
}
`,
  ),
  fun(
    'mirror',
    'Mirror',
    'flip-horizontal-2',
    `
void main() {
  vec2 p = tc;
  if (p.x > 0.5) p.x = 1.0 - p.x;
  finish(sample(p).rgb);
}
`,
  ),
  fun(
    'funhouse',
    'Funhouse',
    'waves',
    `
void main() {
  vec2 t = tc;
  t.x += sin(t.y * 10.0 + uTime * 2.4) * 0.03;
  t.y += sin(t.x * 6.0 + uTime * 1.6) * 0.02;
  finish(sample(t).rgb);
}
`,
  ),
  fun(
    'glitch',
    'Glitch',
    'zap',
    `
void main() {
  float frame = floor(uTime * 12.0);
  float row = floor(tc.y * 28.0);
  float burst = step(0.6, hash(vec2(floor(uTime * 3.0), 7.0)));
  vec2 t = tc;
  t.x += (hash(vec2(row, frame + 1.0)) - 0.5) * 0.12 * step(0.82, hash(vec2(row, frame))) * burst;
  float split = (0.004 + 0.012 * burst) * (0.6 + 0.4 * sin(uTime * 20.0));
  vec3 col = vec3(sample(t + vec2(split, 0.0)).r, sample(t).g, sample(t - vec2(split, 0.0)).b);
  col *= 0.93 + 0.07 * sin(tc.y * uSize.y * 1.5);
  col = mix(col, col.gbr, step(0.97, hash(floor(tc * vec2(12.0, 20.0)) + frame)) * burst);
  finish(col);
}
`,
  ),
  fun(
    'vhs',
    'VHS',
    'tv',
    `
void main() {
  vec2 t = tc;
  float band = 1.0 - smoothstep(0.0, 0.06, abs(tc.y - fract(uTime * 0.13)));
  t.x += band * (hash(vec2(floor(tc.y * uSize.y / 2.0), floor(uTime * 30.0))) - 0.5) * 0.03;
  t.x += sin(tc.y * 120.0 + uTime * 10.0) * 0.0012;
  float lum = luma(sample(t).rgb);
  vec3 chroma = vec3(0.0);
  for (int i = -3; i <= 3; i++) {
    chroma += sample(t + vec2(float(i) * 3.0 / uSize.x + 0.004, 0.0)).rgb;
  }
  chroma /= 7.0;
  vec3 col = chroma - vec3(luma(chroma)) + lum;
  col = saturation(col, 0.85) * vec3(1.05, 0.98, 0.95);
  col *= 0.92 + 0.08 * sin(tc.y * uSize.y * 1.5707963);
  col += grain(tc) * 0.08 + band * 0.08;
  finish(lift(col, 0.04) * vignette(tc, 0.35));
}
`,
  ),
  fun(
    'popart',
    'Pop art',
    'grid-2x2',
    `
void main() {
  vec2 cell = floor(tc * 2.0);
  vec2 t = fract(tc * 2.0);
  float l = smoothstep(0.15, 0.85, luma(sample(t).rgb));
  float k = cell.x + cell.y * 2.0;
  vec3 dark = k < 0.5 ? vec3(0.1, 0.1, 0.45) : k < 1.5 ? vec3(0.55, 0.0, 0.35)
    : k < 2.5 ? vec3(0.0, 0.35, 0.3) : vec3(0.6, 0.15, 0.0);
  vec3 mid = k < 0.5 ? vec3(1.0, 0.3, 0.55) : k < 1.5 ? vec3(1.0, 0.85, 0.0)
    : k < 2.5 ? vec3(1.0, 0.45, 0.2) : vec3(0.2, 0.75, 1.0);
  vec3 light = k < 0.5 ? vec3(1.0, 0.95, 0.3) : k < 1.5 ? vec3(0.4, 0.95, 1.0)
    : k < 2.5 ? vec3(1.0, 0.9, 0.85) : vec3(1.0, 0.8, 0.95);
  vec3 col = mix(dark, mid, smoothstep(0.28, 0.36, l));
  col = mix(col, light, smoothstep(0.62, 0.7, l));
  col *= 1.0 - 0.9 * smoothstep(0.3, 0.6, edgeAt(t, 3.0 / uSize));
  float gap = min(abs(tc.x - 0.5) * uSize.x, abs(tc.y - 0.5) * uSize.y);
  finish(mix(col, vec3(1.0), step(gap, 2.0)));
}
`,
  ),
  fun(
    'comic',
    'Comic',
    'circle-dot',
    `
void main() {
  vec3 c = sample(tc).rgb;
  vec3 poster = floor(saturation(c, 1.35) * 4.0 + 0.5) / 4.0;
  vec2 pp = rot(tc * uSize, 0.785) / max(uSize.y / 160.0, 3.0);
  float dotR = sqrt(1.0 - luma(c)) * 0.6;
  float dots = 1.0 - smoothstep(dotR - 0.08, dotR + 0.08, length(fract(pp) - 0.5));
  vec3 col = poster * (1.0 - dots * 0.35);
  finish(col * (1.0 - smoothstep(0.22, 0.45, edgeAt(tc, 1.5 / uSize))));
}
`,
  ),
  fun(
    'sketch',
    'Sketch',
    'pen-tool',
    `
void main() {
  float l = luma(sample(tc).rgb);
  float edge = smoothstep(0.08, 0.4, edgeAt(tc, 1.2 / uSize));
  vec2 p = tc * uSize;
  float h1 = smoothstep(0.55, 0.0, l) * (0.5 + 0.5 * sin((p.x + p.y) * 0.9));
  float h2 = smoothstep(0.3, 0.0, l) * (0.5 + 0.5 * sin((p.x - p.y) * 0.9));
  float paper = 0.96 + 0.04 * noise(p * 0.15);
  float ink = clamp(edge + h1 * 0.35 + h2 * 0.35, 0.0, 1.0);
  finish(vec3(paper) * vec3(1.0, 0.98, 0.94) * (1.0 - ink * 0.85));
}
`,
  ),
  fun(
    'pixel',
    'Pixel',
    'grid-3x3',
    `
void main() {
  vec2 block = vec2(uSize.x / 48.0);
  vec2 cellPos = tc * uSize / block;
  vec2 p = (floor(cellPos) + 0.5) * block / uSize;
  vec2 f = abs(fract(cellPos) - 0.5);
  float bevel = 1.0 - 0.18 * smoothstep(0.38, 0.5, max(f.x, f.y));
  finish(sample(p).rgb * bevel);
}
`,
  ),
  fun(
    'neon',
    'Neon',
    'rainbow',
    `
void main() {
  vec3 c = sample(tc).rgb;
  float edge = smoothstep(0.08, 0.4, edgeAt(tc, 1.5 / uSize));
  finish(hue(fract(tc.y * 0.8 + uTime * 0.1)) * edge * 1.6 + c * 0.12);
}
`,
  ),
  fun(
    'thermal',
    'Thermal',
    'thermometer',
    `
void main() {
  float t = luma(sample(tc).rgb);
  vec3 col = mix(vec3(0.0, 0.0, 0.3), vec3(0.5, 0.0, 0.6), smoothstep(0.0, 0.25, t));
  col = mix(col, vec3(0.95, 0.1, 0.1), smoothstep(0.25, 0.55, t));
  col = mix(col, vec3(1.0, 0.8, 0.0), smoothstep(0.55, 0.8, t));
  finish(mix(col, vec3(1.0), smoothstep(0.8, 1.0, t)));
}
`,
  ),
];

const COLOR_EFFECTS: VideoEffect[] = [
  color(
    'golden',
    'Golden',
    'sun',
    `
void main() {
  vec3 c = sample(tc).rgb;
  vec3 col = splitTone(c, vec3(0.35, 0.25, 0.4), vec3(1.0, 0.78, 0.45), 0.16) * vec3(1.06, 1.0, 0.9);
  col = screen(col, glowAt(tc, uSize.y / 45.0, 0.6) * vec3(1.0, 0.75, 0.4) * 0.45);
  finish(sCurve(vibrance(col, 0.15), 0.15) * vignette(tc, 0.18));
}
`,
  ),
  color(
    'cine',
    'Cine',
    'clapperboard',
    `
void main() {
  vec3 col = sCurve(sample(tc).rgb, 0.35);
  col = splitTone(col, vec3(0.0, 0.45, 0.55), vec3(1.0, 0.62, 0.32), 0.22);
  finish(lift(vibrance(col, 0.1), 0.02) * vignette(tc, 0.3));
}
`,
  ),
  color(
    'film',
    'Film',
    'film',
    `
void main() {
  vec3 col = sCurve(sample(tc).rgb, 0.25);
  col = splitTone(col, vec3(0.1, 0.35, 0.3), vec3(1.0, 0.85, 0.65), 0.1);
  col = screen(col, glowAt(tc, uSize.y / 70.0, 0.7) * vec3(1.0, 0.35, 0.2) * 0.6);
  col = lift(col, 0.05) + grain(tc) * 0.07;
  finish(col * vignette(tc, 0.22));
}
`,
  ),
  color(
    'matte',
    'Matte',
    'layers',
    `
void main() {
  vec3 col = lift(saturation(sample(tc).rgb, 0.82), 0.1) * 0.97;
  finish(splitTone(col, vec3(0.2, 0.35, 0.45), vec3(1.0, 0.9, 0.8), 0.08));
}
`,
  ),
  color(
    'dream',
    'Dream',
    'cloud',
    `
void main() {
  vec3 blur = blurAt(tc, uSize.y / 50.0);
  vec3 col = mix(screen(sample(tc).rgb, blur * 0.45), blur, 0.12);
  col = splitTone(col, vec3(0.55, 0.45, 0.8), vec3(1.0, 0.85, 0.9), 0.12);
  finish(lift(col, 0.03));
}
`,
  ),
  color(
    'vivid',
    'Vivid',
    'palette',
    `
void main() {
  vec3 c = sample(tc).rgb;
  vec3 col = c + (c - blurAt(tc, uSize.y / 120.0)) * 0.6;
  finish(sCurve(vibrance(col, 0.45), 0.25));
}
`,
  ),
  color(
    'arctic',
    'Arctic',
    'snowflake',
    `
void main() {
  vec3 col = saturation(sample(tc).rgb, 0.85) * vec3(0.9, 1.0, 1.1) + vec3(0.0, 0.02, 0.05);
  col = splitTone(col, vec3(0.1, 0.3, 0.6), vec3(0.85, 0.95, 1.0), 0.15);
  finish(sCurve(lift(col, 0.02) + 0.03, 0.12));
}
`,
  ),
  color(
    'sunset',
    'Sunset',
    'sunset',
    `
void main() {
  vec3 col = sample(tc).rgb * vec3(1.08, 0.98, 0.9);
  vec3 leak = mix(vec3(1.0, 0.45, 0.2), vec3(0.9, 0.3, 0.6), tc.y);
  col = screen(col, leak * 0.25 * (1.0 - smoothstep(0.0, 1.1, length(tc - vec2(1.0, 0.9)))));
  col = splitTone(col, vec3(0.4, 0.1, 0.4), vec3(1.0, 0.7, 0.4), 0.15);
  finish(sCurve(vibrance(col, 0.2), 0.15) * vignette(tc, 0.2));
}
`,
  ),
  color(
    'pastel',
    'Pastel',
    'candy',
    `
void main() {
  vec3 col = lift(saturation(sample(tc).rgb, 0.7), 0.12);
  finish(splitTone(col, vec3(0.4, 0.8, 0.75), vec3(1.0, 0.8, 0.88), 0.18) + 0.02);
}
`,
  ),
  color(
    'mono',
    'Mono',
    'contrast',
    `
void main() {
  float l = dot(sample(tc).rgb, vec3(0.32, 0.5, 0.18));
  finish((sCurve(vec3(l), 0.35) + grain(tc) * 0.03) * vec3(1.0, 0.99, 0.97));
}
`,
  ),
  color(
    'noir',
    'Noir',
    'moon',
    `
void main() {
  float l = dot(sample(tc).rgb, vec3(0.25, 0.6, 0.15));
  vec3 col = sCurve(sCurve(vec3(l), 0.6), 0.4);
  finish(col * vignette(tc, 0.65) + grain(tc) * 0.06);
}
`,
  ),
  color(
    'vintage',
    'Vintage',
    'camera',
    `
void main() {
  vec3 c = sample(tc).rgb;
  vec3 sepia = vec3(dot(c, vec3(0.393, 0.769, 0.189)),
    dot(c, vec3(0.349, 0.686, 0.168)),
    dot(c, vec3(0.272, 0.534, 0.131)));
  vec3 col = lift(mix(c, sepia, 0.55), 0.08) * vec3(1.0, 0.96, 0.86);
  col = screen(col, vec3(1.0, 0.5, 0.25) * 0.22 * (1.0 - smoothstep(0.0, 0.8, length(tc - vec2(0.0, 1.0)))));
  finish(sCurve(col + grain(tc) * 0.06, 0.12) * vignette(tc, 0.45));
}
`,
  ),
];

export const VIDEO_EFFECTS: readonly VideoEffect[] = [
  ...BEAUTY_EFFECTS,
  ...LENS_EFFECTS,
  ...FACE_FUN,
  ...PICTURE_FUN,
  ...COLOR_EFFECTS,
];

/** The effect with this ID, if there is one ('none' and unknown IDs have none). */
export function videoEffect(id: string): VideoEffect | undefined {
  return VIDEO_EFFECTS.find((effect) => effect.id === id);
}

/** The effects a platform can run: without a face tracker, none of the face ones. */
export function availableEffects(options: { faceTracking: boolean }): VideoEffect[] {
  return VIDEO_EFFECTS.filter((effect) => options.faceTracking || !effect.face);
}

/** The complete fragment shader both apps compile (the prelude of WebRTC's GL drawers). */
export function effectFragmentShader(effect: VideoEffect): string {
  return (
    'precision mediump float;\nvarying vec2 tc;\nuniform sampler2D tex;\n' +
    effect.shader.split('sample(').join('texture2D(tex, ')
  );
}

/** The vertex shader for one full-screen quad (WebRTC's drawers use the same). */
export const EFFECT_VERTEX_SHADER = `varying vec2 tc;
attribute vec4 in_pos;
attribute vec4 in_tc;
uniform mat4 tex_mat;
void main() {
  gl_Position = in_pos;
  tc = (tex_mat * in_tc).xy;
}
`;

/** Where a tracked face is, in the picture's pixels from its bottom left (shader units). */
export interface FaceAnchor {
  /** Between the eyes. */
  x: number;
  y: number;
  /** Distance between the eyes. */
  eyes: number;
  /** The head's roll in radians (0 when the tracker cannot tell). */
  roll: number;
}
