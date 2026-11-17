// The whole loop-building chain in one place, free of any browser or React
// code so it can run in a background worker (or directly, in tests).
//
// Order: resample -> hum notch -> spectral noise reduction -> (beat averaging)
// -> gate -> EQ -> grid or hand-picked loop -> gain -> limiter.

import { resample } from '../analysis/resample.js';
import { gridWarp, sliceBeats } from '../analysis/gridwarp.js';
import { seamLoop, seamReport } from '../analysis/manualloop.js';
import { removeHum } from '../analysis/cleanup.js';
import { applyEq } from './eq.js';
import { limit, applyGain, samplePeak, dbToGain, gainToDb } from './dynamics.js';
import { integratedLufs, truePeakDb } from './loudness.js';
import { averageSpectrum } from './spectrum.js';
import { gateCurve, applyCurve, beatCosts, NOISE_LEVELS } from './noise.js';
import { denoise } from './denoise.js';
import { averageBeat, repeatBeat } from './average.js';

/**
 * Settings (`s`) used below:
 *   outRate, humHz (0 = leave hum alone), denoise, noise (keys of the level tables),
 *   average (bool), eq, bpm, count, nudge (seconds), selection ({start,end} or null
 *   for the automatic grid), autoGain, gainDb, limiterOn, ceilingDb
 */
export function createRenderer() {
  let cache = {};
  const reset = () => { cache = { baseKey: '', cleanKey: '', gateKey: '', avgKey: '', costs: null }; };
  reset();

  /** Everything up to (not including) the EQ; cached, since the EQ is what people drag around. */
  function prepare(data, analysis, s) {
    const baseKey = `${s.outRate}|${s.humHz}`;
    if (cache.baseKey !== baseKey) {
      let base = resample(data.pcm, data.sampleRate, s.outRate);
      if (s.humHz) base = Float32Array.from(removeHum(base, s.outRate, s.humHz));
      cache.base = base;
      cache.spectrum = averageSpectrum(base, s.outRate);
      cache.baseKey = baseKey;
    }
    const cleanKey = `${baseKey}|${s.denoise}`;
    if (cache.cleanKey !== cleanKey) {
      cache.clean = denoise(cache.base, s.outRate, s.denoise, analysis.beats);
      cache.cleanKey = cleanKey;
    }
    const gateKey = `${cleanKey}|${s.noise}`;
    if (cache.gateKey !== gateKey) {
      const curve = gateCurve(data.pcm, data.sampleRate, NOISE_LEVELS[s.noise].floorDb, analysis.beats);
      cache.gated = applyCurve(cache.clean, s.outRate, curve);
      cache.gateKey = gateKey;
    }
    if (!cache.costs) cache.costs = beatCosts(data.pcm, data.sampleRate, analysis.beats);
  }

  function finish(warped, before, s) {
    // Level: gain, then the limiter as the last stage so the file never exceeds the ceiling.
    const peak = samplePeak(warped.samples);
    const gain = s.autoGain ? (peak > 0 ? dbToGain(s.ceilingDb) / peak : 1) : dbToGain(s.gainDb);
    const gained = applyGain(warped.samples, gain);
    const limited = s.limiterOn ? limit(gained, s.outRate, s.ceilingDb) : { samples: gained, maxReductionDb: 0 };
    return {
      ...warped,
      samples: limited.samples,
      gain,
      spectrum: cache.spectrum,
      meters: {
        gainDb: gainToDb(gain),
        reductionDb: limited.maxReductionDb,
        pre: { peak: truePeakDb(before.samples), lufs: integratedLufs(before.samples, s.outRate) },
        post: { peak: truePeakDb(limited.samples), lufs: integratedLufs(limited.samples, s.outRate) },
      },
    };
  }

  /** @returns the finished loop, or null when one cannot be built from these settings */
  function render(data, analysis, s) {
    prepare(data, analysis, s);
    const { outRate } = s;
    const beats = analysis.beats;

    if (s.selection) {
      // The hand-picked region, as recorded, with a crossfaded seam.
      const { start, end } = s.selection;
      const samples = seamLoop(applyEq(cache.gated, outRate, s.eq), outRate, start, end);
      if (!samples) return null;
      const report = seamReport(data.pcm, data.sampleRate, beats, start, end);
      const seconds = samples.length / outRate;
      const firstBeat = Math.max(0, beats.findIndex((b) => b.s1Onset >= start - 0.005));
      return finish({
        samples,
        sampleRate: outRate,
        seconds,
        beats: report.beats,
        bpm: report.beats > 0 ? Math.round((report.beats * 600) / seconds) / 10 : 0,
        firstBeat,
        usedBeats: [],
        truncatedS2: 0,
        irregular: 0,
        manual: true,
        report,
      }, { samples: seamLoop(cache.base, outRate, start, end) }, s);
    }

    const opts = { bpm: s.bpm, count: s.count, nudge: s.nudge, costs: cache.costs };
    const before = gridWarp(cache.base, outRate, beats, opts);
    if (!before) return null;

    if (s.average) {
      // One clean beat averaged from the whole recording, repeated on the grid.
      if (cache.avgKey !== cache.cleanKey) {
        cache.avg = averageBeat(cache.clean, outRate, beats);
        cache.avgKey = cache.cleanKey;
      }
      if (cache.avg) {
        const rep = repeatBeat(cache.avg, s.count);
        const curve = gateCurve(rep.pcm, outRate, NOISE_LEVELS[s.noise].floorDb, rep.beats);
        const eqd = applyEq(applyCurve(rep.pcm, outRate, curve), outRate, s.eq);
        const warped = gridWarp(eqd, outRate, rep.beats, { bpm: s.bpm, count: s.count, nudge: s.nudge });
        if (warped) {
          return finish({
            ...warped,
            usedBeats: rep.beats.slice(0, warped.beats),
            averaged: { used: cache.avg.used, total: cache.avg.total },
          }, before, s);
        }
      }
    }

    const warped = gridWarp(applyEq(cache.gated, outRate, s.eq), outRate, beats, opts);
    if (!warped) return null;
    return finish({
      ...warped,
      usedBeats: beats.slice(warped.firstBeat, warped.firstBeat + warped.beats),
      averageFailed: Boolean(s.average),
    }, before, s);
  }

  /** Each heartbeat as its own short file, with the same tone and gain as the loop. */
  function oneShots(data, analysis, s, gain) {
    prepare(data, analysis, s);
    const source = applyEq(cache.gated, s.outRate, s.eq);
    return sliceBeats(source, s.outRate, analysis.beats).map((slice) => {
      const gained = applyGain(slice, gain);
      return s.limiterOn ? limit(gained, s.outRate, s.ceilingDb).samples : gained;
    });
  }

  return { render, oneShots, reset };
}
