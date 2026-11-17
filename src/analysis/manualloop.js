// Manual loops: the user picks a region by hand; these helpers snap it to a
// clean loop, build the looped audio with a crossfaded seam, and report how
// smooth the seam is.

const PRE_ROLL_S = 0.02; // same lead-in the automatic grid uses before each S1
const XFADE_S = 0.012;
const MATCH_S = 0.04; // how much audio is compared on each side of the seam

/** How alike n samples starting at a and at b are (-1..1; 1 = identical). */
function matchAt(x, a, b, n) {
  let ab = 0; let aa = 0; let bb = 0;
  for (let i = 0; i < n; i++) {
    const u = x[a + i]; const v = x[b + i];
    ab += u * v; aa += u * u; bb += v * v;
  }
  // 2ab / (aa + bb): like correlation, but also marked down when the two
  // stretches differ in loudness, which would be heard as a bump at the seam.
  return aa + bb > 0 ? (2 * ab) / (aa + bb) : 0;
}

/**
 * Adjust a hand-drawn selection so it loops cleanly.
 * With detected beats: start and end move to the nearest heartbeat starts, so
 * the loop holds a whole number of beats. Then the end is fine-tuned so the
 * waveform after the end lines up with the waveform after the start.
 * Without beats, only the end is moved (up to 150 ms) to the best-matching spot.
 * @returns {{ start: number, end: number, beats: number|null, method: 'beats'|'waveform' }}
 */
export function snapLoop(pcm, fs, beats, start, end) {
  let A = Math.max(0, Math.min(start, end));
  let B = Math.min(pcm.length / fs, Math.max(start, end));
  let count = null;
  let method = 'waveform';
  const marks = (beats || []).map((b) => Math.max(0, b.s1Onset - PRE_ROLL_S));
  if (marks.length >= 2) {
    const nearest = (t) => marks.reduce((best, m, i) => (Math.abs(m - t) < Math.abs(marks[best] - t) ? i : best), 0);
    let k = nearest(A);
    let m = nearest(B);
    if (m <= k) m = k + 1;
    if (m > marks.length - 1) { m = marks.length - 1; k = Math.min(k, m - 1); }
    A = marks[k]; B = marks[m]; count = m - k; method = 'beats';
  }

  const a = Math.round(A * fs);
  const b0 = Math.round(B * fs);
  const W = Math.round(MATCH_S * fs);
  const range = Math.round((method === 'beats' ? 0.008 : 0.15) * fs);
  const minLen = Math.round(0.1 * fs);
  let best = b0;
  let bestMatch = -2;
  for (let d = -range; d <= range; d++) {
    const b = b0 + d;
    if (b - a < minLen || b + W > pcm.length || a + W > pcm.length) continue;
    const c = matchAt(pcm, a, b, W);
    if (c > bestMatch) { bestMatch = c; best = b; }
  }
  if (bestMatch > 0.3) B = best / fs;
  return { start: A, end: B, beats: count, method };
}

/**
 * The selected audio as a loop. The first few milliseconds are crossfaded from
 * what followed the selection's end, so the join between the last and first
 * sample is continuous.
 */
export function seamLoop(x, fs, start, end) {
  const a = Math.max(0, Math.round(Math.min(start, end) * fs));
  const b = Math.min(x.length, Math.round(Math.max(start, end) * fs));
  const L = b - a;
  if (L < 8) return null;
  const out = Float32Array.from(x.subarray(a, b));
  const xf = Math.min(Math.round(XFADE_S * fs), L >> 2);
  for (let i = 0; i < xf; i++) {
    const g = (i + 0.5) / xf;
    const after = b + i < x.length ? x[b + i] : 0;
    out[i] = x[a + i] * g + after * (1 - g);
  }
  return out;
}

/**
 * How well does this selection loop?
 * - match: similarity (0..1) of the audio after the end to the audio after the start
 * - quiet: both cut points sit in a quiet part of the recording
 * - stepRatio: the jump across the seam compared with ordinary sample-to-sample movement
 * - beats: heartbeat starts inside the selection; wholeBeats: both ends sit on heartbeat starts
 */
export function seamReport(pcm, fs, beats, start, end) {
  const a = Math.max(0, Math.round(start * fs));
  const b = Math.min(pcm.length, Math.round(end * fs));
  const W = Math.round(MATCH_S * fs);
  const match = b + W <= pcm.length && a + W <= pcm.length ? Math.max(0, matchAt(pcm, a, b, W)) : 0;

  const rms = (i0, i1) => {
    let e = 0; let c = 0;
    for (let i = Math.max(0, i0); i < Math.min(pcm.length, i1); i++) { e += pcm[i] * pcm[i]; c++; }
    return c ? Math.sqrt(e / c) : 0;
  };
  const near = Math.round(0.015 * fs);
  const whole = rms(a, b) || 1e-12;
  const quiet = rms(a - near, a + near) < 0.5 * whole && rms(b - near, b + near) < 0.5 * whole;

  const loop = seamLoop(pcm, fs, start, end);
  let stepRatio = Infinity;
  if (loop) {
    const diffs = new Float32Array(loop.length - 1);
    for (let i = 1; i < loop.length; i++) diffs[i - 1] = Math.abs(loop[i] - loop[i - 1]);
    const typical = Float32Array.from(diffs).sort()[Math.floor(diffs.length * 0.99)] || 1e-12;
    stepRatio = Math.abs(loop[0] - loop[loop.length - 1]) / typical;
  }

  const marks = (beats || []).map((bt) => bt.s1Onset);
  const inside = marks.filter((t) => t >= start - 0.005 && t < end - 0.005).length;
  const onMark = (t) => marks.some((m) => Math.abs(m - PRE_ROLL_S - t) < 0.012);
  const wholeBeats = marks.length >= 2 && onMark(start) && onMark(end);
  return {
    match,
    quiet,
    stepRatio,
    beats: inside,
    wholeBeats,
    smooth: stepRatio < 3 && (match > 0.6 || quiet),
  };
}
