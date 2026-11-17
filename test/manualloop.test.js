import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapLoop, seamLoop, seamReport } from '../src/analysis/manualloop.js';
import { analyseHeartbeat } from '../src/analysis/detect.js';
import { synthHeart } from './synth.js';

const tile = (loop, reps) => {
  const out = new Float32Array(loop.length * reps);
  for (let r = 0; r < reps; r++) out.set(loop, r * loop.length);
  return out;
};

test('snap: a rough selection becomes a whole number of beats', () => {
  const s = synthHeart({ seconds: 20, bpm: 72, noise: 0.03 });
  const a = analyseHeartbeat(s.pcm, 4000);
  // Sloppy hand selection: starts mid-way through beat 3, ends a bit after beat 7.
  const rough = { start: a.beats[3].s1Onset + 0.21, end: a.beats[7].s1Onset + 0.13 };
  const snapped = snapLoop(s.pcm, 4000, a.beats, rough.start, rough.end);
  assert.equal(snapped.method, 'beats');
  assert.equal(snapped.beats, 4);
  assert.ok(Math.abs(snapped.start - (a.beats[3].s1Onset - 0.02)) < 1e-9);
  assert.ok(Math.abs(snapped.end - (a.beats[7].s1Onset - 0.02)) < 0.009);
  const rep = seamReport(s.pcm, 4000, a.beats, snapped.start, snapped.end);
  assert.equal(rep.beats, 4);
  assert.ok(rep.wholeBeats && rep.smooth, JSON.stringify(rep));
});

test('snap: a selection through the middle of heart sounds is flagged, then fixed', () => {
  const s = synthHeart({ seconds: 20, bpm: 72, noise: 0.01 });
  const a = analyseHeartbeat(s.pcm, 4000);
  // Start cuts through an S1, end lands in a quiet gap: a click waiting to happen.
  const bad = { start: a.beats[2].s1 + 0.004, end: a.beats[5].s1 + 0.6 };
  const before = seamReport(s.pcm, 4000, a.beats, bad.start, bad.end);
  assert.equal(before.smooth, false, JSON.stringify(before));
  const fixed = snapLoop(s.pcm, 4000, a.beats, bad.start, bad.end);
  assert.equal(seamReport(s.pcm, 4000, a.beats, fixed.start, fixed.end).smooth, true);
});

test('seam: the looped audio has no jump where it wraps, and keeps its length', () => {
  const s = synthHeart({ seconds: 20, bpm: 72, noise: 0.03, sampleRate: 44100 });
  const a = analyseHeartbeat(s.pcm, 44100);
  const sel = snapLoop(s.pcm, 44100, a.beats, a.beats[2].s1Onset, a.beats[6].s1Onset);
  const loop = seamLoop(s.pcm, 44100, sel.start, sel.end);
  assert.equal(loop.length, Math.round(sel.end * 44100) - Math.round(sel.start * 44100));
  let inner = 0;
  for (let i = 1; i < loop.length; i++) inner = Math.max(inner, Math.abs(loop[i] - loop[i - 1]));
  assert.ok(Math.abs(loop[0] - loop[loop.length - 1]) <= inner, 'wrap step no bigger than any ordinary step');
  // Repeated, it is still a steady heartbeat at the recorded rate.
  const r = analyseHeartbeat(tile(loop, 6), 44100);
  assert.ok(r.ok && Math.abs(r.bpm - 72) < 2.5, `bpm ${r.bpm}`);
  assert.equal(r.beats.length >= 4 * 6 - 2, true);
  const rr = r.rr.map((v) => v * 1000);
  assert.ok(Math.max(...rr) - Math.min(...rr) < 90, 'no stumble at the seam');
});

test('snap without detected beats: the end moves to where the waveform repeats', () => {
  // A plain repeating tone burst pattern, period 0.5 s; no heartbeat analysis given.
  const fs = 4000;
  const x = new Float32Array(fs * 6);
  for (let i = 0; i < x.length; i++) {
    const t = (i / fs) % 0.5;
    x[i] = Math.exp(-t * 14) * Math.sin(2 * Math.PI * 60 * t);
  }
  const snapped = snapLoop(x, fs, null, 1.0, 2.07); // 70 ms too long
  assert.equal(snapped.method, 'waveform');
  assert.equal(snapped.beats, null);
  assert.ok(Math.abs(snapped.end - 2.0) < 0.002, `end ${snapped.end}`);
  assert.equal(seamReport(x, fs, null, snapped.start, snapped.end).smooth, true);
});

test('seamLoop rejects an empty selection', () => {
  assert.equal(seamLoop(new Float32Array(4000), 4000, 1, 1), null);
});
