// Heart-sound analysis: envelope -> tempo -> S1/S2 beat tracking -> BPM / HRV.
// Works on raw mono samples at the file's native sample rate.

import { biquad, filtfilt, decimate, movingAverage, median } from './filters.js';
import { detectHum, removeHum } from './cleanup.js';

const BAND_LOW_HZ = 25;
const BAND_HIGH_HZ = 150;
const WORK_RATE_HZ = 2000; // heart sounds sit below ~200 Hz; this keeps 0.5 ms timing
const SPLIT_HZ = 65; // boundary between the S1-dominant and S2-dominant bands
const MIN_BPM = 30;
const MAX_BPM = 200;
const SLOW_BPM = 40; // below this, look for a faster rate hiding inside a looped recording

function smoothEnvelope(x, fs) {
  const sq = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) sq[i] = x[i] * x[i];
  let env = movingAverage(sq, 0.04 * fs);
  for (let i = 0; i < env.length; i++) env[i] = Math.sqrt(env[i]);
  return movingAverage(env, 0.02 * fs);
}

/**
 * Band-limited amplitude envelope of the heart sounds, plus separate low and high
 * band envelopes. S1 is lower-pitched than S2, so the two bands rise and fall
 * differently, which is what tells a heartbeat apart from half a heartbeat.
 */
export function heartEnvelope(pcm, sampleRate) {
  const factor = Math.max(1, Math.floor(sampleRate / WORK_RATE_HZ));
  const fs = sampleRate / factor;
  let x = decimate(pcm, factor);
  // Mains hum sits inside the heart band and would bury the quieter sounds.
  const hum = detectHum(x, fs);
  if (hum) x = removeHum(x, fs, hum);
  x = filtfilt(x, biquad('highpass', fs, BAND_LOW_HZ));
  x = filtfilt(x, biquad('lowpass', fs, Math.min(BAND_HIGH_HZ, 0.45 * fs)));
  const low = filtfilt(x, biquad('lowpass', fs, SPLIT_HZ));
  const high = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) high[i] = x[i] - low[i];
  return {
    env: smoothEnvelope(x, fs),
    fs,
    hum,
    bands: [smoothEnvelope(low, fs), smoothEnvelope(high, fs)],
  };
}

/**
 * Rescue for irregular rhythms. When beats come at uneven intervals the only
 * thing that still repeats exactly is the S1-to-S2 time, so the autocorrelation
 * locks on to that and reports an absurdly fast rate. The giveaway: there are
 * far fewer sounds in the recording than that rate would need. In that case
 * take the sounds that are followed by a partner at that spacing as S1, and use
 * the typical time between them.
 * @returns {number|null} a better period in seconds, or null to keep the given one
 */
export function irregularPeriod(env, fs, period) {
  const n = env.length;
  const sorted = Float64Array.from(env).sort();
  const thr = 0.25 * sorted[Math.min(n - 1, Math.floor(0.97 * n))];
  if (!(thr > 0)) return null;
  const sep = Math.round(0.1 * fs);
  const events = [];
  for (let i = 1; i < n - 1; i++) {
    if (env[i] < thr || env[i] < env[i - 1] || env[i] < env[i + 1]) continue;
    const last = events[events.length - 1];
    if (last !== undefined && i - last < sep) {
      if (env[i] > env[last]) events[events.length - 1] = i;
    } else events.push(i);
  }
  if (events.length < 6) return null;
  const duration = n / fs;
  if ((events.length * period) / duration >= 0.8) return null; // enough sounds for the claimed rate
  const s1 = [];
  for (let k = 0; k + 1 < events.length; k++) {
    const gap = (events[k + 1] - events[k]) / fs;
    if (gap > 0.8 * period && gap < 1.2 * period) s1.push(events[k] / fs);
  }
  if (s1.length < 4) return null;
  const rr = [];
  for (let k = 1; k < s1.length; k++) rr.push(s1[k] - s1[k - 1]);
  const typical = median(rr);
  return typical > 1.3 * period && 60 / typical >= MIN_BPM ? typical : null;
}

