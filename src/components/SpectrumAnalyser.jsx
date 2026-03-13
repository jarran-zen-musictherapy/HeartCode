import { useEffect, useRef } from 'react';
import { getAnalyserData, getIsPlaying } from '../audio/engine.js';

export default function SpectrumAnalyser({ isPlaying }) {
  const canvasRef = useRef(null);
  const animFrameRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    function draw() {
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
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, width, height);
    }

    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, [isPlaying]);

  return (
    <div className="spectrum-analyser">
      <canvas ref={canvasRef} width={800} height={200} />
    </div>
  );
}
