import { useRef, useState } from 'react';
import { decodeFile } from '../audio/engine.js';

export default function FileLoader({ onFileLoaded }) {
  const inputRef = useRef(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleChange(e) {
    const file = e.target.files[0];
    if (!file) return;

    setLoading(true);
    setError(null);

    try {
      const meta = await decodeFile(file);
      onFileLoaded({ name: file.name, ...meta });
    } catch (err) {
      console.error('Failed to decode audio file:', err);
      setError('Could not decode this file. Please use a valid .wav or .mp3.');
      onFileLoaded(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="file-loader">
      <label htmlFor="audio-file">Load audio file:</label>
      <input
        ref={inputRef}
        id="audio-file"
        type="file"
        accept=".wav,.mp3"
        onChange={handleChange}
        disabled={loading}
      />
      {loading && <span className="loading-text">Decoding…</span>}
      {error && <span className="error-text">{error}</span>}
    </div>
  );
}
