import { play, pause, stop } from '../audio/engine.js';

export default function TransportControls({ onPlayStateChange }) {
  function handlePlay() {
    play();
    onPlayStateChange(true);
  }

  function handlePause() {
    pause();
    onPlayStateChange(false);
  }

  function handleStop() {
    stop();
    onPlayStateChange(false);
  }

  return (
    <div className="transport-controls">
      <button onClick={handlePlay}>Play</button>
      <button onClick={handlePause}>Pause</button>
      <button onClick={handleStop}>Stop</button>
    </div>
  );
}
