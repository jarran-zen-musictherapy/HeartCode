import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseHeartbeat } from '../src/analysis/detect.js';
import { median } from '../src/analysis/filters.js';
import { synthHeart } from './synth.js';

// Match detected S1 onsets to true beat starts after removing the constant
// offset between "start of burst" and "detected onset".
function score(result, truth) {
  const det = result.beats.map((b) => b.s1Onset);
  const offs = truth.map((t) => {
    const near = det.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a));
    return near - t;
  });
  const off = median(offs);
  const hits = offs.filter((o) => Math.abs(o - off) < 0.02).length;
  return { recall: hits / truth.length, extra: det.length - truth.length, offset: off };
}

const cases = [
  { name: '72 bpm @ 4 kHz (Littmann profile)', sampleRate: 4000, bpm: 72 },
  { name: '50 bpm slow', sampleRate: 4000, bpm: 50, systole: 0.36 },
  { name: '110 bpm fast', sampleRate: 4000, bpm: 110, systole: 0.24 },
  { name: '77 bpm @ 44.1 kHz', sampleRate: 44100, bpm: 77 },
  { name: 'S2 louder than S1 (timing rule must still pick S1)', sampleRate: 4000, bpm: 68, s1Amp: 0.6, s2Amp: 1 },
  { name: 'noisy recording', sampleRate: 4000, bpm: 80, noise: 0.12 },
  { name: 'irregular rhythm (8% jitter)', sampleRate: 4000, bpm: 75, jitter: 0.08 },
];

for (const c of cases) {
  test(c.name, () => {
    const s = synthHeart({ seconds: 30, ...c });
    const r = analyseHeartbeat(s.pcm, s.sampleRate);
    assert.ok(r.ok, r.reason);
    assert.ok(Math.abs(r.bpm - c.bpm) < 0.04 * c.bpm, `bpm ${r.bpm.toFixed(1)} vs ${c.bpm}`);
    const sc = score(r, s.s1);
    assert.ok(sc.recall >= 0.95, `recall ${sc.recall.toFixed(2)}`);
    assert.ok(Math.abs(sc.extra) <= 1, `extra beats ${sc.extra}`);
    assert.equal(r.anchorMethod, 'timing');
    const withS2 = r.beats.filter((b) => b.s2 !== null).length;
    assert.ok(withS2 >= 0.9 * r.beats.length, 'S2 found for most beats');
  });
}

test('swapAnchor moves the anchor to the other sound', () => {
  const s = synthHeart({ seconds: 20, bpm: 72 });
  const a = analyseHeartbeat(s.pcm, s.sampleRate);
  const b = analyseHeartbeat(s.pcm, s.sampleRate, { swapAnchor: true });
  const shift = median(b.beats.slice(1, 10).map((x) => x.s1)) - median(a.beats.slice(1, 10).map((x) => x.s1));
  assert.ok(Math.abs(Math.abs(shift) % (60 / 72)) > 0.2, 'anchor shifted by about a systole');
});

test('silence and noise are rejected, not given a fake BPM', () => {
  const silent = analyseHeartbeat(new Float32Array(4000 * 10), 4000);
  assert.equal(silent.ok, false);
  const s = synthHeart({ seconds: 15, s1Amp: 0, s2Amp: 0, noise: 0.3 });
  const noisy = analyseHeartbeat(s.pcm, s.sampleRate);
  assert.equal(noisy.ok, false);
});

test('too-short recordings are rejected', () => {
  assert.equal(analyseHeartbeat(new Float32Array(4000), 4000).ok, false);
});

// Regression: a loud S2 near mid-cycle used to make the tempo read at double.
for (const c of [
  { bpm: 65, systole: 0.42, s2Amp: 0.8 },
  { bpm: 85, systole: 0.33, s2Amp: 1.0 },
  { bpm: 100, systole: 0.3, s2Amp: 1.0 },
  { bpm: 55, systole: 0.5, s2Amp: 0.8 },
]) {
  test(`no tempo doubling: ${c.bpm} bpm, S2 at ${(c.systole * c.bpm / 60 * 100).toFixed(0)}% of the cycle`, () => {
    const s = synthHeart({ seconds: 25, noise: 0.03, jitter: 0.03, ...c });
    const r = analyseHeartbeat(s.pcm, s.sampleRate);
    assert.ok(r.ok, r.reason);
    assert.ok(Math.abs(r.bpm / c.bpm - 1) < 0.05, `got ${r.bpm.toFixed(1)}`);
  });
}

