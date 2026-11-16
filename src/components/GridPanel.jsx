import { useEffect, useMemo, useRef, useState } from 'react';
import { getAnalysisData, startPreview, stopPreview, onPreviewChange } from '../audio/engine.js';
import { resample } from '../analysis/resample.js';
import { gridWarp, sliceBeats, addClicks } from '../analysis/gridwarp.js';
import { encodeWav } from '../export/wavEncode.js';
import { makeZip } from '../export/zip.js';
import { makeMidi } from '../export/midi.js';
import { beatsCsv } from '../export/csv.js';
import { removeHum as notchHum } from '../analysis/cleanup.js';
import { applyEq, EQ_PRESETS } from '../process/eq.js';
import { limit, applyGain, samplePeak, dbToGain, gainToDb } from '../process/dynamics.js';
import { integratedLufs, truePeakDb } from '../process/loudness.js';
import { averageSpectrum } from '../process/spectrum.js';
import TonePanel from './TonePanel.jsx';
import { median } from '../analysis/filters.js';

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
  const [eq, setEq] = useState(() => EQ_PRESETS.gentle.make());
  const [removeHum, setRemoveHum] = useState(true);
  const [view, setView] = useState('post');
  const [level, setLevel] = useState({ autoGain: true, gainText: '0', limiterOn: true, ceilingText: '-1' });
  const [nudgeText, setNudgeText] = useState('0');
  const [clicks, setClicks] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [render, setRender] = useState(null);
  const cacheRef = useRef({ key: '', base: null, spectrum: null });
  const nudgeMs = Math.max(-100, Math.min(100, Number(nudgeText) || 0));

  const bpm = Number(bpmText);
  const bpmValid = Number.isFinite(bpm) && bpm >= 30 && bpm <= 240;
  const effectiveMode = lengthMode === 'bars' && wholeBars >= 4 ? 'bars' : 'all';
  const count = effectiveMode === 'bars' ? wholeBars : usable;
  const gainDb = Math.max(-24, Math.min(60, Number(level.gainText) || 0));
  const ceilingDb = Math.max(-12, Math.min(0, Number.isFinite(Number(level.ceilingText)) && level.ceilingText !== '' ? Number(level.ceilingText) : -1));
  const useHum = removeHum && analysis.hum > 0;
  // Everything that changes the rendered audio; a render is current only if its key matches.
  const settingsKey = JSON.stringify([bpmText, count, rate, useHum, nudgeText, eq, level.autoGain, gainDb, level.limiterOn, ceilingDb]);
  const [namePrefix, setNamePrefix] = useState(() => fileName.replace(/\.[^.]+$/, ''));
  const base = useMemo(() => namePrefix.trim().replace(/[^\w.\- ]+/g, '_') || 'heartcode', [namePrefix]);

  useEffect(() => onPreviewChange((on) => {
    setPreviewing(on);
    reportPreview(on);
  }), [reportPreview]);

  // Stop any preview when this panel goes away (new file loaded).
  useEffect(() => () => { stopPreview(); reportPreview(false); }, [reportPreview]);

  // Re-render the loop whenever a setting changes (debounced while typing or dragging).
  useEffect(() => {
    stopPreview();
    if (!bpmValid || count < 1) return undefined;
    const id = setTimeout(() => {
      const data = getAnalysisData();
      if (!data) return;
      const outRate = rate === 'native' ? data.sampleRate : Number(rate);
      const cache = cacheRef.current;
      const key = `${outRate}|${useHum ? analysis.hum : 0}`;
      if (cache.key !== key) {
        let base = resample(data.pcm, data.sampleRate, outRate);
        if (useHum) base = Float32Array.from(notchHum(base, outRate, analysis.hum));
        cache.base = base;
        cache.spectrum = averageSpectrum(base, outRate);
        cache.key = key;
      }
      const opts = { bpm, count, nudge: nudgeMs / 1000 };
      const eqd = applyEq(cache.base, outRate, eq);
      const warped = gridWarp(eqd, outRate, analysis.beats, opts);
      if (!warped) { setRender(null); return; }
      const before = gridWarp(cache.base, outRate, analysis.beats, opts);

      // Level: gain, then the limiter as the last stage so the file never exceeds the ceiling.
      const peak = samplePeak(warped.samples);
      const gain = level.autoGain ? (peak > 0 ? dbToGain(ceilingDb) / peak : 1) : dbToGain(gainDb);
      const gained = applyGain(warped.samples, gain);
      const limited = level.limiterOn ? limit(gained, outRate, ceilingDb) : { samples: gained, maxReductionDb: 0 };
      setRender({
        ...warped,
        samples: limited.samples,
        source: eqd,
        gain,
        spectrum: cache.spectrum,
        key: settingsKey,
        meters: {
          gainDb: gainToDb(gain),
          reductionDb: limited.maxReductionDb,
          pre: { peak: truePeakDb(before.samples), lufs: integratedLufs(before.samples, outRate) },
          post: { peak: truePeakDb(limited.samples), lufs: integratedLufs(limited.samples, outRate) },
        },
      });
    }, 200);
    return () => clearTimeout(id);
    // settingsKey covers every setting used above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis, settingsKey]);

  const fresh = Boolean(render) && bpmValid && render.key === settingsKey;

  function togglePreview() {
    if (previewing) { stopPreview(); return; }
    const s = clicks ? addClicks(render.samples, render.sampleRate, render.bpm) : render.samples;
    startPreview(s, render.sampleRate);
  }

  function exportLoop() {
    const wav = encodeWav(render.samples, render.sampleRate, 24);
    download(wav, `${base}_${render.bpm}bpm_${render.beats}beats.wav`, 'audio/wav');
  }

  function exportOneShots() {
    // Same tone and gain as the loop; each slice is limited by itself.
    const slices = sliceBeats(render.source, render.sampleRate, analysis.beats);
    const files = slices.map((s, i) => {
      const gained = applyGain(s, render.gain);
      const out = level.limiterOn ? limit(gained, render.sampleRate, ceilingDb).samples : gained;
      return { name: `${base}_beat${String(i + 1).padStart(2, '0')}.wav`, data: encodeWav(out, render.sampleRate, 24) };
    });
    download(makeZip(files), `${base}_oneshots.zip`, 'application/zip');
  }

  function exportMidi() {
    const used = analysis.beats.slice(render.firstBeat, render.firstBeat + render.beats);
    const ref = median(used.map((b) => b.s1Amp)) || 1;
    const midi = makeMidi({
      bpm: render.bpm,
      beats: used.map((b) => ({
        velocity: Math.max(0, Math.min(1, (0.6 * b.s1Amp) / ref)),
        s2Offset: b.s2Onset === null ? null : b.s2Onset - b.s1Onset,
      })),
    });
    download(midi, `${base}_${render.bpm}bpm_${render.beats}beats.mid`, 'audio/midi');
  }

  function exportCsv() {
    download(beatsCsv(analysis), `${base}_beats.csv`, 'text/csv');
  }

  const stretch = bpmValid ? bpm / analysis.bpm : 1;

  return (
    <>
      <TonePanel
        eq={eq}
        onEq={setEq}
        spectrum={render ? render.spectrum : null}
        sampleRate={render ? render.sampleRate : 44100}
        view={view}
        onView={setView}
        level={level}
        onLevel={setLevel}
        meters={fresh ? render.meters : null}
        hum={analysis.hum}
        removeHum={removeHum}
        onRemoveHum={setRemoveHum}
      />
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
        <label title="Shift every heartbeat earlier (negative) or later (positive) against the grid">
          Nudge (ms)
          <input
            type="number" min="-100" max="100" step="1" value={nudgeText}
            onChange={(e) => setNudgeText(e.target.value)}
          />
        </label>
        <label>
          Export file name
          <input type="text" value={namePrefix} onChange={(e) => setNamePrefix(e.target.value)} />
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
      {fresh && render.irregular > 0 && (
        <p className="error-text">
          {render.irregular} of the {render.beats} beats in this loop are much longer or shorter than the rest in
          the recording, which usually means a missed or extra marker. Check the waveform, or try the shorter
          loop length.
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
        <button onClick={exportMidi} disabled={!fresh}>Export MIDI (.mid)</button>
        <button onClick={exportCsv}>Export beat data (.csv)</button>
      </div>
    </div>
    </>
  );
}
