import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  splitSubjects, matchMarkers, describeReference, scoreRecording, summarise, bootstrap, verdict, CONFIG,
} from '../validation/validate.mjs';
import { synthHeart } from './synth.js';
import { encodeWav } from '../src/export/wavEncode.js';

const rowsFor = (s1, s2, len) => {
  const rows = [];
  for (let k = 0; k < s1.length; k++) {
    rows.push({ start: s1[k], end: s1[k] + 0.1, label: 1 }, { start: s1[k] + 0.1, end: s2[k], label: 2 });
    rows.push({ start: s2[k], end: s2[k] + 0.08, label: 3 }, { start: s2[k] + 0.08, end: k + 1 < s1.length ? s1[k + 1] : len, label: 4 });
  }
  return rows;
};

test('split: by subject, reproducible, 20/80, no overlap', () => {
  const ids = Array.from({ length: 500 }, (_, i) => String(10000 + i * 7));
  const a = splitSubjects([...ids, ...ids]); const b = splitSubjects([...ids].reverse());
  assert.deepEqual(a, b);
  assert.equal(a.dev.length, 100); assert.equal(a.test.length, 400);
  assert.equal(new Set([...a.dev, ...a.test]).size, 500);
  assert.notDeepEqual(splitSubjects(ids, 1).dev, a.dev);
});

test('matching is one-to-one, closest first, within tolerance', () => {
  const m = matchMarkers([1.00, 1.05, 3.0], [1.04, 2.0], 0.1);
  assert.equal(m.pairs.length, 1);
  assert.equal(m.pairs[0].i, 1); // 1.05 is closer to 1.04 than 1.00 is
  assert.equal(matchMarkers([1.0], [1.2], 0.1).pairs.length, 0);
});

test('reference: regions, S1/S2 starts and rate come from the labels', () => {
  const s1 = [1, 1.8, 2.6, 3.4, 4.2, 5.0]; const s2 = s1.map((t) => t + 0.3);
  const ref = describeReference(rowsFor(s1, s2, 5.8));
  assert.equal(ref.s1.length, 6); assert.equal(ref.s2.length, 6);
  assert.ok(Math.abs(ref.refBpm - 75) < 0.1);
  assert.equal(ref.region.length, 1);
  // two separately labelled stretches stay separate and a gap between them is not a beat interval
  const two = describeReference([...rowsFor(s1.slice(0, 3), s2.slice(0, 3), 3.4), ...rowsFor(s1.slice(3).map((t) => t + 20), s2.slice(3).map((t) => t + 20), 25.8)]);
  assert.equal(two.region.length, 2);
  assert.ok(Math.abs(two.refBpm - 75) < 0.1);
});

const fakeAnalysis = (beatsAt, bpm, extra = {}) => ({
  ok: true, bpm, beats: beatsAt.map((t) => ({ s1Onset: t })), regularity: 0.8, coverage: 1, tempoAmbiguous: false, ...extra,
});
const REF_S1 = [1, 1.8, 2.6, 3.4, 4.2, 5.0, 5.8]; const REF = describeReference(rowsFor(REF_S1, REF_S1.map((t) => t + 0.3), 6.6));

test('scoring: a perfect detector scores 1, and each failure shows up where it should', () => {
  const perfect = scoreRecording(fakeAnalysis(REF_S1, 75), REF);
  assert.equal(perfect.tp, 7); assert.equal(perfect.fp, 0); assert.ok(perfect.rateOk && perfect.orderOk && !perfect.octave);
  assert.ok(perfect.errMs.every((e) => Math.abs(e) < 1e-6));
  assert.equal(perfect.silentSwap, false);
  // markers on S2 instead: right count, wrong sound
  const onS2 = scoreRecording(fakeAnalysis(REF_S1.map((t) => t + 0.3), 75), REF);
  assert.equal(onS2.tp, 0); assert.equal(onS2.orderOk, false); assert.equal(onS2.nS2, 7);
  assert.equal(onS2.silentSwap, true); // no loudness-fallback notice, so the swap was silent
  assert.equal(scoreRecording(fakeAnalysis(REF_S1.map((t) => t + 0.3), 75, { anchorMethod: 'loudness' }), REF).silentSwap, false);
  // double rate with no warning is a SILENT octave error; with a warning it is not
  const dbl = [...REF_S1, ...REF_S1.map((t) => t + 0.4)].sort((a, b) => a - b);
  const silent = scoreRecording(fakeAnalysis(dbl, 150), REF);
  assert.ok(silent.octave && silent.silentOctave && !silent.rateOk);
  const warned = scoreRecording(fakeAnalysis(dbl, 150, { tempoAmbiguous: true }), REF);
  assert.ok(warned.octave && warned.warned && !warned.silentOctave);
  const lowReg = scoreRecording(fakeAnalysis(dbl, 150, { regularity: 0.2 }), REF);
  assert.ok(!lowReg.silentOctave);
  // half rate
  assert.ok(scoreRecording(fakeAnalysis(REF_S1.filter((_, i) => i % 2 === 0), 37.5), REF).octave);
  // nothing found counts as a miss, and as a warning
  const none = scoreRecording({ ok: false, reason: 'x' }, REF);
  assert.ok(none.tp === 0 && !none.rateOk && none.warned && !none.silentOctave);
  // an extra marker inside the labelled stretch is a false positive; one outside it is ignored
  const extra = scoreRecording(fakeAnalysis([...REF_S1, 2.2, 9.0], 75), REF);
  assert.equal(extra.fp, 1);
  // a marker 40 ms early still counts, even on the first beat, where it lies before the labelled region
  assert.equal(scoreRecording(fakeAnalysis(REF_S1.map((t) => t - 0.04), 75), REF).tp, 7);
});

