import { useEffect, useRef } from 'react';
import { getAnalyserData } from '../audio/engine.js';

export default function SpectrumAnalyser({ isPlaying }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const animFrameRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    function syncSize() {
      const rect = container.getBoundingClientRect();
      canvas.width = Math.floor(rect.width);
      canvas.height = 200;
    }

    syncSize();
    const observer = new ResizeObserver(() => syncSize());
    observer.observe(container);

    const ctx = canvas.getContext('2d');

    function draw() {
      const width = canvas.width;
      const height = canvas.height;
      const data = getAnalyserData();

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, width, height);

      if (data) {
        const barCount = data.length;
        const barWidth = width / barCount;

        for (let i = 0; i < barCount; i++) {
          const barHeight = (data[i] / 255) * height;
          const x = i * barWidth;
          const y = height - barHeight;
          ctx.fillStyle = `hsl(${(i / barCount) * 240}, 80%, 55%)`;
          ctx.fillRect(x, y, Math.max(barWidth - 1, 1), barHeight);
        }
      }

      animFrameRef.current = requestAnimationFrame(draw);
    }

    if (isPlaying) {
      draw();
    } else {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, width, height);
    }

    return () => {
      observer.disconnect();
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, [isPlaying]);

  return (
    <div className="spectrum-analyser">
      <h3 className="section-label">Spectrum</h3>
      <div ref={containerRef} className="canvas-container">
        <canvas ref={canvasRef} height={200} />
      </div>
    </div>
  );
}
