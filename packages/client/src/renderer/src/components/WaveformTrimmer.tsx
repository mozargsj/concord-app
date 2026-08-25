import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import '../styles/WaveformTrimmer.css';

const CANVAS_WIDTH = 480;
const CANVAS_HEIGHT = 88;
const MIN_SELECTION_SEC = 0.2;

interface WaveformTrimmerProps {
  buffer: AudioBuffer;
  maxDurationSec: number;
  onRangeChange: (startSec: number, endSec: number) => void;
  /** Where playback currently is (absolute seconds into the full buffer) — null/undefined hides
   * the line entirely. Draggable regardless of whether playback is active, so the user can jump
   * back to a point they want to re-hear (onSeekPlayhead). */
  playheadSec?: number | null;
  onSeekPlayhead?: (sec: number) => void;
}

type DragMode = 'start' | 'end' | 'move' | 'playhead';

interface DragState {
  mode: DragMode;
  startClientX: number;
  startSec: number;
  endSec: number;
}

/** Waveform preview with a draggable trim window (start/end handles, or drag the body to shift
 * the whole window) — the selection is capped at maxDurationSec, per the soundboard's 15s limit. */
export default function WaveformTrimmer({
  buffer,
  maxDurationSec,
  onRangeChange,
  playheadSec = null,
  onSeekPlayhead
}: WaveformTrimmerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const duration = buffer.duration;

  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(Math.min(duration, maxDurationSec));

  const peaks = useMemo(() => computePeaks(buffer, CANVAS_WIDTH), [buffer]);

  useEffect(() => {
    onRangeChange(startSec, endSec);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- report every change, callback identity isn't a dep
  }, [startSec, endSec]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    ctx.fillStyle = '#5b6dfa';
    const mid = CANVAS_HEIGHT / 2;
    for (let x = 0; x < peaks.length; x++) {
      const amplitude = Math.max(1, peaks[x] * mid);
      ctx.fillRect(x, mid - amplitude, 1, amplitude * 2);
    }
  }, [peaks]);

  function secToPercent(sec: number): number {
    return duration > 0 ? (sec / duration) * 100 : 0;
  }

  function clientXToSec(clientX: number): number {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * duration;
  }

  function handlePointerDown(mode: DragMode, event: ReactPointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { mode, startClientX: event.clientX, startSec, endSec };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  }

  function handlePointerMove(event: PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;

    if (drag.mode === 'playhead') {
      // Absolute (not delta-based) — a scrubber tracks the cursor directly, clamped to the
      // trimmed selection since that's the only range preview playback ever covers.
      const sec = Math.max(startSec, Math.min(endSec, clientXToSec(event.clientX)));
      onSeekPlayhead?.(sec);
      return;
    }

    const deltaSec = clientXToSec(event.clientX) - clientXToSec(drag.startClientX);

    if (drag.mode === 'start') {
      let next = drag.startSec + deltaSec;
      next = Math.max(0, Math.min(next, drag.endSec - MIN_SELECTION_SEC));
      if (drag.endSec - next > maxDurationSec) next = drag.endSec - maxDurationSec;
      setStartSec(Math.max(0, next));
    } else if (drag.mode === 'end') {
      let next = drag.endSec + deltaSec;
      next = Math.min(duration, Math.max(next, drag.startSec + MIN_SELECTION_SEC));
      if (next - drag.startSec > maxDurationSec) next = drag.startSec + maxDurationSec;
      setEndSec(Math.min(duration, next));
    } else {
      const windowLength = drag.endSec - drag.startSec;
      let nextStart = drag.startSec + deltaSec;
      nextStart = Math.max(0, Math.min(nextStart, duration - windowLength));
      setStartSec(nextStart);
      setEndSec(nextStart + windowLength);
    }
  }

  function handlePointerUp() {
    dragRef.current = null;
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
  }

  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cleanup only, not a live subscription
  }, []);

  const selectionLeftPct = secToPercent(startSec);
  const selectionWidthPct = secToPercent(endSec) - selectionLeftPct;

  return (
    <div className="waveform-trimmer">
      <div className="waveform-trimmer__stage" ref={containerRef}>
        <canvas ref={canvasRef} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} className="waveform-trimmer__canvas" />
        <div className="waveform-trimmer__mask" style={{ left: 0, width: `${selectionLeftPct}%` }} />
        <div
          className="waveform-trimmer__mask"
          style={{ left: `${selectionLeftPct + selectionWidthPct}%`, right: 0 }}
        />
        <div
          className="waveform-trimmer__selection"
          style={{ left: `${selectionLeftPct}%`, width: `${selectionWidthPct}%` }}
          onPointerDown={(event) => handlePointerDown('move', event)}
        >
          <div className="waveform-trimmer__handle waveform-trimmer__handle--start" onPointerDown={(event) => handlePointerDown('start', event)} />
          <div className="waveform-trimmer__handle waveform-trimmer__handle--end" onPointerDown={(event) => handlePointerDown('end', event)} />
        </div>
        {playheadSec !== null && (
          <div
            className="waveform-trimmer__playhead"
            style={{ left: `${secToPercent(playheadSec)}%` }}
            onPointerDown={(event) => handlePointerDown('playhead', event)}
          />
        )}
      </div>
      <div className="waveform-trimmer__duration">
        {(endSec - startSec).toFixed(1)}s selecionados (máx. {maxDurationSec}s)
      </div>
    </div>
  );
}

function computePeaks(buffer: AudioBuffer, width: number): number[] {
  const data = buffer.getChannelData(0);
  const blockSize = Math.max(1, Math.floor(data.length / width));
  const peaks: number[] = [];
  for (let i = 0; i < width; i++) {
    const start = i * blockSize;
    let max = 0;
    for (let j = 0; j < blockSize && start + j < data.length; j++) {
      const value = Math.abs(data[start + j]);
      if (value > max) max = value;
    }
    peaks.push(max);
  }
  return peaks;
}
