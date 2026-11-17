import { useState } from 'react';
import { decodePcm } from '../audio/engine.js';
import { batchOne } from '../worker/client.js';
import { EQ_PRESETS } from '../process/eq.js';
import { encodeWav } from '../export/wavEncode.js';
import { makeZip } from '../export/zip.js';
import { beatsCsv } from '../export/csv.js';
import { summaryCsv } from '../export/summary.js';

const ACCEPT = '.wav,.mp3,.m4a,.aac,.mp4,.mov,.aif,.aiff,.flac,.ogg,audio/*,video/mp4,video/quicktime';

/** Many recordings in, one zip out: a loop and a beat table for each, plus a summary sheet. */
export default function BatchPanel() {
  const [progress, setProgress] = useState(null); // { done, total, name }
  const [result, setResult] = useState(null); // { ok, failed }

  async function run(fileList) {
    const files = Array.from(fileList);
    if (!files.length || progress) return;
    setResult(null);
    const settings = {
      outRate: 44100, removeHum: true, denoise: 'off', noise: 'off', average: false,
      eq: EQ_PRESETS.gentle.make(), nudge: 0, selection: null,
      autoGain: true, gainDb: 0, limiterOn: true, ceilingDb: -1,
    };
    const enc = new TextEncoder();
    const out = [];
    const items = [];
    const taken = new Set();
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setProgress({ done: i, total: files.length, name: file.name });
      // Two files may share a name (different folders); keep both.
      let stem = file.name.replace(/\.[^.]+$/, '').replace(/[^\w.\- ]+/g, '_') || 'recording';
      for (let k = 2; taken.has(stem); k++) stem = `${stem.replace(/_\d+$/, '')}_${k}`;
      taken.add(stem);
      try {
        const { pcm, sampleRate } = await decodePcm(file);
        const r = await batchOne(pcm, sampleRate, settings);
        const item = { name: file.name, analysis: r.analysis, loop: r.loop };
        if (r.analysis.ok) out.push({ name: `${stem}_beats.csv`, data: enc.encode(beatsCsv(r.analysis)) });
        if (r.loop) {
          item.loopFile = `${stem}_${r.loop.bpm}bpm_${r.loop.beats}beats.wav`;
          out.push({ name: item.loopFile, data: encodeWav(r.loop.samples, r.loop.sampleRate, 24) });
        }
        items.push(item);
      } catch (err) {
        console.error('Batch: could not process', file.name, err);
        items.push({ name: file.name, error: 'Could not read audio from this file' });
      }
    }
    out.unshift({ name: 'summary.csv', data: enc.encode(summaryCsv(items)) });
    const url = URL.createObjectURL(new Blob([makeZip(out)], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'heartcode_batch.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const ok = items.filter((it) => it.loop).length;
    setProgress(null);
    setResult({ ok, failed: items.length - ok });
  }

  return (
    <details className="batch-panel">
      <summary>Batch: process many recordings at once</summary>
      <p className="note">
        Choose several recordings. Each one is analysed and turned into a loop at its own heart rate with the
        standard settings (the cleanest 16 beats, or fewer in whole bars of 4; gentle rumble cut, 44.1 kHz 24-bit WAV, peak at −1 dB). You get
        one zip with every loop, a beat table per recording, and a summary sheet. Nothing is uploaded.
        Recordings the tempo check is unsure about are marked in the summary: check those by hand.
      </p>
      <input
        type="file" multiple accept={ACCEPT} disabled={Boolean(progress)} aria-label="Recordings for batch processing"
        onChange={(e) => { const input = e.target; run(input.files).finally(() => { input.value = ''; }); }}
      />
      {progress && (
        <p className="loading-text">
          Working on {progress.done + 1} of {progress.total}: {progress.name}
        </p>
      )}
      {result && (
        <p className="note">
          Done: {result.ok} {result.ok === 1 ? 'loop' : 'loops'} made
          {result.failed > 0 ? `, ${result.failed} could not be looped (see summary.csv for why)` : ''}. The zip is in
          your downloads.
        </p>
      )}
    </details>
  );
}
