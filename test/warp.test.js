import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resample } from '../src/analysis/resample.js';
import { gridWarp, sliceBeats, chooseBeats, normaliseGain } from '../src/analysis/gridwarp.js';
import { analyseHeartbeat } from '../src/analysis/detect.js';
import { median } from '../src/analysis/filters.js';
import { encodeWav } from '../src/export/wavEncode.js';
import { parseWav } from '../src/audio/wav.js';
import { crc32, makeZip } from '../src/export/zip.js';
import { synthHeart } from './synth.js';
import { makeMidi } from '../src/export/midi.js';
import { beatsCsv } from '../src/export/csv.js';
import { cleanUp, detectHum } from '../src/analysis/cleanup.js';

test('resampler: 4 kHz -> 44.1 kHz keeps a 100 Hz tone accurate to better than -70 dB', () => {
  const n = 8000;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 100 * i) / 4000);
  const y = resample(x, 4000, 44100);
  assert.equal(y.length, 88200);
  let err = 0;
  let sig = 0;
  for (let m = 4410; m < y.length - 4410; m++) { // ignore the edges
    const ideal = 0.5 * Math.sin((2 * Math.PI * 100 * m) / 44100);
    err += (y[m] - ideal) ** 2;
    sig += ideal ** 2;
  }
  const db = 10 * Math.log10(err / sig);
  assert.ok(db < -70, `error ${db.toFixed(1)} dB`);
});

test('resampler: downsampling removes content above the new Nyquist', () => {
  const n = 44100;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * 3000 * i) / 44100); // above 2 kHz
  const y = resample(x, 44100, 4000);
  let peak = 0;
  for (let m = 200; m < y.length - 200; m++) peak = Math.max(peak, Math.abs(y[m]));
  assert.ok(peak < 0.001, `leak ${peak}`);
});

function warpAndCheck({ srcBpm, targetBpm, rate, jitter = 0.03 }) {
  const s = synthHeart({ seconds: 20, bpm: srcBpm, jitter, sampleRate: 4000 });
  const a = analyseHeartbeat(s.pcm, 4000);
  const x = resample(s.pcm, 4000, rate);
  const w = gridWarp(x, rate, a.beats, { bpm: targetBpm, count: 8 });
  assert.equal(w.beats, 8);
  assert.equal(w.samples.length, Math.round(8 * (60 / targetBpm) * rate), 'exact loop length');

  // Repeat the loop so the analysis also crosses the seam, then re-detect.
  const reps = 4;
  const long = new Float32Array(w.samples.length * reps);
  for (let r = 0; r < reps; r++) long.set(w.samples, r * w.samples.length);
  const b = analyseHeartbeat(long, rate);
  assert.ok(b.ok, b.reason);
  assert.ok(Math.abs(b.bpm - targetBpm) < 0.3, `bpm ${b.bpm.toFixed(2)} vs ${targetBpm}`);
  assert.ok(b.beats.length >= 8 * reps - 2, `beats ${b.beats.length}`);
  const grid = 60 / targetBpm;
  const dev = b.beats.map((bt) => {
    const ph = bt.s1Onset / grid;
    return (ph - Math.round(ph)) * grid;
  });
  const off = median(dev);
  const worst = Math.max(...dev.map((d) => Math.abs(d - off)));
  assert.ok(worst < 0.003, `worst grid error ${(worst * 1000).toFixed(2)} ms`);
  assert.ok(Math.abs(off) < 0.004, `S1 onset sits on the grid (offset ${(off * 1000).toFixed(2)} ms)`);

  // No clicks: the loop (including its seam) never jumps more than the source does.
  let srcStep = 0;
  for (let i = 1; i < x.length; i++) srcStep = Math.max(srcStep, Math.abs(x[i] - x[i - 1]));
  let outStep = Math.abs(w.samples[0] - w.samples[w.samples.length - 1]);
  for (let i = 1; i < w.samples.length; i++) outStep = Math.max(outStep, Math.abs(w.samples[i] - w.samples[i - 1]));
  assert.ok(outStep <= srcStep * 1.5, `step ${outStep} vs source ${srcStep}`);
  return w;
}

