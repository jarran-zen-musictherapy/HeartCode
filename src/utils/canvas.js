export function extractPeaks(pcmData, targetWidth) {
  const length = pcmData.length;
  const peaks = new Array(targetWidth);
  for (let i = 0; i < targetWidth; i++) {
    // Proportional bucket edges: no empty buckets, works when length < width too.
    const start = Math.floor((i * length) / targetWidth);
    const end = Math.max(start + 1, Math.floor(((i + 1) * length) / targetWidth));
    let min = Infinity;
    let max = -Infinity;
    for (let j = start; j < end && j < length; j++) {
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
