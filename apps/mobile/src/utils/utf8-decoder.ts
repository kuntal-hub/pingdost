// A WHATWG `TextDecoder` for UTF-8 only, used when the JS engine has none or ignores
// `fatal` (protobuf-es decodes strings with `fatal: true`; ADR 0012). It follows the
// Encoding Standard's UTF-8 decoder step for step, including the replacement rules and the
// BOM; there is no streaming mode.

const REPLACEMENT = 0xfffd;
const CHUNK = 8_192;

const LABELS = new Set(['utf-8', 'utf8', 'unicode-1-1-utf-8']);

export interface Utf8DecoderOptions {
  fatal?: boolean;
  ignoreBOM?: boolean;
}

export class Utf8TextDecoder {
  readonly encoding = 'utf-8';
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;

  constructor(label = 'utf-8', options: Utf8DecoderOptions = {}) {
    if (!LABELS.has(label.trim().toLowerCase())) {
      throw new RangeError(`The encoding label provided ('${label}') is not supported.`);
    }
    this.fatal = options.fatal ?? false;
    this.ignoreBOM = options.ignoreBOM ?? false;
  }

  decode(input?: ArrayBuffer | ArrayBufferView, options?: { stream?: boolean }): string {
    if (options?.stream) throw new TypeError('streaming decode is not supported');
    const bytes =
      input === undefined
        ? new Uint8Array(0)
        : input instanceof ArrayBuffer
          ? new Uint8Array(input)
          : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);

    const units: number[] = [];
    const parts: string[] = [];
    const emit = (codePoint: number) => {
      if (codePoint > 0xffff) {
        const offset = codePoint - 0x10000;
        units.push(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
      } else {
        units.push(codePoint);
      }
      if (units.length >= CHUNK) parts.push(String.fromCharCode(...units.splice(0)));
    };
    const fail = () => {
      if (this.fatal) throw new TypeError('The encoded data was not valid utf-8.');
      emit(REPLACEMENT);
    };

    let needed = 0;
    let seen = 0;
    let codePoint = 0;
    let lower = 0x80;
    let upper = 0xbf;
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i]!;
      if (needed === 0) {
        if (byte <= 0x7f) emit(byte);
        else if (byte >= 0xc2 && byte <= 0xdf) {
          needed = 1;
          codePoint = byte & 0x1f;
        } else if (byte >= 0xe0 && byte <= 0xef) {
          if (byte === 0xe0) lower = 0xa0;
          if (byte === 0xed) upper = 0x9f;
          needed = 2;
          codePoint = byte & 0x0f;
        } else if (byte >= 0xf0 && byte <= 0xf4) {
          if (byte === 0xf0) lower = 0x90;
          if (byte === 0xf4) upper = 0x8f;
          needed = 3;
          codePoint = byte & 0x07;
        } else fail();
        continue;
      }
      if (byte < lower || byte > upper) {
        // The sequence ends here; this byte starts over (the spec's "prepend").
        codePoint = needed = seen = 0;
        lower = 0x80;
        upper = 0xbf;
        i--;
        fail();
        continue;
      }
      lower = 0x80;
      upper = 0xbf;
      codePoint = (codePoint << 6) | (byte & 0x3f);
      if (++seen === needed) {
        emit(codePoint);
        codePoint = needed = seen = 0;
      }
    }
    if (needed !== 0) fail();

    parts.push(String.fromCharCode(...units));
    const text = parts.join('');
    return !this.ignoreBOM && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }
}

/** Whether the global `TextDecoder` exists and throws on invalid UTF-8 with `fatal: true`. */
export function hasStrictTextDecoder(scope: { TextDecoder?: unknown } = globalThis): boolean {
  const Decoder = scope.TextDecoder as
    (new (label: string, options: object) => { decode(b: Uint8Array): string }) | undefined;
  if (typeof Decoder !== 'function') return false;
  let decoder: { decode(b: Uint8Array): string };
  try {
    decoder = new Decoder('utf-8', { fatal: true });
    if (decoder.decode(Uint8Array.of(0xe2, 0x82, 0xac)) !== '€') return false;
  } catch {
    return false;
  }
  try {
    decoder.decode(Uint8Array.of(0xff));
    return false; // replaced instead of throwing: `fatal` is ignored
  } catch {
    return true;
  }
}
