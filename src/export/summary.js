// One row per recording, for a batch run: the numbers a methods section or a
// spreadsheet needs.

const q = (v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const n = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '' : v.toFixed(d));

export const SUMMARY_COLUMNS = [
  'file', 'status', 'duration_s', 'heart_rate_bpm', 'beats_found', 'regularity_pct', 'beats_found_pct',
  'tempo_uncertain', 's1_to_s2_ms', 'mean_interval_ms', 'sdnn_ms', 'rmssd_ms',
  'loop_file', 'loop_bpm', 'loop_beats', 'loop_seconds',
];

/** @param {{ name: string, error?: string, analysis?: object, loop?: object|null, loopFile?: string }[]} items */
export function summaryCsv(items) {
  const rows = [SUMMARY_COLUMNS];
  for (const it of items) {
    const a = it.analysis;
    if (!a || !a.ok) {
      rows.push([q(it.name), q(it.error || (a && a.reason) || 'No heartbeat found'), a ? n(a.duration, 2) : '',
        ...new Array(SUMMARY_COLUMNS.length - 3).fill('')]);
      continue;
    }
    rows.push([
      q(it.name), 'ok', n(a.duration, 2), n(a.bpm), String(a.beats.length), n(a.regularity * 100, 0), n(a.coverage * 100, 0),
      a.tempoAmbiguous ? 'yes' : 'no',
      a.tempoCheck && a.tempoCheck.s1s2 !== null ? n(a.tempoCheck.s1s2 * 1000, 0) : '',
      a.hrv ? n(a.hrv.meanRR) : '', a.hrv ? n(a.hrv.sdnn) : '', a.hrv ? n(a.hrv.rmssd) : '',
      it.loop ? q(it.loopFile) : '', it.loop ? n(it.loop.bpm, 0) : '', it.loop ? String(it.loop.beats) : '',
      it.loop ? n(it.loop.seconds, 3) : '',
    ]);
  }
  return `${rows.map((r) => r.join(',')).join('\r\n')}\r\n`;
}
