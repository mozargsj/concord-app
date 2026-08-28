import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Eye, Volume2, VolumeX, WifiOff, X } from 'lucide-react';
import MediaStreamVideo from './MediaStreamVideo';
import searchingArt from '../assets/images/investigando.png';
import '../styles/ScreenShareTile.css';

// How long to wait for the first real video frame before telling the viewer the connection
// itself seems to have failed, instead of leaving them staring at a black tile with no
// explanation (see decisions.md — reported as a real bug where the tile went black with no
// feedback at all, root cause still being tracked down separately).
const SEARCHING_TIMEOUT_MS = 10000;

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
 * already-live own-preview tile — captures the current frame to a canvas first, so the paused
 * state shows a frozen (blurred) picture rather than going blank, and resumes automatically once
 * Concord is focused again. A peer's tile (isOwnPreview false) is unaffected by focus loss once
 * a viewer has clicked to watch it — it keeps decoding/painting in the background same as if
 * Concord were focused; the only blur a viewer ever sees is the pre-click gate placeholder, which
 * a click (and the explicit "×" close) is what dismisses and restores, never window focus.
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
  // Tracks whether the <video> element has actually started painting real frames yet, separate
  // from isLive (which just means "we're trying to show it") — a track can be connected with
  // zero frames ever arriving (the exact "tela preta" bug reported in real testing), and without
  // this the viewer had no way to tell "still connecting" from "broken".
  const [hasReceivedFrame, setHasReceivedFrame] = useState(isOwnPreview);
  const [connectionFailed, setConnectionFailed] = useState(false);
  // Bumped by the retry button to re-run the waiting-for-frame effect below without needing
  // isLive itself to change (it doesn't, on a retry — the tile is already "live", just stuck).
  const [retryTick, setRetryTick] = useState(0);
  const visibleVideoRef = useRef<HTMLVideoElement>(null);
  const audioVideoRef = useRef<HTMLVideoElement>(null);

  // Own-preview never needs this — it's the local capture, frames are never in question. For a
  // peer's tile, every time it goes live (first click, or a retry) this waits for a real 'playing'
  // event on the video element before trusting it; SEARCHING_TIMEOUT_MS without one means
  // something's actually wrong, not just a normal connection delay.
  useEffect(() => {
    if (!isLive || isOwnPreview) return;
    setHasReceivedFrame(false);
    setConnectionFailed(false);
    const video = visibleVideoRef.current;
    const timeout = setTimeout(() => setConnectionFailed(true), SEARCHING_TIMEOUT_MS);
    function handlePlaying() {
      clearTimeout(timeout);
      setHasReceivedFrame(true);
    }
    video?.addEventListener('playing', handlePlaying);
    return () => {
      clearTimeout(timeout);
      video?.removeEventListener('playing', handlePlaying);
    };
  }, [isLive, isOwnPreview, retryTick]);

  function handleRetrySearching(event: ReactMouseEvent) {
    event.stopPropagation();
    setRetryTick((tick) => tick + 1);
  }

  // Grabs whatever the visible <video> is currently showing onto a canvas, for the placeholder
  // to display in place of a live feed — used both by the own-preview auto-pause below and by a
  // viewer's explicit close, so the tile never just goes blank between "was showing something"
  // and "back to the click gate". Returns null when there's nothing real to capture yet (video
  // never reached a frame — same guard as before).
  function captureFrozenFrame(): string | null {
    const video = visibleVideoRef.current;
    if (!video || video.videoWidth === 0) return null;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.7);
  }

  useEffect(() => {
    function handleWindowBlur() {
      // Only the sharer's own preview auto-pauses on focus loss — once a viewer has clicked to
      // watch someone else's share, it keeps playing even with Concord in the background. The
      // gate before that first click already shows its own placeholder regardless of focus, so
      // there's nothing left for this handler to do for a viewer's tile.
      if (!isOwnPreview) return;
      setFrozenFrameUrl(captureFrozenFrame());
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
    // always-on audio element (hasStartedViewing gates its mount, so this also cuts the audio)
    // rather than just leaving everything running quietly behind the collapsed grid tile.
    // Captures a frozen frame first (same helper the own-preview auto-pause uses) so the gate
    // shows a blurred static picture of where the transmission left off instead of going
    // straight back to a plain "Clique para visualizar" — it only becomes live (and audible)
    // again once clicked. Doesn't apply to the own-preview tile — there's no "pre-first-click"
    // state for it to reset to, it just keeps auto-following Concord's own focus like normal
    // once the fullscreen view is closed.
    if (!isOwnPreview) {
      setFrozenFrameUrl(captureFrozenFrame());
      setIsLive(false);
      setHasStartedViewing(false);
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
        <div className="screen-share-tile__live-wrap">
          {/* muted — the hidden element above already owns audio playback for this stream;
              playing it here too would double it up. Stays mounted even while the searching/
              failed overlay covers it, since it's the same element whose 'playing' event the
              effect above is listening for — swapping it out would mean it never fires. */}
          <MediaStreamVideo stream={stream} fit="contain" muted videoRef={visibleVideoRef} />
          {!hasReceivedFrame && !connectionFailed && (
            <div className="screen-share-tile__overlay screen-share-tile__overlay--searching">
              <div className="screen-share-tile__message">
                <img src={searchingArt} alt="" className="screen-share-tile__searching-icon" />
                <span>Buscando transmissão...</span>
              </div>
            </div>
          )}
          {connectionFailed && (
            <div className="screen-share-tile__overlay screen-share-tile__overlay--failed">
              <div className="screen-share-tile__message">
                <WifiOff size={22} />
                <span>Não foi possível carregar essa transmissão.</span>
                <button type="button" className="screen-share-tile__retry" onClick={handleRetrySearching}>
                  Tentar novamente
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <button type="button" className="screen-share-tile__overlay" onClick={handleStartViewing}>
          {frozenFrameUrl && <img src={frozenFrameUrl} alt="" className="screen-share-tile__frozen-image" />}
          <div className="screen-share-tile__message">
            <Eye size={22} />
            <span>
              {/* The "pausou" wording only makes sense for the own-preview auto-pause — a
                  viewer's frozenFrameUrl only ever comes from an explicit close now, so it gets
                  the same "click to view" prompt as the never-clicked-yet state, just with the
                  last frame blurred behind it instead of nothing. */}
              {isOwnPreview && frozenFrameUrl
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