/**
 * Cardiac period (seconds) from the autocorrelation of the band envelopes.
 * Returns { period, strength, ambiguous }. `ambiguous` is true when a heartbeat
 * with two near-identical sounds could equally be read at double the rate
 * (or half), so the caller can offer a x2 / half override.
 */
export function estimatePeriod(env, fs, bands = [env]) {
  const factor = Math.max(1, Math.round(fs / 100));
  const chans = bands.map((c) => decimate(c, factor));
  const r = fs / factor;
  const n = chans[0].length;
  for (const e of chans) {
    let mean = 0;
    for (let i = 0; i < n; i++) mean += e[i];
    mean /= n;
    for (let i = 0; i < n; i++) e[i] -= mean;
  }

  const minLag = Math.max(1, Math.round((60 / MAX_BPM) * r));
  const maxLag = Math.min(Math.round((60 / MIN_BPM) * r), Math.floor(n / 2));
  if (maxLag <= minLag + 2) return null;

  let ac0 = 0;
  for (const e of chans) for (let i = 0; i < n; i++) ac0 += e[i] * e[i];
  ac0 /= n;
  if (ac0 <= 0) return null;

  const ac = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let sum = 0;
    for (const e of chans) {
      let s = 0;
      for (let i = 0; i + lag < n; i++) s += e[i] * e[i + lag];
      sum += s;
    }
    ac[lag] = sum / (n - lag) / ac0; // unbiased, so long lags are not penalised
  }
  const isPeak = (l) => ac[l] >= ac[l - 1] && ac[l] >= ac[l + 1];
  const peakNear = (target, tolFrac) => {
    const tol = Math.max(2, Math.round(target * tolFrac));
    let best = -1;
    for (let l = Math.max(minLag, Math.round(target) - tol); l <= Math.min(maxLag, Math.round(target) + tol); l++) {
      if (isPeak(l) && (best < 0 || ac[l] > ac[best])) best = l;
    }
    return best;
  };

  let best = -1;
  for (let l = minLag; l <= maxLag; l++) {
    if (isPeak(l) && (best < 0 || ac[l] > ac[best])) best = l;
  }
  if (best < 0) return null;

  // The strongest peak may be a multiple of the true period (2T looks nearly as
  // good as T). Step down to the shorter period only when it is essentially as
  // strong, which the band split makes true only for a genuine beat period and
  // not for the S1-to-S2 spacing.
  let chosen = best;
  for (const k of [3, 2]) {
    if (best / k < minLag) continue;
    const local = peakNear(best / k, 0.08);
    if (local > 0 && ac[local] >= 0.9 * ac[best]) { chosen = local; break; }
  }

  // A recording that is itself a loop (a bounce from a DAW) repeats exactly, so the
  // loop length scores a near-perfect match and can beat the heartbeat inside it.
  // A rate under 40 BPM is rarely real: if a whole-number fraction of that period
  // shows a clear peak at a plausible heart rate, take the strongest such peak.
  if (60 / (chosen / r) < SLOW_BPM) {
    let alt = -1;
    for (let k = 2; k <= 8; k++) {
      const target = chosen / k;
      if (target < minLag || 60 / (target / r) > MAX_BPM) break;
      const local = peakNear(target, 0.05);
      if (local > 0 && ac[local] >= 0.55 * ac[chosen] && (alt < 0 || ac[local] > ac[alt] + 0.02)) alt = local;
    }
    if (alt > 0) chosen = alt;
  }

  // Is the reading ambiguous? A strong peak at half the chosen period means the
  // beat could be a single sound repeating at double the rate.
  const half = chosen / 2 >= minLag ? peakNear(chosen / 2, 0.06) : -1;
  const double = chosen * 2 <= maxLag ? peakNear(chosen * 2, 0.06) : -1;
  const ambiguous = (half > 0 && ac[half] >= 0.75 * ac[chosen])
    || (double > 0 && ac[double] >= 0.98 * ac[chosen] && ac[chosen] < 0.9);

  const a = ac[chosen - 1]; const b = ac[chosen]; const c = ac[chosen + 1];
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  return { period: (chosen + shift) / r, strength: ac[chosen], ambiguous };
}

