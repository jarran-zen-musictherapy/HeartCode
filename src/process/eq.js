// Parametric EQ: low cut, low shelf, two bells, high shelf, high cut.
// Runs as ordinary causal biquads, so the curve drawn on screen is exactly
// what is applied to the audio.

import { biquad, applyBiquad, biquadGainDb } from '../analysis/filters.js';

const BUTTERWORTH_4 = [0.5412, 1.3066]; // Q pair for a 24 dB/octave cut

export const EQ_LIMITS = { minHz: 10, maxHz: 5000, maxGain: 18, minQ: 0.3, maxQ: 8 };

export function flatEq() {
  return {
    lowCut: { on: false, freq: 20 },
    bands: [
      { type: 'lowshelf', freq: 60, gain: 0, q: 0.707 },
      { type: 'peaking', freq: 120, gain: 0, q: 1 },
      { type: 'peaking', freq: 300, gain: 0, q: 1 },
      { type: 'highshelf', freq: 800, gain: 0, q: 0.707 },
    ],
    highCut: { on: false, freq: 1000 },
  };
}

function preset(change) {
  const eq = flatEq();
  change(eq);
  return eq;
}

// Starting points, not prescriptions: adjust by ear.
export const EQ_PRESETS = {
  flat: { label: 'Flat (no EQ)', make: () => flatEq() },
  gentle: {
    label: 'Gentle: cut rumble below 20 Hz',
    make: () => preset((eq) => { eq.lowCut.on = true; }),
  },
  rumble: {
    label: 'Rumble cut: remove below 40 Hz',
    make: () => preset((eq) => { eq.lowCut = { on: true, freq: 40 }; }),
  },
  heart: {
    label: 'Heart band: 25-400 Hz only',
    make: () => preset((eq) => {
      eq.lowCut = { on: true, freq: 25 };
      eq.highCut = { on: true, freq: 400 };
    }),
  },
  smallSpeakers: {
    label: 'Small speakers: lift 100-300 Hz',
    make: () => preset((eq) => {
      eq.lowCut = { on: true, freq: 30 };
      eq.bands[1] = { type: 'peaking', freq: 150, gain: 6, q: 0.9 };
      eq.bands[2] = { type: 'peaking', freq: 300, gain: 4, q: 1 };
    }),
  },
};

/** Biquad sections for an EQ setting at a given sample rate (inactive stages are skipped). */
export function eqSections(eq, fs) {
  const top = 0.45 * fs;
  const out = [];
  if (eq.lowCut.on && eq.lowCut.freq < top) {
    for (const q of BUTTERWORTH_4) out.push(biquad('highpass', fs, eq.lowCut.freq, q));
  }
  for (const b of eq.bands) {
    if (b.gain !== 0 && b.freq < top) out.push(biquad(b.type, fs, b.freq, b.q, b.gain));
  }
  if (eq.highCut.on && eq.highCut.freq < top) {
    for (const q of BUTTERWORTH_4) out.push(biquad('lowpass', fs, eq.highCut.freq, q));
  }
  return out;
}

/** Apply the EQ. Returns the input array itself when the EQ is flat. */
export function applyEq(x, fs, eq) {
  const sections = eqSections(eq, fs);
  if (!sections.length) return x;
  let y = x;
  for (const c of sections) y = applyBiquad(y, c);
  return Float32Array.from(y);
}

/** Combined EQ gain in dB at each of the given frequencies. */
export function eqResponseDb(eq, fs, freqs) {
  const sections = eqSections(eq, fs);
  return freqs.map((f) => (f >= fs / 2 ? -120 : sections.reduce((sum, c) => sum + biquadGainDb(c, fs, f), 0)));
}
