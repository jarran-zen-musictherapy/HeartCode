/** Encode mono samples (-1..1) as a PCM WAV file. Returns an ArrayBuffer. */
export function encodeWav(samples, sampleRate, bitDepth = 24) {
  if (bitDepth !== 16 && bitDepth !== 24) throw new Error('bitDepth must be 16 or 24');
  const bytes = bitDepth / 8;
  const dataLen = samples.length * bytes;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const text = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  text(0, 'RIFF');
  v.setUint32(4, 36 + dataLen, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * bytes, true);
  v.setUint16(32, bytes, true);
  v.setUint16(34, bitDepth, true);
  text(36, 'data');
  v.setUint32(40, dataLen, true);
  const max = bitDepth === 16 ? 32767 : 8388607;
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.round(Math.max(-1, Math.min(1, samples[i])) * max);
    if (bitDepth === 16) {
      v.setInt16(off, s, true);
    } else {
      v.setUint8(off, s & 0xff);
      v.setUint8(off + 1, (s >> 8) & 0xff);
      v.setUint8(off + 2, (s >> 16) & 0xff);
    }
    off += bytes;
  }
  return buf;
}