/** Candidate heart sounds: local envelope maxima above a locally adaptive threshold. */
function findCandidates(env, fs, period) {
  const n = env.length;
  const win = Math.round(period * fs);
  const minGap = Math.round(0.1 * fs);
  const sorted = Float64Array.from(env).sort();
  const noise = sorted[Math.floor(n * 0.2)];
  const globalRef = sorted[Math.floor(n * 0.995)];
  const raw = [];
  for (let i = 1; i < n - 1; i++) {
    if (env[i] > env[i - 1] && env[i] >= env[i + 1]) raw.push(i);
  }
  // Local maximum over +-1 period (sliding max via coarse blocks is plenty here).
  const block = Math.max(1, Math.round(win / 4));
  const nb = Math.ceil(n / block);
  const bmax = new Float64Array(nb);
  for (let i = 0; i < n; i++) {
    const b = Math.floor(i / block);
    if (env[i] > bmax[b]) bmax[b] = env[i];
  }
  const localMax = (i) => {
    const b = Math.floor(i / block);
    let m = 0;
    for (let k = Math.max(0, b - 4); k <= Math.min(nb - 1, b + 4); k++) if (bmax[k] > m) m = bmax[k];
    return m;
  };
  const kept = [];
  for (const i of raw) {
    const thr = Math.max(0.2 * localMax(i), noise * 2, 0.04 * globalRef);
    if (env[i] < thr) continue;
    const last = kept[kept.length - 1];
    if (last !== undefined && i - last < minGap) {
      if (env[i] > env[last]) kept[kept.length - 1] = i;
    } else {
      kept.push(i);
    }
  }
  return kept.map((i) => ({ i, t: i / fs, amp: env[i] }));
}

/** Follow one sound per cycle outward from a seed candidate. */
function trackChain(cands, seed, period) {
  const walk = (dir) => {
    const out = [];
    let T = period;
    let t = cands[seed].t;
    let idx = seed;
    let misses = 0;
    for (;;) {
      let bestJ = -1;
      // A weak sound at the wrong time is not a beat (matters most at the file ends,
      // where it may be the only candidate in the window).
      let bestScore = 0.08 * cands[seed].amp;
      for (let j = idx + dir; j >= 0 && j < cands.length; j += dir) {
        const dt = (cands[j].t - t) * dir;
        if (dt > 1.3 * T) break;
        if (dt < 0.7 * T) continue;
        const z = (dt - T) / (0.12 * T);
        const score = cands[j].amp * Math.exp(-0.5 * z * z);
        if (score > bestScore) { bestScore = score; bestJ = j; }
      }
      if (bestJ >= 0) {
        const dt = Math.abs(cands[bestJ].t - t);
        T = Math.min(1.5 * period, Math.max(0.67 * period, 0.7 * T + 0.3 * dt));
        t = cands[bestJ].t;
        idx = bestJ;
        misses = 0;
        out.push(bestJ);
      } else {
        // Missed beat (noise, dropout): step one period on and keep looking.
        t += dir * T;
        misses++;
        if (misses > 4) break;
        // Keep idx pointing at the last candidate on the near side of t.
        while (idx + dir >= 0 && idx + dir < cands.length && (cands[idx + dir].t - t) * dir <= 0) idx += dir;
      }
      if (idx + dir < 0 || idx + dir >= cands.length) break;
    }
    return out;
  };
  const back = walk(-1).reverse();
  const fwd = walk(1);
  return [...back, seed, ...fwd];
}

