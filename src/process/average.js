// Beat averaging. Every heartbeat in a recording is the same sound plus
// different noise, so lining the beats up and averaging them keeps the heart
// sound and cancels the noise: about 3 dB quieter noise for every doubling of
// the number of beats. The result is one clean, typical beat.
//
// S1 and S2 are lined up and averaged separately, because the time between
// them changes a little from beat to beat and would otherwise blur S2.

import { biquad, filtfilt, decimate, median } from '../analysis/filters.js';

const PRE_ROLL_S = 0.02; // matches the grid warp: audio kept before each S1 onset
const XFADE_S = 0.005;
const MAX_SHIFT_S = 0.012; // how far a beat may be slid to line up with the others
const ALIGN_WIN_S = 0.16; // length of sound compared when lining up

/**
 * @param {Float32Array} x samples
 * @param {number} fs sample rate
 * @param {Array} beats analysis.beats (times in seconds)
 * @returns {null | { cycle: Float32Array, sampleRate: number, used: number, total: number,
 *   period: number, hasS2: boolean, beat: object }} `cycle` is exactly one beat long and
 *   starts PRE_ROLL_S before the S1 onset; it joins seamlessly to a copy of itself.
 *   `beat` holds that beat's marker times relative to the start of `cycle`.
 */
export function averageBeat(x, fs, beats) {
  const usable = beats.length - 1;
  if (usable < 2) return null;
  const rr = [];
  for (let k = 0; k < usable; k++) rr.push(beats[k + 1].s1Onset - beats[k].s1Onset);
  const medRR = median(rr);
  // Leave out beats next to a missed or extra marker.
  let idx = [];
  for (let k = 0; k < usable; k++) if (Math.abs(rr[k] - medRR) <= 0.2 * medRR) idx.push(k);
  if (idx.length < 2) return null;

  const withS2 = idx.filter((k) => beats[k].s2Onset !== null && beats[k].s2Onset > beats[k].s1Onset);
  const hasS2 = withS2.length >= Math.max(2, 0.5 * idx.length);
  const medOff = hasS2 ? median(withS2.map((k) => beats[k].s2Onset - beats[k].s1Onset)) : 0;

  const C = Math.round(medRR * fs);
  const pre = Math.round(PRE_ROLL_S * fs);
  const xf = Math.max(1, Math.round(XFADE_S * fs));
  const L1 = hasS2 ? Math.max(xf * 2, Math.min(C - xf * 2, Math.round(medOff * fs))) : C;

  // Lining-up is done on a small low-frequency copy: fast, and immune to hiss.
  const factor = Math.max(1, Math.floor(fs / 2000));
  const fd = fs / factor;
  const low = filtfilt(decimate(x, factor), biquad('highpass', fd, 20));
  const W = Math.round(ALIGN_WIN_S * fd);
  const maxLag = Math.round(MAX_SHIFT_S * fd);
  const preD = Math.round(PRE_ROLL_S * fd);

  /** For each start time, the shift (seconds) that best matches the group, and how well it matches. */
  function align(starts) {
    const n = starts.length;
    const shifts = new Float64Array(n);
    const match = new Float64Array(n).fill(1);
    const tmpl = new Float64Array(W);
    for (let pass = 0; pass < 2; pass++) {
      tmpl.fill(0);
      for (let b = 0; b < n; b++) {
        const a = Math.round((starts[b] + shifts[b]) * fd) - preD;
        for (let i = 0; i < W; i++) { const j = a + i; if (j >= 0 && j < low.length) tmpl[i] += low[j]; }
      }
      let tt = 0;
      for (let i = 0; i < W; i++) tt += tmpl[i] * tmpl[i];
      for (let b = 0; b < n; b++) {
        const a = Math.round(starts[b] * fd) - preD;
        const score = new Float64Array(2 * maxLag + 1);
        let best = 0;
        for (let lag = -maxLag; lag <= maxLag; lag++) {
          let c = 0; let ss = 0;
          for (let i = 0; i < W; i++) {
            const j = a + lag + i;
            const v = j >= 0 && j < low.length ? low[j] : 0;
            c += v * tmpl[i]; ss += v * v;
          }
          score[lag + maxLag] = ss > 0 && tt > 0 ? c / Math.sqrt(ss * tt) : 0;
          if (score[lag + maxLag] > score[best + maxLag]) best = lag;
        }
        // Parabolic refinement between lags.
        let frac = 0;
        if (best > -maxLag && best < maxLag) {
          const y0 = score[best + maxLag - 1]; const y1 = score[best + maxLag]; const y2 = score[best + maxLag + 1];
          const d = y0 - 2 * y1 + y2;
          if (d < 0) frac = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / d));
        }
        shifts[b] = (best + frac) / fd;
        match[b] = score[best + maxLag];
      }
    }
    return { shifts, match };
  }

  let a1 = align(idx.map((k) => beats[k].s1Onset));
  // Drop beats that do not look like the rest (a cough, a bump, a wrong marker).
  const typical = median(Array.from(a1.match));
  const keep = [];
  idx.forEach((k, i) => { if (a1.match[i] >= 0.6 * typical) keep.push(i); });
  if (keep.length >= 2 && keep.length < idx.length) {
    idx = keep.map((i) => idx[i]);
    a1 = align(idx.map((k) => beats[k].s1Onset));
  }
  const s2Start = (k) => (beats[k].s2Onset !== null && beats[k].s2Onset > beats[k].s1Onset
    ? beats[k].s2Onset : beats[k].s1Onset + medOff);
  const a2 = hasS2 ? align(idx.map(s2Start)) : null;

  // Average each part. A beat only contributes for as long as it is that part:
  // its S1 part stops where its own S2 begins, its S2 part where the next beat begins.
  function average(len, startOf, endOf) {
    const sum = new Float64Array(len + xf);
    const cnt = new Uint32Array(len + xf);
    idx.forEach((k, b) => {
      const a = startOf(k, b) - pre - xf;
      const stop = Math.min(len + xf, endOf(k, b) - pre - a, x.length - a);
      for (let i = Math.max(0, -a); i < stop; i++) { sum[i] += x[a + i]; cnt[i]++; }
    });
    let last = 0;
    for (let i = 0; i < sum.length; i++) {
      if (cnt[i]) { sum[i] /= cnt[i]; last = sum[i]; } else sum[i] = last;
    }
    return sum; // index 0 is xf samples before the part begins
  }
  const on1 = (k, b) => Math.round((beats[k].s1Onset + a1.shifts[b]) * fs);
  const next1 = (k) => Math.round(beats[k + 1].s1Onset * fs);
  let cycle;
  if (hasS2) {
    const on2 = (k, b) => Math.round((s2Start(k) + a2.shifts[b]) * fs);
    const A1 = average(L1, on1, (k, b) => Math.max(on1(k, b) + pre + xf, on2(k, b) + xf));
    const A2 = average(C - L1, on2, (k) => next1(k) + xf);
    cycle = new Float32Array(C);
    for (let i = 0; i < L1; i++) cycle[i] = A1[i + xf];
    for (let i = L1; i < C; i++) cycle[i] = A2[i - L1 + xf];
    for (let j = 0; j < xf; j++) {
      const g = (j + 0.5) / xf;
      cycle[L1 - xf + j] = (1 - g) * A1[L1 + j] + g * A2[j]; // S1 part into S2 part
      cycle[C - xf + j] = (1 - g) * A2[C - L1 + j] + g * A1[j]; // end of the beat into its own start
    }
  } else {
    const A1 = average(C, on1, (k) => next1(k) + xf);
    cycle = new Float32Array(C);
    for (let i = 0; i < C; i++) cycle[i] = A1[i + xf];
    for (let j = 0; j < xf; j++) {
      const g = (j + 0.5) / xf;
      cycle[C - xf + j] = (1 - g) * A1[C + j] + g * A1[j];
    }
  }

  const s1Lag = median(idx.map((k) => beats[k].s1 - beats[k].s1Onset));
  const s2Lag = hasS2 ? median(withS2.map((k) => beats[k].s2 - beats[k].s2Onset)) : 0;
  const t0 = pre / fs;
  return {
    cycle,
    sampleRate: fs,
    used: idx.length,
    total: usable,
    period: C / fs,
    hasS2,
    beat: {
      s1Onset: t0,
      s1: t0 + s1Lag,
      s1Amp: median(idx.map((k) => beats[k].s1Amp)),
      s2Onset: hasS2 ? t0 + L1 / fs : null,
      s2: hasS2 ? t0 + L1 / fs + s2Lag : null,
    },
  };
}

/**
 * Lay the averaged beat end to end as if it were a (perfectly regular) recording,
 * so the grid warp and the noise gate can work on it like on any other.
 */
export function repeatBeat(avg, count) {
  const C = avg.cycle.length;
  const pcm = new Float32Array(C * (count + 2));
  for (let r = 0; r < count + 2; r++) pcm.set(avg.cycle, r * C);
  const beats = [];
  for (let r = 0; r < count + 2; r++) {
    const t = r * avg.period;
    beats.push({
      s1Onset: avg.beat.s1Onset + t,
      s1: avg.beat.s1 + t,
      s1Amp: avg.beat.s1Amp,
      s2Onset: avg.beat.s2Onset === null ? null : avg.beat.s2Onset + t,
      s2: avg.beat.s2 === null ? null : avg.beat.s2 + t,
    });
  }
  return { pcm, beats };
}
