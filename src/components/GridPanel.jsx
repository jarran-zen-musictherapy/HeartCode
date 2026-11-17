import { useEffect, useMemo, useRef, useState } from 'react';
import { getAnalysisData, startPreview, stopPreview, onPreviewChange } from '../audio/engine.js';
import { resample } from '../analysis/resample.js';
import { gridWarp, sliceBeats, addClicks } from '../analysis/gridwarp.js';
import { snapLoop, seamLoop, seamReport } from '../analysis/manualloop.js';
import { encodeWav } from '../export/wavEncode.js';
import { makeZip } from '../export/zip.js';
import { makeMidi } from '../export/midi.js';
import { beatsCsv } from '../export/csv.js';
import { removeHum as notchHum } from '../analysis/cleanup.js';
import { applyEq, EQ_PRESETS } from '../process/eq.js';
import { limit, applyGain, samplePeak, dbToGain, gainToDb } from '../process/dynamics.js';
import { integratedLufs, truePeakDb } from '../process/loudness.js';
import { averageSpectrum } from '../process/spectrum.js';
import { gateCurve, applyCurve, beatCosts, NOISE_LEVELS } from '../process/noise.js';
import { encodeMp3, estimateSize, MP3_RATES, MP3_BITRATES } from '../export/mp3.js';
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

