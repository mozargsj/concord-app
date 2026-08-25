import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Eye, Volume2, VolumeX, X } from 'lucide-react';
import MediaStreamVideo from './MediaStreamVideo';
import '../styles/ScreenShareTile.css';

interface ScreenShareTileProps {
  stream: MediaStream;
  isDeafened: boolean;
  isFocused: boolean;
  onCloseFocus: () => void;
  /** The sharer's own outgoing-transmission preview — skips the click-to-view gate (they're
   * already actively sharing, requiring a click to see their own output is just friction) and
   * auto-resumes on refocus instead of needing another click (unlike a viewer's tile of someone
   * else's share). No persistent audio element either: this stream is *their own* capture, so
   * playing its audio back to them would echo whatever system sound they're already hearing
   * directly from the OS. */
  isOwnPreview?: boolean;
}

/**
 * A screen-share tile never plays live the moment it appears — a viewer has to click to start
 * watching (which also focuses/expands the tile, RoomView's existing behavior), and until then
 * it shows a blurred placeholder instead of decoding/painting any video (real resource savings,
 * not just a CSS overlay on top of a live feed). isOwnPreview skips this gate entirely — the
 * sharer is already actively sharing, requiring a click to see their own output would just be
 * friction — but still gets the same focus-driven blur/pause below, just fully automatic on both
 * ends (auto-live, auto-paused, auto-resumed) instead of click-driven. Sending itself is owned
 * entirely outside this component (ServerListPage/MeshManager) and is completely unaffected
 * either way — this only ever touches local rendering of whatever tile it's given.
 *
 * Losing window focus (Concord in the background) auto-pauses the *visual* side of an
 * already-live tile — captures the current frame to a canvas first, so the paused state shows a
 * frozen (blurred) picture rather than going blank. Audio (for a peer's tile, never the
 * own-preview one — see isOwnPreview) is a separate, always-on element once viewing has started
 * at all (hasStartedViewing) — it keeps playing through a focus loss, since only the decode/paint
 * side is what needed pausing for resource savings. Regaining focus resumes the own-preview tile
 * automatically; a peer's tile instead waits for another click, same as the rest of the app's
 * click-to-toggle interactions.
 *
 * The close (X) button lives here rather than in RoomView, even though it also has to unfocus
 * the tile (RoomView's own state) — for a peer's tile, closing is a full reset back to "never
 * clicked" (stops both image and audio); the own-preview tile has no such state to reset, closing
 * it just exits fullscreen and it keeps auto-following Concord's focus as usual.
 */
