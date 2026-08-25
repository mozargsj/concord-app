import { useEffect, useRef, useState } from 'react';
import type { RoomSummary } from '@concord/shared';
import type { RoomPeer } from '../hooks/useRoomConnection';
import { HeadphoneOff, MicOff } from 'lucide-react';
import CallControls from './CallControls';
import MediaStreamVideo from './MediaStreamVideo';
import ScreenShareTile from './ScreenShareTile';
import ParticipantVolumeMenu from './ParticipantVolumeMenu';
import HostStarBadge from './HostStarBadge';
import LiveBadge from './LiveBadge';
import { getAvatarColor } from '../lib/avatarColor';
import { getGridContainerStyle, getGridItemStyle } from '../lib/participantGrid';
import { playCameraStart, playCameraStop, playTransmissionEnter, playTransmissionExit } from '../lib/soundEffects';
import { getMasterVolume, onMasterVolumeChange } from '../lib/masterVolume';
import {
  type PeerVolumeSettings,
  getPeerVolumeSettings,
  setPeerMuted,
  setPeerVolume
} from '../lib/peerVolumePreferences';
import '../styles/RoomView.css';

interface RoomViewProps {
  room: RoomSummary | null;
  isMicMuted: boolean;
  onToggleMic: () => void;
  onSelectMic: (deviceId: string) => void;
  isSpeaking: boolean;
  showMutedSpeakingHint: boolean;
  onLeave: () => void;
  isDeafened: boolean;
  selfPeerId: string | null;
  hostPeerId: string | null;
  peers: RoomPeer[];
  currentUserDisplayName: string;
  currentUserAvatarUrl: string | null;
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
      avatarUrl: string | null;
      isSelf: boolean;
      isHost: boolean;
      stream: MediaStream | null;
      isSpeaking: boolean;
      isMicMuted: boolean;
      isDeafened: boolean;
      // null for self — there's no incoming stream to adjust volume on for your own tile.
      userId: string | null;
    }
  | { kind: 'screen'; key: string; name: string; stream: MediaStream };