function bestChain(cands, period) {
  const seeds = cands.map((c, j) => j).sort((a, b) => cands[b].amp - cands[a].amp).slice(0, 5);
  let best = null;
  let bestScore = -1;
  for (const s of seeds) {
    const chain = trackChain(cands, s, period);
    let score = 0;
    for (const j of chain) score += cands[j].amp;
    if (score > bestScore) { bestScore = score; best = chain; }
  }
  return best;
}

/**
 * Track beats across the whole recording, including separate stretches of
 * heartbeat with silence or handling noise between them (the tracker gives up
 * after a few missed beats, so each stretch is found by itself).
 * `allowed` optionally restricts tracking to a subset of candidate indices.
 * Returns candidate indices in time order.
 */
function trackAll(cands, period, allowed = null) {
  const idx = allowed ? allowed.slice().sort((a, b) => a - b) : cands.map((c, j) => j);
  const pool = idx.map((j) => cands[j]);
  const found = [];
  let mainLevel = 0;
  const run = (lo, hi) => { // inclusive positions in `pool`
    if (hi - lo + 1 < 3) return;
    const chain = bestChain(pool.slice(lo, hi + 1), period).map((k) => k + lo);
    const level = median(chain.map((k) => pool[k].amp));
    if (!found.length) mainLevel = level;
    // A further stretch must be a real run of beats, not a couple of stray noises.
    else if (chain.length < 4 || level < 0.25 * mainLevel) return;
    found.push(...chain);
    run(lo, chain[0] - 1);
    run(chain[chain.length - 1] + 1, hi);
  };
  run(0, pool.length - 1);
  return found.sort((a, b) => a - b).map((k) => idx[k]);
}

/** For each chain sound, the strongest other sound before the next chain sound. */
function findPartners(cands, chain, period, lo, hi) {
  const inChain = new Set(chain);
  return chain.map((j, k) => {
    const t = cands[j].t;
    const P = k + 1 < chain.length ? Math.min(cands[chain[k + 1]].t - t, 1.5 * period) : period;
    let best = -1;
    for (let m = j + 1; m < cands.length; m++) {
      const f = (cands[m].t - t) / P;
      if (f >= hi) break;
      if (f < lo || inChain.has(m)) continue;
      if (cands[m].amp < 0.12 * cands[j].amp) continue;
      if (best < 0 || cands[m].amp > cands[best].amp) best = m;
    }
    return best < 0 ? null : { j: best, frac: (cands[best].t - t) / P };
  });
}

/** Walk back from an envelope peak to where the sound starts rising. */
function onsetTime(env, fs, peakIdx) {
  const level = 0.25 * env[peakIdx];
  const limit = Math.max(0, peakIdx - Math.round(0.12 * fs));
  let i = peakIdx;
  while (i > limit && env[i] > level) i--;
  return i / fs;
}

/**
 * Analyse a heartbeat recording.
 * @param {Float32Array} pcm mono samples
 * @param {number} sampleRate native sample rate
 * @param {{ swapAnchor?: boolean, tempoFactor?: 0.5|2 }} [opts] swapAnchor: treat the other
 *   sound as S1; tempoFactor: manual override when the tempo came out at half or double
 */
