import { useEffect, useState } from 'react';
import FileLoader from './components/FileLoader.jsx';
import TransportControls from './components/TransportControls.jsx';
import WaveformDisplay from './components/WaveformDisplay.jsx';
import SpectrumAnalyser from './components/SpectrumAnalyser.jsx';
import AnalysisPanel from './components/AnalysisPanel.jsx';
import GridPanel from './components/GridPanel.jsx';
import { getAnalysisData, onEnded } from './audio/engine.js';
import { analyseHeartbeat } from './analysis/detect.js';

function App() {
  const [fileMeta, setFileMeta] = useState(null);
  const [fileVersion, setFileVersion] = useState(0); // bumps on every load, even of the same file
  const [isPlaying, setIsPlaying] = useState(false);
  const [analysis, setAnalysis] = useState(null);
  const [swapAnchor, setSwapAnchor] = useState(false);
  const [tempoFactor, setTempoFactor] = useState(1); // 1, 0.5 or 2: manual half/double override
  const [isPreviewing, setIsPreviewing] = useState(false);

  // Keep the buttons honest when playback reaches the end by itself.
  useEffect(() => onEnded(() => setIsPlaying(false)), []);

  // Analyse whenever a file loads or the S1/S2 choice is flipped.
  useEffect(() => {
    if (!fileMeta) return undefined;
    const data = getAnalysisData();
    if (!data) return undefined;
    // Defer one tick so the waveform paints before the number crunching.
    const id = setTimeout(() => {
      setAnalysis(analyseHeartbeat(data.pcm, data.sampleRate, { swapAnchor, tempoFactor }));
    }, 0);
    return () => clearTimeout(id);
  }, [fileMeta, fileVersion, swapAnchor, tempoFactor]);

  function handleFileLoaded(meta) {
    setIsPlaying(false);
    setAnalysis(null);
    setSwapAnchor(false);
    setTempoFactor(1);
    setFileMeta(meta);
    setFileVersion((v) => v + 1);
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
        </div>
      )}

      {fileMeta && (
        <>
          <TransportControls isPlaying={isPlaying} onPlayStateChange={setIsPlaying} />
          <WaveformDisplay version={fileVersion} isPlaying={isPlaying} analysis={analysis} />
          <AnalysisPanel
            analysis={analysis}
            swapAnchor={swapAnchor}
            onSwapAnchor={() => setSwapAnchor((s) => !s)}
            tempoFactor={tempoFactor}
            onTempoFactor={setTempoFactor}
          />
          {analysis && analysis.ok && (
            <GridPanel
              key={fileVersion}
              analysis={analysis}
              fileName={fileMeta.name}
              onPreviewChange={setIsPreviewing}
            />
          )}
          <SpectrumAnalyser isPlaying={isPlaying || isPreviewing} />
        </>
      )}
    </div>
  );
}

export default App;
