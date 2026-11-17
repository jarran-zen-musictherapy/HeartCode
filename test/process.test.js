import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flatEq, applyEq, eqResponseDb, EQ_PRESETS } from '../src/process/eq.js';
import { limit, applyGain, samplePeak, dbToGain } from '../src/process/dynamics.js';
import { integratedLufs, truePeakDb, kWeighting } from '../src/process/loudness.js';
import { averageSpectrum } from '../src/process/spectrum.js';
import { synthHeart } from './synth.js';

const sine = (f, fs, seconds, amp = 1, phase = 0) => {
  const x = new Float32Array(Math.round(fs * seconds));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * f * i) / fs + phase);
  return x;
};
const rmsDb = (x, skip = 0) => {
  let s = 0;
  for (let i = skip; i < x.length; i++) s += x[i] * x[i];
  return 10 * Math.log10(s / (x.length - skip));
};

test('EQ: flat setting returns the audio untouched', () => {
  const x = sine(100, 44100, 0.5);
  assert.equal(applyEq(x, 44100, flatEq()), x);
});

test('EQ: the drawn curve matches what the filters do to real audio', () => {
  const eq = flatEq();
  eq.lowCut = { on: true, freq: 40 };
  eq.bands[0].gain = -4;
  eq.bands[1] = { type: 'peaking', freq: 120, gain: 6, q: 1.2 };
  eq.bands[3].gain = 5;
  eq.highCut = { on: true, freq: 900 };
  for (const fs of [4000, 44100]) {
    for (const f of [20, 40, 60, 120, 250, 600, 1200]) {
      const x = sine(f, fs, 3, 0.25);
      const y = applyEq(x, fs, eq);
      const measured = rmsDb(y, fs) - rmsDb(x, fs); // skip the first second (filter settling)
      const [drawn] = eqResponseDb(eq, fs, [f]);
      assert.ok(Math.abs(measured - drawn) < 0.15, `${fs} Hz rate, ${f} Hz: drawn ${drawn.toFixed(2)} measured ${measured.toFixed(2)}`);
    }
  }
});

test('EQ: bell and shelves hit their set gain; cuts are 24 dB/octave', () => {
  const eq = flatEq();
  eq.bands[1] = { type: 'peaking', freq: 150, gain: 6, q: 1 };
  assert.ok(Math.abs(eqResponseDb(eq, 44100, [150])[0] - 6) < 0.01);
  const sh = flatEq(); sh.bands[0].gain = 5; sh.bands[3].gain = -3;
  assert.ok(Math.abs(eqResponseDb(sh, 44100, [10])[0] - 5) < 0.3);
  assert.ok(Math.abs(eqResponseDb(sh, 44100, [8000])[0] + 3) < 0.3);
  const hp = flatEq(); hp.lowCut = { on: true, freq: 100 };
  const [atCut, octaveBelow] = eqResponseDb(hp, 44100, [100, 50]);
  assert.ok(Math.abs(atCut + 3) < 0.1, `-3 dB at the cut frequency, got ${atCut.toFixed(2)}`);
  assert.ok(Math.abs(octaveBelow + 24) < 0.6, `about -24 dB an octave below, got ${octaveBelow.toFixed(1)}`);
});

test('EQ: every preset is stable and keeps heart sounds in place at 4 kHz and 44.1 kHz', () => {
  for (const [name, p] of Object.entries(EQ_PRESETS)) {
    for (const fs of [4000, 44100]) {
      const s = synthHeart({ seconds: 5, bpm: 72, sampleRate: fs });
      const y = applyEq(s.pcm, fs, p.make());
      const peak = samplePeak(y);
      assert.ok(Number.isFinite(peak) && peak > 0.05 && peak < 6, `${name} at ${fs}: peak ${peak}`);
    }
  }
});

