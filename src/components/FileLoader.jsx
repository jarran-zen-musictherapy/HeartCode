import { useRef } from 'react';
import { decodeFile } from '../audio/engine.js';

export default function FileLoader({ onFileLoaded }) {
  const inputRef = useRef(null);

  async function handleChange(e) {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const meta = await decodeFile(file);
      onFileLoaded({ name: file.name, ...meta });
    } catch (err) {
      console.error('Failed to decode audio file:', err);
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
      />
    </div>
  );
}
