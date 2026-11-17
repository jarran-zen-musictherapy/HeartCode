# HeartCode: handover notes

Browser tool (React 19 + Vite 8, Web Audio, Canvas) that turns stethoscope heartbeat recordings into clean, tempo-gridded loops for clinical music therapy. Everything runs locally in the browser; no audio leaves the device. Not a medical device (footer says so).

Live: https://jarran-zen-musictherapy.github.io/HeartCode/ (GitHub Actions: lint, test, build, deploy on push to main).

## Commands
- `npm install`, `npm run dev`, `npm test` (node --test, ~70 tests), `npm run lint`, `npm run build`
- Single-file offline build: `vite.standalone.config.js` -> `standalone/HeartCode.html` (ignored by git)

## Pipeline
load (src/audio/wav.js, engine.js) -> detect (src/analysis/detect.js) -> process (src/process/*) -> loop (src/analysis/gridwarp.js or manualloop.js) -> export (src/export/*)

Chain order (src/process/render.js): resample -> hum notch -> spectral noise removal -> (beat averaging) -> noise gate -> EQ -> grid/loop -> gain -> look-ahead limiter (last). Drawn EQ curve = applied curve (causal biquads).

## Key decisions
- Own WAV parser keeps true sample rate (4 kHz Littmann/Eko files). decodeAudioData is only a fallback because it resamples.
- Only the first 300 s are loaded (MAX_SECONDS); WAV is read partially via wavLayout.
- Detector: decimate to ~2 kHz, 25-150 Hz band, low/high envelopes, multiband autocorrelation tempo (sub-multiple step-down, `tempoAmbiguous` flag), beat tracker per stretch (trackAll), S1 chosen by timing (short gap follows S1) with loudness tie-break, per-stretch orientation, onset walk-back and outlier correction.
- Grid warp is slice-and-place, not time-stretch: S1 onset sits on the grid, S2 keeps its natural offset, only the gap changes. 5 ms crossfades, exact loop length.
- Manual loops: snapLoop (beat starts minus 20 ms pre-roll, waveform-match fine tune), seamLoop (12 ms crossfade), seamReport.
- MP3 cannot loop seamlessly (UI says so); WAV 16/24 is the loop format. 4 kHz -> 44.1 kHz for MP3. lamejs is LGPL-3.0 (README notes it). Repo has no licence yet.

- Analysis and rendering run in a worker (src/worker/: client.js talks to hc.worker.js; handler.js is the shared job code and the main-thread fallback). The worker is imported with `?worker&inline` so the single-file build works from file://. Render requests quote `analysis.id`; stale ones are refused.
- Beat averaging (src/process/average.js) aligns and averages S1 and S2 separately, then the loop is built from repeats of that one beat. Spectral noise removal (src/process/denoise.js) learns its noise print from the gaps between beats.
- Tempo check (checkTempo in detect.js): a "second sound" under 0.15 s after S1 is not S2; with one sound per beat, alternating loudness or gaps suggests Half. Suggestion only, never auto-applied.
- Batch (BatchPanel.jsx + 'batch' job): cleanest 16 beats per file, zip with loops, beat CSVs and summary.csv.

## Known weak spots
- Tempo halving/doubling on faint or irregular recordings. Half/Auto/Double override exists; PT004 (128 vs 64 BPM) and Jan (122 vs 61 BPM) need true reference rates; the sounds themselves (even spacing, no alternation) point to the faster reading for both.
- Irregular/dying rhythms: whole-file analysis is poor; use selection analysis and manual loops.
- One tempo per recording. MP3 encoding still runs on the main thread.
- Averaging and noise removal are verified on synthetic audio only. Tempo ramp not built. MIDI is off for manual loops.

## Untested
- Safari/iPad, real iPhone screen-recording import, and any listening judgement of EQ presets, gate or seam smoothness (verified by measurement only, never by ear).

## Gotchas
- ESLint react-hooks is strict: no ref access during render; keep hooks above use (a hook-order bug hit GridPanel once).
- Test fixtures come from test/synth.js.
- Ethics/governance flags: TGA medical-device framing, CALHN patient-data rules, IP ownership, stethoscope-app terms of service.
