import { useEffect, useRef } from 'react';
import { getAnalyserData, getAnalyserBinHz } from '../audio/engine.js';
import { fitCanvas } from '../utils/canvas.js';

const HEIGHT = 200;
const MAX_HZ = 600; // heart sounds live below ~200 Hz; murmurs reach a few hundred
const AXIS = 16;

export default function SpectrumAnalyser({ isPlaying }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return undefined;

    let raf = null;

    function draw(live) {
      const width = Math.floor(container.getBoundingClientRect().width);
      if (width < 2) return;
      const ctx = fitCanvas(canvas, width, HEIGHT);
      const plotH = HEIGHT - AXIS;

      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, width, HEIGHT);

      const data = live ? getAnalyserData() : null;
      const binHz = getAnalyserBinHz();
      if (data && binHz > 0) {
        const barCount = Math.min(data.length, Math.ceil(MAX_HZ / binHz));
        const barWidth = width / barCount;
        for (let i = 0; i < barCount; i++) {
          const barHeight = (data[i] / 255) * plotH;
          ctx.fillStyle = `hsl(${190 - (i / barCount) * 150}, 80%, 55%)`;
          ctx.fillRect(i * barWidth, plotH - barHeight, Math.max(barWidth - 1, 1), barHeight);
        }
      }

      ctx.fillStyle = '#888';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textBaseline = 'bottom';
      for (let hz = 0; hz <= MAX_HZ; hz += 100) {
        const x = (hz / MAX_HZ) * width;
        ctx.fillRect(Math.min(x, width - 1), plotH, 1, 3);
        ctx.textAlign = hz === 0 ? 'left' : hz === MAX_HZ ? 'right' : 'center';
        ctx.fillText(`${hz} Hz`, x, HEIGHT);
      }
    }

    function loop() {
      draw(true);
      raf = requestAnimationFrame(loop);
    }

    if (isPlaying) loop();
    else draw(false);

    const observer = new ResizeObserver(() => draw(isPlaying));
    observer.observe(container);

    return () => {
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [isPlaying]);

  return (
    <div className="spectrum-analyser">
      <h3 className="section-label">Spectrum (0–{MAX_HZ} Hz)</h3>
      <div ref={containerRef} className="canvas-container">
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}
