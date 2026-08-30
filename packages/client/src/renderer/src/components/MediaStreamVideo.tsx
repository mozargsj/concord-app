import { useEffect, useRef, type RefObject } from 'react';
import { getPreferredDeviceId, onOutputDeviceChange } from '../lib/devicePreferences';

/** setSinkId isn't in the standard DOM typings yet (Audio Output Devices API is still experimental). */
type MediaElementWithSink = HTMLMediaElement & { setSinkId?: (deviceId: string) => Promise<void> };

// [2026-08-30, pedido do Mozar] Shared across every instance — multiple MediaStreamAudioSourceNode
// can tap different streams on the same AudioContext with no conflict, no reason to pay for one
// context per peer tile. Created lazily (only once a caller actually passes `volume`, i.e. only
// for peer audio — a caller with no `volume` prop never touches this at all).
let sharedAudioContext: AudioContext | null = null;
function getSharedAudioContext(): AudioContext {
  if (!sharedAudioContext) sharedAudioContext = new AudioContext();
  return sharedAudioContext;
}

interface MediaStreamVideoProps {
  stream: MediaStream;
  mirrored?: boolean;
  fit?: 'cover' | 'contain';
  muted?: boolean;
  /** 0-2 (0-200%). Left untouched (browser default of 1) when omitted — ScreenShareTile manages
   * its own volume directly via videoRef instead of this prop, so this only matters for callers
   * that pass it (remote participant tiles, per-peer + master volume combined). Whenever this is
   * passed, audio is routed through a Web Audio GainNode instead of the native <video>.volume —
   * HTMLMediaElement.volume is spec-capped at 1.0 (100%), so anything above that (the "ganho"
   * pedido pelo Mozar, até 200%) can only work through Web Audio, not the native attribute. The
   * native element's own audio is muted either way once this prop is passed, to avoid doubling up. */
  volume?: number;
  /** Keeps the element mounted (so its audio track still plays) without showing any picture. */
  hidden?: boolean;
  /** Lets a parent reach the underlying <video> element directly — e.g. ScreenShareTile grabbing
   * a frame onto a canvas right before tearing this element down. Falls back to an internal ref
   * when not provided, same as every other caller today. */
  videoRef?: RefObject<HTMLVideoElement>;
  /** [2026-08-30, pedido do Mozar] Fires once real pixel dimensions are known (video's own
   * `loadedmetadata`, same event the frame-capture logic elsewhere already waits on implicitly
   * via videoWidth) — RoomView.tsx uses this to shape the focused tile's letterbox to the real
   * proporção transmitida (16:9, 21:9, 4:3, o que for) em vez de sempre travar em 16:9. */
  onDimensionsChange?: (width: number, height: number) => void;
}

