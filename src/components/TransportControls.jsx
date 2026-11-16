import { play, pause, stop } from '../audio/engine.js';

export default function TransportControls({ isPlaying, onPlayStateChange }) {
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
      <button onClick={handlePlay} disabled={isPlaying}>Play</button>
      <button onClick={handlePause} disabled={!isPlaying}>Pause</button>
      {/* Stop stays enabled while paused so you can return to the start. */}
      <button onClick={handleStop}>Stop</button>
    </div>
  );
}
