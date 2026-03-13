import { useEffect, useRef, useCallback } from 'react';
import { getPCMData } from '../audio/engine.js';
import { extractPeaks } from '../utils/canvas.js';

export default function WaveformDisplay() {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);

  const drawWaveform = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const pcm = getPCMData();
    if (!pcm) return;

    const rect = container.getBoundingClientRect();
    const width = Math.floor(rect.width);
    const height = 200;
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    const midY = height / 2;
    const peaks = extractPeaks(pcm, width);

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
  }, []);

  useEffect(() => {
    drawWaveform();

    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => drawWaveform());
    observer.observe(container);
    return () => observer.disconnect();
  }, [drawWaveform]);

  return (
    <div className="waveform-display">
      <h3 className="section-label">Waveform</h3>
      <div ref={containerRef} className="canvas-container">
        <canvas ref={canvasRef} height={200} />
      </div>
    </div>
  );
}
