// MP3 encoding (via the LAME-based lamejs library, LGPL).

import { Mp3Encoder } from '@breezystack/lamejs';

export const MP3_RATES = [44100, 48000, 32000, 24000, 22050, 16000, 12000, 11025, 8000];
export const MP3_BITRATES = [64, 96, 128, 160, 192, 256, 320];

/**
 * Encode mono samples (-1..1) as MP3.
 * The sample rate must be one of MP3_RATES; resample first if it is not.
 * @returns {Uint8Array}
 */
export function encodeMp3(samples, sampleRate, kbps = 192) {
  if (!MP3_RATES.includes(sampleRate)) throw new Error(`MP3 does not support ${sampleRate} Hz`);
  const encoder = new Mp3Encoder(1, sampleRate, kbps);
  const BLOCK = 1152;
  const chunks = [];
  let total = 0;
  const pcm = new Int16Array(BLOCK);
  for (let i = 0; i < samples.length; i += BLOCK) {
    const n = Math.min(BLOCK, samples.length - i);
    for (let j = 0; j < n; j++) {
      pcm[j] = Math.round(Math.max(-1, Math.min(1, samples[i + j])) * 32767);
    }
    const out = encoder.encodeBuffer(n === BLOCK ? pcm : pcm.subarray(0, n));
    if (out.length) { chunks.push(Uint8Array.from(out)); total += out.length; }
  }
  const tail = encoder.flush();
  if (tail.length) { chunks.push(Uint8Array.from(tail)); total += tail.length; }
  const mp3 = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { mp3.set(c, off); off += c.length; }
  return mp3;
}

/** Expected file size in bytes, for showing before export. */
export function estimateSize(format, seconds, { sampleRate, bitDepth, kbps }) {
  if (format === 'mp3') return Math.round((seconds * kbps * 1000) / 8);
  return 44 + Math.round(seconds * sampleRate) * (bitDepth / 8);
}