export function analyseHeartbeat(pcm, sampleRate, opts = {}) {
  // One NaN or Infinity (a corrupt file) would poison every filter and make the
  // whole recording look beatless, so zero such samples first.
  for (let i = 0; i < pcm.length; i++) {
    if (!Number.isFinite(pcm[i])) {
      pcm = Float32Array.from(pcm, (v) => (Number.isFinite(v) ? v : 0));
      break;
    }
  }
  const duration = pcm.length / sampleRate;
  const empty = (reason) => ({
    ok: false, reason, duration, beats: [], bpm: null, rr: [], hrv: null,
  });
  if (duration < 2) return empty('Recording is too short to analyse (need at least 2 seconds).');

  const { env, fs, bands, hum } = heartEnvelope(pcm, sampleRate);
  const tempo = estimatePeriod(env, fs, bands);
  if (!tempo || tempo.strength < 0.1) return empty('No regular heartbeat found in this recording.');
  const slower = irregularPeriod(env, fs, tempo.period);
  if (slower) { tempo.period = slower; tempo.irregular = true; }
  if (opts.tempoFactor === 2 || opts.tempoFactor === 0.5) tempo.period /= opts.tempoFactor;

  const cands = findCandidates(env, fs, tempo.period);
  if (cands.length < 3) return empty('Too few heart sounds detected.');

  // Track every stretch of heartbeat, then decide S1 vs S2 separately for each
  // stretch: the tracker follows whichever sound is strongest, and that can be
  // S1 in one stretch and S2 in the next.
  const tracked = trackAll(cands, tempo.period);
  const stretches = [];
  for (const j of tracked) {
    const cur = stretches[stretches.length - 1];
    if (cur && cands[j].t - cands[cur[cur.length - 1]].t < 2.5 * tempo.period) cur.push(j);
    else stretches.push([j]);
  }

  // Which sound is S1? Systole (S1->S2) is shorter than diastole (S2->S1),
  // so S1 is the sound followed by the SHORT gap. If the gaps are too even to
  // tell, fall back to "S1 is the louder sound".
  const orient = (seg) => {
    const found = findPartners(cands, seg, tempo.period, 0.15, 0.85).filter(Boolean);
    if (found.length < 0.5 * seg.length) return { paired: false, method: 'single', isS1: true };
    const frac = median(found.map((p) => p.frac));
    if (Math.abs(frac - 0.5) >= 0.05) return { paired: true, method: 'timing', isS1: frac < 0.5 };
    const segAmp = median(seg.map((j) => cands[j].amp));
    const partnerAmp = median(found.map((p) => cands[p.j].amp));
    return { paired: true, method: 'loudness', isS1: segAmp >= partnerAmp };
  };

  let chain = [];
  let anchorMethod = 'single';
  let paired = false;
  let longest = 0;
  for (const seg of stretches) {
    const o = orient(seg);
    if (seg.length > longest) { longest = seg.length; anchorMethod = o.method; paired = o.paired; }
    let isS1 = o.isS1;
    if (opts.swapAnchor && o.paired) isS1 = !isS1;
    let use = seg;
    if (!isS1) {
      // Re-track this stretch on its other sounds so the chain itself is S1.
      const inSeg = new Set(seg);
      const others = [];
      for (let j = Math.max(0, seg[0] - 1); j <= Math.min(cands.length - 1, seg[seg.length - 1] + 1); j++) {
        if (!inSeg.has(j)) others.push(j);
      }
      if (others.length >= 3) {
        const alt = trackAll(cands, tempo.period, others);
        if (alt.length >= 2) use = alt;
      }
    }
    chain.push(...use);
  }
  chain = [...new Set(chain)].sort((x, y) => x - y);
  const partners = paired ? findPartners(cands, chain, tempo.period, 0.15, 0.7) : [];

  // A sound clipped by the start or end of the file is not a usable beat.
  const edge = 0.06;
  const beats = chain.map((j, k) => {
    const s2 = paired && partners[k] ? cands[partners[k].j] : null;
    return {
      s1: cands[j].t,
      s1Onset: onsetTime(env, fs, cands[j].i),
      s1Amp: cands[j].amp,
      s2: s2 ? s2.t : null,
      s2Onset: s2 ? onsetTime(env, fs, s2.i) : null,
    };
  }).filter((b) => b.s1 >= edge && b.s1 <= duration - edge);
  // A recording that stops mid-sound leaves a weak partial beat at the very end or start.
  const typical = median(beats.map((b) => b.s1Amp));
  const partial = (b) => b.s1Amp < 0.35 * typical && (b.s1 < 0.15 || b.s1 > duration - 0.15);
  while (beats.length && partial(beats[beats.length - 1])) beats.pop();
  while (beats.length && partial(beats[0])) beats.shift();
  if (beats.length < 2) return empty('Too few complete heartbeats detected.');

  // The heart cannot empty in under about 0.15 s, so a "second sound" closer
  // than that is the tail of S1, not S2. Do not report it as one.
  const gaps = beats.filter((b) => b.s2 !== null).map((b) => b.s2 - b.s1);
  if (gaps.length && median(gaps) < MIN_SYSTOLE_S) {
    for (const b of beats) { b.s2 = null; b.s2Onset = null; }
    paired = false;
    anchorMethod = 'single';
  }

  // Noise can drag an individual onset early or late. Peaks are far steadier,
  // so pull any onset whose peak-to-onset lag is an outlier back to the median lag.
  for (const [peak, onset] of [['s1', 's1Onset'], ['s2', 's2Onset']]) {
    const lags = beats.filter((b) => b[peak] !== null).map((b) => b[peak] - b[onset]);
    const lag = median(lags);
    for (const b of beats) {
      if (b[peak] !== null && Math.abs(b[peak] - b[onset] - lag) > 0.015) b[onset] = Math.max(0, b[peak] - lag);
    }
  }

  // R-R style intervals from S1 onsets; ignore gaps that span a missed beat.
  const allRR = [];
  for (let k = 1; k < beats.length; k++) allRR.push(beats[k].s1Onset - beats[k - 1].s1Onset);
  const medRR = median(allRR);
  const rr = allRR.filter((v) => v > 0.6 * medRR && v < 1.6 * medRR);
  const bpm = rr.length ? 60 / median(rr) : 60 / tempo.period;

  let hrv = null;
  if (rr.length >= 3) {
    const ms = rr.map((v) => v * 1000);
    const mean = ms.reduce((a, b) => a + b, 0) / ms.length;
    const sdnn = Math.sqrt(ms.reduce((a, b) => a + (b - mean) ** 2, 0) / (ms.length - 1));
    let sq = 0;
    let nd = 0;
    for (let k = 1; k < allRR.length; k++) {
      const a = allRR[k - 1]; const b = allRR[k];
      if (a > 0.6 * medRR && a < 1.6 * medRR && b > 0.6 * medRR && b < 1.6 * medRR) {
        sq += ((b - a) * 1000) ** 2; nd++;
      }
    }
    hrv = { meanRR: mean, sdnn, rmssd: nd ? Math.sqrt(sq / nd) : null };
  }

  const tempoCheck = checkTempo(beats, medRR, paired);

  // Beats we would expect between the first and last marker. A long silence between
  // two stretches of heartbeat is a pause in the recording, not missed beats.
  const beatLen = 60 / bpm;
  let expected = 1;
  for (const v of allRR) expected += v > 4 * beatLen ? 1 : Math.max(1, Math.round(v / beatLen));
  return {
    ok: true,
    duration,
    bpm,
    beats,
    rr,
    hrv,
    anchorMethod, // 'timing' | 'loudness' | 'single'
    s2Found: paired,
    regularity: tempo.strength, // 0..1 autocorrelation strength
    // Evenly spaced sounds (S1 picked by loudness) are exactly the case where a
    // heartbeat and half a heartbeat look alike, so flag that too.
    tempoAmbiguous: tempo.ambiguous || anchorMethod === 'loudness' || tempoCheck.suggest !== null,
    tempoCheck, // what the sounds themselves say about half/double tempo
    coverage: Math.min(1, beats.length / expected), // share of expected beats found
    hum, // 0, 50 or 60: mains hum found (and filtered out for the analysis)
    shortRecording: duration < 30, // HRV from under 30 s is indicative only
  };
}

