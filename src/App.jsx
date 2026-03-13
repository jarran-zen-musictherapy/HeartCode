import { useState } from 'react';
import FileLoader from './components/FileLoader.jsx';
import TransportControls from './components/TransportControls.jsx';
import WaveformDisplay from './components/WaveformDisplay.jsx';
import SpectrumAnalyser from './components/SpectrumAnalyser.jsx';

function App() {
  const [fileMeta, setFileMeta] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);

  function handleFileLoaded(meta) {
    setFileMeta(meta);
    setIsPlaying(false);
  }

  return (
    <div className="app">
      <h1>HeartCode</h1>
      <p className="subtitle">Audio Processing for Clinical Music Therapy</p>

      <FileLoader onFileLoaded={handleFileLoaded} />

      {fileMeta && (
        <div className="file-info">
          <span><strong>File:</strong> {fileMeta.name}</span>
          <span><strong>Sample Rate:</strong> {fileMeta.sampleRate} Hz</span>
          <span><strong>Duration:</strong> {fileMeta.duration.toFixed(2)}s</span>
          <span><strong>Channels:</strong> {fileMeta.numberOfChannels}</span>
          {fileMeta.sampleRate === 4000 && (
            <span className="badge">(Littmann CORE profile detected)</span>
          )}
        </div>
      )}

      {fileMeta && (
        <>
          <TransportControls isPlaying={isPlaying} onPlayStateChange={setIsPlaying} />
          <WaveformDisplay />
          <SpectrumAnalyser isPlaying={isPlaying} />
        </>
      )}
    </div>
  );
}

export default App;
