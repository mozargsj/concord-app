import { useEffect, useRef, useState } from 'react';
import type { RoomSummary } from '@concord/shared';
import type { ScreenSource } from '../types/window';
import micOffIcon from '../assets/icons/mic-off.svg';
import closeIcon from '../assets/icons/window-close.svg';
import CallControls from './CallControls';
import ScreenSharePicker from './ScreenSharePicker';
import MediaStreamVideo from './MediaStreamVideo';
import { mockCurrentUser, mockParticipantsByRoom } from '../fixtures/mockData';
import { getAvatarColor } from '../lib/avatarColor';
import { getGridContainerStyle, getGridItemStyle } from '../lib/participantGrid';
import { getPreferredDeviceId } from '../lib/devicePreferences';
import '../styles/RoomView.css';

interface RoomViewProps {
  room: RoomSummary | null;
  isMicMuted: boolean;
  onToggleMic: () => void;
  isSpeaking: boolean;
  onLeave: () => void;
}

type Tile =
  | { kind: 'participant'; key: string; name: string; isSelf: boolean }
  | { kind: 'screen'; key: string; name: string; stream: MediaStream };

export default function RoomView({ room, isMicMuted, onToggleMic, isSpeaking, onLeave }: RoomViewProps) {
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [focusedTileKey, setFocusedTileKey] = useState<string | null>(null);

  const cameraStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);

  // Stop every local track on unmount / leaving the room — real local capture,
  // never sent anywhere (no RTCPeerConnection yet), but the hardware indicator
  // light must still turn off like it would for any other app.
  useEffect(() => {
    if (room) return;
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    screenStreamRef.current = null;
    setCameraStream(null);
    setScreenStream(null);
    setFocusedTileKey(null);
  }, [room]);

  useEffect(() => {
    return () => {
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setFocusedTileKey(null);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // If the focused tile disappears (e.g. screen share stopped), fall back to the grid.
  useEffect(() => {
    if (focusedTileKey && focusedTileKey !== 'self-screen') return;
    if (focusedTileKey === 'self-screen' && !screenStream) setFocusedTileKey(null);
  }, [focusedTileKey, screenStream]);

  async function startCamera(deviceId?: string) {
    const preferred = deviceId ?? getPreferredDeviceId('videoinput') ?? undefined;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: preferred ? { deviceId: { exact: preferred } } : true
      });
      cameraStreamRef.current = stream;
      setCameraStream(stream);
      setMediaError(null);
    } catch (error) {
      setMediaError(error instanceof Error ? error.message : 'Não foi possível acessar a câmera.');
    }
  }

  async function handleToggleCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
      setCameraStream(null);
      return;
    }
    await startCamera();
  }

  async function handleSelectCamera(deviceId: string) {
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
      setCameraStream(null);
      await startCamera(deviceId);
    }
  }

  function handleToggleScreenShare() {
    if (screenStream) {
      screenStream.getTracks().forEach((track) => track.stop());
      screenStreamRef.current = null;
      setScreenStream(null);
      setFocusedTileKey(null);
      return;
    }
    setIsPickerOpen(true);
  }

  async function handlePickSource(source: ScreenSource, includeAudio: boolean) {
    setIsPickerOpen(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // Electron's documented desktopCapturer pattern — legacy constraint
        // shape is still how Chromium wires a specific screen/window id in.
        // System-audio loopback via chromeMediaSource:'desktop' is Windows-only
        // and only reliable for whole-screen sources, not individual windows.
        audio: includeAudio ? ({ mandatory: { chromeMediaSource: 'desktop' } } as MediaTrackConstraints) : false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: source.id
          }
        } as MediaTrackConstraints
      });
      screenStreamRef.current = stream;
      setScreenStream(stream);
      setMediaError(null);
    } catch (error) {
      setMediaError(
        error instanceof Error ? error.message : 'Não foi possível capturar a tela escolhida.'
      );
    }
  }

  if (!room) {
    return (
      <div className="room-view room-view--empty">
        <p>Selecione uma sala para entrar.</p>
      </div>
    );
  }

  const others = mockParticipantsByRoom[room.id] ?? [];
  const tiles: Tile[] = [
    { kind: 'participant', key: 'self', name: mockCurrentUser.displayName, isSelf: true },
    ...others.map((name): Tile => ({ kind: 'participant', key: name, name, isSelf: false }))
  ];
  if (screenStream) {
    tiles.push({
      kind: 'screen',
      key: 'self-screen',
      name: `${mockCurrentUser.displayName} — Tela`,
      stream: screenStream
    });
  }

  return (
    <div className="room-view">
      {mediaError && <div className="room-view__error">{mediaError}</div>}

      <div className="room-view__participants" style={getGridContainerStyle(tiles.length)}>
        {tiles.map((tile, index) => {
          const speaking = tile.kind === 'participant' && tile.isSelf && isSpeaking && !isMicMuted;
          const muted = tile.kind === 'participant' && tile.isSelf && isMicMuted;
          const showCamera = tile.kind === 'participant' && tile.isSelf && cameraStream;
          const isFocused = tile.key === focusedTileKey;
          const isFocusable = tile.kind === 'screen';

          const media =
            tile.kind === 'screen' ? (
              <MediaStreamVideo stream={tile.stream} fit="contain" />
            ) : showCamera ? (
              <MediaStreamVideo stream={cameraStream} mirrored fit="cover" />
            ) : (
              <div
                className={'room-view__avatar' + (speaking ? ' room-view__avatar--speaking' : '')}
                style={{ background: getAvatarColor(tile.name) }}
              >
                {tile.name.charAt(0)}
              </div>
            );

          const status = (
            <div className="room-view__participant-status">
              {muted && <img src={micOffIcon} alt="" className="room-view__participant-status-icon" />}
              <span>{tile.name}</span>
            </div>
          );

          return (
            <div
              key={tile.key}
              className={
                'room-view__participant-tile' +
                (isFocused ? ' room-view__participant-tile--focused' : '') +
                (isFocusable ? ' room-view__participant-tile--focusable' : '')
              }
              style={isFocused ? undefined : getGridItemStyle(index, tiles.length)}
              onClick={isFocusable && !isFocused ? () => setFocusedTileKey(tile.key) : undefined}
            >
              {isFocused ? (
                // Locked to 16:9, letterboxed, even when the available space isn't
                // that shape — the transmission's own aspect (via object-fit:contain
                // on the video) can add further black bars inside this box too.
                <div className="room-view__focus-frame">
                  {media}
                  <button
                    className="room-view__focus-close"
                    title="Fechar (Esc)"
                    onClick={(event) => {
                      event.stopPropagation();
                      setFocusedTileKey(null);
                    }}
                  >
                    <img src={closeIcon} alt="" />
                  </button>
                  {status}
                </div>
              ) : (
                <>
                  {media}
                  {status}
                </>
              )}
            </div>
          );
        })}
      </div>

      <CallControls
        isMicMuted={isMicMuted}
        onToggleMic={onToggleMic}
        isCameraOn={!!cameraStream}
        onToggleCamera={handleToggleCamera}
        onSelectCamera={handleSelectCamera}
        isSharingScreen={!!screenStream}
        onToggleScreenShare={handleToggleScreenShare}
        onLeave={onLeave}
      />

      {isPickerOpen && (
        <ScreenSharePicker onSelect={handlePickSource} onClose={() => setIsPickerOpen(false)} />
      )}
    </div>
  );
}
