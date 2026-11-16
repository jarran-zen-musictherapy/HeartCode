// Loudness and peak metering: integrated LUFS (ITU-R BS.1770-4) and true peak.

import { applyBiquad } from '../analysis/filters.js';

/** K-weighting filters for any sample rate (the standard's 48 kHz pair, re-derived). */
export function kWeighting(fs) {
  const shelf = (() => {
    const K = Math.tan((Math.PI * 1681.974450955533) / fs);
    const Vh = 10 ** (3.999843853973347 / 20);
    const Vb = Vh ** 0.4996667741545416;
    const Q = 0.7071752369554196;
    const a0 = 1 + K / Q + K * K;
    return {
      b0: (Vh + (Vb * K) / Q + K * K) / a0,
      b1: (2 * (K * K - Vh)) / a0,
      b2: (Vh - (Vb * K) / Q + K * K) / a0,
      a1: (2 * (K * K - 1)) / a0,
      a2: (1 - K / Q + K * K) / a0,
    };
  })();
  const highpass = (() => {
    const K = Math.tan((Math.PI * 38.13547087602444) / fs);
    const Q = 0.5003270373238773;
    const a0 = 1 + K / Q + K * K;
    return { b0: 1 / a0, b1: -2 / a0, b2: 1 / a0, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  })();
  return [shelf, highpass];
}

/**
 * Integrated loudness of a mono signal in LUFS, with the standard's gating.
 * Returns -Infinity for silence or for audio shorter than one 400 ms block.
 */
export function integratedLufs(x, fs) {
  let y = x;
  for (const c of kWeighting(fs)) y = applyBiquad(y, c);
  const block = Math.round(0.4 * fs);
  const hop = Math.round(0.1 * fs);
  if (y.length < block) return -Infinity;

  const prefix = new Float64Array(y.length + 1);
  for (let i = 0; i < y.length; i++) prefix[i + 1] = prefix[i] + y[i] * y[i];
  const powers = [];
  for (let s = 0; s + block <= y.length; s += hop) powers.push((prefix[s + block] - prefix[s]) / block);

  const toLufs = (p) => -0.691 + 10 * Math.log10(p);
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const abs = powers.filter((p) => p > 0 && toLufs(p) > -70);
  if (!abs.length) return -Infinity;
  const relGate = toLufs(mean(abs)) - 10;
  const gated = abs.filter((p) => toLufs(p) > relGate);
  return gated.length ? toLufs(mean(gated)) : -Infinity;
}

/**
 * True peak in dBTP: the highest level the waveform reaches BETWEEN samples too.
 * Only the neighbourhoods of the largest samples are interpolated (4x), which
 * gives the same answer as oversampling everything at a fraction of the cost.
 */
export function truePeakDb(x) {
  const n = x.length;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(x[i]);
    if (a > peak) peak = a;
  }
  if (peak === 0) return -Infinity;

  const HALF = 12; // taps each side
  const spots = [];
  for (let i = 1; i < n - 1; i++) {
    const a = Math.abs(x[i]);
    if (a > 0.5 * peak && a >= Math.abs(x[i - 1]) && a >= Math.abs(x[i + 1])) spots.push(i);
  }
  spots.sort((p, q) => Math.abs(x[q]) - Math.abs(x[p]));
  let best = peak;
  for (const i of spots.slice(0, 400)) {
    for (const base of [i - 1, i]) {
      for (const frac of [0.25, 0.5, 0.75]) {
        let acc = 0;
        for (let k = -HALF + 1; k <= HALF; k++) {
          const idx = base + k;
          if (idx < 0 || idx >= n) continue;
          const d = frac - k; // distance from sample idx to the point being evaluated
          const w = 0.5 + 0.5 * Math.cos((Math.PI * d) / HALF); // Hann window
          acc += x[idx] * (Math.sin(Math.PI * d) / (Math.PI * d)) * w;
        }
        if (Math.abs(acc) > best) best = Math.abs(acc);
      }
    }
  }
  return 20 * Math.log10(best);
}