export default function MediaStreamVideo({
  stream,
  mirrored,
  fit = 'cover',
  muted = true,
  volume,
  hidden = false,
  videoRef: externalVideoRef,
  onDimensionsChange
}: MediaStreamVideoProps) {
  const internalVideoRef = useRef<HTMLVideoElement>(null);
  const videoRef = externalVideoRef ?? internalVideoRef;
  const boostedAudioRef = useRef<HTMLAudioElement>(null);
  const gainNodeRef = useRef<GainNode | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    return () => {
      video.srcObject = null;
    };
  }, [stream]); // eslint-disable-line react-hooks/exhaustive-deps -- videoRef is stable (own useRef, or caller-owned and unchanging)

  // Builds/tears down the boost graph once per stream (not per volume tick — see the effect
  // below for that). Only when a caller actually passes `volume` at all: a `volume` of exactly 1
  // still goes through here (keeps one code path instead of a magic ">1" threshold switching
  // between native and Web Audio mid-drag), but a caller that never passes `volume` (self-preview
  // etc.) never touches any of this.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || volume === undefined) return;
    if (stream.getAudioTracks().length === 0) return; // video-only stream — nothing to route

    // Native audio is muted declaratively below (nativeMuted, the JSX `muted` attribute) — not
    // set imperatively here, since React re-applies its own `muted` prop on every unrelated
    // re-render (this effect only reruns on stream change) and would silently win that fight,
    // eventually letting native audio play back alongside the boosted audio.
    const ctx = getSharedAudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    const destination = ctx.createMediaStreamDestination();
    source.connect(gain);
    gain.connect(destination);
    gainNodeRef.current = gain;

    const boostedAudio = boostedAudioRef.current;
    if (boostedAudio) boostedAudio.srcObject = destination.stream;

    return () => {
      source.disconnect();
      gain.disconnect();
      gainNodeRef.current = null;
      if (boostedAudio) boostedAudio.srcObject = null;
    };
    // `volume !== undefined` (not `volume` itself) — rebuilds only when a caller starts/stops
    // passing volume at all, never on every value tick while it's already active (that's the
    // effect below, a plain gain.value write, much cheaper than tearing down/rebuilding nodes).
  }, [stream, volume !== undefined]); // eslint-disable-line react-hooks/exhaustive-deps -- videoRef/boostedAudioRef stable

  useEffect(() => {
    const video = videoRef.current;
    if (!video || volume === undefined) return;
    // `muted` must win here too — once a caller passes `volume` at all, the native element's own
    // `muted` attribute (below) no longer gates what's actually audible (that's this gain/volume
    // instead), so deafen/mute has to be folded into the same value or it becomes a no-op for
    // every caller that also passes `volume` (every real peer tile, via getPeerVolume).
    const effectiveVolume = muted ? 0 : volume;
    if (gainNodeRef.current) {
      // Instant, not ramped — this doubles as the deafen/mute path, which should cut immediately,
      // not fade.
      gainNodeRef.current.gain.value = effectiveVolume;
    } else {
      // No audio track on this stream (graph above never built) — nothing to boost, but keep the
      // native element's volume in sync anyway in case a track shows up later without a re-mount.
      video.volume = Math.max(0, Math.min(1, effectiveVolume));
    }
  }, [volume, muted]); // eslint-disable-line react-hooks/exhaustive-deps -- videoRef/gainNodeRef stable

  useEffect(() => {
    const video = videoRef.current as MediaElementWithSink | null;
    if (!video?.setSinkId) return;

    const applyPreferred = (deviceId: string) => {
      video.setSinkId?.(deviceId).catch(() => {
        // some outputs (e.g. default) can't be set as a sink on every platform — ignore
      });
    };

    const preferred = getPreferredDeviceId('audiooutput');
    if (preferred) applyPreferred(preferred);

    return onOutputDeviceChange(applyPreferred);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- videoRef is stable, see effect above

  // Same output-device preference applies to the boosted-audio element as the video element —
  // when `volume` isn't passed this element never gets a srcObject (still mounted, just silent).
  useEffect(() => {
    const audio = boostedAudioRef.current as MediaElementWithSink | null;
    if (!audio?.setSinkId) return;

    const applyPreferred = (deviceId: string) => {
      audio.setSinkId?.(deviceId).catch(() => {});
    };

    const preferred = getPreferredDeviceId('audiooutput');
    if (preferred) applyPreferred(preferred);

    return onOutputDeviceChange(applyPreferred);
  }, []);

  // Once `volume` is passed at all, Web Audio owns playback (see the effect above) — the native
  // element must stay muted regardless of the `muted` prop, or its own audio plays back alongside
  // the boosted copy.
  const nativeMuted = muted || volume !== undefined;

  return (
    <>
      <video
        ref={videoRef}
        autoPlay
        muted={nativeMuted}
        playsInline
        onLoadedMetadata={
          onDimensionsChange
            ? (event) => {
                const video = event.currentTarget;
                if (video.videoWidth > 0 && video.videoHeight > 0) {
                  onDimensionsChange(video.videoWidth, video.videoHeight);
                }
              }
            : undefined
        }
        style={
          hidden
            ? { position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }
            : {
                width: '100%',
                height: '100%',
                objectFit: fit,
                background: '#000000',
                transform: mirrored ? 'scaleX(-1)' : undefined
              }
        }
      />
      {volume !== undefined && (
        <audio ref={boostedAudioRef} autoPlay style={{ display: 'none' }} />
      )}
    </>
  );
}
