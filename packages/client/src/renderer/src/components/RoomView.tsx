import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { RoomSummary } from '@concord/shared';
import type { RoomPeer } from '../hooks/useRoomConnection';
import { Eye, EarOff, HeadphoneOff, MicOff, VolumeX, X } from 'lucide-react';
import CallControls from './CallControls';
import MediaStreamVideo from './MediaStreamVideo';
import ScreenShareTile from './ScreenShareTile';
import HostStarBadge from './HostStarBadge';
import LiveBadge from './LiveBadge';
import { getAvatarColor } from '../lib/avatarColor';
import { getGridContainerStyle, getGridItemStyle } from '../lib/participantGrid';
import { playCameraStart, playCameraStop, playTransmissionEnter, playTransmissionExit } from '../lib/soundEffects';
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
  // Shared with RoomSidebar via usePeerVolumeControl (lifted to ServerListPage) so muting/
  // adjusting someone from either place stays in sync live, not just after a remount.
  getPeerVolume: (userId: string | null) => number | undefined;
  onOpenVolumeMenu: (x: number, y: number, peerId: string, userId: string, name: string) => void;
  isPeerMutedByMe: (userId: string) => boolean;
  onViewProfile: (userId: string, name: string, avatarUrl: string | null) => void;
  // userId of whoever's volume popup is currently open (shared with RoomSidebar) — drives the
  // "clicked" highlight so the action has visible feedback beyond the popup itself.
  activeVolumeMenuUserId: string | null;
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
      // False for self — this badge means "this peer muted YOU", never applicable to your own tile.
      mutedMe: boolean;
      // False for self — "you muted this peer" (peerVolumePreferences.ts, local-only).
      mutedByMe: boolean;
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
  onToggleScreenShare,
  getPeerVolume,
  onOpenVolumeMenu,
  activeVolumeMenuUserId,
  isPeerMutedByMe,
  onViewProfile
}: RoomViewProps) {
  const [focusedTileKey, setFocusedTileKey] = useState<string | null>(null);
  // [2026-08-30, pedido do Mozar] Largura/altura reais do vídeo em foco (16:9, 21:9, 4:3, o que a
  // transmissão de verdade for) — a letterbox do .room-view__focus-frame usa isso em vez de um
  // 16:9 travado. null até o <video> carregar metadata pela primeira vez (novo alvo de foco);
  // volta a 16/9 nesse meio-tempo (CSS var(--focus-ratio, 1.7778)) pra não piscar 0.
  const [focusedAspectRatio, setFocusedAspectRatio] = useState<number | null>(null);
  useEffect(() => {
    setFocusedAspectRatio(null);
  }, [focusedTileKey]);
  // A remote peer's camera stays blurred/gated (same "clique para visualizar" idea as a screen
  // share, decision from the Mozar) until clicked at least once — keyed by tile.key, same
  // identifier focusedTileKey already uses. Never applies to the local user's own camera preview
  // (showCamera below), matching ScreenShareTile's isOwnPreview exemption. Stays viewed for the
  // rest of the session once clicked — no reset button for this one, unlike the screen tile's "×".
  const [viewedCameraPeerIds, setViewedCameraPeerIds] = useState<Set<string>>(new Set());

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

  // If whatever justified focusing this tile goes away — screen share stopped (mine or a peer's),
  // a camera turned off or died mid-call (device unplugged, driver crash — ServerListPage tears
  // the stream down and this just reacts to cameraStream/personalStream going video-less), or the
  // peer disconnected entirely — fall back to the grid instead of leaving the 16:9 box showing a
  // dead/frozen tile (or, for a since-vanished tile, silently priming a stale focusedTileKey that
  // would auto-focus again the next time that same key becomes valid, e.g. a re-share). Covers
  // every tile kind through the one mechanism instead of a one-off carved out per case.
  useEffect(() => {
    if (!focusedTileKey) return;
    if (focusedTileKey === 'self-screen') {
      if (!screenStream) setFocusedTileKey(null);
      return;
    }
    if (focusedTileKey === 'self') {
      if (!cameraStream) setFocusedTileKey(null);
      return;
    }
    if (focusedTileKey.endsWith('-screen')) {
      const peerId = focusedTileKey.slice(0, -'-screen'.length);
      const peer = peers.find((p) => p.peerId === peerId);
      if (!peer?.screenStream) setFocusedTileKey(null);
      return;
    }
    const peer = peers.find((p) => p.peerId === focusedTileKey);
    const hasVideo = !!peer?.personalStream && peer.personalStream.getVideoTracks().length > 0;
    if (!hasVideo) setFocusedTileKey(null);
  }, [focusedTileKey, screenStream, cameraStream, peers]);

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
      mutedMe: false,
      mutedByMe: false,
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
        mutedMe: peer.mutedMe,
        mutedByMe: isPeerMutedByMe(peer.userId),
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
          // A camera feed (self or remote) gets the same click-to-expand treatment as a screen
          // share — "treat the camera as a transmission too". A tile with no actual video (just
          // the avatar placeholder) has nothing worth expanding.
          const hasCameraVideo = !!showCamera || hasRemoteVideo;
          const isFocused = tile.key === focusedTileKey;
          const isFocusable = tile.kind === 'screen' || hasCameraVideo;
          const isVolumeTarget = tile.kind === 'participant' && !!tile.userId;
          const isVolumeMenuActive = isVolumeTarget && tile.userId === activeVolumeMenuUserId;

          const effectiveVolume = tile.kind === 'participant' ? getPeerVolume(tile.userId) : undefined;

          const handleFocusedDimensions = isFocused
            ? (width: number, height: number) => setFocusedAspectRatio(width / height)
            : undefined;

          const media =
            tile.kind === 'screen' ? (
              <ScreenShareTile
                stream={tile.stream}
                isDeafened={isDeafened}
                isFocused={isFocused}
                onCloseFocus={() => setFocusedTileKey(null)}
                isOwnPreview={tile.key === 'self-screen'}
                onDimensionsChange={handleFocusedDimensions}
              />
            ) : showCamera ? (
              <MediaStreamVideo stream={cameraStream} mirrored fit="cover" onDimensionsChange={handleFocusedDimensions} />
            ) : hasRemoteVideo ? (
              <div
                className={
                  'room-view__camera-wrap' + (viewedCameraPeerIds.has(tile.key) ? '' : ' room-view__camera-wrap--gated')
                }
              >
                <MediaStreamVideo
                  stream={remoteStream!}
                  muted={isDeafened}
                  volume={effectiveVolume}
                  fit="cover"
                  onDimensionsChange={handleFocusedDimensions}
                />
                {!viewedCameraPeerIds.has(tile.key) && (
                  <div className="room-view__camera-gate-message">
                    <Eye size={22} />
                    <span>Clique para visualizar</span>
                  </div>
                )}
              </div>
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

          const mutedMe = tile.kind === 'participant' && tile.mutedMe;
          const mutedByMe = tile.kind === 'participant' && tile.mutedByMe;

          const status = (
            <div className="room-view__participant-status">
              {muted && <MicOff size={20} className="room-view__participant-status-icon" />}
              {tileIsDeafened && <HeadphoneOff size={20} className="room-view__participant-status-icon" />}
              {mutedMe && (
                <span title={`${tile.name} te mutou`}>
                  <EarOff
                    size={20}
                    className="room-view__participant-status-icon room-view__participant-status-icon--muted-me"
                  />
                </span>
              )}
              {mutedByMe && (
                <span title={`Você mutou ${tile.name}`}>
                  <VolumeX
                    size={20}
                    className="room-view__participant-status-icon room-view__participant-status-icon--muted-me"
                  />
                </span>
              )}
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
                (isFocusable ? ' room-view__participant-tile--focusable' : '') +
                (isVolumeTarget ? ' room-view__participant-tile--volume-target' : '') +
                (isVolumeMenuActive ? ' room-view__participant-tile--volume-active' : '')
              }
              style={isFocused ? undefined : getGridItemStyle(index, tiles.length)}
              onClick={
                isFocusable && !isFocused
                  ? () => {
                      setFocusedTileKey(tile.key);
                      if (hasRemoteVideo) {
                        setViewedCameraPeerIds((prev) => (prev.has(tile.key) ? prev : new Set(prev).add(tile.key)));
                      }
                    }
                  : // No video to focus (just the avatar circle) — click views the real profile
                    // instead, same trigger point as RoomSidebar's participant row.
                    isVolumeTarget && !isFocusable
                    ? () => onViewProfile(tile.userId!, tile.name, tile.kind === 'participant' ? tile.avatarUrl : null)
                    : undefined
              }
              onContextMenu={
                tile.kind === 'participant' && tile.userId
                  ? (event) => {
                      event.preventDefault();
                      onOpenVolumeMenu(event.clientX, event.clientY, tile.key, tile.userId!, tile.name);
                    }
                  : undefined
              }
            >
              {/* Always the same wrapper, for every tile kind, focused or not — only the CSS
                  differs (16:9-locked fullscreen vs. plain 100%-fill grid cell, and a
                  `--participant` override that keeps an unfocused camera tile looking exactly
                  like the old unwrapped fragment: no black board, no rounding, no clipping).
                  Screen tiles keep local state (ScreenShareTile's isLive/volume) that must
                  survive a click toggling focus; conditionally mounting/unmounting a wrapper
                  around `media` based on tile kind or camera-on/off used to change the parent
                  shape, which made React tear the subtree down and remount it right after that
                  same click had just set isLive — keeping the wrapper's presence tied only to
                  `tile.key` (never to `tile.kind` or `hasCameraVideo`) avoids that for camera
                  tiles too, now that turning a camera on/off can also flip whether a tile is
                  focusable. */}
              <div
                className={
                  'room-view__focus-frame' +
                  (isFocused ? '' : ' room-view__focus-frame--grid') +
                  (tile.kind === 'participant' ? ' room-view__focus-frame--participant' : '')
                }
                style={isFocused ? ({ '--focus-ratio': focusedAspectRatio ?? 16 / 9 } as CSSProperties) : undefined}
              >
                {/* Screen tiles' close button lives inside ScreenShareTile instead — closing has
                    to reset that component's own play/audio state, not just this file's focus
                    state. A camera feed has no such component/state of its own, so the close
                    control for it lives here. */}
                {isFocused && tile.kind === 'participant' && (
                  <button
                    type="button"
                    className="room-view__focus-close"
                    title="Fechar (Esc)"
                    onClick={(event) => {
                      event.stopPropagation();
                      setFocusedTileKey(null);
                    }}
                  >
                    <X size={14} />
                  </button>
                )}
                {media}
                {liveIndicator}
                {status}
              </div>
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
        isFocused={focusedTileKey !== null}
        onExitFocus={() => setFocusedTileKey(null)}
      />

    </div>
  );
}
