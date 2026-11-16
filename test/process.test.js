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