export default function RoomView({
  room,
  isMicMuted,
  onToggleMic,
  onSelectMic,
  isSpeaking,
  showMutedSpeakingHint,
  onLeave,
  isDeafened,
  selfPeerId,
  hostPeerId,
  peers,
  currentUserDisplayName,
  currentUserAvatarUrl,
  cameraStream,
  screenStream,
  mediaError,
  onToggleCamera,
  onSelectCamera,
  onToggleScreenShare
}: RoomViewProps) {
  const [focusedTileKey, setFocusedTileKey] = useState<string | null>(null);
  // Live overrides for this session — seeded lazily from localStorage the first time a given
  // userId is touched (getEffectivePeerSettings below), so most peers never need an entry here
  // at all until the listener actually right-clicks one.
  const [peerVolumeOverrides, setPeerVolumeOverrides] = useState<Record<string, PeerVolumeSettings>>({});
  const [masterVolume, setMasterVolumeState] = useState(getMasterVolume());
  const [volumeMenu, setVolumeMenu] = useState<{ x: number; y: number; userId: string; name: string } | null>(
    null
  );

  useEffect(() => onMasterVolumeChange(setMasterVolumeState), []);

  function getEffectivePeerSettings(userId: string): PeerVolumeSettings {
    return peerVolumeOverrides[userId] ?? getPeerVolumeSettings(userId);
  }

  function handlePeerVolumeChange(userId: string, volume: number) {
    setPeerVolumeOverrides((prev) => ({ ...prev, [userId]: { ...getEffectivePeerSettings(userId), volume } }));
    setPeerVolume(userId, volume);
  }

  function handleTogglePeerMute(userId: string) {
    const next = !getEffectivePeerSettings(userId).muted;
    setPeerVolumeOverrides((prev) => ({ ...prev, [userId]: { ...getEffectivePeerSettings(userId), muted: next } }));
    setPeerMuted(userId, next);
  }

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
      if (!hasVideo && prevState?.hasVideo) playCameraStop();
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
      avatarUrl: currentUserAvatarUrl,
      isSelf: true,
      isHost: isSelfHost,
      stream: null,
      isSpeaking: isSpeaking && !isMicMuted,
      isMicMuted,
      isDeafened,
      userId: null
    },
    ...peers.map(
      (peer): Tile => ({
        kind: 'participant',
        key: peer.peerId,
        name: peer.displayName,
        avatarUrl: peer.avatarUrl,
        isSelf: false,
        isHost: peer.peerId === hostPeerId,
        stream: peer.personalStream,
        isSpeaking: peer.isSpeaking,
        isMicMuted: peer.isMicMuted,
        isDeafened: peer.isDeafened,
        userId: peer.userId
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
          const muted = tile.kind === 'participant' && tile.isMicMuted;
          const tileIsDeafened = tile.kind === 'participant' && tile.isDeafened;
          const tileAvatarUrl = tile.kind === 'participant' ? tile.avatarUrl : null;
          const showCamera = tile.kind === 'participant' && tile.isSelf && cameraStream;
          const remoteStream = tile.kind === 'participant' && !tile.isSelf ? tile.stream : null;
          const hasRemoteVideo = !!remoteStream && remoteStream.getVideoTracks().length > 0;
          const isFocused = tile.key === focusedTileKey;
          const isFocusable = tile.kind === 'screen';

          // Peer's own fixed level × this listener's general volume — same "two volumes
          // combine, neither replaces the other" pattern already decided for the soundboard.
          const peerSettings =
            tile.kind === 'participant' && tile.userId ? getEffectivePeerSettings(tile.userId) : null;
          const effectiveVolume = peerSettings
            ? peerSettings.muted
              ? 0
              : (peerSettings.volume / 100) * (masterVolume / 100)
            : undefined;

          const media =
            tile.kind === 'screen' ? (
              <ScreenShareTile
                stream={tile.stream}
                isDeafened={isDeafened}
                isFocused={isFocused}
                onCloseFocus={() => setFocusedTileKey(null)}
                isOwnPreview={tile.key === 'self-screen'}
              />
            ) : showCamera ? (
              <MediaStreamVideo stream={cameraStream} mirrored fit="cover" />
            ) : hasRemoteVideo ? (
              <MediaStreamVideo stream={remoteStream!} muted={isDeafened} volume={effectiveVolume} fit="cover" />
            ) : (
              <div
                className={'room-view__avatar' + (speaking ? ' room-view__avatar--speaking' : '')}
                style={tileAvatarUrl ? undefined : { background: getAvatarColor(tile.name) }}
              >
                {tileAvatarUrl ? (
                  <img src={tileAvatarUrl} alt="" className="room-view__avatar-image" />
                ) : (
                  tile.name.charAt(0)
                )}
                {/* No camera track from this peer yet — keep the audio playing invisibly. */}
                {remoteStream && (
                  <MediaStreamVideo stream={remoteStream} muted={isDeafened} volume={effectiveVolume} hidden />
                )}
              </div>
            );

          const isHost = tile.kind === 'participant' && tile.isHost;

          const status = (
            <div className="room-view__participant-status">
              {muted && <MicOff size={13} className="room-view__participant-status-icon" />}
              {tileIsDeafened && <HeadphoneOff size={13} className="room-view__participant-status-icon" />}
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
              onContextMenu={
                tile.kind === 'participant' && tile.userId
                  ? (event) => {
                      event.preventDefault();
                      setVolumeMenu({ x: event.clientX, y: event.clientY, userId: tile.userId!, name: tile.name });
                    }
                  : undefined
              }
            >
              {tile.kind === 'screen' ? (
                // Always the same wrapper, focused or not — only the CSS (16:9-locked
                // fullscreen vs. plain 100%-fill grid cell) differs between the two. Screen
                // tiles keep local state (ScreenShareTile's isLive/volume) that must survive a
                // click toggling focus; conditionally mounting/unmounting this wrapper around
                // `media` used to change its parent shape between the two branches, which made
                // React tear the component down and remount it right after that same click had
                // just set isLive — the fix here is keeping the parent shape constant instead.
                <div
                  className={'room-view__focus-frame' + (isFocused ? '' : ' room-view__focus-frame--grid')}
                >
                  {/* Close button now lives inside ScreenShareTile — closing has to reset that
                      component's own play/audio state, not just this file's focus state. */}
                  {media}
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
        showMutedSpeakingHint={showMutedSpeakingHint}
        isCameraOn={!!cameraStream}
        onToggleCamera={onToggleCamera}
        onSelectCamera={onSelectCamera}
        isSharingScreen={!!screenStream}
        onToggleScreenShare={onToggleScreenShare}
        onLeave={onLeave}
      />

      {volumeMenu && (
        <ParticipantVolumeMenu
          x={volumeMenu.x}
          y={volumeMenu.y}
          name={volumeMenu.name}
          volume={getEffectivePeerSettings(volumeMenu.userId).volume}
          isMuted={getEffectivePeerSettings(volumeMenu.userId).muted}
          onVolumeChange={(value) => handlePeerVolumeChange(volumeMenu.userId, value)}
          onToggleMute={() => handleTogglePeerMute(volumeMenu.userId)}
          onClose={() => setVolumeMenu(null)}
        />
      )}
    </div>
  );
}