test('grid warp: 72 bpm source onto an 80 bpm grid (beats shortened)', () => {
  warpAndCheck({ srcBpm: 72, targetBpm: 80, rate: 44100 });
});
test('grid warp: 72 bpm source onto a 60 bpm grid (gaps extended)', () => {
  warpAndCheck({ srcBpm: 72, targetBpm: 60, rate: 44100 });
});
test('grid warp: irregular source, non-integer samples per beat, 48 kHz', () => {
  warpAndCheck({ srcBpm: 77, targetBpm: 77, rate: 48000, jitter: 0.08 });
});
test('grid warp at the native 4 kHz rate', () => {
  warpAndCheck({ srcBpm: 66, targetBpm: 70, rate: 4000 });
});

test('chooseBeats never asks for more beats than exist', () => {
  const beats = [0, 1, 2, 3].map((t) => ({ s1Onset: t }));
  assert.deepEqual(chooseBeats(beats, 8), { start: 0, count: 3 });
  assert.equal(chooseBeats([{ s1Onset: 0 }], 4).count, 0);
});

test('one-shots: one slice per complete beat, faded to zero at both ends', () => {
  const s = synthHeart({ seconds: 10, bpm: 72 });
  const a = analyseHeartbeat(s.pcm, 4000);
  const slices = sliceBeats(s.pcm, 4000, a.beats);
  assert.equal(slices.length, a.beats.length - 1);
  for (const sl of slices) {
    assert.ok(Math.abs(sl[0]) < 0.02 && Math.abs(sl[sl.length - 1]) < 0.02);
  }
  assert.ok(normaliseGain(slices) > 0);
});

test('WAV encode -> parse round trip (16 and 24 bit)', () => {
  const x = new Float32Array(1000);
  for (let i = 0; i < x.length; i++) x[i] = 0.8 * Math.sin(i / 7);
  for (const bits of [16, 24]) {
    const w = parseWav(encodeWav(x, 44100, bits));
    assert.equal(w.sampleRate, 44100);
    assert.equal(w.bitDepth, bits);
    assert.equal(w.frames, 1000);
    let worst = 0;
    for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(w.mono[i] - x[i]));
    assert.ok(worst < (bits === 16 ? 1e-4 : 1e-6), `error ${worst}`);
  }
});

test('zip: CRC matches the standard check value and sizes add up', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const z = makeZip([{ name: 'a.wav', data: new Uint8Array([1, 2, 3]).buffer }]);
  assert.equal(z.length, 22 + 30 + 5 + 3 + 46 + 5);
});

test('nudge shifts every heartbeat by the requested amount', () => {
  const s = synthHeart({ seconds: 20, bpm: 72 });
  const a = analyseHeartbeat(s.pcm, 4000);
  const x = resample(s.pcm, 4000, 44100);
  const onsets = (nudge) => {
    const w = gridWarp(x, 44100, a.beats, { bpm: 72, count: 8, nudge });
    const long = new Float32Array(w.samples.length * 3);
    for (let r = 0; r < 3; r++) long.set(w.samples, r * w.samples.length);
    const grid = 60 / 72;
    return median(analyseHeartbeat(long, 44100).beats.map((b) => {
      const ph = b.s1Onset / grid;
      return (ph - Math.round(ph)) * grid;
    }));
  };
  const moved = onsets(0.03) - onsets(0);
  assert.ok(Math.abs(moved - 0.03) < 0.002, `moved ${(moved * 1000).toFixed(1)} ms`);
});

test('a beat right at the start of the file still lands on the grid', () => {
  const s = synthHeart({ seconds: 12, bpm: 72, lead: 0.4 });
  const a = analyseHeartbeat(s.pcm, 4000);
  // Pretend the first onset is 5 ms into the file (less than the 20 ms pre-roll).
  const cut = Math.round((a.beats[0].s1Onset - 0.005) * 4000);
  const pcm = s.pcm.subarray(cut);
  const beats = a.beats.map((b) => ({ ...b, s1Onset: b.s1Onset - cut / 4000, s1: b.s1 - cut / 4000, s2: b.s2 === null ? null : b.s2 - cut / 4000 }));
  const w = gridWarp(pcm, 4000, beats, { bpm: 72, count: beats.length - 1 });
  const long = new Float32Array(w.samples.length * 3);
  for (let r = 0; r < 3; r++) long.set(w.samples, r * w.samples.length);
  const grid = 60 / 72;
  const dev = analyseHeartbeat(long, 4000).beats.map((b) => {
    const ph = b.s1Onset / grid;
    return (ph - Math.round(ph)) * grid;
  });
  const off = median(dev);
  assert.ok(Math.max(...dev.map((d) => Math.abs(d - off))) < 0.003, 'all beats share one grid offset');
});