const MIN_SYSTOLE_S = 0.15;

/**
 * A second opinion on half/double tempo, from the sounds themselves.
 * With two sounds per beat (S1 and S2) the tempo is well pinned down. With one
 * sound per beat there are two readings: a fast heart whose S2 is too faint to
 * hear, or a slow heart whose S1 and S2 are both being counted as beats. In the
 * second case the "beats" alternate: louder/softer, or short gap/long gap.
 * @returns {{ soundsPerBeat: 1|2, s1s2: number|null, alternating: boolean, suggest: 'half'|null }}
 */
export function checkTempo(beats, medRR, paired) {
  if (paired) {
    const d = beats.filter((b) => b.s2 !== null).map((b) => b.s2 - b.s1);
    return { soundsPerBeat: 2, s1s2: d.length ? median(d) : null, alternating: false, suggest: null };
  }
  // Split into runs of steady beats; within each, compare every beat with the next.
  const amp = { sum: 0, sq: 0, n: 0 };
  const gap = { sum: 0, sq: 0, n: 0 };
  let run = [];
  const flush = () => {
    if (run.length >= 5) {
      const a = []; const g = [];
      for (let i = 0; i + 1 < run.length; i++) {
        const sign = i % 2 ? -1 : 1;
        a.push(sign * Math.log((run[i + 1].s1Amp || 1e-12) / (run[i].s1Amp || 1e-12)));
        if (i + 2 < run.length) {
          g.push(sign * ((run[i + 2].s1Onset - run[i + 1].s1Onset) - (run[i + 1].s1Onset - run[i].s1Onset)) / (2 * medRR));
        }
      }
      for (const [acc, v] of [[amp, a], [gap, g]]) {
        if (!v.length) continue;
        const m = v.reduce((x, y) => x + y, 0) / v.length;
        const flip = m < 0 ? -1 : 1; // which of the two sounds comes first in this run is arbitrary
        for (const x of v) { acc.sum += flip * x; acc.sq += x * x; acc.n++; }
      }
    }
    run = [];
  };
  for (let k = 0; k < beats.length; k++) {
    if (k > 0) {
      const rr = beats[k].s1Onset - beats[k - 1].s1Onset;
      if (rr < 0.6 * medRR || rr > 1.5 * medRR) flush();
    }
    run.push(beats[k]);
  }
  flush();
  const stat = (acc) => {
    if (acc.n < 6) return { mean: 0, t: 0 };
    const mean = acc.sum / acc.n;
    const sd = Math.sqrt(Math.max(1e-12, acc.sq / acc.n - mean * mean));
    return { mean, t: (mean / sd) * Math.sqrt(acc.n) };
  };
  const a = stat(amp);
  const g = stat(gap);
  const alternating = (Math.exp(a.mean) >= 1.25 && a.t >= 4) || (g.mean >= 0.05 && g.t >= 4);
  return { soundsPerBeat: 1, s1s2: null, alternating, suggest: alternating ? 'half' : null };
}

/**
 * Analyse only part of a recording (seconds `start` to `end`). Beat times in the
 * result are in whole-file time, so markers and loops line up with the waveform.
 * Useful when the rest of the recording is talking, handling noise or silence.
 */
export function analyseHeartbeatRange(pcm, sampleRate, start, end, opts = {}) {
  const a = Math.max(0, Math.round(Math.min(start, end) * sampleRate));
  const b = Math.min(pcm.length, Math.round(Math.max(start, end) * sampleRate));
  const range = { start: a / sampleRate, end: b / sampleRate };
  const r = analyseHeartbeat(pcm.subarray(a, b), sampleRate, opts);
  if (!r.ok && r.duration < 2) r.reason = 'The selected part is too short to analyse (need at least 2 seconds). Select more, or analyse the whole recording.';
  const shift = (t) => (t === null ? null : t + range.start);
  return {
    ...r,
    range,
    beats: r.beats.map((bt) => ({
      ...bt, s1: shift(bt.s1), s1Onset: shift(bt.s1Onset), s2: shift(bt.s2), s2Onset: shift(bt.s2Onset),
    })),
  };
}
