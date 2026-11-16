# HeartCode

HeartCode is a browser-based audio processing tool that takes digital stethoscope
recordings and turns them into analysed, processed, and rhythmically quantised
audio for clinical music creation. Everything runs in the browser: no recording
is uploaded or stored.

## Run it

```
npm install
npm run dev      # local development
npm test         # analysis tests (Node, no browser needed)
npm run build    # static site in dist/, ready for GitHub Pages
```

## Tech stack

* **Framework:** React 19 (via Vite)
* **Audio engine:** native Web Audio API for playback
* **Analysis:** plain JavaScript modules in `src/analysis/`, independent of the browser
* **Visuals:** HTML5 Canvas (2D context)

## How the pieces fit

* `src/audio/wav.js` reads WAV files directly, so the true sample rate
  (4000 Hz for a Littmann CORE) and the original samples are kept. The browser's
  own decoder resamples everything and is only the fallback (e.g. for MP3).
* `src/audio/engine.js` owns playback and hands the raw samples to the analysis.
* `src/analysis/detect.js` finds the heart sounds:
  band-limited envelope, tempo by autocorrelation, beat tracking, then S1/S2
  labelling. S1 is the sound followed by the shorter gap (systole is shorter than
  diastole); loudness is only the tie-breaker. S1 is the grid anchor.
* `src/analysis/gridwarp.js` builds the loop by slice-and-place, not
  time-stretching: each beat is cut out whole and its S1 onset placed on the
  grid; only the quiet gap before the next beat is shortened or extended. S2
  keeps its natural distance from S1. The loop length is exact and the seam is
  crossfaded, so it loops cleanly in a DAW.
* `src/analysis/resample.js` converts to the export rate (44.1 kHz by default)
  with a windowed-sinc filter. Upsampling a 4 kHz recording adds no detail above
  2 kHz; it only makes the file usable in a DAW.
* `src/export/` writes 24-bit WAV files and a plain zip for the one-shots.

## Development phases

* **Phase 1 (done):** core engine: file loader, waveform, transport, spectrum.
* **Phase 2 (done):** analysis: S1/S2 detection, BPM, beat-interval variability.
* **Phase 3:** processing: parametric EQ, compressor.
* **Phase 4 (done):** grid warp: each heartbeat placed on a tempo grid.
* **Phase 5 (done):** export: loop as WAV, one-shot slices as a zip.

## Known limitations

* Analysis and resampling run on the main thread. A 10-minute 44.1 kHz recording
  freezes the page for about 2 s while analysing; resampling a 10-minute file to a
  different rate takes about 6 s. Typical stethoscope clips (under a minute) are instant.
* One tempo per recording: if the heart rate changes sharply mid-file, the median is reported.
* Mains hum (50 Hz) inside the heart band can hide beats; it is flagged as low confidence
  rather than filtered, because S1 energy lives at the same frequency.
* Stereo files are mixed to mono as (L+R)/2; only the first two channels are read.
* When S1 and S2 are equally spaced the tempo is ambiguous: the app flags it and offers Half/Double.
