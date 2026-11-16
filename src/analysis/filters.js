// Small DSP toolkit: pure functions on typed arrays, no browser APIs,
// so everything here runs (and is tested) in Node as well as the browser.

/** RBJ cookbook biquad coefficients, normalised so a0 = 1. */
export function biquad(type, fs, f0, Q = Math.SQRT1_2) {
  const w0 = (2 * Math.PI * f0) / fs;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  let b0; let b1; let b2;
  if (type === 'lowpass') {
    b1 = 1 - cos; b0 = b1 / 2; b2 = b0;
  } else if (type === 'highpass') {
    b1 = -(1 + cos); b0 = (1 + cos) / 2; b2 = b0;
  } else if (type === 'notch') {
    b0 = 1; b1 = -2 * cos; b2 = 1;
  } else {
    throw new Error(`Unsupported biquad type: ${type}`);
  }
  const a0 = 1 + alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}

function runBiquad(x, c, reverse) {
  const n = x.length;
  const y = new Float64Array(n);
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  for (let k = 0; k < n; k++) {
    const i = reverse ? n - 1 - k : k;
    const xi = x[i];
    const yi = c.b0 * xi + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
    y[i] = yi;
  }
  return y;
}

/** Zero-phase filtering (forward then backward), so event timing is not shifted. */
export function filtfilt(x, c) {
  return runBiquad(runBiquad(x, c, false), c, true);
}

/** Integer-factor decimation by block averaging. */
export function decimate(x, factor) {
  if (factor <= 1) return Float64Array.from(x);
  const n = Math.floor(x.length / factor);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const base = i * factor;
    for (let j = 0; j < factor; j++) s += x[base + j];
    y[i] = s / factor;
  }
  return y;
}

/** Centred moving average of window length `win` samples. */
export function movingAverage(x, win) {
  const n = x.length;
  const w = Math.max(1, Math.round(win));
  const half = Math.floor(w / 2);
  const y = new Float64Array(n);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + x[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    y[i] = (prefix[b] - prefix[a]) / (b - a);
  }
  return y;
}

export function median(values) {
  if (!values.length) return NaN;
  const s = Array.from(values).sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}
