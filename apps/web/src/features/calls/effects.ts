// Camera effects in the browser (ADR 0038). The camera track runs through Chrome's and Edge's
// insertable streams (`MediaStreamTrackProcessor` → WebGL → `MediaStreamTrackGenerator`), so
// the effect is drawn before the picture is encoded and keeps running in a background tab.
// Other browsers have no such streams: they offer no effects. The shaders are the shared ones
// from `@pingdost/call-engine`; the face effects need a face tracker the web does not have.
import {
  availableEffects,
  EFFECT_VERTEX_SHADER,
  effectFragmentShader,
  VIDEO_EFFECTS,
  type VideoEffect,
} from '@pingdost/call-engine';

interface TrackProcessor {
  readonly readable: ReadableStream<VideoFrame>;
}

type TrackGenerator = MediaStreamTrack & { readonly writable: WritableStream<VideoFrame> };

interface InsertableStreams {
  Processor: new (init: { track: MediaStreamTrack }) => TrackProcessor;
  Generator: new (init: { kind: 'video' }) => TrackGenerator;
}

function insertableStreams(): InsertableStreams | null {
  const scope = globalThis as unknown as {
    MediaStreamTrackProcessor?: InsertableStreams['Processor'];
    MediaStreamTrackGenerator?: InsertableStreams['Generator'];
  };
  if (!scope.MediaStreamTrackProcessor || !scope.MediaStreamTrackGenerator) return null;
  if (typeof OffscreenCanvas === 'undefined' || typeof VideoFrame === 'undefined') return null;
  return { Processor: scope.MediaStreamTrackProcessor, Generator: scope.MediaStreamTrackGenerator };
}

