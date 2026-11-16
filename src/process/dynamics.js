// Gain and a look-ahead brickwall limiter.

export const dbToGain = (db) => 10 ** (db / 20);
export const gainToDb = (g) => (g > 0 ? 20 * Math.log10(g) : -Infinity);

export function applyGain(x, gain) {
  if (gain === 1) return x;
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i] * gain;
  return y;
}

export function samplePeak(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > p) p = a;
  }
  return p;
}

/**
 * Brickwall peak limiter. No output sample exceeds the ceiling; audio already
 * under the ceiling is left untouched. Gain changes are eased in over the
 * look-ahead window and released smoothly, so there are no clicks.
 * @returns {{ samples: Float32Array, maxReductionDb: number }}
 */
export function limit(x, fs, ceilingDb = -1, { lookahead = 0.005, release = 0.08 } = {}) {
  const ceiling = dbToGain(ceilingDb);
  const n = x.length;
  if (samplePeak(x) <= ceiling) return { samples: x, maxReductionDb: 0 };

  const L = Math.max(1, Math.round(lookahead * fs));
  const k = 1 - Math.exp(-1 / (release * fs));

  // 1. Gain each sample needs, with a smooth release back towards 1.
  const e = new Float64Array(n);
  let prev = 1;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(x[i]);
    const need = a > ceiling ? ceiling / a : 1;
    prev = Math.min(need, prev + (1 - prev) * k);
    e[i] = prev;
  }
  // 2. Look ahead: the lowest gain needed anywhere in the next L samples.
  const h = new Float64Array(n);
  const dq = new Int32Array(n);
  let head = 0; let tail = 0;
  let j = 0;
  for (let i = 0; i < n; i++) {
    const end = Math.min(n - 1, i + L - 1);
    while (j <= end) {
      while (tail > head && e[dq[tail - 1]] >= e[j]) tail--;
      dq[tail++] = j++;
    }
    while (dq[head] < i) head++;
    h[i] = e[dq[head]];
  }
  // 3. Average over the past L samples: turns the step into a ramp. Every value
  //    averaged already covers sample i, so the result never exceeds what i needs.
  const y = new Float32Array(n);
  let sum = 0;
  let minGain = 1;
  for (let i = 0; i < n; i++) {
    sum += h[i];
    if (i >= L) sum -= h[i - L];
    const g = sum / Math.min(i + 1, L);
    if (g < minGain) minGain = g;
    y[i] = x[i] * g;
  }
  return { samples: y, maxReductionDb: -gainToDb(minGain) };
}
