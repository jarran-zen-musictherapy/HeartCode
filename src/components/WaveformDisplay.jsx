import { useEffect, useRef } from 'react';
import { getPCMData } from '../audio/engine.js';
import { extractPeaks } from '../utils/canvas.js';

export default function WaveformDisplay() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const pcm = getPCMData();
    if (!pcm) return;

    const width = canvas.width;
    const height = canvas.height;
    const midY = height / 2;
    const peaks = extractPeaks(pcm, width);

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = '#00d4ff';
    ctx.lineWidth = 1;

    for (let i = 0; i < peaks.length; i++) {
      const { min, max } = peaks[i];
      const yMax = midY - max * midY;
      const yMin = midY - min * midY;
      ctx.beginPath();
      ctx.moveTo(i, yMax);
      ctx.lineTo(i, yMin);
      ctx.stroke();
    }
  });

  return (
    <div className="waveform-display">
      <canvas ref={canvasRef} width={800} height={200} />
    </div>
  );
}
