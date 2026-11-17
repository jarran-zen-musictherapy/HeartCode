// The heavy jobs (analysis and loop rendering), written as plain message
// handling so the same code runs inside a worker or, if workers are not
// available, directly on the page.

import { analyseHeartbeat, analyseHeartbeatRange } from '../analysis/detect.js';
import { createRenderer } from '../process/render.js';

export function createHandler() {
  let data = null;
  let analysis = null;
  let analysisId = 0;
  const renderer = createRenderer();

  return function handle(msg) {
    switch (msg.type) {
      case 'audio':
        data = { pcm: msg.pcm, sampleRate: msg.sampleRate };
        analysis = null;
        renderer.reset();
        return true;
      case 'analyse': {
        if (!data) return null;
        const r = msg.range
          ? analyseHeartbeatRange(data.pcm, data.sampleRate, msg.range.start, msg.range.end, msg.opts)
          : analyseHeartbeat(data.pcm, data.sampleRate, msg.opts);
        analysisId += 1;
        analysis = { ...r, id: analysisId };
        renderer.reset();
        return analysis;
      }
      case 'render':
        // A render for markers that have since been replaced is of no use to anyone.
        if (!data || !analysis || msg.analysisId !== analysis.id) return { stale: true };
        return { loop: renderer.render(data, analysis, msg.settings) };
      case 'oneShots':
        if (!data || !analysis || msg.analysisId !== analysis.id) return [];
        return renderer.oneShots(data, analysis, msg.settings, msg.gain);
      case 'batch': {
        // One whole recording, start to finish, without disturbing the one on screen.
        const d = { pcm: msg.pcm, sampleRate: msg.sampleRate };
        const a = analyseHeartbeat(d.pcm, d.sampleRate, {});
        if (!a.ok) return { analysis: a, loop: null };
        const usable = a.beats.length - 1;
        // Whole bars of 4 where possible, 16 beats at most: the cleanest stretch is chosen.
        const count = usable >= 4 ? Math.min(16, Math.floor(usable / 4) * 4) : usable;
        const settings = { ...msg.settings, humHz: msg.settings.removeHum ? a.hum || 0 : 0, bpm: Math.round(a.bpm), count };
        return { analysis: a, loop: count >= 1 ? createRenderer().render(d, a, settings) : null };
      }
      default:
        throw new Error(`Unknown job: ${msg.type}`);
    }
  };
}
