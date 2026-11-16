import { useEffect, useRef } from 'react';
import { getAnalysisData, getCurrentTime, seek } from '../audio/engine.js';
import { extractPeaks, fitCanvas, niceStep } from '../utils/canvas.js';

const HEIGHT = 220;
const RULER = 16;
const MINI = 36;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export default function WaveformDisplay({ version, isPlaying, analysis }) {
  const canvasRef = useRef(null);
  const miniRef = useRef(null);
  const containerRef = useRef(null);
  const viewRef = useRef({ start: 0, end: 0, version: -1 }); // visible time range, kept across redraws
  const apiRef = useRef({});

  useEffect(() => {
    const canvas = canvasRef.current;
    const mini = miniRef.current;
    const container = containerRef.current;
    const data = getAnalysisData();
    if (!canvas || !mini || !container || !data) return undefined;

    const { pcm, sampleRate } = data;
    const duration = pcm.length / sampleRate;
    const view = viewRef.current;
    if (view.version !== version) { // new file: show all of it
      view.start = 0;
      view.end = duration;
      view.version = version;
    }
    const minSpan = Math.min(duration, Math.max(0.02, 64 / sampleRate));
    const beats = analysis && analysis.ok ? analysis.beats : [];

    let width = 0;
    let raf = null;
    let peakCache = { key: '', peaks: null };
    let miniCache = { width: 0, peaks: null, top: 1 };

    function setView(start, span) {
      const s = clamp(span, minSpan, duration);
      view.start = clamp(start, 0, duration - s);
      view.end = view.start + s;
      draw();
    }
    function zoom(factor, anchorTime) {
      const span = view.end - view.start;
      const t = anchorTime ?? (view.start + view.end) / 2;
      const next = clamp(span / factor, minSpan, duration);
      setView(t - ((t - view.start) / span) * next, next);
    }
    const timeAt = (x) => view.start + (x / Math.max(1, width)) * (view.end - view.start);

    function drawMain() {
      const ctx = fitCanvas(canvas, width, HEIGHT);
      const span = view.end - view.start;
      const xOf = (t) => ((t - view.start) / span) * width;
      const plotTop = RULER;
      const plotH = HEIGHT - RULER;
      const midY = plotTop + plotH / 2;

      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, width, HEIGHT);

      // Time ruler.
      const step = niceStep((span / width) * 80);
      const decimals = Math.max(0, Math.min(3, -Math.floor(Math.log10(step))));
      ctx.font = '10px system-ui, sans-serif';
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      for (let t = Math.ceil(view.start / step) * step; t <= view.end; t += step) {
        const x = Math.round(xOf(t)) + 0.5;
        ctx.strokeStyle = '#2a2a4e';
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, HEIGHT); ctx.stroke();
        ctx.fillStyle = '#888';
        ctx.fillText(`${t.toFixed(decimals)}s`, x + 3, 2);
      }

      // Beat markers (numbered once there is room).
      const pxPerBeat = analysis && analysis.ok ? (60 / analysis.bpm / span) * width : 0;
      beats.forEach((b, k) => {
        if (b.s2Onset !== null && b.s2Onset >= view.start && b.s2Onset <= view.end) {
          ctx.fillStyle = 'rgba(255, 204, 0, 0.5)';
          ctx.fillRect(xOf(b.s2Onset), plotTop, 1, plotH);
        }
        if (b.s1Onset >= view.start && b.s1Onset <= view.end) {
          const x = xOf(b.s1Onset);
          ctx.fillStyle = '#00ff88';
          ctx.fillRect(x, plotTop, 1.5, plotH);
          if (pxPerBeat > 34) {
            ctx.textBaseline = 'bottom';
            ctx.fillText(String(k + 1), x + 4, HEIGHT - 3);
          }
        }
      });

      // Waveform, scaled so the visible part fills the height.
      const s0 = view.start * sampleRate;
      const s1 = view.end * sampleRate;
      const perPx = (s1 - s0) / width;
      ctx.strokeStyle = '#00d4ff';
      ctx.lineWidth = 1;
      if (perPx > 1) {
        const key = `${s0}|${s1}|${width}`;
        if (peakCache.key !== key) peakCache = { key, peaks: extractPeaks(pcm, width, s0, s1) };
        const { peaks } = peakCache;
        let top = 0;
        for (const p of peaks) top = Math.max(top, Math.abs(p.min), Math.abs(p.max));
        const gain = top > 0 ? (0.95 * plotH) / 2 / top : 1;
        ctx.beginPath();
        for (let i = 0; i < peaks.length; i++) {
          ctx.moveTo(i + 0.5, midY - peaks[i].max * gain);
          ctx.lineTo(i + 0.5, midY - peaks[i].min * gain + 0.5);
        }
        ctx.stroke();
      } else {
        // Zoomed right in: draw the individual samples.
        const a = Math.max(0, Math.floor(s0) - 1);
        const b = Math.min(pcm.length - 1, Math.ceil(s1) + 1);
        let top = 0;
        for (let i = a; i <= b; i++) top = Math.max(top, Math.abs(pcm[i]));
        const gain = top > 0 ? (0.95 * plotH) / 2 / top : 1;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = a; i <= b; i++) {
          const x = xOf(i / sampleRate);
          const y = midY - pcm[i] * gain;
          if (i === a) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        if (perPx < 0.15) {
          ctx.fillStyle = '#00d4ff';
          for (let i = a; i <= b; i++) {
            ctx.beginPath();
            ctx.arc(xOf(i / sampleRate), midY - pcm[i] * gain, 2.5, 0, 2 * Math.PI);
            ctx.fill();
          }
        }
      }

      const now = getCurrentTime();
      if (now >= view.start && now <= view.end) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(xOf(now), 0, 1.5, HEIGHT);
      }
    }

    function drawMini() {
      const ctx = fitCanvas(mini, width, MINI);
      if (miniCache.width !== width) {
        const peaks = extractPeaks(pcm, width);
        let top = 0;
        for (const p of peaks) top = Math.max(top, Math.abs(p.min), Math.abs(p.max));
        miniCache = { width, peaks, top: top || 1 };
      }
      ctx.fillStyle = '#14142a';
      ctx.fillRect(0, 0, width, MINI);
      const gain = (0.9 * MINI) / 2 / miniCache.top;
      ctx.strokeStyle = '#4a6a8a';
      ctx.beginPath();
      miniCache.peaks.forEach((p, i) => {
        ctx.moveTo(i + 0.5, MINI / 2 - p.max * gain);
        ctx.lineTo(i + 0.5, MINI / 2 - p.min * gain + 0.5);
      });
      ctx.stroke();
      const x0 = (view.start / duration) * width;
      const x1 = (view.end / duration) * width;
      ctx.fillStyle = 'rgba(0, 212, 255, 0.18)';
      ctx.fillRect(x0, 0, Math.max(2, x1 - x0), MINI);
      ctx.strokeStyle = '#00d4ff';
      ctx.strokeRect(x0 + 0.5, 0.5, Math.max(2, x1 - x0) - 1, MINI - 1);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect((getCurrentTime() / duration) * width, 0, 1, MINI);
    }

    function draw() {
      width = Math.floor(container.getBoundingClientRect().width);
      if (width < 2) return;
      drawMain();
      drawMini();
    }

    function loop() {
      // Follow the playhead: turn the page when it leaves the view.
      const now = getCurrentTime();
      const span = view.end - view.start;
      if (span < duration && (now < view.start || now > view.end)) {
        view.start = clamp(now - 0.1 * span, 0, duration - span);
        view.end = view.start + span;
      }
      draw();
      raf = requestAnimationFrame(loop);
    }

    if (isPlaying) loop(); else draw();

    const observer = new ResizeObserver(draw);
    observer.observe(container);

    // --- Main canvas: click to move the playhead, drag to pan, pinch / ctrl+wheel to zoom.
    let drag = null;
    function onDown(e) {
      drag = { x: e.clientX, start: view.start, moved: false };
      canvas.setPointerCapture(e.pointerId);
    }
    function onMove(e) {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 4) drag.moved = true;
      if (drag.moved) {
        const span = view.end - view.start;
        setView(drag.start - (dx / width) * span, span);
      }
    }
    function onUp(e) {
      if (drag && !drag.moved) {
        seek(timeAt(e.clientX - canvas.getBoundingClientRect().left));
        draw();
      }
      drag = null;
    }
    function onWheel(e) {
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoom(Math.exp(-e.deltaY * 0.01), timeAt(e.clientX - canvas.getBoundingClientRect().left));
      } else if (horizontal && view.end - view.start < duration) {
        e.preventDefault();
        const span = view.end - view.start;
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        setView(view.start + (delta / width) * span, span);
      } // a plain vertical scroll is left alone so the page still scrolls
    }
    function onKey(e) {
      const span = view.end - view.start;
      if (e.key === '+' || e.key === '=') zoom(2);
      else if (e.key === '-' || e.key === '_') zoom(0.5);
      else if (e.key === '0') setView(0, duration);
      else if (e.key === 'ArrowLeft') setView(view.start - 0.2 * span, span);
      else if (e.key === 'ArrowRight') setView(view.start + 0.2 * span, span);
      else return;
      e.preventDefault();
    }
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('keydown', onKey);

    // --- Overview strip: click or drag to move the visible window.
    let miniDrag = false;
    function miniTo(e) {
      const span = view.end - view.start;
      const t = ((e.clientX - mini.getBoundingClientRect().left) / width) * duration;
      setView(t - span / 2, span);
    }
    function miniDown(e) { miniDrag = true; mini.setPointerCapture(e.pointerId); miniTo(e); }
    function miniMove(e) { if (miniDrag) miniTo(e); }
    function miniUp() { miniDrag = false; }
    mini.addEventListener('pointerdown', miniDown);
    mini.addEventListener('pointermove', miniMove);
    mini.addEventListener('pointerup', miniUp);
    mini.addEventListener('pointercancel', miniUp);

    apiRef.current = {
      zoomIn: () => zoom(2),
      zoomOut: () => zoom(0.5),
      fit: () => setView(0, duration),
      toPlayhead: () => { const span = view.end - view.start; setView(getCurrentTime() - span / 2, span); },
    };

    return () => {
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('keydown', onKey);
      mini.removeEventListener('pointerdown', miniDown);
      mini.removeEventListener('pointermove', miniMove);
      mini.removeEventListener('pointerup', miniUp);
      mini.removeEventListener('pointercancel', miniUp);
    };
  }, [version, isPlaying, analysis]);

  function handleZoomOut() { apiRef.current.zoomOut?.(); }
  function handleZoomIn() { apiRef.current.zoomIn?.(); }
  function handleFit() { apiRef.current.fit?.(); }
  function handleToPlayhead() { apiRef.current.toPlayhead?.(); }

  return (
    <div className="waveform-display">
      <h3 className="section-label">
        Waveform
        {analysis && analysis.ok && (
          <span className="legend">
            <span className="key s1" /> S1 <span className="key s2" /> S2
          </span>
        )}
        <span className="zoom-buttons">
          <button onClick={handleZoomOut} aria-label="Zoom out" title="Zoom out (−)">−</button>
          <button onClick={handleZoomIn} aria-label="Zoom in" title="Zoom in (+)">+</button>
          <button onClick={handleFit} title="Show the whole recording (0)">Fit</button>
          <button onClick={handleToPlayhead} title="Centre on the playhead">Playhead</button>
        </span>
      </h3>
      <div ref={containerRef} className="canvas-container">
        <canvas
          ref={canvasRef}
          className="wave-main"
          tabIndex={0}
          aria-label="Waveform. Plus and minus zoom, arrow keys move, zero shows everything."
        />
        <canvas ref={miniRef} className="wave-mini" aria-hidden="true" />
      </div>
      <p className="note">
        Click to move the playhead. Drag to move along. Pinch or Ctrl/⌘ + scroll to zoom. The strip underneath
        shows the whole recording: drag the blue box.
      </p>
    </div>
  );
}