test('truly ambiguous rhythm is flagged, and the half override recovers it', () => {
  const s = synthHeart({ seconds: 25, bpm: 45, systole: 60 / 45 / 2, s2Amp: 1, noise: 0.03, jitter: 0.03 });
  const r = analyseHeartbeat(s.pcm, s.sampleRate);
  assert.ok(Math.abs(r.bpm / 45 - 1) < 0.05 || r.tempoAmbiguous, 'wrong tempo must be flagged');
  const f = analyseHeartbeat(s.pcm, s.sampleRate, { tempoFactor: r.bpm > 60 ? 0.5 : 1 });
  assert.ok(Math.abs(f.bpm / 45 - 1) < 0.05, `override gives ${f.bpm.toFixed(1)}`);
});

test('a single NaN sample does not break analysis', () => {
  const s = synthHeart({ seconds: 20, bpm: 72 });
  s.pcm[1000] = NaN;
  s.pcm[5000] = Infinity;
  const r = analyseHeartbeat(s.pcm, s.sampleRate);
  assert.ok(r.ok, r.reason);
  assert.ok(Math.abs(r.bpm - 72) < 3);
});

test('analysis is scale-invariant and ignores DC offset and polarity', () => {
  const s = synthHeart({ seconds: 20, bpm: 72 });
  for (const f of [(v) => v * 1e-5, (v) => v * 40, (v) => v + 0.5, (v) => -v]) {
    const r = analyseHeartbeat(s.pcm.map(f), s.sampleRate);
    assert.ok(r.ok && Math.abs(r.bpm - 72) < 3);
  }
});

test('a looped bounce reads the heart rate, not the loop length', () => {
  // Four beats at 124 BPM, then that exact two-second clip repeated (as a DAW bounce would be).
  const one = synthHeart({ seconds: 60 / 124 * 4 + 0.4, bpm: 124, systole: 0.2, jitter: 0.04, noise: 0.03, lead: 0.05 });
  const clipLen = Math.round((60 / 124) * 4 * 4000);
  const x = new Float32Array(clipLen * 20);
  for (let r = 0; r < 20; r++) x.set(one.pcm.subarray(0, clipLen), r * clipLen);
  const res = analyseHeartbeat(x, 4000);
  assert.ok(res.ok, res.reason);
  assert.ok(Math.abs(res.bpm - 124) < 10 || (Math.abs(res.bpm - 62) < 2 && res.tempoAmbiguous), `got ${res.bpm.toFixed(1)}`);
  assert.ok(res.bpm > 45, 'never the loop length');
});

test('a genuinely slow heart (45 BPM) is still read as slow', () => {
  const s = synthHeart({ seconds: 40, bpm: 45, systole: 0.38 });
  const r = analyseHeartbeat(s.pcm, 4000);
  assert.ok(Math.abs(r.bpm - 45) < 2, `got ${r.bpm.toFixed(1)}`);
  const slow = synthHeart({ seconds: 60, bpm: 36, systole: 0.4 });
  const r2 = analyseHeartbeat(slow.pcm, 4000);
  assert.ok(Math.abs(r2.bpm - 36) < 2, `36 BPM read as ${r2.bpm.toFixed(1)}`);
});

test('two stretches of heartbeat separated by silence are both tracked', () => {
  const a = synthHeart({ seconds: 14, bpm: 74, noise: 0.02, seed: 4 });
  const b = synthHeart({ seconds: 14, bpm: 74, noise: 0.02, seed: 5 });
  const gap = 4000 * 5;
  const x = new Float32Array(a.pcm.length + gap + b.pcm.length);
  x.set(a.pcm, 0);
  for (let i = 0; i < gap; i++) x[a.pcm.length + i] = 0.002 * Math.sin(i); // near-silence
  x.set(b.pcm, a.pcm.length + gap);
  const r = analyseHeartbeat(x, 4000);
  assert.ok(r.ok, r.reason);
  const total = a.s1.length + b.s1.length;
  assert.ok(r.beats.length >= total - 2 && r.beats.length <= total + 1, `beats ${r.beats.length} of ${total}`);
  const inSecond = r.beats.filter((bt) => bt.s1 > 19).length;
  assert.ok(inSecond >= b.s1.length - 1, `second stretch has ${inSecond} beats`);
  assert.ok(Math.abs(r.bpm - 74) < 2);
  assert.ok(r.coverage > 0.9, `coverage ${r.coverage}`);
  assert.equal(r.anchorMethod, 'timing');
});

test('stray noises away from the heartbeat do not become beats', () => {
  const s = synthHeart({ seconds: 12, bpm: 72, noise: 0.01 });
  const x = new Float32Array(4000 * 22);
  x.set(s.pcm, 0);
  for (const t of [15.0, 17.3]) for (let i = 0; i < 300; i++) x[Math.round(t * 4000) + i] += 0.8 * Math.sin(i / 5) * Math.exp(-i / 80);
  const r = analyseHeartbeat(x, 4000);
  assert.equal(r.beats.filter((b) => b.s1 > 13).length, 0);
});