/** The effects this browser can draw (none without insertable streams; never face ones). */
export function webEffects(): VideoEffect[] {
  return insertableStreams() ? availableEffects({ faceTracking: false }) : [];
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
/** One full-screen quad: position (x, y) and texture coordinate (u, v) per corner. */
const QUAD = new Float32Array([-1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1, 1, 1, 1, 1]);

interface Program {
  program: WebGLProgram;
  position: number;
  coordinate: number;
  tex: WebGLUniformLocation | null;
  texMatrix: WebGLUniformLocation | null;
  size: WebGLUniformLocation | null;
  time: WebGLUniformLocation | null;
  face: WebGLUniformLocation | null;
  faceOn: WebGLUniformLocation | null;
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | string {
  const shader = gl.createShader(type);
  if (!shader) return 'no shader';
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  const log = gl.getShaderInfoLog(shader) ?? 'compile failed';
  gl.deleteShader(shader);
  return log;
}

/** The program for `effect`, or the compiler's complaint. */
function link(gl: WebGLRenderingContext, effect: VideoEffect): Program | string {
  const vertex = compile(gl, gl.VERTEX_SHADER, EFFECT_VERTEX_SHADER);
  if (typeof vertex === 'string') return vertex;
  const fragment = compile(gl, gl.FRAGMENT_SHADER, effectFragmentShader(effect));
  if (typeof fragment === 'string') return fragment;
  const program = gl.createProgram();
  if (!program) return 'no program';
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    return gl.getProgramInfoLog(program) ?? 'link failed';
  }
  return {
    program,
    position: gl.getAttribLocation(program, 'in_pos'),
    coordinate: gl.getAttribLocation(program, 'in_tc'),
    tex: gl.getUniformLocation(program, 'tex'),
    texMatrix: gl.getUniformLocation(program, 'tex_mat'),
    size: gl.getUniformLocation(program, 'uSize'),
    time: gl.getUniformLocation(program, 'uTime'),
    face: gl.getUniformLocation(program, 'uFace'),
    faceOn: gl.getUniformLocation(program, 'uFaceOn'),
  };
}

/**
 * Compiles every shared effect here (the face ones too, which Android runs): a check for
 * development, since a GLSL mistake shows only at run time. Returns the effects that failed.
 */
export function checkEffectShaders(): { id: string; error: string }[] {
  const gl = new OffscreenCanvas(4, 4).getContext('webgl');
  if (!gl) return [{ id: '*', error: 'no WebGL' }];
  const failed: { id: string; error: string }[] = [];
  for (const effect of VIDEO_EFFECTS) {
    const program = link(gl, effect);
    if (typeof program === 'string') failed.push({ id: effect.id, error: program });
    else gl.deleteProgram(program.program);
  }
  return failed;
}

/** One call's camera effects: `track` replaces the camera on the sender and in the self view. */
export class CameraEffects {
  readonly track: MediaStreamTrack;
  readonly #streams: InsertableStreams;
  readonly #writer: WritableStreamDefaultWriter<VideoFrame>;
  #reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  #generation = 0;
  #effect: VideoEffect | null = null;
  #canvas: OffscreenCanvas | null = null;
  #gl: WebGLRenderingContext | null = null;
  #texture: WebGLTexture | null = null;
  #quad: WebGLBuffer | null = null;
  readonly #programs = new Map<string, Program | null>();
  readonly #startedAt = performance.now();
  #stopped = false;

  constructor() {
    const streams = insertableStreams();
    if (!streams) throw new Error('camera effects need insertable streams');
    this.#streams = streams;
    const generator = new streams.Generator({ kind: 'video' });
    this.track = generator;
    this.#writer = generator.writable.getWriter();
  }

  /** The effect for the coming frames (null: they pass unchanged). */
  setEffect(effect: VideoEffect | null): void {
    this.#effect = effect;
  }

  /** The camera to read from (null while it is closed). */
  setSource(track: MediaStreamTrack | null): void {
    const generation = ++this.#generation;
    const previous = this.#reader;
    this.#reader = null;
    void previous?.cancel().catch(() => undefined);
    if (!track || this.#stopped) return;
    const reader = new this.#streams.Processor({ track }).readable.getReader();
    this.#reader = reader;
    void this.#pump(reader, generation);
  }

  stop(): void {
    this.#stopped = true;
    this.setSource(null);
    this.track.stop();
    void this.#writer.close().catch(() => undefined);
    const gl = this.#gl;
    if (gl) {
      for (const program of this.#programs.values()) if (program) gl.deleteProgram(program.program);
      gl.deleteTexture(this.#texture);
      gl.deleteBuffer(this.#quad);
    }
    this.#programs.clear();
    this.#gl = null;
    this.#canvas = null;
  }

  async #pump(reader: ReadableStreamDefaultReader<VideoFrame>, generation: number): Promise<void> {
    for (;;) {
      let result: ReadableStreamReadResult<VideoFrame>;
      try {
        result = await reader.read();
      } catch {
        return;
      }
      if (result.done) return;
      const frame = result.value;
      if (generation !== this.#generation || this.#stopped) {
        frame.close();
        return;
      }
      let out = frame;
      const effect = this.#effect;
      if (effect) {
        try {
          out = this.#render(frame, effect);
          frame.close();
        } catch (error) {
          out = frame;
          if (import.meta.env.DEV) console.warn('[calls] effect not drawn', error);
        }
      }
      try {
        // The generator takes the frame (and closes it once sent).
        await this.#writer.write(out);
      } catch {
        out.close();
        return;
      }
    }
  }

  #render(frame: VideoFrame, effect: VideoEffect): VideoFrame {
    const width = frame.displayWidth;
    const height = frame.displayHeight;
    const gl = this.#context(width, height);
    const program = this.#program(gl, effect);
    if (!program) throw new Error(`effect ${effect.id} did not compile`);
    gl.viewport(0, 0, width, height);
    gl.useProgram(program.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#quad);
    gl.enableVertexAttribArray(program.position);
    gl.vertexAttribPointer(program.position, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(program.coordinate);
    gl.vertexAttribPointer(program.coordinate, 2, gl.FLOAT, false, 16, 8);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#texture);
    // Bottom row first, like the textures the effects are written for (Android's too).
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    gl.uniform1i(program.tex, 0);
    gl.uniformMatrix4fv(program.texMatrix, false, IDENTITY);
    gl.uniform2f(program.size, width, height);
    gl.uniform1f(program.time, (performance.now() - this.#startedAt) / 1000);
    gl.uniform4f(program.face, 0, 0, 0, 0);
    gl.uniform1f(program.faceOn, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return new VideoFrame(this.#canvas!, { timestamp: frame.timestamp });
  }

  #context(width: number, height: number): WebGLRenderingContext {
    if (!this.#canvas) this.#canvas = new OffscreenCanvas(width, height);
    const canvas = this.#canvas;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    if (this.#gl) return this.#gl;
    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('no WebGL');
    this.#texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.#texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.#quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#quad);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    this.#gl = gl;
    return gl;
  }

  #program(gl: WebGLRenderingContext, effect: VideoEffect): Program | null {
    if (this.#programs.has(effect.id)) return this.#programs.get(effect.id) ?? null;
    const program = link(gl, effect);
    if (typeof program === 'string') {
      if (import.meta.env.DEV) console.warn(`[calls] effect ${effect.id}: ${program}`);
      this.#programs.set(effect.id, null);
      return null;
    }
    this.#programs.set(effect.id, program);
    return program;
  }
}
