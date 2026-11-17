import { useEffect, useRef } from 'react';
import { EQ_LIMITS, EQ_PRESETS, eqResponseDb } from '../process/eq.js';
import { NOISE_LEVELS } from '../process/noise.js';
import { DENOISE_LEVELS } from '../process/denoise.js';
import { fitCanvas } from '../utils/canvas.js';

const HEIGHT = 240;
const LEFT = 34;
const BOTTOM = 16;
const CURVE_RANGE = 24; // dB above and below the centre line
const SPECTRUM_RANGE = 72; // dB shown from the top of the spectrum down
const TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000];
const BAND_NAMES = ['Low shelf', 'Bell 1', 'Bell 2', 'High shelf'];
const COLOURS = ['#ff9f43', '#00ff88', '#ffcc00', '#c792ea'];

const { minHz, maxHz, maxGain, minQ, maxQ } = EQ_LIMITS;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmtDb = (v) => (Number.isFinite(v) ? v.toFixed(1) : '−∞');

function Meter({ label, peak, lufs }) {
  const pct = Number.isFinite(peak) ? clamp(((peak + 60) / 60) * 100, 0, 100) : 0;
  return (
    <div className="meter">
      <span className="meter-label">{label}</span>
      <div className="meter-bar" role="img" aria-label={`${label} true peak ${fmtDb(peak)} dBTP`}>
        <div className={`meter-fill${peak > -0.05 ? ' hot' : ''}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="meter-value">{fmtDb(peak)} <small>dBTP</small></span>
      <span className="meter-value">{fmtDb(lufs)} <small>LUFS</small></span>
    </div>
  );
}

export default function TonePanel({
  eq, onEq, spectrum, sampleRate, view, onView, level, onLevel, meters, hum, removeHum, onRemoveHum, noise, onNoise, denoise, onDenoise,
}) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const dragRef = useRef(null);
  const geomRef = useRef(null);

  // Total make-up applied after the EQ, for drawing the "after" spectrum at its true level.
  const appliedGainDb = meters ? meters.gainDb : 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return undefined;

    function draw() {
      const width = Math.floor(container.getBoundingClientRect().width);
      if (width < 80) return;
      const ctx = fitCanvas(canvas, width, HEIGHT);
      const plotW = width - LEFT;
      const plotH = HEIGHT - BOTTOM;
      const span = Math.log(maxHz / minHz);
      const xOf = (f) => LEFT + (Math.log(f / minHz) / span) * plotW;
      const fOf = (x) => minHz * Math.exp(((x - LEFT) / plotW) * span);
      const yOf = (db) => (1 - (clamp(db, -CURVE_RANGE, CURVE_RANGE) + CURVE_RANGE) / (2 * CURVE_RANGE)) * plotH;
      const dbOf = (y) => (1 - y / plotH) * 2 * CURVE_RANGE - CURVE_RANGE;
      geomRef.current = { xOf, fOf, yOf, dbOf };

      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, width, HEIGHT);

      // Grid and labels.
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillStyle = '#888';
      ctx.strokeStyle = '#2a2a4e';
      ctx.lineWidth = 1;
      ctx.textBaseline = 'bottom';
      for (const f of TICKS) {
        const x = Math.round(xOf(f)) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, plotH); ctx.stroke();
        ctx.textAlign = f === maxHz ? 'right' : 'center';
        ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x, HEIGHT);
      }
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (const db of [-18, -12, -6, 0, 6, 12, 18]) {
        const y = Math.round(yOf(db)) + 0.5;
        ctx.strokeStyle = db === 0 ? '#44446a' : '#2a2a4e';
        ctx.beginPath(); ctx.moveTo(LEFT, y); ctx.lineTo(width, y); ctx.stroke();
        ctx.fillText(`${db > 0 ? '+' : ''}${db}`, LEFT - 4, y);
      }

      const cols = [];
      for (let x = LEFT; x <= width; x++) cols.push(fOf(x));
      const response = eqResponseDb(eq, sampleRate || 44100, cols);

      // Spectrum of the recording, before or after the EQ.
      if (spectrum) {
        const { binHz, power } = spectrum;
        const at = (f) => {
          const pos = f / binHz;
          const i = Math.floor(pos);
          if (i + 1 >= power.length) return 0;
          return power[i] + (power[i + 1] - power[i]) * (pos - i);
        };
        const pre = cols.map((f, k) => {
          const next = k + 1 < cols.length ? cols[k + 1] : f;
          let p = at(f);
          for (let i = Math.ceil(f / binHz); i * binHz < next && i < power.length; i++) p = Math.max(p, power[i]);
          return 10 * Math.log10(p + 1e-20);
        });
        let ref = -Infinity;
        cols.forEach((f, k) => { if (f >= 20 && f <= 2000 && pre[k] > ref) ref = pre[k]; });
        const shown = view === 'post' ? pre.map((v, k) => v + response[k] + appliedGainDb) : pre;
        const top = ref + 6 + (view === 'post' ? Math.max(0, appliedGainDb) : 0);
        ctx.beginPath();
        ctx.moveTo(LEFT, plotH);
        shown.forEach((v, k) => ctx.lineTo(LEFT + k, clamp(((top - v) / SPECTRUM_RANGE) * plotH, 0, plotH)));
        ctx.lineTo(width, plotH);
        ctx.closePath();
        ctx.fillStyle = view === 'post' ? 'rgba(0, 212, 255, 0.28)' : 'rgba(150, 150, 190, 0.28)';
        ctx.fill();
      }

      // EQ curve.
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      response.forEach((db, k) => (k ? ctx.lineTo(LEFT + k, yOf(db)) : ctx.moveTo(LEFT + k, yOf(db))));
      ctx.stroke();

      // Handles.
      const handle = (x, y, colour, text) => {
        ctx.beginPath(); ctx.arc(x, y, 9, 0, 2 * Math.PI);
        ctx.fillStyle = colour; ctx.fill();
        ctx.fillStyle = '#0f0f23';
        ctx.font = 'bold 10px system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(text, x, y + 0.5);
      };
      eq.bands.forEach((b, i) => handle(xOf(b.freq), yOf(b.gain), COLOURS[i], String(i + 1)));
      if (eq.lowCut.on) handle(xOf(eq.lowCut.freq), yOf(0), '#ff6b6b', 'L');
      if (eq.highCut.on) handle(xOf(eq.highCut.freq), yOf(0), '#ff6b6b', 'H');
    }

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(container);
    return () => observer.disconnect();
  }, [eq, spectrum, sampleRate, view, appliedGainDb]);

  function pointerPos(e) {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function handlePointerDown(e) {
    const g = geomRef.current;
    if (!g) return;
    const { x, y } = pointerPos(e);
    const targets = eq.bands.map((b, i) => ({ id: i, x: g.xOf(b.freq), y: g.yOf(b.gain) }));
    if (eq.lowCut.on) targets.push({ id: 'lowCut', x: g.xOf(eq.lowCut.freq), y: g.yOf(0) });
    if (eq.highCut.on) targets.push({ id: 'highCut', x: g.xOf(eq.highCut.freq), y: g.yOf(0) });
    let best = null;
    for (const t of targets) {
      const d = Math.hypot(t.x - x, t.y - y);
      if (d < 18 && (!best || d < best.d)) best = { ...t, d };
    }
    if (!best) return;
    dragRef.current = best.id;
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e) {
    const id = dragRef.current;
    const g = geomRef.current;
    if (id === null || id === undefined || !g) return;
    const { x, y } = pointerPos(e);
    const freq = Math.round(clamp(g.fOf(x), minHz, maxHz));
    if (typeof id === 'number') {
      const gain = Math.round(clamp(g.dbOf(y), -maxGain, maxGain) * 2) / 2;
      onEq({ ...eq, bands: eq.bands.map((b, i) => (i === id ? { ...b, freq, gain } : b)) });
    } else {
      onEq({ ...eq, [id]: { ...eq[id], freq } });
    }
  }

  function handlePointerUp() {
    dragRef.current = null;
  }

  function handleDoubleClick(e) {
    const g = geomRef.current;
    if (!g) return;
    const { x, y } = pointerPos(e);
    const i = eq.bands.findIndex((b) => Math.hypot(g.xOf(b.freq) - x, g.yOf(b.gain) - y) < 18);
    if (i >= 0) onEq({ ...eq, bands: eq.bands.map((b, k) => (k === i ? { ...b, gain: 0 } : b)) });
  }

  const setBand = (i, field, raw, lo, hi) => {
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    onEq({ ...eq, bands: eq.bands.map((b, k) => (k === i ? { ...b, [field]: clamp(v, lo, hi) } : b)) });
  };
  const setCut = (id, patch) => onEq({ ...eq, [id]: { ...eq[id], ...patch } });
  const cutFreq = (id, raw) => {
    const v = Number(raw);
    if (Number.isFinite(v)) setCut(id, { freq: clamp(v, minHz, maxHz) });
  };

  const reduction = meters ? meters.reductionDb : 0;
  const clipping = meters && !level.limiterOn && meters.post.peak > 0;

  return (
    <div className="tone-panel">
      <h3 className="section-label">
        Tone &amp; Level
        <span className="toggle" role="group" aria-label="Spectrum shown">
          <button className={view === 'pre' ? 'on' : ''} onClick={() => onView('pre')}>Before</button>
          <button className={view === 'post' ? 'on' : ''} onClick={() => onView('post')}>After</button>
        </span>
      </h3>

      <div ref={containerRef} className="canvas-container">
        <canvas
          ref={canvasRef}
          className="eq-canvas"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onDoubleClick={handleDoubleClick}
          title="Drag a numbered dot to shape the sound. Double-click a dot to reset it."
        />
      </div>
      <p className="note">
        White line: the EQ curve. Shaded area: the recording&apos;s frequency content {view === 'post' ? 'after' : 'before'} EQ
        and gain. Drag the dots, or type exact values below.
      </p>

      <div className="controls">
        <label>
          EQ preset
          <select value="" onChange={(e) => e.target.value && onEq(EQ_PRESETS[e.target.value].make())}>
            <option value="">Choose…</option>
            {Object.entries(EQ_PRESETS).map(([id, p]) => <option key={id} value={id}>{p.label}</option>)}
          </select>
        </label>
        <label title="Learns the background noise from the gaps between heartbeats, then removes it everywhere, including underneath the heart sounds">
          Noise removal
          <select value={denoise} onChange={(e) => onDenoise(e.target.value)}>
            {Object.entries(DENOISE_LEVELS).map(([id, n]) => <option key={id} value={id}>{n.label}</option>)}
          </select>
        </label>
        <label title="Turns down the gaps between heart sounds, where hiss and room noise sit">
          Quieten the gaps
          <select value={noise} onChange={(e) => onNoise(e.target.value)}>
            {Object.entries(NOISE_LEVELS).map(([id, n]) => <option key={id} value={id}>{n.label}</option>)}
          </select>
        </label>
        {hum > 0 && (
          <label className="check">
            <input type="checkbox" checked={removeHum} onChange={(e) => onRemoveHum(e.target.checked)} />
            Remove {hum} Hz mains hum
          </label>
        )}
      </div>

      <div className="eq-bands">
        <div className="eq-band">
          <label className="check">
            <input type="checkbox" checked={eq.lowCut.on} onChange={(e) => setCut('lowCut', { on: e.target.checked })} />
            <span className="dot" style={{ background: '#ff6b6b' }}>L</span> Low cut
          </label>
          <label>Hz<input type="number" min={minHz} max={maxHz} value={eq.lowCut.freq} onChange={(e) => cutFreq('lowCut', e.target.value)} /></label>
        </div>
        {eq.bands.map((b, i) => (
          <div className="eq-band" key={BAND_NAMES[i]}>
            <span className="band-name"><span className="dot" style={{ background: COLOURS[i] }}>{i + 1}</span> {BAND_NAMES[i]}</span>
            <label>Hz<input type="number" min={minHz} max={maxHz} value={b.freq} onChange={(e) => setBand(i, 'freq', e.target.value, minHz, maxHz)} /></label>
            <label>dB<input type="number" min={-maxGain} max={maxGain} step="0.5" value={b.gain} onChange={(e) => setBand(i, 'gain', e.target.value, -maxGain, maxGain)} /></label>
            {b.type === 'peaking' && (
              <label>Q<input type="number" min={minQ} max={maxQ} step="0.1" value={b.q} onChange={(e) => setBand(i, 'q', e.target.value, minQ, maxQ)} /></label>
            )}
          </div>
        ))}
        <div className="eq-band">
          <label className="check">
            <input type="checkbox" checked={eq.highCut.on} onChange={(e) => setCut('highCut', { on: e.target.checked })} />
            <span className="dot" style={{ background: '#ff6b6b' }}>H</span> High cut
          </label>
          <label>Hz<input type="number" min={minHz} max={maxHz} value={eq.highCut.freq} onChange={(e) => cutFreq('highCut', e.target.value)} /></label>
        </div>
      </div>

      <div className="controls level">
        <label className="check">
          <input type="checkbox" checked={level.autoGain} onChange={(e) => onLevel({ ...level, autoGain: e.target.checked })} />
          Auto gain (peak to ceiling)
        </label>
        <label>
          Gain (dB)
          <input
            type="number" min="-24" max="60" step="0.5" disabled={level.autoGain}
            value={level.autoGain && meters ? meters.gainDb.toFixed(1) : level.gainText}
            onChange={(e) => onLevel({ ...level, gainText: e.target.value })}
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={level.limiterOn} onChange={(e) => onLevel({ ...level, limiterOn: e.target.checked })} />
          Limiter
        </label>
        <label>
          Ceiling (dB)
          <input
            type="number" min="-12" max="0" step="0.1" value={level.ceilingText}
            onChange={(e) => onLevel({ ...level, ceilingText: e.target.value })}
          />
        </label>
      </div>

      {meters && (
        <div className="meters">
          <Meter label="Before" peak={meters.pre.peak} lufs={meters.pre.lufs} />
          <Meter label="After" peak={meters.post.peak} lufs={meters.post.lufs} />
          <p className="note">
            {level.limiterOn
              ? (reduction > 0.05 ? `Limiter is turning the loudest peaks down by up to ${reduction.toFixed(1)} dB.` : 'Limiter is on but not needed at this gain.')
              : 'Limiter is off.'}
            {' '}Heart sounds are mostly deep bass, which the LUFS scale counts lightly, so expect lower LUFS
            readings than music at the same peak level.
          </p>
          {clipping && (
            <p className="error-text">
              The output goes over full scale by {meters.post.peak.toFixed(1)} dB and will distort. Lower the gain or
              turn the limiter on.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
