/** Beat-by-beat table of the analysis, for spreadsheets or statistics packages. */
export function beatsCsv(analysis) {
  const f = (v, d = 4) => (v === null || v === undefined ? '' : v.toFixed(d));
  const rows = [['beat', 's1_onset_s', 's1_peak_s', 's2_peak_s', 's1_to_s2_ms', 'interval_to_next_ms']];
  analysis.beats.forEach((b, k) => {
    const next = analysis.beats[k + 1];
    rows.push([
      k + 1,
      f(b.s1Onset),
      f(b.s1),
      f(b.s2),
      b.s2 === null ? '' : f((b.s2 - b.s1) * 1000, 1),
      next ? f((next.s1Onset - b.s1Onset) * 1000, 1) : '',
    ]);
  });
  return `${rows.map((r) => r.join(',')).join('\r\n')}\r\n`;
}