test('limiter: never exceeds the ceiling, and leaves quiet audio untouched', () => {
  const s = synthHeart({ seconds: 10, bpm: 72, sampleRate: 44100 });
  const quiet = applyGain(s.pcm, 0.3);
  assert.equal(limit(quiet, 44100, -1).samples, quiet, 'nothing to do, so the same array comes back');
  for (const ceilingDb of [-1, -6]) {
    const loud = applyGain(s.pcm, 4);
    const out = limit(loud, 44100, ceilingDb);
    assert.ok(samplePeak(out.samples) <= dbToGain(ceilingDb) * 1.000001, `peak ${samplePeak(out.samples)}`);
    assert.ok(out.maxReductionDb > 6, `reduction ${out.maxReductionDb.toFixed(1)} dB`);
    // Gain only ever turns down, never up.
    for (let i = 0; i < loud.length; i += 7) assert.ok(Math.abs(out.samples[i]) <= Math.abs(loud[i]) + 1e-9);
  }
  // A single loud moment: the gain is back to normal well within half a second.
  const x = sine(80, 44100, 2, 0.5);
  for (let i = 30000; i < 30200; i++) x[i] *= 3;
  const y = limit(x, 44100, -1).samples;
  for (let i = 30200 + 22050; i < x.length; i++) assert.ok(Math.abs(y[i] - x[i]) < 0.005 * 0.5 + 1e-9);
  for (let i = 0; i < 29000; i++) assert.ok(Math.abs(y[i] - x[i]) < 1e-9, 'audio before the loud moment is untouched');
});

test('limiter: gain moves smoothly (no clicks)', () => {
  const x = sine(60, 44100, 1, 0.5);
  for (let i = 20000; i < 20400; i++) x[i] *= 4; // a sudden loud burst
  const out = limit(x, 44100, -1).samples;
  let worst = 0;
  for (let i = 1; i < out.length; i++) {
    const g0 = x[i - 1] !== 0 ? out[i - 1] / x[i - 1] : 1;
    const g1 = x[i] !== 0 ? out[i] / x[i] : 1;
    if (Math.abs(x[i]) > 0.05 && Math.abs(x[i - 1]) > 0.05) worst = Math.max(worst, Math.abs(g1 - g0));
  }
  assert.ok(worst < 0.01, `largest gain step per sample ${worst}`);
});

test('LUFS: matches the standard (48 kHz coefficients and reference tone)', () => {
  const [shelf, hp] = kWeighting(48000);
  assert.ok(Math.abs(shelf.b0 - 1.53512485958697) < 1e-6);
  assert.ok(Math.abs(shelf.a1 + 1.69065929318241) < 1e-6);
  assert.ok(Math.abs(hp.a1 + 1.99004745483398) < 1e-6);
  // A full-scale 997 Hz sine on one channel reads -3.01 LUFS.
  for (const fs of [48000, 44100]) {
    const l = integratedLufs(sine(997, fs, 5, 1), fs);
    assert.ok(Math.abs(l + 3.01) < 0.05, `${fs}: ${l.toFixed(2)} LUFS`);
  }
  const quieter = integratedLufs(sine(997, 48000, 5, 0.1), 48000);
  assert.ok(Math.abs(quieter + 23.01) < 0.05, 'scales 1 dB per dB');
  assert.equal(integratedLufs(new Float32Array(48000), 48000), -Infinity);
});

test('LUFS: silence between sounds is gated out', () => {
  const tone = sine(997, 48000, 2, 0.5);
  const withGaps = new Float32Array(48000 * 10);
  withGaps.set(tone, 0);
  withGaps.set(tone, 48000 * 6);
  const a = integratedLufs(tone, 48000);
  const b = integratedLufs(withGaps, 48000);
  assert.ok(Math.abs(a - b) < 0.5, `${a.toFixed(2)} vs ${b.toFixed(2)}`);
});

test('true peak: finds peaks that fall between samples', () => {
  // fs/4 sine sampled 45 degrees off its crest: samples reach 0.707, the wave reaches 1.0.
  const x = sine(12000, 48000, 0.2, 1, Math.PI / 4);
  assert.ok(Math.abs(20 * Math.log10(samplePeak(x)) + 3.01) < 0.05);
  assert.ok(Math.abs(truePeakDb(x)) < 0.15, `true peak ${truePeakDb(x).toFixed(2)} dBTP`);
  // Low-frequency audio: true peak equals sample peak.
  const low = sine(60, 44100, 0.5, 0.5);
  assert.ok(Math.abs(truePeakDb(low) + 6.02) < 0.05);
});

