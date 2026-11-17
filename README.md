# HeartCode

HeartCode is a browser-based audio processing tool that takes digital stethoscope
recordings and turns them into analysed, processed, and rhythmically quantised
audio for clinical music creation. Everything runs in the browser: no recording
is uploaded or stored.

**Use it:** https://jarran-zen-musictherapy.github.io/HeartCode/

**Private by design.** Recordings are processed entirely in your browser. Nothing is
uploaded, stored or sent anywhere.

**Not a medical device.** HeartCode is a tool for making music from heart sounds. Its
heart-rate and variability figures are for musical use only and must not be used for
diagnosis or clinical decisions.

## How to use

1. Get the recording off your stethoscope app. A direct `.wav` export is ideal (Littmann
   CORE via the Eko app exports 4000 Hz mono). A screen recording of the app playing the
   heartbeat also works: HeartCode reads the audio from `.mp4`, `.mov` and `.m4a` files.
   About 30 seconds of a still, quiet recording works best.
2. Load it. Check that the green S1 markers sit on each heartbeat; use *Swap S1 and S2*
   or *Half / Double* if they do not.
3. Set the tempo and loop length, preview with the metronome, then export the loop or
   the individual beats.

## Run it

```
npm install
npm run dev      # local development
npm test         # analysis tests (Node, no browser needed)
npm run build    # static site in dist/ (published by .github/workflows/deploy.yml)
npm run build:standalone  # one HTML file that opens by double-click
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
* `src/analysis/cleanup.js` detects 50/60 Hz mains hum and removes it with narrow
  notch filters (for the analysis always, for the export when Clean-up is on), and
  provides the rumble and hiss cuts.
* `src/process/` is the tone and level chain applied to previews and exports: EQ
  (low cut, low shelf, two bells, high shelf, high cut), then gain, then a look-ahead
  brickwall limiter as the last stage. Meters follow ITU-R BS.1770 (integrated LUFS
  with gating, true peak). The EQ runs as ordinary causal filters, so the curve on
  screen is exactly what is applied.
* `src/process/noise.js` is the noise reduction (a smooth gate that turns down the gaps
  between heart sounds, set from each recording's own levels) and the per-beat
  cleanliness score used by the "cleanest beats" loop options.
* `src/export/` writes 24-bit WAV files, a plain zip for the one-shots, MP3 (via lamejs, LGPL-3.0), a MIDI file
  (S1 on C1 on every beat, S2 on D1 at its natural offset) and a beat-by-beat CSV.

## Development phases

* **Phase 1 (done):** core engine: file loader, waveform, transport, spectrum.
* **Phase 2 (done):** analysis: S1/S2 detection, BPM, beat-interval variability.
* **Phase 3 (done):** tone and level: parametric EQ with a before/after spectrum, gain,
  look-ahead limiter, true-peak and LUFS meters.
* **Phase 4 (done):** grid warp: each heartbeat placed on a tempo grid.
* **Phase 5 (done):** export: loop as WAV, one-shot slices as a zip.

## Known limitations

* Analysis and resampling run on the main thread. A 10-minute 44.1 kHz recording
  freezes the page for about 2 s while analysing; resampling a 10-minute file to a
  different rate takes about 6 s. Typical stethoscope clips (under a minute) are instant.
* One tempo per recording: if the heart rate changes sharply mid-file, the median is reported.
* Stereo files are mixed to mono as (L+R)/2; only the first two channels are read.
* When S1 and S2 are equally spaced the tempo is ambiguous: the app flags it and offers Half/Double.

## Third-party code

MP3 export uses [@breezystack/lamejs](https://www.npmjs.com/package/@breezystack/lamejs)
(a JavaScript port of LAME), licensed under LGPL-3.0.
