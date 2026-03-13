export function extractPeaks(pcmData, targetWidth) {
  const length = pcmData.length;
  const bucketSize = Math.ceil(length / targetWidth);
  const peaks = [];

  for (let i = 0; i < targetWidth; i++) {
    const start = i * bucketSize;
    const end = Math.min(start + bucketSize, length);
    let min = 1;
    let max = -1;

    for (let j = start; j < end; j++) {
      const val = pcmData[j];
      if (val < min) min = val;
      if (val > max) max = val;
    }

    peaks.push({ min, max });
  }

  return peaks;
}