test('spectrum: a tone shows up at the right frequency', () => {
  for (const fs of [4000, 44100]) {
    const x = sine(110, fs, 4, 0.5);
    const sp = averageSpectrum(x, fs);
    let top = 0;
    for (let i = 1; i < sp.power.length; i++) if (sp.power[i] > sp.power[top]) top = i;
    assert.ok(Math.abs(top * sp.binHz - 110) <= sp.binHz, `peak at ${(top * sp.binHz).toFixed(1)} Hz`);
    assert.ok(sp.binHz < 4, `resolution ${sp.binHz.toFixed(2)} Hz`);
  }
  assert.equal(averageSpectrum(new Float32Array(10), 4000), null);
});

// ---- noise reduction, cleanest slice, MP3 ----
const { gateCurve, applyCurve, beatCosts } = await import('../src/process/noise.js');
const { analyseHeartbeat } = await import('../src/analysis/detect.js');
const { gridWarp, chooseBeats } = await import('../src/analysis/gridwarp.js');
const { encodeMp3, estimateSize } = await import('../src/export/mp3.js');

test('noise gate: gaps drop by the set amount, heart sounds keep their level, gain is smooth', () => {
  const s = synthHeart({ seconds: 20, bpm: 72, noise: 0.05 });
  const a = analyseHeartbeat(s.pcm, 4000);
  const curve = gateCurve(s.pcm, 4000, -18, a.beats);
  const y = applyCurve(s.pcm, 4000, curve);
  const rms = (x, t0, t1) => {
    let e = 0; let c = 0;
    for (let i = Math.round(t0 * 4000); i < Math.round(t1 * 4000); i++) { e += x[i] * x[i]; c++; }
    return Math.sqrt(e / c);
  };
  let gapDrop = 0; let peakDrop = 0; let count = 0;
  for (const b of a.beats.slice(1, -1)) {
    // Quiet stretch well after S2 and before the next S1.
    gapDrop += 20 * Math.log10(rms(y, b.s1 + 0.55, b.s1 + 0.7) / rms(s.pcm, b.s1 + 0.55, b.s1 + 0.7));
    peakDrop += 20 * Math.log10(rms(y, b.s1 - 0.03, b.s1 + 0.03) / rms(s.pcm, b.s1 - 0.03, b.s1 + 0.03));
    count++;
  }
  gapDrop /= count; peakDrop /= count;
  assert.ok(gapDrop < -15 && gapDrop > -19, `gap level change ${gapDrop.toFixed(1)} dB`);
  assert.ok(Math.abs(peakDrop) < 0.3, `S1 level change ${peakDrop.toFixed(2)} dB`);
  let step = 0;
  for (let i = 1; i < curve.gain.length; i++) step = Math.max(step, Math.abs(curve.gain[i] - curve.gain[i - 1]));
  assert.ok(step < 0.03, `largest gain step ${step}`);
  // Detection is unaffected by gating.
  assert.equal(analyseHeartbeat(y, 4000).beats.length, a.beats.length);
  assert.equal(gateCurve(s.pcm, 4000, 0), null, 'off does nothing');
  assert.equal(applyCurve(s.pcm, 4000, null), s.pcm);
});

test('noise gate: quiet S2 sounds are kept', () => {
  const s = synthHeart({ seconds: 20, bpm: 72, noise: 0.03, s2Amp: 0.3 });
  const a = analyseHeartbeat(s.pcm, 4000);
  const y = applyCurve(s.pcm, 4000, gateCurve(s.pcm, 4000, -30, a.beats));
  const b = analyseHeartbeat(y, 4000);
  const withS2 = b.beats.filter((x) => x.s2 !== null).length;
  assert.ok(withS2 >= 0.9 * a.beats.length, `S2 on ${withS2} of ${a.beats.length}`);
});

