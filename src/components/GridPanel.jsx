import { useEffect, useMemo, useRef, useState } from 'react';
import { getAnalysisData, startPreview, stopPreview, onPreviewChange } from '../audio/engine.js';
import { resample } from '../analysis/resample.js';
import { gridWarp, sliceBeats, normaliseGain, addClicks } from '../analysis/gridwarp.js';
import { encodeWav } from '../export/wavEncode.js';
import { makeZip } from '../export/zip.js';

function download(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function scaled(samples, gain) {
  if (gain === 1) return samples;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
  return out;
}

export default function GridPanel({ analysis, fileName, onPreviewChange: reportPreview }) {
  const usable = analysis.beats.length - 1;
  const wholeBars = Math.floor(usable / 4) * 4;

  const [bpmText, setBpmText] = useState(() => String(Math.round(analysis.bpm)));
  const bpmEdited = useRef(false);
  // Follow the analysed tempo (e.g. after Half/Double or Swap) until the user types their own.
  useEffect(() => {
    if (!bpmEdited.current) setBpmText(String(Math.round(analysis.bpm)));
  }, [analysis.bpm]);
  const [rate, setRate] = useState('44100');
  const [lengthMode, setLengthMode] = useState(wholeBars >= 4 ? 'bars' : 'all');
  const [normalise, setNormalise] = useState(true);
  const [clicks, setClicks] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [render, setRender] = useState(null);
  const resampledRef = useRef({ rate: 0, samples: null });

  const bpm = Number(bpmText);
  const bpmValid = Number.isFinite(bpm) && bpm >= 30 && bpm <= 240;
  const effectiveMode = lengthMode === 'bars' && wholeBars >= 4 ? 'bars' : 'all';
  const count = effectiveMode === 'bars' ? wholeBars : usable;
  const [namePrefix, setNamePrefix] = useState(() => fileName.replace(/\.[^.]+$/, ''));
  const base = useMemo(() => namePrefix.trim().replace(/[^\w.\- ]+/g, '_') || 'heartcode', [namePrefix]);

  useEffect(() => onPreviewChange((on) => {
    setPreviewing(on);
    reportPreview(on);
  }), [reportPreview]);

  // Stop any preview when this panel goes away (new file loaded).
  useEffect(() => () => { stopPreview(); reportPreview(false); }, [reportPreview]);

  // Re-render the loop whenever a setting changes (debounced while typing).
  useEffect(() => {
    stopPreview();
    if (!bpmValid || count < 1) return undefined;
    const id = setTimeout(() => {
      const data = getAnalysisData();
      if (!data) return;
      const outRate = rate === 'native' ? data.sampleRate : Number(rate);
      const cache = resampledRef.current;
      if (cache.rate !== outRate) {
        cache.samples = resample(data.pcm, data.sampleRate, outRate);
        cache.rate = outRate;
      }
      const warped = gridWarp(cache.samples, outRate, analysis.beats, { bpm, count });
      setRender(warped ? { ...warped, source: cache.samples } : null);
    }, 200);
    return () => clearTimeout(id);
  }, [analysis, bpm, bpmValid, count, rate]);

  // Compare by value so a stale render (settings just changed) disables the buttons.
  const fresh = Boolean(render) && bpmValid && render.bpm === bpm && render.beats === count
    && (rate === 'native' || render.sampleRate === Number(rate));

  function togglePreview() {
    if (previewing) { stopPreview(); return; }
    const gain = normalise ? normaliseGain([render.samples]) : 1;
    let s = scaled(render.samples, gain);
    if (clicks) s = addClicks(s, render.sampleRate, render.bpm);
    startPreview(s, render.sampleRate);
  }

  function exportLoop() {
    const gain = normalise ? normaliseGain([render.samples]) : 1;
    const wav = encodeWav(scaled(render.samples, gain), render.sampleRate, 24);
    download(wav, `${base}_${render.bpm}bpm_${render.beats}beats.wav`, 'audio/wav');
  }

  function exportOneShots() {
    const slices = sliceBeats(render.source, render.sampleRate, analysis.beats);
    const gain = normalise ? normaliseGain(slices) : 1; // one gain for all, so relative loudness is kept
    const files = slices.map((s, i) => ({
      name: `${base}_beat${String(i + 1).padStart(2, '0')}.wav`,
      data: encodeWav(scaled(s, gain), render.sampleRate, 24),
    }));
    download(makeZip(files), `${base}_oneshots.zip`, 'application/zip');
  }

  const stretch = bpmValid ? bpm / analysis.bpm : 1;

  return (
    <div className="grid-panel">
      <h3 className="section-label">Grid &amp; Export</h3>
      <div className="controls">
        <label>
          Tempo (BPM)
          <input
            type="number" min="30" max="240" step="0.1" value={bpmText}
            onChange={(e) => { bpmEdited.current = true; setBpmText(e.target.value); }}
          />
        </label>
        <label>
          Loop length
          <select value={effectiveMode} onChange={(e) => setLengthMode(e.target.value)}>
            {wholeBars >= 4 && <option value="bars">{wholeBars} beats (whole bars of 4)</option>}
            <option value="all">{usable} beats (all)</option>
          </select>
        </label>
        <label>
          Sample rate
          <select value={rate} onChange={(e) => setRate(e.target.value)}>
            <option value="44100">44.1 kHz</option>
            <option value="48000">48 kHz</option>
            <option value="native">Same as recording</option>
          </select>
        </label>
        <label>
          Export file name
          <input type="text" value={namePrefix} onChange={(e) => setNamePrefix(e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={normalise} onChange={(e) => setNormalise(e.target.checked)} />
          Normalise to −1 dB
        </label>
        <label className="check">
          <input type="checkbox" checked={clicks} onChange={(e) => { stopPreview(); setClicks(e.target.checked); }} />
          Metronome in preview
        </label>
      </div>

      {!bpmValid && <p className="error-text">Enter a tempo between 30 and 240 BPM.</p>}
      {fresh && (
        <p className="note">
          {render.beats} heartbeats, one per beat at {render.bpm} BPM: {render.seconds.toFixed(3)} s loop,
          {' '}{(render.sampleRate / 1000).toFixed(1)} kHz, 24-bit mono. Each S1 sits on the grid; S2 keeps its
          natural timing.
        </p>
      )}
      {fresh && (stretch > 1.25 || stretch < 0.7) && (
        <p className="note">
          This tempo is far from the recorded {analysis.bpm.toFixed(0)} BPM, so the gaps between beats are
          {stretch > 1 ? ' cut short' : ' stretched out'} noticeably.
        </p>
      )}
      {fresh && render.truncatedS2 > 0 && (
        <p className="error-text">
          At this tempo {render.truncatedS2} of {render.beats} beats lose part of their second sound (S2).
          Lower the tempo to keep it.
        </p>
      )}

      <div className="actions">
        <button onClick={togglePreview} disabled={!fresh}>
          {previewing ? 'Stop preview' : 'Preview loop'}
        </button>
        <button onClick={exportLoop} disabled={!fresh}>Export loop (.wav)</button>
        <button onClick={exportOneShots} disabled={!fresh}>Export one-shots (.zip)</button>
      </div>
    </div>
  );
}
