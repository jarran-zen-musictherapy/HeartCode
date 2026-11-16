import { useState } from 'react';
import { decodeFile } from '../audio/engine.js';

export default function FileLoader({ onFileLoaded }) {
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
      setError('Could not read audio from this file. Try a .wav, .m4a or .mp3, or a screen recording saved as .mp4.');
      onFileLoaded(null);
    } finally {
      setLoading(false);
      e.target.value = ''; // allow re-loading the same file
    }
  }

  return (
    <div className="file-loader">
      <label htmlFor="audio-file">Load a recording (audio file or screen recording):</label>
      <input
        id="audio-file"
        type="file"
        accept=".wav,.mp3,.m4a,.aac,.mp4,.mov,.aif,.aiff,.flac,.ogg,audio/*,video/mp4,video/quicktime"
        onChange={handleChange}
        disabled={loading}
      />
      {loading && <span className="loading-text">Decoding…</span>}
      {error && <span className="error-text">{error}</span>}
    </div>
  );
}
