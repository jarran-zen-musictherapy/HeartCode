// Sample-rate conversion with a Kaiser-windowed sinc filter.
// Written out here (rather than using the browser's resampler) so an export
// is bit-identical on every machine and can be tested in Node.

const TABLE_RES = 256; // kernel table entries per input sample
const KAISER_BETA = 9; // ~90 dB stop-band

function besselI0(x) {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 40; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

/**
 * @param {Float32Array|Float64Array} x input samples
 * @param {number} inRate
 * @param {number} outRate
 * @param {number} [zeros=32] sinc zero-crossings each side (quality)
 * @returns {Float32Array}
 */
export function resample(x, inRate, outRate, zeros = 32) {
  if (inRate === outRate) return Float32Array.from(x);
  const ratio = outRate / inRate;
  // Cut-off as a fraction of the input Nyquist: just under the lower of the two rates.
  const fc = Math.min(1, ratio) * 0.92;
  const halfWidth = zeros / fc; // kernel half-width, in input samples

  const tableLen = Math.ceil(halfWidth * TABLE_RES) + 2;
  const table = new Float64Array(tableLen);
  const i0b = besselI0(KAISER_BETA);
  for (let k = 0; k < tableLen; k++) {
    const d = k / TABLE_RES;
    if (d >= halfWidth) { table[k] = 0; continue; }
    const arg = Math.PI * fc * d;
    const sinc = d === 0 ? 1 : Math.sin(arg) / arg;
    const r = d / halfWidth;
    table[k] = fc * sinc * (besselI0(KAISER_BETA * Math.sqrt(1 - r * r)) / i0b);
  }

  const n = x.length;
  const outLen = Math.round(n * ratio);
  const y = new Float32Array(outLen);
  for (let m = 0; m < outLen; m++) {
    const t = m / ratio;
    const first = Math.max(0, Math.ceil(t - halfWidth));
    const last = Math.min(n - 1, Math.floor(t + halfWidth));
    let acc = 0;
    for (let i = first; i <= last; i++) {
      const pos = Math.abs(t - i) * TABLE_RES;
      const k = pos | 0;
      const frac = pos - k;
      acc += x[i] * (table[k] + (table[k + 1] - table[k]) * frac);
    }
    y[m] = acc;
  }
  return y;
}
