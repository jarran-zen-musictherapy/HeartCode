// Clean-up filters: mains-hum detection and removal, rumble and hiss cuts.
// Used by the analysis (so hum cannot hide beats) and by the export chain.

import { biquad, filtfilt } from './filters.js';

const HUM_Q = 20; // notch about 2.5 Hz wide at 50 Hz: removes the hum, leaves the heart sound

/** Average Hann-windowed power at one frequency, over 2-second segments. */
function tonePower(x, fs, freq) {
  const seg = Math.min(x.length, Math.round(2 * fs));
  if (seg < 16) return 0;
  const w = (2 * Math.PI * freq) / fs;
  let total = 0;
  let count = 0;
  for (let start = 0; start + seg <= x.length; start += seg) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < seg; i++) {
      const v = x[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (seg - 1)));
      re += v * Math.cos(w * i);
      im -= v * Math.sin(w * i);
    }
    total += re * re + im * im;
    count++;
  }
  return count ? total / count : 0;
}

/**
 * Look for mains hum. Heart sounds are broadband, so a narrow spike at exactly
 * 50 or 60 Hz that towers over its neighbours is electrical, not cardiac.
 * @returns {0|50|60} hum frequency, or 0 if none
 */
export function detectHum(x, fs) {
  if (fs < 150) return 0;
  // 40 s is plenty to decide, and keeps this fast on long files.
  const view = x.length > 40 * fs ? x.subarray(0, Math.round(40 * fs)) : x;
  let found = 0;
  let bestRatio = 12; // spike must be this many times its surroundings
  for (const f of [50, 60]) {
    const around = [f - 7, f - 4, f + 4, f + 7].map((g) => tonePower(view, fs, g));
    const floor = around.reduce((a, b) => a + b, 0) / around.length;
    const ratio = floor > 0 ? tonePower(view, fs, f) / floor : 0;
    if (ratio > bestRatio) { bestRatio = ratio; found = f; }
  }
  return found;
}

/** Notch out a hum frequency and its harmonics (zero-phase, so timing is untouched). */
export function removeHum(x, fs, humHz) {
  let y = x;
  for (let h = 1; h <= 4; h++) {
    const f = humHz * h;
    if (f > 0.45 * fs) break;
    y = filtfilt(y, biquad('notch', fs, f, HUM_Q * h));
  }
  return y;
}

export const CLEANUP_MODES = {
  off: { label: 'Off (raw recording)' },
  gentle: { label: 'Gentle: remove hum and rumble', highpass: 20 },
  focused: { label: 'Focused: heart band only (25-400 Hz)', highpass: 25, lowpass: 400 },
};

/**
 * Apply a clean-up mode to audio at any sample rate.
 * @param {Float32Array} x
 * @param {number} fs
 * @param {'off'|'gentle'|'focused'} mode
 * @param {0|50|60} humHz hum to remove (0 = none)
 * @returns {Float32Array}
 */
export function cleanUp(x, fs, mode, humHz = 0) {
  const m = CLEANUP_MODES[mode];
  if (!m || mode === 'off') return x;
  let y = x;
  if (humHz) y = removeHum(y, fs, humHz);
  if (m.highpass) y = filtfilt(y, biquad('highpass', fs, m.highpass));
  if (m.lowpass && m.lowpass < 0.45 * fs) {
    // Two passes of a 2nd-order filter each way: a firm but click-free roll-off.
    y = filtfilt(filtfilt(y, biquad('lowpass', fs, m.lowpass)), biquad('lowpass', fs, m.lowpass));
  }
  return Float32Array.from(y);
}
