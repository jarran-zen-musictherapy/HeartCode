/**
 * Min/max of the samples behind each pixel column, for drawing a waveform.
 * `start` and `end` (sample indices) select the part of the recording shown.
 */
export function extractPeaks(pcmData, targetWidth, start = 0, end = pcmData.length) {
  const s0 = Math.max(0, Math.floor(start));
  const s1 = Math.min(pcmData.length, Math.ceil(end));
  const length = Math.max(0, s1 - s0);
  const peaks = new Array(targetWidth);
  for (let i = 0; i < targetWidth; i++) {
    // Proportional bucket edges: no empty buckets, works when length < width too.
    const a = s0 + Math.floor((i * length) / targetWidth);
    const b = Math.max(a + 1, s0 + Math.floor(((i + 1) * length) / targetWidth));
    let min = Infinity;
    let max = -Infinity;
    for (let j = a; j < b && j < s1; j++) {
      const val = pcmData[j];
      if (val < min) min = val;
      if (val > max) max = val;
    }
    if (min === Infinity) { min = 0; max = 0; }
    peaks[i] = { min, max };
  }
  return peaks;
}

/** Size a canvas for the device pixel ratio; returns a context scaled to CSS pixels. */
export function fitCanvas(canvas, cssWidth, cssHeight) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(cssWidth * dpr));
  canvas.height = Math.round(cssHeight * dpr);
  canvas.style.height = `${cssHeight}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** A "nice" tick spacing (1, 2 or 5 times a power of ten) of at least `minStep`. */
export function niceStep(minStep) {
  const pow = 10 ** Math.floor(Math.log10(minStep));
  for (const m of [1, 2, 5, 10]) if (m * pow >= minStep) return m * pow;
  return 10 * pow;
}