test('irregular source beats are counted', () => {
  const beats = [0, 1, 2, 4, 5, 6].map((t) => ({ s1Onset: t + 0.5, s1: t + 0.55, s2: null, s2Onset: null }));
  const w = gridWarp(new Float32Array(4000 * 8), 4000, beats, { bpm: 60, count: 5 });
  assert.equal(w.irregular, 1);
});

test('mains hum: detected, does not hide beats, and clean-up removes it', () => {
  const s = synthHeart({ seconds: 30, bpm: 72, noise: 0.03 });
  const humPower = (x) => {
    let re = 0; let im = 0;
    for (let i = 0; i < x.length; i++) { re += x[i] * Math.cos((2 * Math.PI * 50 * i) / 4000); im += x[i] * Math.sin((2 * Math.PI * 50 * i) / 4000); }
    return Math.hypot(re, im) / x.length;
  };
  const dirty = s.pcm.map((v, i) => v + 0.5 * Math.sin((2 * Math.PI * 50 * i) / 4000));
  assert.equal(detectHum(s.pcm, 4000), 0, 'no false alarm on a clean recording');
  assert.equal(detectHum(dirty, 4000), 50);
  const r = analyseHeartbeat(dirty, 4000);
  assert.equal(r.hum, 50);
  assert.ok(r.beats.length >= 34 && Math.abs(r.bpm - 72) < 1, `beats ${r.beats.length}`);
  const cleaned = cleanUp(dirty, 4000, 'gentle', 50);
  assert.ok(humPower(cleaned) < 0.02 * humPower(dirty), 'hum reduced by more than 34 dB');
  assert.equal(cleanUp(dirty, 4000, 'off', 50), dirty, 'off leaves the audio untouched');
});

test('clean-up keeps the heart sounds: beats and timing unchanged', () => {
  const s = synthHeart({ seconds: 20, bpm: 72 });
  const a = analyseHeartbeat(s.pcm, 4000);
  for (const mode of ['gentle', 'focused']) {
    const b = analyseHeartbeat(cleanUp(s.pcm, 4000, mode, 0), 4000);
    assert.equal(b.beats.length, a.beats.length);
    const worst = Math.max(...b.beats.map((bt, k) => Math.abs(bt.s1 - a.beats[k].s1)));
    assert.ok(worst < 0.003, `${mode}: peak moved ${(worst * 1000).toFixed(2)} ms`);
  }
});

test('MIDI export: valid header, tempo, one S1 per beat, ends at the loop end', () => {
  const m = makeMidi({ bpm: 75, beats: [0, 1, 2, 3].map(() => ({ velocity: 0.6, s2Offset: 0.3 })) });
  const txt = (o) => String.fromCharCode(...m.slice(o, o + 4));
  assert.equal(txt(0), 'MThd');
  assert.equal(txt(14), 'MTrk');
  assert.equal((m[12] << 8) | m[13], 480);
  const len = (m[18] << 24) | (m[19] << 16) | (m[20] << 8) | m[21];
  assert.equal(m.length, 22 + len);
  assert.equal((m[26] << 16) | (m[27] << 8) | m[28], 800000); // 60e6 / 75
  // Walk the track: count note-ons and total ticks.
  let p = 22; let ticks = 0; let s1 = 0; let s2 = 0;
  while (p < m.length) {
    let d = 0; let byte;
    do { byte = m[p++]; d = (d << 7) | (byte & 0x7f); } while (byte & 0x80);
    ticks += d;
    if (m[p] === 0xff) { p += 3 + m[p + 2]; } else {
      if (m[p] === 0x90 && m[p + 1] === 36) s1++;
      if (m[p] === 0x90 && m[p + 1] === 38) s2++;
      p += 3;
    }
  }
  assert.equal(s1, 4);
  assert.equal(s2, 4);
  assert.equal(ticks, 4 * 480);
});

test('CSV export: header plus one row per beat', () => {
  const s = synthHeart({ seconds: 10, bpm: 72 });
  const a = analyseHeartbeat(s.pcm, 4000);
  const lines = beatsCsv(a).trim().split('\r\n');
  assert.equal(lines.length, a.beats.length + 1);
  assert.equal(lines[0].split(',').length, 6);
  assert.ok(lines[1].startsWith('1,'));
});