test('verdicts: thresholds are applied as written', () => {
  const mk = (n, o) => Array.from({ length: n }, (_, i) => ({ subject: String(i % 40), tp: 90, nRef: 100, nMark: 100, tp60: 80, nMark60: 100, rateOk: true, octave: false, silentOctave: false, orderOk: true, ...o(i) }));
  const good = mk(200, () => ({}));
  const m = summarise(good); const v = verdict(m, bootstrap(good, 200));
  assert.ok(Math.abs(m.f1 - 0.9) < 1e-9);
  assert.equal(v.find((c) => c.id === 'C1').pass, true); // F1 0.90 exactly meets the rule
  const low = mk(200, () => ({ tp: 89 })); // F1 0.89
  assert.equal(verdict(summarise(low), bootstrap(low, 200)).find((c) => c.id === 'C1').pass, false);
  assert.ok(v.filter((c) => c.id !== 'C1').every((c) => c.pass));
  const bad = mk(200, (i) => ({ rateOk: i % 3 !== 0, octave: i % 3 === 0, silentOctave: i % 3 === 0 }));
  const vb = verdict(summarise(bad), bootstrap(bad, 200));
  assert.equal(vb.find((c) => c.id === 'C2').pass, false);
  assert.equal(vb.find((c) => c.id === 'C4').pass, false);
});

test('end to end on a fake CirCor folder: honest labels score high, shifted labels score low', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'circor-'));
  const data = path.join(dir, 'training_data'); fs.mkdirSync(data);
  const truth = {};
  for (let s = 0; s < 14; s++) {
    const id = String(50000 + s);
    for (const loc of ['AV', 'PV']) {
      const h = synthHeart({ sampleRate: 4000, seconds: 16, bpm: 70 + s * 3, seed: s * 2 + (loc === 'AV' ? 1 : 2), noise: 0.03 });
      const shift = s % 7 === 6 ? 0.35 : 0; // two subjects get labels deliberately shifted off the real beats
      fs.writeFileSync(path.join(data, `${id}_${loc}.wav`), Buffer.from(encodeWav(h.pcm, 4000, 16)));
      const s1 = h.s1.map((t) => t + shift);
      fs.writeFileSync(path.join(data, `${id}_${loc}.tsv`), rowsFor(s1, s1.map((t) => t + 0.32), 15.9).map((r) => `${r.start.toFixed(3)}\t${r.end.toFixed(3)}\t${r.label}`).join('\n') + '\n');
    }
    fs.writeFileSync(path.join(data, `${id}.txt`), `${id} 2 4000\n#Age: Child\n#Murmur: ${s % 2 ? 'Present' : 'Absent'}\n#Campaign: CC2014\n`);
    truth[id] = s % 7 === 6;
  }
  const out = path.join(dir, 'out');
  const run = (split, extra = []) => execFileSync('node', ['validation/validate.mjs', dir, '--split', split, '--out', path.join(out, split), ...extra], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  const log = run('dev');
  assert.match(log, /Verdict/);
  const sumDev = JSON.parse(fs.readFileSync(path.join(out, 'dev', 'summary.json'), 'utf8'));
  assert.ok(fs.existsSync(path.join(out, 'dev', 'report.md')) && fs.existsSync(path.join(out, 'dev', 'results.csv')));
  const rows = fs.readFileSync(path.join(out, 'dev', 'results.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const honest = rows.filter((r) => !truth[r.subject]); const shifted = rows.filter((r) => truth[r.subject]);
  assert.ok(honest.length > 0);
  assert.ok(summarise(honest).f1 > 0.9, `honest F1 ${summarise(honest).f1}`);
  if (shifted.length) assert.ok(summarise(shifted).f1 < 0.3, `shifted F1 ${summarise(shifted).f1}`);
  assert.equal(typeof sumDev.metrics.f1, 'number');
  // resuming does nothing new; the test split refuses to open without the confirmation flag
  assert.match(run('dev'), /split = /);
  assert.throws(() => run('test'), /ONCE/);
});
