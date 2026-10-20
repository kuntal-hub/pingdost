// Byte helpers. Hermes ships TextEncoder but not always TextDecoder, so UTF-8 decoding
// falls back to a small decoder.

export function toHex(data: Uint8Array): string {
  return Array.from(data, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error('invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 with padding (Hermes has no `Buffer`). */
export function toBase64(data: Uint8Array): string {
  let out = '';
  for (let i = 0; i < data.length; i += 3) {
    const a = data[i] ?? 0;
    const b = data[i + 1] ?? 0;
    const c = data[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    out += BASE64[(n >> 18) & 63]! + BASE64[(n >> 12) & 63]!;
    out += i + 1 < data.length ? BASE64[(n >> 6) & 63]! : '=';
    out += i + 2 < data.length ? BASE64[n & 63]! : '=';
  }
  return out;
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[\s=]/g, '');
  if (!/^[A-Za-z0-9+/]*$/.test(clean) || clean.length % 4 === 1) throw new Error('invalid base64');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of clean) {
    value = (value << 6) | BASE64.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 0xff;
    }
  }
  return out;
}

export const encodeUtf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

export function decodeUtf8(data: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(data);
  let out = '';
  for (let i = 0; i < data.length;) {
    const first = data[i++] ?? 0;
    const extra = first >= 0xf0 ? 3 : first >= 0xe0 ? 2 : first >= 0xc0 ? 1 : 0;
    let code = extra === 0 ? first : first & (0x3f >> extra);
    for (let n = 0; n < extra; n++) code = (code << 6) | ((data[i++] ?? 0) & 0x3f);
    out += String.fromCodePoint(code);
  }
  return out;
}
