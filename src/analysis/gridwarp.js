// Grid warp by slice-and-place.
//
// A heartbeat is two short sounds followed by near-silence, so instead of
// time-stretching (which smears transients) each beat is cut out whole and
// placed with its S1 onset exactly on the tempo grid. Only the quiet gap
// before the next beat is shortened or extended. S2 keeps its natural
// distance from S1, so it sits off-grid as a ghost note.

import { median } from './filters.js';

const PRE_ROLL_S = 0.02; // audio kept before each S1 onset so the attack is intact
const XFADE_S = 0.005; // crossfade between neighbouring slices
const S2_TAIL_S = 0.09; // S2 peak to the end of the S2 sound

/** How many beats can be placed, and which run of beats is the most even. */
export function chooseBeats(beats, count) {
  const usable = beats.length - 1; // each slice needs the next onset as its end
  const n = Math.max(0, Math.min(count, usable));
  if (n < 1) return { start: 0, count: 0 };
  const len = [];
  for (let k = 0; k < usable; k++) len.push(beats[k + 1].s1Onset - beats[k].s1Onset);
  const med = median(len);
  let best = 0;
  let bestCost = Infinity;
  for (let s = 0; s + n <= usable; s++) {
    let cost = 0;
    for (let k = s; k < s + n; k++) cost += Math.abs(len[k] - med);
    if (cost < bestCost - 1e-9) { bestCost = cost; best = s; }
  }
  return { start: best, count: n };
}

/**
 * Build a seamless loop with one heartbeat per grid beat.
 * @param {Float32Array} x samples
 * @param {number} fs sample rate of x
 * @param {Array} beats analysis.beats
 * @param {{ bpm: number, count: number }} opts
 */
export function gridWarp(x, fs, beats, { bpm, count }) {
  const { start, count: n } = chooseBeats(beats, count);
  if (n < 1 || !(bpm > 0)) return null;

  const pre = Math.round(PRE_ROLL_S * fs);
  const xf = Math.round(XFADE_S * fs);
  const beatLen = (60 / bpm) * fs; // fractional: positions are rounded per beat, so error never accumulates
  const total = Math.round(n * beatLen);
  const out = new Float32Array(total);
  let truncatedS2 = 0;

  for (let k = 0; k < n; k++) {
    const b = beats[start + k];
    const next = beats[start + k + 1];
    const A = Math.max(0, Math.round(b.s1Onset * fs) - pre);
    const B = Math.min(x.length, Math.max(A + 1, Math.round(next.s1Onset * fs) - pre));
    const slotStart = Math.round(k * beatLen) - pre;
    const slotLen = Math.round((k + 1) * beatLen) - pre - slotStart;
    const need = slotLen + xf;
    const piece = new Float32Array(need);

    // Source may run a little past B: that is still inside the next beat's quiet pre-roll.
    const maxTake = Math.min(x.length - A, B - A + Math.max(0, pre - xf));
    if (maxTake >= need) {
      piece.set(x.subarray(A, A + need));
      if (b.s2 !== null && (b.s2 + S2_TAIL_S - b.s1Onset) * fs + pre > slotLen) truncatedS2++;
    } else {
      // Source beat is shorter than the grid slot: copy it, then extend the quiet
      // gap by playing it backwards and forwards (no clicks, no silent holes).
      const srcLen = B - A;
      piece.set(x.subarray(A, B));
      let q0 = A + Math.floor(0.55 * srcLen);
      if (b.s2 !== null) q0 = Math.max(q0, Math.round((b.s2 + S2_TAIL_S) * fs));
      if (B - q0 < Math.round(0.02 * fs)) q0 = B - Math.max(2, Math.min(srcLen >> 2, Math.round(0.05 * fs)));
      q0 = Math.max(A, Math.min(q0, B - 2));
      let pos = B - 1;
      let dir = -1;
      for (let j = srcLen; j < need; j++) {
        piece[j] = x[pos];
        pos += dir;
        if (pos < q0) { pos = q0; dir = 1; } else if (pos >= B) { pos = B - 1; dir = -1; }
      }
    }

    for (let j = 0; j < xf; j++) {
      const g = (j + 0.5) / xf;
      piece[j] *= g;
      piece[need - 1 - j] *= g;
    }
    // Overlap-add, wrapping around the loop so the seam is crossfaded too.
    for (let j = 0; j < need; j++) {
      const idx = (((slotStart + j) % total) + total) % total;
      out[idx] += piece[j];
    }
  }

  return {
    samples: out,
    sampleRate: fs,
    beats: n,
    firstBeat: start,
    bpm,
    seconds: total / fs,
    truncatedS2,
  };
}

/** Cut each heartbeat out as its own one-shot (S1 through to just before the next S1). */
export function sliceBeats(x, fs, beats) {
  const pre = Math.round(PRE_ROLL_S * fs);
  const fadeIn = Math.round(0.003 * fs);
  const fadeOut = Math.round(0.01 * fs);
  const slices = [];
  for (let k = 0; k + 1 < beats.length; k++) {
    const A = Math.max(0, Math.round(beats[k].s1Onset * fs) - pre);
    const B = Math.min(x.length, Math.round(beats[k + 1].s1Onset * fs) - pre);
    if (B - A < fadeIn + fadeOut + 2) continue;
    const s = Float32Array.from(x.subarray(A, B));
    for (let j = 0; j < fadeIn; j++) s[j] *= (j + 0.5) / fadeIn;
    for (let j = 0; j < fadeOut; j++) s[s.length - 1 - j] *= (j + 0.5) / fadeOut;
    slices.push(s);
  }
  return slices;
}

/** Gain that brings the loudest sample to `peakDb` dBFS (1 if the input is silent). */
export function normaliseGain(arrays, peakDb = -1) {
  let peak = 0;
  for (const a of arrays) for (let i = 0; i < a.length; i++) peak = Math.max(peak, Math.abs(a[i]));
  return peak > 0 ? 10 ** (peakDb / 20) / peak : 1;
}

/** Short clicks on every grid beat, for checking alignment by ear (preview only). */
export function addClicks(samples, fs, bpm, level = 0.35) {
  const out = Float32Array.from(samples);
  const beatLen = (60 / bpm) * fs;
  const len = Math.round(0.012 * fs);
  for (let k = 0; Math.round(k * beatLen) < out.length; k++) {
    const at = Math.round(k * beatLen);
    for (let j = 0; j < len && at + j < out.length; j++) {
      out[at + j] += level * Math.exp(-j / (0.003 * fs)) * Math.sin((2 * Math.PI * 1500 * j) / fs);
    }
  }
  return out;
}