test('cleanest slice: a beat with a noise burst is avoided', () => {
  const s = synthHeart({ seconds: 20, bpm: 72, noise: 0.02 });
  const a = analyseHeartbeat(s.pcm, 4000);
  const dirty = Float32Array.from(s.pcm);
  // Scratchy noise across beats 3 to 5.
  let st = 9;
  const from = Math.round(a.beats[3].s1Onset * 4000); const to = Math.round(a.beats[6].s1Onset * 4000);
  for (let i = from; i < to; i++) { st = (st * 1664525 + 1013904223) >>> 0; dirty[i] += 0.5 * (st / 4294967296 - 0.5) * Math.sin(i / 3); }
  const costs = beatCosts(dirty, 4000, a.beats);
  assert.equal(costs.length, a.beats.length - 1);
  for (const n of [1, 2, 4]) {
    const pick = chooseBeats(a.beats, n, costs);
    assert.ok(pick.start + n <= 3 || pick.start >= 6, `${n}-beat pick starts at ${pick.start}`);
  }
  const worst = costs.indexOf(Math.max(...costs));
  assert.ok(worst >= 3 && worst <= 5, `worst beat ${worst}`);
});

test('a one-beat loop is exactly one beat long and loops on the grid', () => {
  const s = synthHeart({ seconds: 12, bpm: 72 });
  const a = analyseHeartbeat(s.pcm, 4000);
  const w = gridWarp(s.pcm, 4000, a.beats, { bpm: 60, count: 1, costs: beatCosts(s.pcm, 4000, a.beats) });
  assert.equal(w.beats, 1);
  assert.equal(w.samples.length, 4000);
  const long = new Float32Array(4000 * 12);
  for (let r = 0; r < 12; r++) long.set(w.samples, r * 4000);
  const r = analyseHeartbeat(long, 4000);
  assert.ok(Math.abs(r.bpm - 60) < 0.2, `bpm ${r.bpm}`);
});

test('MP3 export: valid frames, size close to the estimate', () => {
  const x = sine(220, 44100, 3, 0.5);
  for (const kbps of [64, 192, 320]) {
    const mp3 = encodeMp3(x, 44100, kbps);
    assert.equal(mp3[0], 0xff);
    assert.equal(mp3[1] & 0xe0, 0xe0, 'MPEG frame sync');
    const est = estimateSize('mp3', 3, { kbps });
    assert.ok(Math.abs(mp3.length - est) / est < 0.06, `${kbps} kbps: ${mp3.length} vs ${est}`);
  }
  assert.throws(() => encodeMp3(x, 4000, 128));
  assert.equal(estimateSize('wav', 2, { sampleRate: 44100, bitDepth: 24 }), 44 + 88200 * 3);
});

// --- noise removal, beat averaging, and the full render chain ---
import { denoise } from '../src/process/denoise.js';
import { averageBeat, repeatBeat } from '../src/process/average.js';
import { createRenderer } from '../src/process/render.js';
import { createHandler } from '../src/worker/handler.js';
import { flatEq as flat } from '../src/process/eq.js';

const snrDb = (y, clean) => {
  let s = 0; let n = 0;
  for (let i = 0; i < y.length; i++) { s += clean[i] ** 2; n += (y[i] - clean[i]) ** 2; }
  return 10 * Math.log10(s / n);
};

test('noise removal: off returns the audio untouched; on improves the signal-to-noise ratio a lot', () => {
  const o = { sampleRate: 4000, seed: 3, seconds: 20 };
  const clean = synthHeart({ ...o, noise: 0 }).pcm;
  const noisy = synthHeart({ ...o, noise: 0.08 }).pcm;
  const beats = analyseHeartbeat(noisy, 4000).beats;
  assert.equal(denoise(noisy, 4000, 'off', beats), noisy);
  const before = snrDb(noisy, clean);
  for (const [lvl, gain] of [['light', 5], ['medium', 9], ['strong', 12]]) {
    assert.ok(snrDb(denoise(noisy, 4000, lvl, beats), clean) > before + gain, lvl);
    assert.ok(snrDb(denoise(noisy, 4000, lvl), clean) > before + gain, `${lvl} without beats`);
  }
});

