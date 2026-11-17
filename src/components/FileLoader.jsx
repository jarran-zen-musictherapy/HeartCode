import { useState } from 'react';
import { decodeFile } from '../audio/engine.js';

export default function FileLoader({ onFileLoaded }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [over, setOver] = useState(false);

  async function loadFile(file) {
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const meta = await decodeFile(file);
      if (!meta) return; // a newer file took over while this one was decoding
      onFileLoaded({ name: file.name, ...meta });
    } catch (err) {
      console.error('Failed to decode audio file:', err);
      setError('Could not read audio from this file. Try a .wav, .m4a or .mp3, or a screen recording saved as .mp4.');
      onFileLoaded(null);
    } finally {
      setLoading(false);
    }
  }

  async function handleChange(e) {
    const input = e.target;
    await loadFile(input.files[0]);
    input.value = ''; // allow re-loading the same file
  }

  function handleDrop(e) {
    e.preventDefault();
    setOver(false);
    if (!loading) loadFile(e.dataTransfer.files[0]);
  }

  return (
    <div
      className={`file-loader drop-zone${over ? ' over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={handleDrop}
    >
      <label htmlFor="audio-file">Load a recording (audio file or screen recording):</label>
      <input
        id="audio-file"
        type="file"
        accept=".wav,.mp3,.m4a,.aac,.mp4,.mov,.aif,.aiff,.flac,.ogg,audio/*,video/mp4,video/quicktime"
        onChange={handleChange}
        disabled={loading}
      />
      <span className="drop-hint">or drop a file here. Video files are fine: only the sound is used.</span>
      {loading && <span className="loading-text">Decoding…</span>}
      {error && <span className="error-text">{error}</span>}
    </div>
  );
}
