// Spectral noise reduction. The gaps between heartbeats hold nothing but
// background noise, so they are used as a "noise print": at every moment and
// every frequency, whatever is no louder than that print is turned down.
// Unlike the gate this also cleans the noise underneath the heart sounds.

import { fft } from './spectrum.js';

export const DENOISE_LEVELS = {
  off: { label: 'Off' },
  light: { label: 'Light', over: 1, floorDb: -8 },
  medium: { label: 'Medium', over: 1.5, floorDb: -15 },
  strong: { label: 'Strong', over: 2.2, floorDb: -26 },
};

/**
 * @param {Float32Array} x samples
 * @param {number} fs sample rate
 * @param {string} level key of DENOISE_LEVELS
 * @param {Array|null} beats analysis.beats: tells us where the quiet gaps are.
 *   Without them the quietest fifth of the recording is used as the noise print.
 * @returns {Float32Array} same length as x (x itself when there is nothing to do)
 */
export function denoise(x, fs, level, beats = null) {
  const cfg = DENOISE_LEVELS[level];
  if (!cfg || !cfg.over) return x;
  let N = 256;
  while (N < 0.064 * fs) N <<= 1; // about 64-93 ms per frame
  const hop = N >> 2;
  if (x.length < 4 * N) return x;
  const half = N >> 1;
  const frames = Math.ceil((x.length + N) / hop);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = Math.sin((Math.PI * (i + 0.5)) / N); // sqrt-Hann: used twice

  // Pass 1: power in every frame and bin.
  const power = new Float32Array(frames * (half + 1));
  const energy = new Float64Array(frames);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const load = (f) => {
    const start = f * hop - (N - hop);
    for (let i = 0; i < N; i++) {
      const j = start + i;
      re[i] = j >= 0 && j < x.length ? x[j] * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
  };
  for (let f = 0; f < frames; f++) {
    load(f);
    let e = 0;
    for (let k = 0; k <= half; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      power[f * (half + 1) + k] = p;
      e += p;
    }
    energy[f] = e;
  }

  // Which frames are pure background? Those sitting wholly inside the gap before a beat.
  const isNoise = new Uint8Array(frames);
  let count = 0;
  if (beats && beats.length >= 3) {
    for (let b = 0; b + 1 < beats.length; b++) {
      const len = beats[b + 1].s1Onset - beats[b].s1Onset;
      const g0 = (beats[b].s1Onset + 0.62 * len) * fs;
      const g1 = (beats[b].s1Onset + 0.96 * len) * fs;
      const f0 = Math.ceil((g0 + N - hop) / hop);
      const f1 = Math.floor((g1 - hop) / hop);
      for (let f = Math.max(0, f0); f <= f1 && f < frames; f++) { if (!isNoise[f]) { isNoise[f] = 1; count++; } }
    }
  }
  if (count < 6) {
    // No usable gaps: fall back to the quietest fifth of the frames.
    isNoise.fill(0);
    const inside = [];
    for (let f = 4; f < frames - 4; f++) inside.push(f);
    inside.sort((a, b) => energy[a] - energy[b]);
    count = Math.max(1, Math.floor(inside.length / 5));
    for (let i = 0; i < count; i++) isNoise[inside[i]] = 1;
  }
  const noise = new Float64Array(half + 1);
  for (let f = 0; f < frames; f++) {
    if (!isNoise[f]) continue;
    for (let k = 0; k <= half; k++) noise[k] += power[f * (half + 1) + k];
  }
  for (let k = 0; k <= half; k++) noise[k] = (noise[k] / count) * cfg.over + 1e-20;

  // Pass 2: Wiener-style gain, steadied from frame to frame ("decision-directed")
  // so the leftover noise does not warble.
  const floor = 10 ** (cfg.floorDb / 20);
  const out = new Float32Array(x.length);
  const prev = new Float64Array(half + 1); // last frame's cleaned-power to noise ratio
  const gain = new Float64Array(half + 1);
  const ALPHA = 0.9;
  for (let f = 0; f < frames; f++) {
    load(f);
    for (let k = 0; k <= half; k++) {
      const post = power[f * (half + 1) + k] / noise[k];
      const prio = ALPHA * prev[k] + (1 - ALPHA) * Math.max(post - 1, 0);
      const g = Math.max(floor, prio / (1 + prio));
      gain[k] = g;
      prev[k] = g * g * post;
    }
    for (let k = 0; k <= half; k++) {
      // Smooth a little across frequency as well.
      const g = k > 0 && k < half ? 0.25 * gain[k - 1] + 0.5 * gain[k] + 0.25 * gain[k + 1] : gain[k];
      re[k] *= g; im[k] *= g;
      if (k > 0 && k < half) { re[N - k] *= g; im[N - k] *= g; }
    }
    // Inverse FFT via the forward one (conjugate trick).
    for (let i = 0; i < N; i++) im[i] = -im[i];
    fft(re, im);
    const start = f * hop - (N - hop);
    const scale = 1 / (N * 2); // sqrt-Hann squared overlapped 4x sums to 2
    for (let i = 0; i < N; i++) {
      const j = start + i;
      if (j >= 0 && j < x.length) out[j] += re[i] * win[i] * scale;
    }
  }
  return out;
}