test('noise removal: a clean recording passes through nearly unchanged', () => {
  const noisy = synthHeart({ sampleRate: 4000, seed: 4, seconds: 12, noise: 0.002 }).pcm;
  const out = denoise(noisy, 4000, 'medium', analyseHeartbeat(noisy, 4000).beats);
  assert.equal(out.length, noisy.length);
  assert.ok(snrDb(out, noisy) > 25);
});

test('beat averaging: keeps the heart sound, cuts noise by the square root of the beat count, and loops', () => {
  for (const sampleRate of [4000, 44100]) {
    const noisy = synthHeart({ sampleRate, seed: 5, seconds: 30, jitter: 0.03, noise: 0.1 });
    const a = analyseHeartbeat(noisy.pcm, sampleRate);
    const avg = averageBeat(noisy.pcm, sampleRate, a.beats);
    const C = avg.cycle.length;
    assert.ok(avg.used >= 0.8 * avg.total && avg.hasS2);
    assert.ok(Math.abs(avg.period - 60 / 72) < 0.02);
    let s1 = 0; let s2 = 0;
    const split = Math.round(avg.beat.s2Onset * sampleRate) - Math.round(0.01 * sampleRate);
    for (let i = 0; i < split; i++) s1 = Math.max(s1, Math.abs(avg.cycle[i]));
    for (let i = split; i < C; i++) s2 = Math.max(s2, Math.abs(avg.cycle[i]));
    assert.ok(s1 > 0.85 && s1 < 1.15, `S1 level ${s1}`);
    assert.ok(s2 > 0.48 && s2 < 0.72, `S2 level ${s2}`); // not blurred by beat-to-beat timing changes
    let q = 0;
    const q0 = Math.round(0.75 * C); const q1 = Math.round(0.95 * C);
    for (let i = q0; i < q1; i++) q += avg.cycle[i] ** 2;
    q = Math.sqrt(q / (q1 - q0));
    assert.ok(q < 1.3 * (0.1 / Math.sqrt(avg.used)), `gap noise ${q}`);
    // The beat joins on to itself without a step.
    assert.ok(Math.abs(avg.cycle[0] - avg.cycle[C - 1]) < 0.05);
    const rep = repeatBeat(avg, 4);
    assert.equal(rep.pcm.length, 6 * C);
    assert.equal(rep.beats.length, 6);
  }
});

test('beat averaging: an odd beat (a bump) is left out', () => {
  const h = synthHeart({ sampleRate: 4000, seed: 6, seconds: 25, noise: 0.01, jitter: 0.01 });
  const a = analyseHeartbeat(h.pcm, 4000);
  const k = 7;
  const at = Math.round((a.beats[k].s1Onset - 0.02) * 4000);
  for (let i = 0; i < 600; i++) h.pcm[at + i] = 0.9 * Math.sin(i * 0.9) * (i % 7 ? 1 : -1);
  const avg = averageBeat(h.pcm, 4000, a.beats);
  assert.ok(avg.used < avg.total);
  assert.equal(averageBeat(h.pcm, 4000, a.beats.slice(0, 2)), null);
});

const SETTINGS = {
  outRate: 44100, humHz: 0, denoise: 'off', noise: 'off', average: false, eq: flat(), bpm: 72, count: 4,
  nudge: 0, selection: null, autoGain: true, gainDb: 0, limiterOn: true, ceilingDb: -1,
};

