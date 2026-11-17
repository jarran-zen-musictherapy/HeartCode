const METHOD_TEXT = {
  timing: 'S1 chosen by timing: it is the sound followed by the shorter gap.',
  loudness: 'Gaps between sounds are too even to tell S1 from S2, so the louder sound is used as S1.',
  single: 'Only one sound per beat was found, so it is used as the anchor.',
};

function Stat({ label, value, unit }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">
        {value}
        {unit && <span className="stat-unit"> {unit}</span>}
      </span>
    </div>
  );
}

export default function AnalysisPanel({
  analysis, swapAnchor, onSwapAnchor, tempoFactor, onTempoFactor, selection, onAnalyseSelection, onAnalyseAll,
}) {
  // Choose what gets analysed: everything, or just the selected part.
  const range = analysis ? analysis.range : null;
  const scope = (selection || range) ? (
    <div className="tempo-fix">
      {range && (
        <span className="note">
          Analysing only {range.start.toFixed(2)} s to {range.end.toFixed(2)} s.
        </span>
      )}
      {selection && (
        <button className="secondary" onClick={onAnalyseSelection}>
          {range ? 'Re-analyse the current selection' : 'Analyse the selection only'}
        </button>
      )}
      {range && <button className="secondary" onClick={onAnalyseAll}>Analyse the whole recording</button>}
    </div>
  ) : null;

  if (!analysis) {
    return (
      <div className="analysis-panel">
        <h3 className="section-label">Analysis</h3>
        <p className="loading-text">Analysing…</p>
      </div>
    );
  }

  if (!analysis.ok) {
    return (
      <div className="analysis-panel">
        <h3 className="section-label">Analysis</h3>
        <p className="error-text">{analysis.reason}</p>
        {!selection && !range && (
          <p className="note">
            If only part of this recording is heartbeat, select that part on the waveform (Select loop), then
            analyse just the selection.
          </p>
        )}
        {scope}
      </div>
    );
  }

  const {
    bpm, beats, hrv, anchorMethod, s2Found, regularity, coverage, shortRecording, tempoAmbiguous, hum,
  } = analysis;
  const lowConfidence = regularity < 0.4 || coverage < 0.8;

  return (
    <div className="analysis-panel">
      <h3 className="section-label">Analysis</h3>
      <div className="stats">
        <Stat label="Heart rate" value={bpm.toFixed(1)} unit="BPM" />
        <Stat label="Beats found" value={beats.length} />
        {hrv && <Stat label="Mean beat interval" value={hrv.meanRR.toFixed(0)} unit="ms" />}
        {hrv && <Stat label="SDNN" value={hrv.sdnn.toFixed(0)} unit="ms" />}
        {hrv && hrv.rmssd !== null && <Stat label="RMSSD" value={hrv.rmssd.toFixed(0)} unit="ms" />}
        <Stat label="Regularity" value={(regularity * 100).toFixed(0)} unit="%" />
      </div>
      {scope}
      <p className="note">{METHOD_TEXT[anchorMethod]}</p>
      {hum > 0 && (
        <p className="note">{hum} Hz mains hum detected and filtered out before analysis.</p>
      )}
      {shortRecording && hrv && (
        <p className="note">
          Recording is under 30 seconds, so SDNN and RMSSD are indicative only.
        </p>
      )}
      {lowConfidence && (
        <p className="error-text">
          The rhythm here is irregular, or some beats were missed. Check the markers against the waveform
          before relying on these numbers. For an irregular heartbeat, a hand-picked loop keeps the rhythm
          as it really was.
        </p>
      )}
      {(tempoAmbiguous || tempoFactor !== 1) && (
        <p className="error-text">
          The tempo could be read as double or half of {bpm.toFixed(0)} BPM (the two heart sounds are
          nearly identical and evenly spaced). Check the markers: there should be one green line per beat.
        </p>
      )}
      <div className="tempo-fix">
        <span className="note">Tempo wrong?</span>
        {[[0.5, 'Half (÷2)'], [1, 'Auto'], [2, 'Double (×2)']].map(([f, label]) => (
          <button
            key={f}
            className="secondary"
            disabled={tempoFactor === f}
            onClick={() => onTempoFactor(f)}
          >
            {label}
          </button>
        ))}
      </div>
      {s2Found && (
        <button className="secondary" onClick={onSwapAnchor}>
          {swapAnchor ? 'Use automatic S1 choice' : 'Markers on the wrong sound? Swap S1 and S2'}
        </button>
      )}
    </div>
  );
}
