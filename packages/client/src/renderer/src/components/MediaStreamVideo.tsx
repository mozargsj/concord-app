import { useEffect, useRef } from 'react';
import { getPreferredDeviceId, onOutputDeviceChange } from '../lib/devicePreferences';

/** setSinkId isn't in the standard DOM typings yet (Audio Output Devices API is still experimental). */
type MediaElementWithSink = HTMLVideoElement & { setSinkId?: (deviceId: string) => Promise<void> };

interface MediaStreamVideoProps {
  stream: MediaStream;
  mirrored?: boolean;
  fit?: 'cover' | 'contain';
  muted?: boolean;
  /** Keeps the element mounted (so its audio track still plays) without showing any picture. */
  hidden?: boolean;
}

export default function MediaStreamVideo({
  stream,
  mirrored,
  fit = 'cover',
  muted = true,
  hidden = false
}: MediaStreamVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

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
  }, []);

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