test('render chain: grid loop, averaged loop and hand-picked loop all come out exact and within the ceiling', () => {
  const h = synthHeart({ sampleRate: 4000, seed: 7, seconds: 20, noise: 0.03 });
  const data = { pcm: h.pcm, sampleRate: 4000 };
  const analysis = analyseHeartbeat(h.pcm, 4000);
  const r = createRenderer();
  const plain = r.render(data, analysis, SETTINGS);
  assert.equal(plain.samples.length, Math.round((4 * 60 / 72) * 44100));
  assert.equal(plain.usedBeats.length, 4);
  assert.ok(plain.meters.post.peak <= -0.9);
  const avg = r.render(data, analysis, { ...SETTINGS, average: true, denoise: 'medium', noise: 'medium' });
  assert.equal(avg.samples.length, plain.samples.length);
  assert.ok(avg.averaged.used >= 10);
  assert.equal(avg.usedBeats.length, 4);
  // All four beats of the averaged loop are the same beat.
  const L = avg.samples.length / 4;
  let diff = 0;
  for (let i = 0; i < L; i++) diff = Math.max(diff, Math.abs(avg.samples[i] - avg.samples[i + 2 * L]));
  assert.ok(diff < 0.02, `beats differ by ${diff}`);
  const man = r.render(data, analysis, { ...SETTINGS, selection: { start: 2, end: 5 } });
  assert.ok(man.manual && Math.abs(man.seconds - 3) < 0.001);
  assert.equal(r.render(data, analysis, { ...SETTINGS, count: 0 }), null);
  const shots = r.oneShots(data, analysis, SETTINGS, plain.gain);
  assert.equal(shots.length, analysis.beats.length - 1);
});

test('worker jobs: audio, analyse, render in order; stale renders are refused', () => {
  const h = synthHeart({ sampleRate: 4000, seed: 8, seconds: 15 });
  const handle = createHandler();
  assert.equal(handle({ type: 'analyse', opts: {} }), null);
  handle({ type: 'audio', pcm: h.pcm, sampleRate: 4000 });
  const a1 = handle({ type: 'analyse', opts: {} });
  assert.ok(a1.ok && a1.id === 1);
  assert.ok(handle({ type: 'render', analysisId: a1.id, settings: SETTINGS }).loop.samples.length > 0);
  const a2 = handle({ type: 'analyse', opts: {}, range: { start: 2, end: 12 } });
  assert.ok(a2.range && a2.id === 2);
  assert.deepEqual(handle({ type: 'render', analysisId: a1.id, settings: SETTINGS }), { stale: true });
  assert.throws(() => handle({ type: 'nope' }));
});

import { summaryCsv, SUMMARY_COLUMNS } from '../src/export/summary.js';
import { EQ_PRESETS as PRESETS } from '../src/process/eq.js';

test('batch: one job analyses a recording and builds its loop on whole bars; the summary has a row per file', () => {
  const handle = createHandler();
  const settings = { ...SETTINGS, removeHum: true, eq: PRESETS.gentle.make() };
  delete settings.bpm; delete settings.count; delete settings.humHz;
  const h = synthHeart({ sampleRate: 4000, seed: 9, seconds: 20, bpm: 80 });
  const good = handle({ type: 'batch', pcm: h.pcm, sampleRate: 4000, settings });
  assert.ok(good.analysis.ok && good.loop);
  assert.equal(good.loop.bpm, 80);
  assert.equal(good.loop.beats % 4, 0);
  assert.equal(good.loop.samples.length, Math.round((good.loop.beats * 60 / 80) * 44100));
  const bad = handle({ type: 'batch', pcm: new Float32Array(4000 * 5), sampleRate: 4000, settings });
  assert.ok(!bad.analysis.ok && bad.loop === null);

  const csv = summaryCsv([
    { name: 'a, "quoted".wav', analysis: good.analysis, loop: good.loop, loopFile: 'a_80bpm.wav' },
    { name: 'silent.wav', analysis: bad.analysis, loop: null },
    { name: 'broken.mp4', error: 'Could not read audio from this file' },
  ]).trimEnd().split('\r\n');
  assert.equal(csv.length, 4);
  assert.equal(csv[0], SUMMARY_COLUMNS.join(','));
  assert.match(csv[1], /^"a, ""quoted""\.wav",ok,20\.00,(79\.[5-9]|80\.[0-4]),/);
  assert.ok(csv[1].includes(',a_80bpm.wav,80,'));
  assert.ok(csv[2].startsWith('silent.wav,') && !csv[2].includes(',ok,'));
  assert.ok(csv[3].startsWith('broken.mp4,Could not read audio'));
  // Every row has the same number of columns (quoted commas aside).
  assert.equal(csv[2].split(',').length, SUMMARY_COLUMNS.length);
});