export default function GridPanel({
  analysis, fileName, selection, onSelection, onPreviewChange: reportPreview,
}) {
  // The panel also works when no heartbeat was found, for hand-picked loops.
  const autoBpm = analysis.ok ? analysis.bpm : 60;
  const humHz = analysis.hum || 0;
  const usable = Math.max(0, analysis.beats.length - 1);
  const wholeBars = Math.floor(usable / 4) * 4;

  const [bpmText, setBpmText] = useState(() => String(Math.round(autoBpm)));
  const bpmEdited = useRef(false);
  // Follow the analysed tempo (e.g. after Half/Double or Swap) until the user types their own.
  useEffect(() => {
    if (!bpmEdited.current) setBpmText(String(Math.round(autoBpm)));
  }, [autoBpm]);
  const [rate, setRate] = useState('44100');
  const [lengthMode, setLengthMode] = useState(wholeBars >= 4 ? 'bars' : 'all');
  const [eq, setEq] = useState(() => EQ_PRESETS.gentle.make());
  const [removeHum, setRemoveHum] = useState(true);
  const [view, setView] = useState('post');
  const [noise, setNoise] = useState('off');
  const [format, setFormat] = useState('wav');
  const [bitDepth, setBitDepth] = useState(24);
  const [kbpsIndex, setKbpsIndex] = useState(MP3_BITRATES.indexOf(192));
  const [repeatsText, setRepeatsText] = useState('1');
  const [sourceMode, setSourceMode] = useState('manual'); // which loop to use when a selection exists
  const manual = Boolean(selection) && (sourceMode === 'manual' || !analysis.ok);
  const [level, setLevel] = useState({ autoGain: true, gainText: '0', limiterOn: true, ceilingText: '-1' });
  const [nudgeText, setNudgeText] = useState('0');
  const [clicks, setClicks] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [render, setRender] = useState(null);
  const cacheRef = useRef({ key: '', base: null, spectrum: null, gateKey: '', gated: null, costs: null });
  const nudgeMs = Math.max(-100, Math.min(100, Number(nudgeText) || 0));

  const bpm = Number(bpmText);
  const bpmValid = Number.isFinite(bpm) && bpm >= 30 && bpm <= 240;
  const lengthOptions = [];
  if (wholeBars >= 4) lengthOptions.push(['bars', wholeBars, `${wholeBars} beats (whole bars of 4)`]);
  lengthOptions.push(['all', usable, `${usable} beats (all)`]);
  for (const n of [4, 2, 1]) {
    if (n < usable) lengthOptions.push([`best${n}`, n, `Cleanest ${n === 1 ? 'single beat' : `${n} beats`}`]);
  }
  const chosen = lengthOptions.find(([id]) => id === lengthMode) || lengthOptions[0];
  const effectiveMode = chosen[0];
  const count = chosen[1];
  const gainDb = Math.max(-24, Math.min(60, Number(level.gainText) || 0));
  const ceilingDb = Math.max(-12, Math.min(0, Number.isFinite(Number(level.ceilingText)) && level.ceilingText !== '' ? Number(level.ceilingText) : -1));
  const useHum = removeHum && humHz > 0;
  // Everything that changes the rendered audio; a render is current only if its key matches.
  const settingsKey = JSON.stringify([bpmText, count, rate, useHum, nudgeText, eq, level.autoGain, gainDb, level.limiterOn, ceilingDb, noise,
    manual ? [selection.start, selection.end] : null]);
  const [namePrefix, setNamePrefix] = useState(() => fileName.replace(/\.[^.]+$/, ''));
  const base = useMemo(() => namePrefix.trim().replace(/[^\w.\- ]+/g, '_') || 'heartcode', [namePrefix]);

  useEffect(() => onPreviewChange((on) => {
    setPreviewing(on);
    reportPreview(on);
  }), [reportPreview]);

  // Stop any preview when this panel goes away (new file loaded).
  useEffect(() => () => { stopPreview(); reportPreview(false); }, [reportPreview]);

  // Beat scores belong to one analysis; drop them when the markers change.
  useEffect(() => { cacheRef.current.costs = null; cacheRef.current.gateKey = ''; }, [analysis]);

  // Re-render the loop whenever a setting changes (debounced while typing or dragging).
  useEffect(() => {
    stopPreview();
    if (!manual && (!bpmValid || count < 1)) return undefined;
    const id = setTimeout(() => {
      const data = getAnalysisData();
      if (!data) return;
      const outRate = rate === 'native' ? data.sampleRate : Number(rate);
      const cache = cacheRef.current;
      const key = `${outRate}|${useHum ? humHz : 0}`;
      if (cache.key !== key) {
        let base = resample(data.pcm, data.sampleRate, outRate);
        if (useHum) base = Float32Array.from(notchHum(base, outRate, humHz));
        cache.base = base;
        cache.spectrum = averageSpectrum(base, outRate);
        cache.key = key;
      }
      // Noise reduction: turn the gaps between heart sounds down.
      const gateKey = `${key}|${noise}`;
      if (cache.gateKey !== gateKey) {
        const curve = gateCurve(data.pcm, data.sampleRate, NOISE_LEVELS[noise].floorDb, analysis.beats);
        cache.gated = applyCurve(cache.base, outRate, curve);
        cache.gateKey = gateKey;
      }
      if (!cache.costs) cache.costs = beatCosts(data.pcm, data.sampleRate, analysis.beats);
      const opts = { bpm, count, nudge: nudgeMs / 1000, costs: cache.costs };
      const eqd = applyEq(cache.gated, outRate, eq);
      let warped;
      let before;
      if (manual) {
        // The hand-picked region, as recorded, with a crossfaded seam.
        const samples = seamLoop(eqd, outRate, selection.start, selection.end);
        if (!samples) { setRender(null); return; }
        const report = seamReport(data.pcm, data.sampleRate, analysis.beats, selection.start, selection.end);
        const seconds = samples.length / outRate;
        warped = {
          samples,
          sampleRate: outRate,
          seconds,
          beats: report.beats,
          bpm: report.beats > 0 ? Math.round((report.beats * 600) / seconds) / 10 : 0,
          firstBeat: Math.max(0, analysis.beats.findIndex((b) => b.s1Onset >= selection.start - 0.005)),
          truncatedS2: 0,
          irregular: 0,
          manual: true,
          report,
        };
        before = { samples: seamLoop(cache.base, outRate, selection.start, selection.end) };
      } else {
        warped = gridWarp(eqd, outRate, analysis.beats, opts);
        if (!warped) { setRender(null); return; }
        before = gridWarp(cache.base, outRate, analysis.beats, opts);
      }

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

  const fresh = Boolean(render) && (manual || bpmValid) && render.key === settingsKey;

  function togglePreview() {
    if (previewing) { stopPreview(); return; }
    const s = clicks ? addClicks(render.samples, render.sampleRate, render.bpm) : render.samples;
    startPreview(s, render.sampleRate);
  }

  const repeats = Math.max(1, Math.min(500, Math.round(Number(repeatsText)) || 1));
  const kbps = MP3_BITRATES[kbpsIndex];
  // MP3 only exists at certain sample rates; a 4 kHz export is converted to 44.1 kHz.
  const mp3Rate = render && MP3_RATES.includes(render.sampleRate) ? render.sampleRate : 44100;
  const exportSeconds = render ? render.seconds * repeats : 0;
  const sizeBytes = render
    ? estimateSize(format, exportSeconds, { sampleRate: render.sampleRate, bitDepth, kbps })
    : 0;
  const sizeText = sizeBytes >= 1048576 ? `${(sizeBytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
  const tooLong = exportSeconds > 3600;

  function exportLoop() {
    let out = render.samples;
    if (repeats > 1) {
      out = new Float32Array(render.samples.length * repeats);
      for (let r = 0; r < repeats; r++) out.set(render.samples, r * render.samples.length);
    }
    const name = render.manual
      ? `${base}_manual_${(render.seconds * repeats).toFixed(1)}s`
      : `${base}_${render.bpm}bpm_${render.beats * repeats}beats`;
    if (format === 'mp3') {
      const src = mp3Rate === render.sampleRate ? out : resample(out, render.sampleRate, mp3Rate);
      download(encodeMp3(src, mp3Rate, kbps), `${name}.mp3`, 'audio/mpeg');
    } else {
      download(encodeWav(out, render.sampleRate, bitDepth), `${name}.wav`, 'audio/wav');
    }
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

  function snapSelection() {
    const data = getAnalysisData();
    if (!data || !selection) return;
    const s = snapLoop(data.pcm, data.sampleRate, analysis.beats, selection.start, selection.end);
    onSelection({ start: s.start, end: s.end });
  }

  const stretch = bpmValid ? bpm / autoBpm : 1;

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
        hum={humHz}
        removeHum={removeHum}
        onRemoveHum={setRemoveHum}
        noise={noise}
        onNoise={setNoise}
      />
    <div className="grid-panel">
      <h3 className="section-label">Grid &amp; Export</h3>
      {selection ? (
        <div className="manual-loop">
          <div className="controls">
            <label>
              Loop from
              <select value={manual ? 'manual' : 'auto'} onChange={(e) => setSourceMode(e.target.value)} disabled={!analysis.ok}>
                <option value="manual">Your selection on the waveform</option>
                <option value="auto">Automatic: beats on a tempo grid</option>
              </select>
            </label>
            {manual && <button onClick={snapSelection}>Snap to a perfect loop</button>}
          </div>
          {manual && fresh && (
            <>
              <p className="note">
                Your selection: {selection.start.toFixed(3)} s to {selection.end.toFixed(3)} s ({render.seconds.toFixed(3)} s long)
                {render.beats > 0 ? `, ${render.beats} ${render.beats === 1 ? 'heartbeat' : 'heartbeats'}, about ${render.bpm} BPM as recorded` : ''}.
                It plays at its recorded speed; tempo, loop length and nudge apply only to the automatic grid.
              </p>
              {render.report.smooth ? (
                <p className="note seam-ok">
                  Seam check: loops smoothly
                  {render.report.wholeBeats ? ', on whole heartbeats' : ''} (match {(render.report.match * 100).toFixed(0)}%
                  {render.report.quiet ? ', cuts in a quiet spot' : ''}).
                </p>
              ) : (
                <p className="error-text">
                  Seam check: this will probably bump or click where it repeats
                  {render.report.quiet ? '' : ' (a cut lands on a heart sound)'}. Press Snap to a perfect loop.
                </p>
              )}
              {render.report.smooth && !render.report.wholeBeats && analysis.ok && (
                <p className="note">
                  The ends are not on heartbeat starts, so the rhythm may stumble at the repeat. Snap fixes that.
                </p>
              )}
            </>
          )}
        </div>
      ) : (
        <p className="note">
          Want to choose the loop yourself? Turn on Select loop above the waveform and drag across the part you want.
        </p>
      )}
      <div className="controls">
        <label>
          Tempo (BPM)
          <input
            type="number" min="30" max="240" step="0.1" value={bpmText} disabled={manual}
            onChange={(e) => { bpmEdited.current = true; setBpmText(e.target.value); }}
          />
        </label>
        <label>
          Loop length
          <select value={effectiveMode} onChange={(e) => setLengthMode(e.target.value)} disabled={manual}>
            {lengthOptions.map(([id, , label]) => <option key={id} value={id}>{label}</option>)}
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
            type="number" min="-100" max="100" step="1" value={nudgeText} disabled={manual}
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

      {!manual && !bpmValid && <p className="error-text">Enter a tempo between 30 and 240 BPM.</p>}
      {fresh && !manual && (
        <p className="note">
          {render.beats} {render.beats === 1 ? 'heartbeat' : 'heartbeats'}, one per beat at {render.bpm} BPM: {render.seconds.toFixed(3)} s loop,
          {' '}{(render.sampleRate / 1000).toFixed(1)} kHz mono. Each S1 sits on the grid; S2 keeps its
          natural timing.
        </p>
      )}
      {fresh && !manual && (stretch > 1.25 || stretch < 0.7) && (
        <p className="note">
          This tempo is far from the recorded {autoBpm.toFixed(0)} BPM, so the gaps between beats are
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

      <div className="controls export-format">
        <label>
          Loop file format
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="wav">WAV (lossless, loops seamlessly)</option>
            <option value="mp3">MP3 (smaller, for listening)</option>
          </select>
        </label>
        {format === 'wav' ? (
          <label>
            Quality
            <select value={bitDepth} onChange={(e) => setBitDepth(Number(e.target.value))}>
              <option value={24}>24-bit (best)</option>
              <option value={16}>16-bit (smaller)</option>
            </select>
          </label>
        ) : (
          <label>
            Quality: {kbps} kbps
            <input
              type="range" min="0" max={MP3_BITRATES.length - 1} step="1" value={kbpsIndex}
              onChange={(e) => setKbpsIndex(Number(e.target.value))}
            />
          </label>
        )}
        <label title="Play the loop this many times in the exported file">
          Repeats
          <input type="number" min="1" max="500" step="1" value={repeatsText} onChange={(e) => setRepeatsText(e.target.value)} />
        </label>
        {fresh && (
          <span className="size-estimate">
            About {sizeText}, {exportSeconds >= 60 ? `${Math.floor(exportSeconds / 60)} min ${Math.round(exportSeconds % 60)} s` : `${exportSeconds.toFixed(1)} s`}
          </span>
        )}
      </div>
      {format === 'mp3' && (
        <p className="note">
          MP3 files do not loop perfectly: the format adds a sliver of silence at the start and end, so a
          looped MP3 clicks or gaps. Use WAV for anything you will loop, and MP3 for listening copies (set
          Repeats to make it longer).
          {fresh && mp3Rate !== render.sampleRate ? ` MP3 cannot store ${(render.sampleRate / 1000).toFixed(0)} kHz audio, so this export is converted to 44.1 kHz.` : ''}
        </p>
      )}
      {tooLong && <p className="error-text">That is over an hour of audio. Lower Repeats to export.</p>}

      <div className="actions">
        <button onClick={togglePreview} disabled={!fresh}>
          {previewing ? 'Stop preview' : 'Preview loop'}
        </button>
        <button onClick={exportLoop} disabled={!fresh || tooLong}>Export loop (.{format})</button>
        <button onClick={exportOneShots} disabled={!fresh || usable < 1}>Export one-shots (.zip)</button>
        <button onClick={exportMidi} disabled={!fresh || manual} title={manual ? 'MIDI is for the automatic grid' : undefined}>Export MIDI (.mid)</button>
        <button onClick={exportCsv} disabled={!analysis.ok}>Export beat data (.csv)</button>
      </div>
    </div>
    </>
  );
}
