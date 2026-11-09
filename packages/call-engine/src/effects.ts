/**
 * Camera filters and effects for video calls (ADR 0038). Each effect is one GLSL ES 1.00
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
 * Face effects need a face tracker: Android's built-in `FaceDetector` (no library, nothing
 * sent anywhere). The web has none without a large dependency, so it offers the others.
 */

export type VideoEffectKind = 'beauty' | 'face' | 'color';

export interface VideoEffect {
  id: string;
  label: string;
  kind: VideoEffectKind;
  /** Needs the face tracker (Android only for now). */
  face: boolean;
  /** The fragment shader body (see the file comment). */
  shader: string;
}

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

vec3 hue(float h) {
  vec3 k = abs(fract(vec3(h) + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return clamp(k - 1.0, 0.0, 1.0);
}

void finish(vec3 col) {
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/** Face-local coordinates (eyes at (±0.5, 0), up is up) and shape helpers. */
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
  vec2 v = vec2(c * q.x - s * q.y, s * q.x + c * q.y) * uFace.z;
  return (uFace.xy + v) / uSize;
}

/** Coverage of a shape at signed distance d (face units), smoothed over about a pixel. */
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

vec2 rot(vec2 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

vec3 over(vec3 col, vec3 paint, float alpha) {
  return mix(col, paint, clamp(alpha, 0.0, 1.0) * uFaceOn);
}
`;

const color = (id: string, label: string, body: string): VideoEffect => ({
  id,
  label,
  kind: 'color',
  face: false,
  shader: COMMON + body,
});

const beauty = (id: string, label: string, body: string): VideoEffect => ({
  id,
  label,
  kind: 'beauty',
  face: false,
  shader: COMMON + body,
});

const face = (id: string, label: string, body: string): VideoEffect => ({
  id,
  label,
  kind: 'face',
  face: true,
  shader: COMMON + FACE + body,
});

/** A weighted blur over two rings of taps, kinder to edges when `edge` is high. */
const SOFTEN = `
vec3 soften(vec2 t, vec3 c, float radius, float edge) {
  vec2 px = radius / uSize;
  vec3 sum = c;
  float total = 1.0;
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 0.5235988;
    float r = i < 6 ? 1.0 : 2.0;
    vec3 s = sample(t + vec2(cos(a), sin(a)) * px * r).rgb;
    vec3 diff = s - c;
    float w = exp(-dot(diff, diff) * edge);
    sum += s * w;
    total += w;
  }
  return sum / total;
}
`;

export const VIDEO_EFFECTS: readonly VideoEffect[] = [
  beauty(
    'beauty',
    'Beauty',
    `${SOFTEN}
void main() {
  vec3 c = sample(tc).rgb;
  vec3 soft = soften(tc, c, uSize.y / 220.0, 30.0);
  float skin = smoothstep(0.03, 0.14, c.r - c.b) * smoothstep(0.12, 0.3, luma(c));
  vec3 col = mix(c, soft, 0.25 + 0.6 * skin);
  col += (1.0 - col) * 0.07;
  finish(col * vec3(1.03, 1.0, 0.98));
}
`,
  ),
  beauty(
    'glow',
    'Soft glow',
    `${SOFTEN}
void main() {
  vec3 c = sample(tc).rgb;
  vec3 blur = soften(tc, c, uSize.y / 90.0, 0.0);
  vec3 col = 1.0 - (1.0 - c) * (1.0 - blur * 0.45);
  finish(mix(col, blur, 0.15) * vec3(1.02, 1.0, 1.0));
}
`,
  ),
  face(
    'cat',
    'Cat',
    `
void main() {
  vec3 col = sample(tc).rgb;
  vec2 q = toFace(tc);
  vec2 m = vec2(abs(q.x), q.y);
  float ear = sdTri(m, vec2(1.3, 0.95), vec2(0.4, 1.35), vec2(1.1, 2.15));
  float inner = sdTri(m, vec2(1.12, 1.12), vec2(0.62, 1.36), vec2(1.02, 1.82));
  col = over(col, vec3(0.93, 0.6, 0.3), fill(ear));
  col = over(col, vec3(0.97, 0.66, 0.74), fill(inner));
  float nose = sdTri(q, vec2(-0.15, -0.5), vec2(0.15, -0.5), vec2(0.0, -0.68)) - 0.03;
  col = over(col, vec3(0.95, 0.5, 0.62), fill(nose));
  float w = min(sdSegment(m, vec2(0.3, -0.72), vec2(1.2, -0.56)),
    min(sdSegment(m, vec2(0.3, -0.8), vec2(1.25, -0.82)),
        sdSegment(m, vec2(0.3, -0.88), vec2(1.18, -1.08))));
  col = over(col, vec3(0.15), fill(w - 0.018));
  finish(col);
}
`,
  ),
  face(
    'dog',
    'Dog',
    `
void main() {
  vec3 col = sample(tc).rgb;
  vec2 q = toFace(tc);
  vec2 m = vec2(abs(q.x), q.y);
  float ear = sdEllipse(rot(m - vec2(1.15, 0.7), -0.35), vec2(0.36, 0.78));
  col = over(col, vec3(0.42, 0.26, 0.13), fill(ear));
  col = over(col, vec3(0.55, 0.36, 0.2), fill(ear + 0.08));
  float tongue = sdEllipse(q - vec2(0.0, -1.48), vec2(0.17, 0.27));
  col = over(col, vec3(0.93, 0.42, 0.52), fill(tongue));
  col = over(col, vec3(0.75, 0.26, 0.36), fill(sdSegment(q, vec2(0.0, -1.3), vec2(0.0, -1.62)) - 0.012));
  float nose = sdEllipse(q - vec2(0.0, -0.6), vec2(0.21, 0.14));
  col = over(col, vec3(0.06), fill(nose));
  col = over(col, vec3(0.6), fill(sdEllipse(q - vec2(-0.07, -0.56), vec2(0.06, 0.03))));
  finish(col);
}
`,
  ),
  face(
    'bunny',
    'Bunny',
    `
void main() {
  vec3 col = sample(tc).rgb;
  vec2 q = toFace(tc);
  vec2 m = vec2(abs(q.x), q.y);
  vec2 e = rot(m - vec2(0.45, 2.05), 0.12);
  col = over(col, vec3(0.97), fill(sdEllipse(e, vec2(0.25, 0.85))));
  col = over(col, vec3(0.97, 0.7, 0.78), fill(sdEllipse(e, vec2(0.12, 0.64))));
  col = over(col, vec3(0.95, 0.52, 0.64), fill(sdCircle(q - vec2(0.0, -0.56), 0.1)));
  float teeth = sdBox(m - vec2(0.065, -1.2), vec2(0.055, 0.1), 0.02);
  col = over(col, vec3(0.45), fill(teeth - 0.015));
  col = over(col, vec3(0.98), fill(teeth));
  finish(col);
}
`,
  ),
  face(
    'shades',
    'Shades',
    `
void main() {
  vec3 col = sample(tc).rgb;
  vec2 q = toFace(tc);
  vec2 m = vec2(abs(q.x), q.y);
  float lens = sdBox(m - vec2(0.52, 0.0), vec2(0.33, 0.22), 0.12);
  float frame = min(abs(lens) - 0.035,
    min(sdSegment(q, vec2(-0.2, 0.08), vec2(0.2, 0.08)) - 0.03,
        sdSegment(m, vec2(0.85, 0.1), vec2(1.15, 0.16)) - 0.03));
  float shine = smoothstep(0.25, -0.2, q.y - (m.x - 0.52) * 0.6);
  col = over(col, mix(vec3(0.03, 0.04, 0.08), vec3(0.25, 0.3, 0.4), shine * 0.6), fill(lens) * 0.95);
  col = over(col, vec3(0.05), fill(frame));
  finish(col);
}
`,
  ),
  face(
    'clown',
    'Clown',
    `
void main() {
  vec3 col = sample(tc).rgb;
  vec2 q = toFace(tc);
  vec2 m = vec2(abs(q.x), q.y);
  float cheek = length(m - vec2(0.75, -0.85));
  col = over(col, vec3(0.95, 0.25, 0.35), (1.0 - smoothstep(0.05, 0.3, cheek)) * 0.55);
  col = over(col, vec3(0.88, 0.05, 0.08), fill(sdCircle(q - vec2(0.0, -0.58), 0.21)));
  col = over(col, vec3(1.0, 0.75, 0.75), fill(sdCircle(q - vec2(-0.07, -0.51), 0.05)));
  finish(col);
}
`,
  ),
  face(
    'bigeyes',
    'Big eyes',
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
  face(
    'party',
    'Party hat',
    `
void main() {
  vec3 col = sample(tc).rgb;
  vec2 q = rot(toFace(tc) - vec2(0.15, 1.35), -0.18);
  float hat = sdTri(q, vec2(-0.6, 0.0), vec2(0.6, 0.0), vec2(0.0, 1.45));
  float stripe = step(0.5, fract((q.y + q.x * 0.35) * 3.0));
  col = over(col, mix(vec3(0.95, 0.3, 0.55), vec3(0.3, 0.75, 0.95), stripe), fill(hat));
  col = over(col, vec3(1.0, 0.85, 0.2), fill(sdCircle(q - vec2(0.0, 1.48), 0.15)));
  finish(col);
}
`,
  ),
  face(
    'mustache',
    'Mustache',
    `
void main() {
  vec3 col = sample(tc).rgb;
  vec2 q = toFace(tc);
  vec2 m = vec2(abs(q.x), q.y);
  float lobe = sdEllipse(rot(m - vec2(0.27, -0.86), 0.25), vec2(0.3, 0.1));
  float curl = sdCircle(m - vec2(0.56, -0.74), 0.075);
  col = over(col, vec3(0.2, 0.12, 0.06), fill(min(lobe, curl)));
  finish(col);
}
`,
  ),
  color(
    'warm',
    'Warm',
    `
void main() {
  vec3 c = sample(tc).rgb;
  finish(saturation(c * vec3(1.08, 1.0, 0.86) + vec3(0.02, 0.01, 0.0), 1.1));
}
`,
  ),
  color(
    'cool',
    'Cool',
    `
void main() {
  vec3 c = sample(tc).rgb;
  finish(c * vec3(0.88, 1.0, 1.12) + vec3(0.0, 0.01, 0.03));
}
`,
  ),
  color(
    'mono',
    'B&W',
    `
void main() {
  float l = luma(sample(tc).rgb);
  finish(vec3((l - 0.5) * 1.25 + 0.5));
}
`,
  ),
  color(
    'vintage',
    'Vintage',
    `
void main() {
  vec3 c = sample(tc).rgb;
  vec3 sepia = vec3(dot(c, vec3(0.393, 0.769, 0.189)),
    dot(c, vec3(0.349, 0.686, 0.168)),
    dot(c, vec3(0.272, 0.534, 0.131)));
  vec3 col = mix(c, sepia, 0.85) * 0.9 + 0.05;
  float vignette = smoothstep(0.85, 0.35, distance(tc, vec2(0.5)));
  finish(col * mix(0.55, 1.0, vignette));
}
`,
  ),
  color(
    'vivid',
    'Vivid',
    `
void main() {
  vec3 c = saturation(sample(tc).rgb, 1.55);
  finish((c - 0.5) * 1.1 + 0.5);
}
`,
  ),
  color(
    'comic',
    'Comic',
    `
void main() {
  vec3 c = sample(tc).rgb;
  vec3 col = floor(saturation(c, 1.3) * 5.0 + 0.5) / 5.0;
  float edge = edgeAt(tc, 1.5 / uSize);
  finish(col * (1.0 - smoothstep(0.25, 0.5, edge)));
}
`,
  ),
  color(
    'sketch',
    'Sketch',
    `
void main() {
  float edge = edgeAt(tc, 1.2 / uSize);
  finish(vec3(1.0 - smoothstep(0.06, 0.35, edge)) * vec3(1.0, 0.98, 0.93));
}
`,
  ),
  color(
    'pixel',
    'Pixel',
    `
void main() {
  vec2 block = vec2(uSize.x / 48.0);
  vec2 p = (floor(tc * uSize / block) + 0.5) * block / uSize;
  finish(sample(p).rgb);
}
`,
  ),
  color(
    'thermal',
    'Thermal',
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
  color(
    'neon',
    'Neon',
    `
void main() {
  vec3 c = sample(tc).rgb;
  float edge = smoothstep(0.08, 0.4, edgeAt(tc, 1.5 / uSize));
  finish(hue(fract(tc.y * 0.8 + uTime * 0.1)) * edge * 1.6 + c * 0.12);
}
`,
  ),
  color(
    'mirror',
    'Mirror',
    `
void main() {
  vec2 p = tc;
  if (p.x > 0.5) p.x = 1.0 - p.x;
  finish(sample(p).rgb);
}
`,
  ),
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
