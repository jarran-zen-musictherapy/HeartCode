import { useEffect, useState } from 'react';
import FileLoader from './components/FileLoader.jsx';
import TransportControls from './components/TransportControls.jsx';
import WaveformDisplay from './components/WaveformDisplay.jsx';
import SpectrumAnalyser from './components/SpectrumAnalyser.jsx';
import AnalysisPanel from './components/AnalysisPanel.jsx';
import GridPanel from './components/GridPanel.jsx';
import { getAnalysisData, onEnded, setLoopRegion } from './audio/engine.js';
import { setAudio, analyse } from './worker/client.js';
import { encodeWav } from './export/wavEncode.js';

function App() {
  const [fileMeta, setFileMeta] = useState(null);
  const [fileVersion, setFileVersion] = useState(0); // bumps on every load, even of the same file
  const [isPlaying, setIsPlaying] = useState(false);
  const [analysis, setAnalysis] = useState(null);
  const [swapAnchor, setSwapAnchor] = useState(false);
  const [tempoFactor, setTempoFactor] = useState(1); // 1, 0.5 or 2: manual half/double override
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [selection, setSelection] = useState(null); // hand-picked loop region { start, end } in seconds
  const [analysisRange, setAnalysisRange] = useState(null); // analyse only this part, or null for everything

  // Keep the buttons honest when playback reaches the end by itself.
  useEffect(() => onEnded(() => setIsPlaying(false)), []);

  // Hand each newly loaded recording to the background worker.
  useEffect(() => {
    const data = getAnalysisData();
    if (fileMeta && data) setAudio(data.pcm, data.sampleRate);
  }, [fileMeta, fileVersion]);

  // Analyse whenever a file loads or the S1/S2 choice is flipped.
  useEffect(() => {
    if (!fileMeta || !getAnalysisData()) return undefined;
    let cancelled = false;
    analyse({ swapAnchor, tempoFactor }, analysisRange).then(
      (result) => { if (!cancelled && result) setAnalysis(result); },
      (err) => { console.error('Analysis failed:', err); },
    );
    return () => { cancelled = true; };
  }, [fileMeta, fileVersion, swapAnchor, tempoFactor, analysisRange]);

  // While a loop is selected, Play loops just that part.
  useEffect(() => { setLoopRegion(selection); }, [selection, fileVersion]);

  function handleFileLoaded(meta) {
    setIsPlaying(false);
    setAnalysis(null);
    setSwapAnchor(false);
    setTempoFactor(1);
    setSelection(null);
    setAnalysisRange(null);
    setFileMeta(meta);
    setFileVersion((v) => v + 1);
  }

  // Save the sound on its own, e.g. the audio track of a screen recording.
  function saveAudio() {
    const data = getAnalysisData();
    if (!data) return;
    const url = URL.createObjectURL(new Blob([encodeWav(data.pcm, data.sampleRate, 24)], { type: 'audio/wav' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileMeta.name.replace(/\.[^.]+$/, '')}_audio.wav`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="app">
      <h1>HeartCode</h1>
      <p className="subtitle">Audio Processing for Clinical Music Therapy</p>

      <FileLoader onFileLoaded={handleFileLoaded} />

      {fileMeta && (
        <div className="file-info">
          <span><strong>File:</strong> {fileMeta.name}</span>
          <span>
            <strong>Sample Rate:</strong> {fileMeta.sampleRate} Hz
            {!fileMeta.nativeRate && ' (as decoded by browser)'}
          </span>
          {fileMeta.bitDepth && <span><strong>Bit Depth:</strong> {fileMeta.bitDepth}</span>}
          <span><strong>Duration:</strong> {fileMeta.duration.toFixed(2)}s</span>
          <span><strong>Channels:</strong> {fileMeta.numberOfChannels}</span>
          {fileMeta.nativeRate && fileMeta.sampleRate === 4000 && (
            <span className="badge">Littmann CORE profile detected</span>
          )}
          <button className="secondary inline" onClick={saveAudio}>Save audio as .wav</button>
        </div>
      )}

      {fileMeta && fileMeta.fullDuration && (
        <p className="note long-file">
          This is a long recording ({(fileMeta.fullDuration / 60).toFixed(1)} minutes). Only the first
          {' '}{(fileMeta.duration / 60).toFixed(0)} minutes are loaded, which is plenty for building a loop.
          To work on a later part, trim the file first.
        </p>
      )}

      {fileMeta && (
        <>
          <TransportControls isPlaying={isPlaying} onPlayStateChange={setIsPlaying} hasSelection={Boolean(selection)} />
          <WaveformDisplay
            version={fileVersion}
            isPlaying={isPlaying}
            analysis={analysis}
            selection={selection}
            onSelection={setSelection}
          />
          <AnalysisPanel
            analysis={analysis}
            swapAnchor={swapAnchor}
            onSwapAnchor={() => setSwapAnchor((s) => !s)}
            tempoFactor={tempoFactor}
            onTempoFactor={setTempoFactor}
            selection={selection}
            onAnalyseSelection={() => { setSwapAnchor(false); setTempoFactor(1); setAnalysisRange(selection); }}
            onAnalyseAll={() => { setSwapAnchor(false); setTempoFactor(1); setAnalysisRange(null); }}
          />
          {analysis && (analysis.ok || selection) && (
            <GridPanel
              key={fileVersion}
              analysis={analysis}
              selection={selection}
              onSelection={setSelection}
              onAnalyseSelection={() => { setSwapAnchor(false); setTempoFactor(1); setAnalysisRange(selection); }}
              fileName={fileMeta.name}
              onPreviewChange={setIsPreviewing}
            />
          )}
          <SpectrumAnalyser isPlaying={isPlaying || isPreviewing} />
        </>
      )}

      <footer className="footer">
        <p>
          <strong>Private by design:</strong> recordings are processed entirely in your browser and are
          never uploaded or stored.
        </p>
        <p>
          HeartCode is a music-creation tool. It is not a medical device and must not be used for
          diagnosis or clinical decisions.
        </p>
        <p className="version">HeartCode v{__APP_VERSION__}</p>
      </footer>
    </div>
  );
}

export default App;
