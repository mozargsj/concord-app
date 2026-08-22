import { useEffect, useRef } from 'react';

interface MediaStreamVideoProps {
  stream: MediaStream;
  mirrored?: boolean;
  fit?: 'cover' | 'contain';
}

export default function MediaStreamVideo({ stream, mirrored, fit = 'cover' }: MediaStreamVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  return (
    <video
      ref={videoRef}
      autoPlay
      muted
      playsInline
      style={{
        width: '100%',
        height: '100%',
        objectFit: fit,
        background: '#000000',
        transform: mirrored ? 'scaleX(-1)' : undefined
      }}
    />
  );
}
