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