export default function ScreenShareTile({
  stream,
  isDeafened,
  isFocused,
  onCloseFocus,
  isOwnPreview = false
}: ScreenShareTileProps) {
  const [hasStartedViewing, setHasStartedViewing] = useState(isOwnPreview);
  const [isLive, setIsLive] = useState(isOwnPreview);
  const [frozenFrameUrl, setFrozenFrameUrl] = useState<string | null>(null);
  const [volumePercent, setVolumePercent] = useState(100);
  const [isMuted, setIsMuted] = useState(false);
  const [isVolumeSliderOpen, setIsVolumeSliderOpen] = useState(false);
  const visibleVideoRef = useRef<HTMLVideoElement>(null);
  const audioVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    function handleWindowBlur() {
      const video = visibleVideoRef.current;
      if (video && video.videoWidth > 0) {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
        setFrozenFrameUrl(canvas.toDataURL('image/jpeg', 0.7));
      }
      setIsLive(false);
    }
    // Own-preview auto-resumes the moment Concord is focused again — no click needed, since it's
    // just their own output and there's nothing to "opt into" the way there is for a peer's share.
    function handleWindowFocus() {
      if (!isOwnPreview) return;
      setFrozenFrameUrl(null);
      setIsLive(true);
    }
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('focus', handleWindowFocus);
    return () => {
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [isOwnPreview]);

  // Applies whenever the level changes, and also right after the always-on audio element first
  // mounts (hasStartedViewing flips true) — the element doesn't exist yet before that, so there's
  // nothing to apply to until this effect re-runs post-mount.
  useEffect(() => {
    const audio = audioVideoRef.current;
    if (audio) audio.volume = isMuted ? 0 : volumePercent / 100;
  }, [volumePercent, isMuted, hasStartedViewing]);

  function handleStartViewing() {
    setFrozenFrameUrl(null);
    setIsLive(true);
    setHasStartedViewing(true);
  }

  function handleClose(event: ReactMouseEvent) {
    event.stopPropagation();
    // Full reset back to the pre-first-click state — stops both the image (isLive) and the
    // always-on audio element (hasStartedViewing gates its mount) rather than just leaving
    // everything running quietly behind the collapsed grid tile. Doesn't apply to the own-preview
    // tile — there's no "pre-first-click" state for it to reset to, it just keeps auto-following
    // Concord's own focus like normal once the fullscreen view is closed.
    if (!isOwnPreview) {
      setIsLive(false);
      setHasStartedViewing(false);
      setFrozenFrameUrl(null);
      setIsVolumeSliderOpen(false);
    }
    onCloseFocus();
  }

  // Left click opens/closes the volume ruler. Right click is the dedicated mute toggle — kept
  // separate so neither gesture steps on the other (previously a second left click did double
  // duty as "mute", which conflicts with just wanting to close the ruler without muting).
  function handleVolumeIconClick(event: ReactMouseEvent) {
    event.stopPropagation();
    setIsVolumeSliderOpen((prev) => !prev);
  }

  function handleVolumeIconContextMenu(event: ReactMouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    setIsMuted((prev) => !prev);
  }

  function handleVolumeSliderChange(value: number) {
    setVolumePercent(value);
    if (isMuted && value > 0) setIsMuted(false);
  }

  return (
    <div className="screen-share-tile">
      {/* Always-on once viewing has started at all — independent of isLive, so audio survives a
          focus-loss pause. muted={isDeafened} keeps it in sync with the app's own deafen state,
          same convention as every other remote audio source. Skipped entirely for the own-preview
          tile — playing your own captured system audio back to yourself would just echo whatever
          you're already hearing straight from the OS. */}
      {hasStartedViewing && !isOwnPreview && (
        <MediaStreamVideo stream={stream} muted={isDeafened} hidden videoRef={audioVideoRef} />
      )}

      {isLive ? (
        // muted — the hidden element above already owns audio playback for this stream; playing
        // it here too would double it up.
        <MediaStreamVideo stream={stream} fit="contain" muted videoRef={visibleVideoRef} />
      ) : (
        <button type="button" className="screen-share-tile__overlay" onClick={handleStartViewing}>
          {frozenFrameUrl && <img src={frozenFrameUrl} alt="" className="screen-share-tile__frozen-image" />}
          <div className="screen-share-tile__message">
            <Eye size={22} />
            <span>
              {frozenFrameUrl
                ? 'O compartilhamento pausou para economizar recursos da sua máquina'
                : 'Clique para visualizar'}
            </span>
          </div>
        </button>
      )}

      {isFocused && (
        <button type="button" className="screen-share-tile__close" title="Fechar (Esc)" onClick={handleClose}>
          <X size={14} />
        </button>
      )}

      {/* No volume control on the own-preview tile — there's no audio element here for it to control. */}
      {!isOwnPreview && (
        <div className="screen-share-tile__volume" onClick={(event) => event.stopPropagation()}>
          {isVolumeSliderOpen && (
            <input
              type="range"
              className="screen-share-tile__volume-slider"
              min={0}
              max={100}
              value={isMuted ? 0 : volumePercent}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => handleVolumeSliderChange(Number(event.target.value))}
            />
          )}
          <button
            type="button"
            className={'screen-share-tile__volume-icon' + (isMuted ? ' screen-share-tile__volume-icon--muted' : '')}
            onClick={handleVolumeIconClick}
            onContextMenu={handleVolumeIconContextMenu}
            title={isMuted ? 'Transmissão silenciada (botão direito para reativar)' : 'Volume da transmissão (botão direito para silenciar)'}
          >
            {isMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
        </div>
      )}
    </div>
  );
}
