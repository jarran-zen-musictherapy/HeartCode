#!/usr/bin/env node
// CirCor DigiScope validation for HeartCode. Protocol: "HeartCode Validation Protocol (CirCor)".
//
//   node validation/validate.mjs <CirCor folder> --split dev
//   node validation/validate.mjs <CirCor folder> --split test --confirm-locked
//
// The detector under test is the browser's own code (src/analysis/detect.js), run with default options.
// Results are appended to results.jsonl as it goes, so an interrupted run carries on where it stopped.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseWav } from '../src/audio/wav.js';
import { analyseHeartbeat } from '../src/analysis/detect.js';
import { median } from '../src/analysis/filters.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- Locked before any test data is opened (protocol sections 4, 6 and 7) -------------------------
export const CONFIG = {
  splitSeed: 20261117,
  devShare: 0.2, // share of SUBJECTS used for development
  tolerance: 0.100, // s: a marker within this of a reference S1 start is a match
  strictTolerance: 0.060, // s: sensitivity check
  rateTolerance: 0.10, // BPM within 10% of the reference rate
  minRefBeats: 5, // recordings with fewer reference S1 marks are excluded
  warn: { minRegularity: 0.4, minCoverage: 0.8 }, // below these the app shows an irregular-rhythm warning
  bootstrap: 2000,
  thresholds: {
    C1_f1: 0.90, C1_f1_lower: 0.87,
    C2_rateCorrect: 0.85,
    C3_orderCorrect: 0.85,
    C4_silentOctave: 0.02, C4_silentOctave_upper: 0.04,
  },
};

// ---- helpers ---------------------------------------------------------------------------------------
function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function splitSubjects(ids, seed = CONFIG.splitSeed, devShare = CONFIG.devShare) {
  const sorted = [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const r = rng(seed);
  for (let i = sorted.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [sorted[i], sorted[j]] = [sorted[j], sorted[i]]; }
  const nDev = Math.round(devShare * sorted.length);
  return { dev: sorted.slice(0, nDev).sort(), test: sorted.slice(nDev).sort() };
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

export function readTsv(file) {
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3) continue;
    const [s, e, l] = f.map(Number);
    if (Number.isFinite(s) && Number.isFinite(e) && Number.isFinite(l)) rows.push({ start: s, end: e, label: l });
  }
  return rows.sort((a, b) => a.start - b.start);
}

function readMeta(file) {
  const meta = {};
  if (!file || !fs.existsSync(file)) return meta;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^#\s*([^:]+):\s*(.*)$/.exec(line.trim());
    if (m) meta[m[1].trim()] = m[2].trim();
  }
  return meta;
}

