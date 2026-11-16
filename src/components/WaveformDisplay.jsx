import { useEffect, useRef } from 'react';
import { getAnalysisData, getCurrentTime, getDuration, seek } from '../audio/engine.js';
import { extractPeaks, fitCanvas } from '../utils/canvas.js';

const HEIGHT = 200;

export default function WaveformDisplay({ version, isPlaying, analysis }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return undefined;

    let peaks = null;
    let peaksWidth = 0;
    let raf = null;

    function draw() {
      const data = getAnalysisData();
      if (!data) return;
      const width = Math.floor(container.getBoundingClientRect().width);
      if (width < 2) return;
      const ctx = fitCanvas(canvas, width, HEIGHT);
      if (!peaks || peaksWidth !== width) {
        peaks = extractPeaks(data.pcm, width);
        peaksWidth = width;
      }
      // Scale quiet recordings up to fill the view (display only).
      let top = 0;
      for (const p of peaks) top = Math.max(top, Math.abs(p.min), Math.abs(p.max));
      const gain = top > 0 ? 0.95 / top : 1;
      const midY = HEIGHT / 2;

      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, width, HEIGHT);

      const duration = getDuration();
      const xOf = (t) => (duration > 0 ? (t / duration) * width : 0);

      if (analysis && analysis.ok) {
        for (const b of analysis.beats) {
          if (b.s2Onset !== null) {
            ctx.fillStyle = 'rgba(255, 204, 0, 0.45)';
            ctx.fillRect(xOf(b.s2Onset), 0, 1, HEIGHT);
          }
          ctx.fillStyle = '#00ff88';
          ctx.fillRect(xOf(b.s1Onset), 0, 1.5, HEIGHT);
        }
      }

      ctx.strokeStyle = '#00d4ff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < peaks.length; i++) {
        const { min, max } = peaks[i];
        ctx.moveTo(i + 0.5, midY - max * gain * midY);
        ctx.lineTo(i + 0.5, midY - min * gain * midY + 0.5);
      }
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(xOf(getCurrentTime()), 0, 1.5, HEIGHT);
    }

    function loop() {
      draw();
      raf = requestAnimationFrame(loop);
    }

    if (isPlaying) loop();
    else draw();

    const observer = new ResizeObserver(() => draw());
    observer.observe(container);

    function handleClick(e) {
      const rect = canvas.getBoundingClientRect();
      seek(((e.clientX - rect.left) / rect.width) * getDuration());
      draw();
    }
    canvas.addEventListener('click', handleClick);

    return () => {
      observer.disconnect();
      canvas.removeEventListener('click', handleClick);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [version, isPlaying, analysis]);

  return (
    <div className="waveform-display">
      <h3 className="section-label">
        Waveform
        {analysis && analysis.ok && (
          <span className="legend">
            <span className="key s1" /> S1 <span className="key s2" /> S2
          </span>
        )}
      </h3>
      <div ref={containerRef} className="canvas-container">
        <canvas ref={canvasRef} title="Click to move the playhead" />
      </div>
    </div>
  );
}
