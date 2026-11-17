// Noise reduction for heart recordings: a smooth gate that turns the gaps
// between heart sounds down, and a per-beat quality score for picking the
// cleanest part of a recording.

import { heartEnvelope } from '../analysis/detect.js';
import { movingAverage, median } from '../analysis/filters.js';

export const NOISE_LEVELS = {
  off: { label: 'Off', floorDb: 0 },
  light: { label: 'Light (gaps -9 dB)', floorDb: -9 },
  medium: { label: 'Medium (gaps -18 dB)', floorDb: -18 },
  strong: { label: 'Strong (gaps -30 dB)', floorDb: -30 },
};

/**
 * Gain-over-time curve that leaves the heart sounds at full level and lowers
 * everything between them to `floorDb`. Computed from the same heart-band
 * envelope the detector uses, so it opens just before each sound and closes
 * gently after it.
 * When the detected `beats` are passed in, the gate is set from this recording's
 * own levels: closed at the level of the gaps, fully open well below the quieter
 * heart sound (S2).
 * @returns {{ gain: Float32Array, fs: number } | null} null when there is nothing to do
 */
export function gateCurve(pcm, sampleRate, floorDb, beats = null) {
  if (!(floorDb < 0)) return null;
  const { env, fs } = heartEnvelope(pcm, sampleRate);
  const n = env.length;
  if (n < 8) return null;
  const sorted = Float64Array.from(env).sort();
  const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];

  // Fallback levels from the overall distribution...
  let gapLevel = 1.8 * pct(sorted, 0.25);
  let soundLevel = 0.45 * pct(sorted, 0.97);
  // ...replaced by measured ones when we know where the beats are.
  if (beats && beats.length >= 3) {
    const gaps = [];
    const sounds = [];
    for (let k = 0; k + 1 < beats.length; k++) {
      const len = beats[k + 1].s1Onset - beats[k].s1Onset;
      const g0 = Math.round((beats[k].s1Onset + 0.65 * len) * fs);
      const g1 = Math.round((beats[k].s1Onset + 0.92 * len) * fs);
      for (let i = g0; i < g1 && i < n; i += 4) gaps.push(env[i]);
      const peak = beats[k].s2 !== null ? beats[k].s2 : null;
      sounds.push(peak !== null ? env[Math.min(n - 1, Math.round(peak * fs))] : 0.4 * beats[k].s1Amp);
    }
    if (gaps.length > 10) {
      gaps.sort((x, y) => x - y);
      gapLevel = pct(gaps, 0.9);
      soundLevel = median(sounds);
    }
  }
  if (!(soundLevel > 0)) return null;
  const closed = Math.max(1e-12, Math.min(gapLevel, 0.5 * soundLevel));
  const open = Math.max(closed * 1.2, Math.sqrt(closed * soundLevel)); // midway (in dB) between gap and sound
  const floor = 10 ** (floorDb / 20);

  let g = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = Math.max(0, Math.min(1, (env[i] - closed) / (open - closed)));
    g[i] = floor + (1 - floor) * t * t * (3 - 2 * t); // smoothstep
  }
  // Hold the gate open for 60 ms after a sound so tails are not chopped...
  const hold = Math.max(1, Math.round(0.06 * fs));
  const held = new Float64Array(n);
  const dq = new Int32Array(n);
  let head = 0; let tail = 0;
  for (let i = 0; i < n; i++) {
    while (tail > head && g[dq[tail - 1]] <= g[i]) tail--;
    dq[tail++] = i;
    while (dq[head] < i - hold) head++;
    held[i] = g[dq[head]];
  }
  // ...then smooth, so the gain never moves abruptly.
  g = movingAverage(movingAverage(held, 0.03 * fs), 0.03 * fs);
  return { gain: Float32Array.from(g), fs };
}

/** Multiply audio (at any sample rate) by a gain curve, interpolating between its points. */
export function applyCurve(x, fs, curve) {
  if (!curve) return x;
  const y = new Float32Array(x.length);
  const ratio = curve.fs / fs;
  const last = curve.gain.length - 1;
  for (let i = 0; i < x.length; i++) {
    const pos = Math.min(last, i * ratio);
    const k = Math.floor(pos);
    const a = curve.gain[k];
    const b = curve.gain[Math.min(last, k + 1)];
    y[i] = x[i] * (a + (b - a) * (pos - k));
  }
  return y;
}

/**
 * Score each beat: lower is cleaner. Combines how unlike the typical beat it is
 * (shape of the heart-band envelope), how noisy its quiet gap is, and how far
 * its length is from the median. The last beat has no following onset, so it
 * gets no score.
 * @returns {number[]} one cost per beat except the last
 */
export function beatCosts(pcm, sampleRate, beats) {
  const usable = beats.length - 1;
  if (usable < 1) return [];
  const { env, fs } = heartEnvelope(pcm, sampleRate);
  const lens = [];
  for (let k = 0; k < usable; k++) lens.push(beats[k + 1].s1Onset - beats[k].s1Onset);
  const medLen = median(lens);
  const L = Math.max(8, Math.round(0.9 * medLen * fs));

  const segs = [];
  const gapNoise = [];
  for (let k = 0; k < usable; k++) {
    const a = Math.round(beats[k].s1Onset * fs);
    const seg = new Float64Array(L);
    for (let i = 0; i < L; i++) seg[i] = a + i < env.length ? env[a + i] : 0;
    segs.push(seg);
    // Mean level over the last third of the beat (diastole), relative to its S1.
    const g0 = a + Math.round(0.65 * lens[k] * fs);
    const g1 = a + Math.round(0.95 * lens[k] * fs);
    let s = 0; let c = 0;
    for (let i = g0; i < g1 && i < env.length; i++) { s += env[i]; c++; }
    gapNoise.push(c ? s / c / (beats[k].s1Amp || 1e-12) : 1);
  }
  const template = new Float64Array(L);
  const col = new Array(usable);
  for (let i = 0; i < L; i++) {
    for (let k = 0; k < usable; k++) col[k] = segs[k][i];
    template[i] = median(col);
  }
  const corr = (u, v) => {
    let mu = 0; let mv = 0;
    for (let i = 0; i < L; i++) { mu += u[i]; mv += v[i]; }
    mu /= L; mv /= L;
    let uv = 0; let uu = 0; let vv = 0;
    for (let i = 0; i < L; i++) {
      uv += (u[i] - mu) * (v[i] - mv); uu += (u[i] - mu) ** 2; vv += (v[i] - mv) ** 2;
    }
    return uu > 0 && vv > 0 ? uv / Math.sqrt(uu * vv) : 0;
  };
  const medNoise = median(gapNoise) || 1e-12;
  return segs.map((seg, k) => (1 - corr(seg, template))
    + 0.5 * Math.max(0, gapNoise[k] / medNoise - 1)
    + Math.abs(lens[k] - medLen) / medLen);
}