/** Greedy one-to-one matching, closest pairs first. */
export function matchMarkers(markers, refs, tol) {
  const pairs = [];
  for (let i = 0; i < markers.length; i++) for (let j = 0; j < refs.length; j++) {
    const d = Math.abs(markers[i] - refs[j]);
    if (d <= tol) pairs.push([d, i, j]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const usedM = new Set(); const usedR = new Set(); const out = [];
  for (const [d, i, j] of pairs) {
    if (usedM.has(i) || usedR.has(j)) continue;
    usedM.add(i); usedR.add(j); out.push({ i, j, err: markers[i] - refs[j], d });
  }
  return { pairs: out, usedM };
}

/** Reference description of one recording from its segmentation rows. */
export function describeReference(rows) {
  const lab = rows.filter((r) => r.label >= 1 && r.label <= 4);
  const region = [];
  for (const r of lab) {
    const last = region[region.length - 1];
    if (last && r.start - last.end < 1e-3) last.end = Math.max(last.end, r.end); else region.push({ start: r.start, end: r.end });
  }
  const s1 = lab.filter((r) => r.label === 1).map((r) => r.start);
  const s2 = lab.filter((r) => r.label === 3).map((r) => r.start);
  const rr = [];
  for (let k = 1; k < s1.length; k++) { const d = s1[k] - s1[k - 1]; if (d > 0.2 && d < 2.0) rr.push(d); }
  return { region, s1, s2, refBpm: rr.length ? 60 / median(rr) : null };
}

/** Score one recording. `analysis` is HeartCode's result; `ref` is describeReference(). */
export function scoreRecording(analysis, ref, cfg = CONFIG) {
  const tol = cfg.tolerance;
  const inside = (t, pad) => ref.region.some((g) => t >= g.start - pad && t <= g.end + pad);
  const strict = (t) => inside(t, 0);
  const row = { nRef: ref.s1.length, refBpm: ref.refBpm, analysed: Boolean(analysis.ok) };
  const markers = analysis.ok ? analysis.beats.map((b) => b.s1Onset).filter((t) => inside(t, tol)) : [];
  const m = matchMarkers(markers, ref.s1, tol);
  const m60 = matchMarkers(markers, ref.s1, cfg.strictTolerance);
  const fp = (mm) => markers.filter((t, i) => !mm.usedM.has(i) && strict(t)).length;
  row.tp = m.pairs.length; row.fp = fp(m); row.nMark = row.tp + row.fp;
  row.tp60 = m60.pairs.length; row.nMark60 = row.tp60 + fp(m60);
  row.errMs = m.pairs.map((p) => p.err * 1000);

  row.bpm = analysis.ok ? analysis.bpm : null;
  const ratio = analysis.ok ? analysis.bpm / ref.refBpm : null;
  const near = (x, target) => x !== null && Math.abs(x / target - 1) <= cfg.rateTolerance;
  row.rateOk = near(ratio, 1);
  row.octave = near(ratio, 0.5) || near(ratio, 2);
  const warned = !analysis.ok || analysis.tempoAmbiguous || analysis.regularity < cfg.warn.minRegularity || analysis.coverage < cfg.warn.minCoverage;
  row.warned = warned;
  row.silentOctave = row.octave && !warned;

  // S1/S2 order: which reference sound is each marker closest to?
  let n1 = 0; let n2 = 0;
  const events = [...ref.s1.map((t) => ({ t, k: 1 })), ...ref.s2.map((t) => ({ t, k: 2 }))];
  for (const t of markers) {
    let best = null;
    for (const e of events) { const d = Math.abs(e.t - t); if (d <= tol && (!best || d < best.d)) best = { d, k: e.k }; }
    if (best) { if (best.k === 1) n1++; else n2++; }
  }
  row.nS1 = n1; row.nS2 = n2; row.orderOk = n1 > n2;
  row.tempoAmbiguous = Boolean(analysis.tempoAmbiguous);
  row.regularity = analysis.ok ? analysis.regularity : null;
  row.coverage = analysis.ok ? analysis.coverage : null;
  row.reason = analysis.ok ? '' : analysis.reason || 'no heartbeat found';
  return row;
}

// ---- pooled metrics and bootstrap ---------------------------------------------------------------------
const zero = () => ({ n: 0, tp: 0, nRef: 0, nMark: 0, tp60: 0, nMark60: 0, rateOk: 0, octave: 0, silent: 0, orderOk: 0 });
function add(acc, r) {
  acc.n++; acc.tp += r.tp; acc.nRef += r.nRef; acc.nMark += r.nMark; acc.tp60 += r.tp60; acc.nMark60 += r.nMark60;
  if (r.rateOk) { acc.rateOk++; if (r.orderOk) acc.orderOk++; }
  if (r.octave) acc.octave++;
  if (r.silentOctave) acc.silent++;
  return acc;
}
function f1(tp, nRef, nMark) { const s = nRef ? tp / nRef : 0; const p = nMark ? tp / nMark : 0; return s + p ? (2 * s * p) / (s + p) : 0; }
export function metrics(a) {
  return {
    n: a.n, sensitivity: a.nRef ? a.tp / a.nRef : 0, precision: a.nMark ? a.tp / a.nMark : 0, f1: f1(a.tp, a.nRef, a.nMark),
    f1_60ms: f1(a.tp60, a.nRef, a.nMark60), rateCorrect: a.n ? a.rateOk / a.n : 0, octave: a.n ? a.octave / a.n : 0,
    silentOctave: a.n ? a.silent / a.n : 0, orderCorrect: a.rateOk ? a.orderOk / a.rateOk : 0, orderN: a.rateOk,
  };
}
export function summarise(rows) { const a = zero(); for (const r of rows) add(a, r); return metrics(a); }

export function bootstrap(rows, B = CONFIG.bootstrap, seed = CONFIG.splitSeed + 1) {
  const bySubject = new Map();
  for (const r of rows) { if (!bySubject.has(r.subject)) bySubject.set(r.subject, zero()); add(bySubject.get(r.subject), r); }
  const subs = [...bySubject.values()];
  const rand = rng(seed);
  const keys = ['f1', 'f1_60ms', 'rateCorrect', 'silentOctave', 'orderCorrect', 'sensitivity', 'precision'];
  const draws = Object.fromEntries(keys.map((k) => [k, []]));
  for (let b = 0; b < B; b++) {
    const a = zero();
    for (let i = 0; i < subs.length; i++) { const s = subs[Math.floor(rand() * subs.length)]; for (const k of Object.keys(a)) a[k] += s[k]; }
    const m = metrics(a);
    for (const k of keys) draws[k].push(m[k]);
  }
  const ci = {};
  for (const k of keys) { const d = draws[k].sort((x, y) => x - y); ci[k] = [d[Math.floor(0.025 * B)], d[Math.min(B - 1, Math.floor(0.975 * B))]]; }
  return ci;
}

export function verdict(m, ci, T = CONFIG.thresholds) {
  return [
    { id: 'C1', claim: 'S1 detection', value: m.f1, ci: ci.f1, rule: `F1 ≥ ${T.C1_f1} and lower bound ≥ ${T.C1_f1_lower}`, pass: m.f1 >= T.C1_f1 && ci.f1[0] >= T.C1_f1_lower },
    { id: 'C2', claim: 'Heart rate', value: m.rateCorrect, ci: ci.rateCorrect, rule: `rate correct ≥ ${T.C2_rateCorrect}`, pass: m.rateCorrect >= T.C2_rateCorrect },
    { id: 'C3', claim: 'S1/S2 order', value: m.orderCorrect, ci: ci.orderCorrect, rule: `order correct ≥ ${T.C3_orderCorrect} (where rate correct)`, pass: m.orderCorrect >= T.C3_orderCorrect },
    { id: 'C4', claim: 'Honest warnings', value: m.silentOctave, ci: ci.silentOctave, rule: `silent half/double ≤ ${T.C4_silentOctave} and upper bound ≤ ${T.C4_silentOctave_upper}`, pass: m.silentOctave <= T.C4_silentOctave && ci.silentOctave[1] <= T.C4_silentOctave_upper },
  ];
}

// ---- reporting ---------------------------------------------------------------------------------------
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const f3 = (x) => x.toFixed(3);

function subgroupTable(title, rows, keyOf) {
  const groups = new Map();
  for (const r of rows) { const k = keyOf(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const lines = [`### ${title}`, '', '| Group | Recordings | S1 F1 | Rate correct | Silent half/double |', '| --- | --- | --- | --- | --- |'];
  for (const k of [...groups.keys()].sort()) { const m = summarise(groups.get(k)); lines.push(`| ${k} | ${m.n} | ${f3(m.f1)} | ${pct(m.rateCorrect)} | ${pct(m.silentOctave)} |`); }
  return lines.join('\n');
}

export function buildReport({ rows, excluded, ctx }) {
  const m = summarise(rows); const ci = bootstrap(rows); const v = verdict(m, ci);
  const errs = rows.flatMap((r) => r.errMs); const abs = errs.map(Math.abs).sort((a, b) => a - b);
  const out = [];
  out.push(`# HeartCode CirCor validation: ${ctx.split} split`, '');
  out.push(`Run ${ctx.when}. Commit \`${ctx.commit}\`${ctx.tag ? ` (tag ${ctx.tag})` : ''}, Node ${ctx.node}. Split seed ${CONFIG.splitSeed}; ${ctx.nSubjects} subjects in this split.`);
  out.push(`${rows.length} recordings scored; ${excluded.length} excluded (fewer than ${CONFIG.minRefBeats} reference S1 marks or no usable segmentation).`, '');
  out.push('## Verdict', '', '| Claim | Result (95% CI) | Rule | Verdict |', '| --- | --- | --- | --- |');
  for (const c of v) out.push(`| ${c.id} ${c.claim} | ${c.id === 'C1' ? f3(c.value) : pct(c.value)} (${c.id === 'C1' ? `${f3(c.ci[0])} to ${f3(c.ci[1])}` : `${pct(c.ci[0])} to ${pct(c.ci[1])}`}) | ${c.rule} | **${c.pass ? 'PASS' : 'FAIL'}** |`);
  out.push('', '## Detail', '');
  out.push(`- S1 sensitivity ${pct(m.sensitivity)}, precision ${pct(m.precision)}, F1 ${f3(m.f1)} at ${CONFIG.tolerance * 1000} ms; F1 ${f3(m.f1_60ms)} at ${CONFIG.strictTolerance * 1000} ms.`);
  out.push(`- Rate correct ${pct(m.rateCorrect)}; half or double ${pct(m.octave)} (of which silent, with no warning: ${pct(m.silentOctave)}).`);
  out.push(`- S1/S2 order correct in ${pct(m.orderCorrect)} of the ${m.orderN} recordings with a correct rate.`);
  if (abs.length) out.push(`- Onset error on matched beats: median ${abs[Math.floor(abs.length / 2)].toFixed(1)} ms, 95th percentile ${abs[Math.floor(0.95 * (abs.length - 1))].toFixed(1)} ms, mean signed ${(errs.reduce((x, y) => x + y, 0) / errs.length).toFixed(1)} ms (positive = HeartCode later than the reference).`);
  out.push(`- Recordings where HeartCode found no heartbeat: ${rows.filter((r) => !r.analysed).length}.`, '');
  out.push('## Subgroups (descriptive, no pass/fail)', '');
  out.push(subgroupTable('Murmur', rows, (r) => r.murmur || 'unknown'), '');
  out.push(subgroupTable('Age category', rows, (r) => r.age || 'unknown'), '');
  out.push(subgroupTable('Location', rows, (r) => r.location || 'unknown'), '');
  out.push(subgroupTable('Campaign', rows, (r) => r.campaign || 'unknown'), '');
  out.push(subgroupTable('Reference heart rate', rows, (r) => (r.refBpm < 80 ? '1. under 80 BPM' : r.refBpm <= 120 ? '2. 80 to 120 BPM' : '3. over 120 BPM')), '');
  out.push('## Method notes', '');
  out.push('- A marker counts if it lies in a labelled stretch, widened by the matching tolerance at each end, so a first beat is not lost to an onset a few milliseconds early. Unmatched markers count as false positives only inside the labelled stretch itself; audio labelled 0 is ignored.');
  out.push('- Reference S1 time is the start of each label-1 row; HeartCode time is its S1 onset marker. Reference rate is 60 / median interval between successive label-1 starts less than 2 s apart.');
  out.push('- Confidence intervals: 95% percentile bootstrap resampling subjects, ' + CONFIG.bootstrap + ' draws.');
  out.push('- Warning = the app would show an irregular-rhythm notice (regularity < ' + CONFIG.warn.minRegularity + ' or coverage < ' + CONFIG.warn.minCoverage + ') or the half/double notice, or found no heartbeat at all.', '');
  if (excluded.length) out.push(`## Excluded recordings (${excluded.length})`, '', excluded.slice(0, 50).map((e) => `- ${e.key}: ${e.why}`).join('\n'), excluded.length > 50 ? `- ...and ${excluded.length - 50} more (see excluded.json)` : '', '');
  return { text: out.join('\n'), verdicts: v, metrics: m, ci };
}

// ---- main --------------------------------------------------------------------------------------------
function sh(cmd) { try { return execSync(cmd, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } }

export async function run(argv) {
  const args = argv.slice(2);
  const dataDir = args.find((a) => !a.startsWith('--'));
  const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
  const split = opt('split');
  if (!dataDir || !['dev', 'test'].includes(split)) { console.error('usage: validate.mjs <CirCor folder> --split dev|test [--limit N] [--out DIR] [--confirm-locked]'); process.exit(2); }
  const limit = opt('limit') ? Number(opt('limit')) : Infinity;
  const outDir = path.resolve(opt('out') || path.join(repo, 'validation-results', split));
  const commit = sh('git rev-parse HEAD'); const dirty = sh('git status --porcelain -- src validation');
  const tag = sh('git describe --tags --exact-match');

  fs.mkdirSync(outDir, { recursive: true });
  const lockFile = path.join(outDir, 'lock.json');
  if (split === 'test') {
    if (!args.includes('--confirm-locked')) { console.error('The test split opens ONCE, on the frozen tool, with the thresholds in CONFIG locked.\nRe-run with --confirm-locked when that is true.'); process.exit(2); }
    if (dirty) { console.error('Refusing: src/ or validation/ has uncommitted changes, so the tool under test is not frozen:\n' + dirty); process.exit(2); }
    if (fs.existsSync(lockFile)) {
      const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (lock.commit !== commit) { console.error(`Refusing: the test split was already opened on commit ${lock.commit}; this is ${commit}.\nChanging the tool after seeing test results spends the test set. Log it as a deviation.`); process.exit(2); }
    } else fs.writeFileSync(lockFile, JSON.stringify({ commit, tag, openedAt: new Date().toISOString(), thresholds: CONFIG.thresholds }, null, 2));
  }

  // Find recordings.
  const files = walk(path.resolve(dataDir));
  const tsvs = files.filter((f) => f.endsWith('.tsv'));
  const metaByDir = new Map(files.filter((f) => /\/\d+\.txt$/.test(f)).map((f) => [f, f]));
  const subjectOf = (f) => path.basename(f).split('_')[0];
  const ids = tsvs.map(subjectOf);
  const sp = splitSubjects(ids);
  const mine = new Set(sp[split]);
  const todo = tsvs.filter((f) => mine.has(subjectOf(f))).sort();
  console.log(`${tsvs.length} segmented recordings from ${new Set(ids).size} subjects; ${split} split = ${mine.size} subjects, ${todo.length} recordings.`);
  if (!todo.length) { console.error('No recordings found. Point this at the folder holding the .wav, .tsv and .txt files.'); process.exit(2); }

  const resFile = path.join(outDir, 'results.jsonl');
  const done = new Set();
  const rows = []; const excluded = [];
  if (fs.existsSync(resFile)) for (const l of fs.readFileSync(resFile, 'utf8').split('\n')) if (l) { const r = JSON.parse(l); done.add(r.key); (r.excluded ? excluded.push({ key: r.key, why: r.why }) : rows.push(r)); }
  let count = 0; const t0 = Date.now();
  for (const tsv of todo) {
    const key = path.relative(path.resolve(dataDir), tsv);
    if (done.has(key)) continue;
    if (count >= limit) break;
    count++;
    const base = path.basename(tsv, '.tsv');
    const [subject, location] = base.split('_');
    let rec;
    try {
      const ref = describeReference(readTsv(tsv));
      const wavFile = tsv.replace(/\.tsv$/, '.wav');
      if (ref.s1.length < CONFIG.minRefBeats || !ref.refBpm) rec = { key, excluded: true, why: `only ${ref.s1.length} reference S1 marks` };
      else if (!fs.existsSync(wavFile)) rec = { key, excluded: true, why: 'no .wav next to the .tsv' };
      else {
        const buf = fs.readFileSync(wavFile);
        const w = parseWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        if (!w) rec = { key, excluded: true, why: 'unreadable .wav' };
        else {
          const meta = readMeta(path.join(path.dirname(tsv), `${subject}.txt`));
          const score = scoreRecording(analyseHeartbeat(w.mono, w.sampleRate, {}), ref);
          rec = { key, subject, location, sampleRate: w.sampleRate, murmur: meta.Murmur, age: meta.Age, campaign: meta.Campaign, ...score };
        }
      }
    } catch (e) { rec = { key, excluded: true, why: `error: ${e.message.slice(0, 80)}` }; }
    fs.appendFileSync(resFile, JSON.stringify(rec) + '\n');
    (rec.excluded ? excluded.push({ key, why: rec.why }) : rows.push(rec));
    if (count % 50 === 0) console.log(`  ${count} done this session, ${rows.length + excluded.length}/${todo.length} overall, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  const remaining = todo.length - rows.length - excluded.length;
  if (remaining > 0) { console.log(`${remaining} recordings still to do. Run the same command again to continue.`); return; }

  const ctx = { split, when: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC', commit: commit.slice(0, 10), tag, node: process.version, nSubjects: mine.size };
  const rep = buildReport({ rows, excluded, ctx });
  fs.writeFileSync(path.join(outDir, 'report.md'), rep.text);
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ ctx, metrics: rep.metrics, ci: rep.ci, verdicts: rep.verdicts }, null, 2));
  fs.writeFileSync(path.join(outDir, 'excluded.json'), JSON.stringify(excluded, null, 2));
  const cols = ['key', 'subject', 'location', 'murmur', 'age', 'campaign', 'sampleRate', 'refBpm', 'bpm', 'nRef', 'tp', 'fp', 'rateOk', 'octave', 'warned', 'silentOctave', 'orderOk', 'tempoAmbiguous', 'regularity', 'coverage', 'reason'];
  fs.writeFileSync(path.join(outDir, 'results.csv'), [cols.join(','), ...rows.map((r) => cols.map((c) => { const v = r[c]; return v === undefined || v === null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v; }).join(','))].join('\n') + '\n');
  console.log('\n' + rep.text.split('## Detail')[0]);
  console.log(`Full report: ${path.join(outDir, 'report.md')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run(process.argv);
