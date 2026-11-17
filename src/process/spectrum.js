// Averaged magnitude spectrum (Welch method) for the EQ display.

export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang); const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1; let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k; const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/**
 * Average power spectrum. Resolution is about 3 Hz, fine enough to see
 * individual features of a heart sound.
 * @returns {{ binHz: number, power: Float64Array } | null}
 */
export function averageSpectrum(x, fs) {
  let size = 2 ** Math.ceil(Math.log2(fs / 3));
  while (size > x.length && size > 256) size >>= 1;
  if (x.length < size) return null;
  const hop = size / 2;
  const segments = Math.floor((x.length - size) / hop) + 1;
  const step = Math.max(1, Math.ceil(segments / 120)); // cap the work on long files
  const win = new Float64Array(size);
  for (let i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  const power = new Float64Array(size / 2);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  let count = 0;
  for (let s = 0; s < segments; s += step) {
    const start = s * hop;
    for (let i = 0; i < size; i++) { re[i] = x[start + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let i = 0; i < size / 2; i++) power[i] += re[i] * re[i] + im[i] * im[i];
    count++;
  }
  for (let i = 0; i < power.length; i++) power[i] /= count;
  return { binHz: fs / size, power };
}
