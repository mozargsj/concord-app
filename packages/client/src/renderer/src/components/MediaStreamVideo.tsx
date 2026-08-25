import { useEffect, useRef, type RefObject } from 'react';
import { getPreferredDeviceId, onOutputDeviceChange } from '../lib/devicePreferences';

/** setSinkId isn't in the standard DOM typings yet (Audio Output Devices API is still experimental). */
type MediaElementWithSink = HTMLVideoElement & { setSinkId?: (deviceId: string) => Promise<void> };

interface MediaStreamVideoProps {
  stream: MediaStream;
  mirrored?: boolean;
  fit?: 'cover' | 'contain';
  muted?: boolean;
  /** 0-1. Left untouched (browser default of 1) when omitted — ScreenShareTile manages its own
   * volume directly via videoRef instead of this prop, so this only matters for callers that
   * pass it (remote participant tiles, per-peer + master volume combined). */
  volume?: number;
  /** Keeps the element mounted (so its audio track still plays) without showing any picture. */
  hidden?: boolean;
  /** Lets a parent reach the underlying <video> element directly — e.g. ScreenShareTile grabbing
   * a frame onto a canvas right before tearing this element down. Falls back to an internal ref
   * when not provided, same as every other caller today. */
  videoRef?: RefObject<HTMLVideoElement>;
}

export default function MediaStreamVideo({
  stream,
  mirrored,
  fit = 'cover',
  muted = true,
  volume,
  hidden = false,
  videoRef: externalVideoRef
}: MediaStreamVideoProps) {
  const internalVideoRef = useRef<HTMLVideoElement>(null);
  const videoRef = externalVideoRef ?? internalVideoRef;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    return () => {
      video.srcObject = null;
    };
  }, [stream]); // eslint-disable-line react-hooks/exhaustive-deps -- videoRef is stable (own useRef, or caller-owned and unchanging)

  useEffect(() => {
    const video = videoRef.current;
    if (!video || volume === undefined) return;
    video.volume = volume;
  }, [volume]); // eslint-disable-line react-hooks/exhaustive-deps -- videoRef is stable, see effect above

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

  return (
    <video
      ref={videoRef}
      autoPlay
      muted={muted}
      playsInline
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
  );
}
