import { useEffect, useRef, useState } from 'react';
import type { RoomSummary } from '@concord/shared';
import type { RoomPeer } from '../hooks/useRoomConnection';
import { MicOff, X } from 'lucide-react';
import CallControls from './CallControls';
import MediaStreamVideo from './MediaStreamVideo';
import HostStarBadge from './HostStarBadge';
import LiveBadge from './LiveBadge';
import { getAvatarColor } from '../lib/avatarColor';
import { getGridContainerStyle, getGridItemStyle } from '../lib/participantGrid';
import { playCameraStart, playTransmissionEnter, playTransmissionExit } from '../lib/soundEffects';
import '../styles/RoomView.css';

interface RoomViewProps {
  room: RoomSummary | null;
  isMicMuted: boolean;
  onToggleMic: () => void;
  onSelectMic: (deviceId: string) => void;
  isSpeaking: boolean;
  onLeave: () => void;
  isDeafened: boolean;
  selfPeerId: string | null;
  hostPeerId: string | null;
  peers: RoomPeer[];
  currentUserDisplayName: string;
  // Camera/screen capture is owned by ServerListPage (not this component) — RoomSidebar's
  // quick-action row needs to toggle and reflect the same state, same "elevated to feed two
  // places at once" pattern as selfIsSpeaking/latencyMs in useRoomConnection.
  cameraStream: MediaStream | null;
  screenStream: MediaStream | null;
  mediaError: string | null;
  onToggleCamera: () => void;
  onSelectCamera: (deviceId: string) => void;
  onToggleScreenShare: () => void;
}

type Tile =
  | {
      kind: 'participant';
      key: string;
      name: string;
      isSelf: boolean;
      isHost: boolean;
      stream: MediaStream | null;
      isSpeaking: boolean;
    }
  | { kind: 'screen'; key: string; name: string; stream: MediaStream };

export default function RoomView({
  room,
  isMicMuted,
  onToggleMic,
  onSelectMic,
  isSpeaking,
  onLeave,
  isDeafened,
  selfPeerId,
  hostPeerId,
  peers,
  currentUserDisplayName,
  cameraStream,
  screenStream,
  mediaError,
  onToggleCamera,
  onSelectCamera,
  onToggleScreenShare
}: RoomViewProps) {
  const [focusedTileKey, setFocusedTileKey] = useState<string | null>(null);

  const peerMediaRef = useRef<Map<string, { hasVideo: boolean; hasScreen: boolean }>>(new Map());

  // Sound cues for peers' camera/screen state changing — no protocol message needed, each
  // client already observes the transition directly from the mesh's own stream state (works
  // identically whether a peer just started sharing, or I just joined mid-transmission).
  useEffect(() => {
    if (!room) return;
    const previous = peerMediaRef.current;
    const next = new Map<string, { hasVideo: boolean; hasScreen: boolean }>();

    for (const peer of peers) {
      const hasVideo = !!peer.personalStream && peer.personalStream.getVideoTracks().length > 0;
      const hasScreen = !!peer.screenStream;
      const prevState = previous.get(peer.peerId);

      if (hasVideo && !prevState?.hasVideo) playCameraStart();
      if (hasScreen && !prevState?.hasScreen) playTransmissionEnter();
      if (!hasScreen && prevState?.hasScreen) playTransmissionExit();

      next.set(peer.peerId, { hasVideo, hasScreen });
    }

    peerMediaRef.current = next;
  }, [room, peers]);

  // Camera/screen tracks themselves are stopped by ServerListPage (which owns them) — this
  // just resets this component's own local UI state when the room goes away.
  useEffect(() => {
    if (!room) setFocusedTileKey(null);
  }, [room]);

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

  if (!room) {
    return (
      <div className="room-view room-view--empty">
        <p>Selecione uma sala para entrar.</p>
      </div>
    );
  }

  const isSelfHost = selfPeerId !== null && selfPeerId === hostPeerId;
  const tiles: Tile[] = [
    {
      kind: 'participant',
      key: 'self',
      name: currentUserDisplayName,
      isSelf: true,
      isHost: isSelfHost,
      stream: null,
      isSpeaking: isSpeaking && !isMicMuted
    },
    ...peers.map(
      (peer): Tile => ({
        kind: 'participant',
        key: peer.peerId,
        name: peer.displayName,
        isSelf: false,
        isHost: peer.peerId === hostPeerId,
        stream: peer.personalStream,
        isSpeaking: peer.isSpeaking
      })
    )
  ];
  if (screenStream) {
    tiles.push({
      kind: 'screen',
      key: 'self-screen',
      name: `${currentUserDisplayName} — Tela`,
      stream: screenStream
    });
  }
  for (const peer of peers) {
    if (peer.screenStream) {
      tiles.push({
        kind: 'screen',
        key: `${peer.peerId}-screen`,
        name: `${peer.displayName} — Tela`,
        stream: peer.screenStream
      });
    }
  }

  return (
    <div className="room-view">
      {mediaError && <div className="room-view__error">{mediaError}</div>}

      <div className="room-view__participants" style={getGridContainerStyle(tiles.length)}>
        {tiles.map((tile, index) => {
          const speaking = tile.kind === 'participant' && tile.isSpeaking;
          const muted = tile.kind === 'participant' && tile.isSelf && isMicMuted;
          const showCamera = tile.kind === 'participant' && tile.isSelf && cameraStream;
          const remoteStream = tile.kind === 'participant' && !tile.isSelf ? tile.stream : null;
          const hasRemoteVideo = !!remoteStream && remoteStream.getVideoTracks().length > 0;
          const isFocused = tile.key === focusedTileKey;
          const isFocusable = tile.kind === 'screen';

          const media =
            tile.kind === 'screen' ? (
              <MediaStreamVideo stream={tile.stream} fit="contain" />
            ) : showCamera ? (
              <MediaStreamVideo stream={cameraStream} mirrored fit="cover" />
            ) : hasRemoteVideo ? (
              <MediaStreamVideo stream={remoteStream!} muted={isDeafened} fit="cover" />
            ) : (
              <div
                className={'room-view__avatar' + (speaking ? ' room-view__avatar--speaking' : '')}
                style={{ background: getAvatarColor(tile.name) }}
              >
                {tile.name.charAt(0)}
                {/* No camera track from this peer yet — keep the audio playing invisibly. */}
                {remoteStream && <MediaStreamVideo stream={remoteStream} muted={isDeafened} hidden />}
              </div>
            );

          const isHost = tile.kind === 'participant' && tile.isHost;

          const status = (
            <div className="room-view__participant-status">
              {muted && <MicOff size={13} className="room-view__participant-status-icon" />}
              <span>{tile.name}</span>
              {isHost && <HostStarBadge className="room-view__host-star" />}
            </div>
          );

          const liveIndicator = tile.kind === 'screen' && <LiveBadge className="room-view__live-badge" />;

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
                    <X size={14} />
                  </button>
                  {liveIndicator}
                  {status}
                </div>
              ) : (
                <>
                  {media}
                  {liveIndicator}
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
        onSelectMic={onSelectMic}
        isCameraOn={!!cameraStream}
        onToggleCamera={onToggleCamera}
        onSelectCamera={onSelectCamera}
        isSharingScreen={!!screenStream}
        onToggleScreenShare={onToggleScreenShare}
        onLeave={onLeave}
      />
    </div>
  );
}
