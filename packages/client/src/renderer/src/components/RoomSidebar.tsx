import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import type { RoomSummary, ServerSummary, UserProfile } from '@concord/shared';
import UserPanel from './UserPanel';
import VoiceConnectionStatus from './VoiceConnectionStatus';
import HostStarBadge from './HostStarBadge';
import LiveBadge from './LiveBadge';
import ConfirmModal from './ConfirmModal';
import SoundboardPopover from './SoundboardPopover';
import SoundboardManagerModal from './SoundboardManagerModal';
import ConfirmAddSoundModal from './ConfirmAddSoundModal';
import {
  AudioLines,
  AudioLinesOff,
  ChevronDown,
  UserPlus,
  Plus,
  Volume2,
  Video,
  VideoOff,
  ScreenShare,
  LayoutGrid,
  Megaphone,
  MicOff,
  HeadphoneOff
} from 'lucide-react';
import { getAvatarColor } from '../lib/avatarColor';
import type { RoomPeer } from '../hooks/useRoomConnection';
import { decodeAudioFile } from '../lib/audioClip';
import { getRnnoiseEnabled, setRnnoiseEnabled } from '../lib/noiseSuppressionSettings';
import { listOwnSounds, loadOwnSoundBytes, syncOwnSoundsToBackend, type OwnSound } from '../lib/soundCache';
import { listTempSounds, type TempSound } from '../lib/soundTempCache';
import { getSoundboardVolume, setSoundboardVolume } from '../lib/soundboardVolume';
import type { SoundListEntry } from '../lib/webrtcMesh';
import '../styles/RoomSidebar.css';

type SoundboardPopoverState = { mode: 'play' | 'config'; x: number; y: number };

const ROLE_DONO = 1;
const ROLE_ADMIN = 2;

interface RoomSidebarProps {
  server: ServerSummary;
  myRole: number;
  rooms: RoomSummary[];
  selectedRoomId: string | null;
  onSelectRoom: (roomId: string) => void;
  onCreateRoom: (name: string) => void;
  onRenameRoom: (roomId: string, name: string) => void;
  onDeleteRoom: (roomId: string) => void;
  onOpenInvite: () => void;
  isMicMuted: boolean;
  isDeafened: boolean;
  onToggleMic: () => void;
  onToggleDeafen: () => void;
  onSelectMic: (deviceId: string) => void;
  onSelectSpeaker: (deviceId: string) => void;
  onNoiseSuppressionChange: () => void;
  isSpeaking: boolean;
  showMutedSpeakingHint: boolean;
  latencyMs: number | null;
  onLeave: () => void;
  selfPeerId: string | null;
  hostPeerId: string | null;
  peers: RoomPeer[];
  currentUser: UserProfile;
  onOpenProfile: () => void;
  selfCameraOn: boolean;
  selfSharingScreen: boolean;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onPlaySoundboardClip: (
    buffer: AudioBuffer,
    volume: number,
    onEnded?: () => void
  ) => { stop: () => void } | null;
  /** Catalogs already received from peers currently in the room — live-only, per decisions.md
   * (never persisted, cleared the moment a peer leaves). */
  peerSoundLists: Record<string, SoundListEntry[]>;
  onRequestPeerSoundList: (peerId: string) => void;
  onRequestPeerSound: (peerId: string, soundId: string, knownHash: string | null) => void;
  /** Bumped by ServerListPage every time a P2P sound download finishes — the trigger to refresh
   * the temp-cache list, since the download itself happens deep inside the mesh, not here. */
  soundDownloadTick: number;
}

export default function RoomSidebar({
  server,
  myRole,
  rooms,
  selectedRoomId,
  onSelectRoom,
  onCreateRoom,
  onRenameRoom,
  onDeleteRoom,
  onOpenInvite,
  isMicMuted,
  isDeafened,
  onToggleMic,
  onToggleDeafen,
  onSelectMic,
  onSelectSpeaker,
  onNoiseSuppressionChange,
  isSpeaking,
  showMutedSpeakingHint,
  latencyMs,
  onLeave,
  selfPeerId,
  hostPeerId,
  peers,
  currentUser,
  onOpenProfile,
  selfCameraOn,
  selfSharingScreen,
  onToggleCamera,
  onToggleScreenShare,
  onPlaySoundboardClip,
  peerSoundLists,
  onRequestPeerSoundList,
  onRequestPeerSound,
  soundDownloadTick
}: RoomSidebarProps) {
  const [isCreatingRoom, setIsCreatingRoom] = useState(false);
  const [newRoomName, setNewRoomName] = useState('');
  const [editingRoomId, setEditingRoomId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [roomPendingDelete, setRoomPendingDelete] = useState<RoomSummary | null>(null);
  const [soundboardPopover, setSoundboardPopover] = useState<SoundboardPopoverState | null>(null);
  const [isSoundboardManagerOpen, setIsSoundboardManagerOpen] = useState(false);
  const [ownSounds, setOwnSounds] = useState<OwnSound[]>([]);
  const [generalVolumePercent, setGeneralVolumePercent] = useState(getSoundboardVolume());
  // Lifted above the popover (which unmounts on close) so the play/pause state survives closing
  // and reopening the megafone's quick-play list while a clip is still going.
  const [activeSoundboardId, setActiveSoundboardId] = useState<string | null>(null);
  const activeSoundboardStopRef = useRef<(() => void) | null>(null);
  // Which peer's catalog the popover is currently drilled into — null means "top level"
  // (my own sounds + the participant list).
  const [selectedSoundboardPeer, setSelectedSoundboardPeer] = useState<{
    peerId: string;
    displayName: string;
    avatarUrl: string | null;
  } | null>(null);
  const [tempSounds, setTempSounds] = useState<TempSound[]>([]);
  const [playingTempSoundId, setPlayingTempSoundId] = useState<string | null>(null);
  const playingTempAudioRef = useRef<HTMLAudioElement | null>(null);
  const [confirmAddTemp, setConfirmAddTemp] = useState<TempSound | null>(null);
  // Mirrors the same toggle exposed in Configurações de voz — quick single-click access right
  // next to the megafone, same interaction as the mic/deafen buttons. Deliberately duplicated
  // rather than removing the settings one: some users will only ever find it here, others only
  // in Configurações, and this one's a lot faster to reach mid-call.
  const [isRnnoiseEnabled, setIsRnnoiseEnabled] = useState(true);

  useEffect(() => {
    setIsRnnoiseEnabled(getRnnoiseEnabled());
  }, []);

  function handleToggleRnnoise() {
    const next = !isRnnoiseEnabled;
    setIsRnnoiseEnabled(next);
    setRnnoiseEnabled(next);
    onNoiseSuppressionChange();
  }

  async function refreshOwnSounds() {
    const sounds = await listOwnSounds();
    setOwnSounds(sounds);
    void syncOwnSoundsToBackend(sounds);
  }

  async function refreshTempSounds() {
    setTempSounds(await listTempSounds());
  }

  useEffect(() => {
    void refreshOwnSounds();
    void refreshTempSounds();
  }, []);

  // A P2P sound download completed somewhere inside the mesh (useRoomConnection's
  // onSoundReceived) — re-read the temp cache to pick it up.
  useEffect(() => {
    void refreshTempSounds();
  }, [soundDownloadTick]);

  useEffect(() => {
    return () => {
      activeSoundboardStopRef.current?.();
      playingTempAudioRef.current?.pause();
    };
  }, []);

  function handleMegafoneClick(event: ReactMouseEvent) {
    setSoundboardPopover({ mode: 'play', x: event.clientX, y: event.clientY });
  }

  function handleMegafoneContextMenu(event: ReactMouseEvent) {
    event.preventDefault();
    setSoundboardPopover({ mode: 'config', x: event.clientX, y: event.clientY });
  }

  function handleGeneralVolumeChange(value: number) {
    setGeneralVolumePercent(value);
    setSoundboardVolume(value);
  }

  // Clicking a sound toggles it: same sound while it's playing stops it, any other sound stops
  // whatever was playing first and starts the new one — mirrors the play/pause behavior in the
  // "Enviar um som" preview and the manager's own list, just wired through the mesh instead of a
  // plain <audio> element since this path actually broadcasts too (see MeshManager.playSoundboardClip).
  async function handleToggleSound(sound: OwnSound) {
    if (activeSoundboardId === sound.id) {
      activeSoundboardStopRef.current?.();
      activeSoundboardStopRef.current = null;
      setActiveSoundboardId(null);
      return;
    }

    activeSoundboardStopRef.current?.();
    const bytes = await loadOwnSoundBytes(sound.id);
    if (!bytes) return;
    const buffer = await decodeAudioFile(bytes.data);
    // Fixed per-sound volume (set once, at save time) combined with the general/real-time
    // volume from the config popover — decisions.md is explicit the two coexist, neither
    // replaces the other.
    const handle = onPlaySoundboardClip(buffer, sound.volume * (generalVolumePercent / 100), () => {
      // Fires whether the clip finished on its own or was stopped explicitly (see
      // MeshManager.playSoundboardClip) — only clear state if this is still the active sound,
      // so a stale callback from a sound that was already superseded doesn't clobber the new one.
      setActiveSoundboardId((current) => (current === sound.id ? null : current));
    });
    activeSoundboardStopRef.current = handle?.stop ?? null;
    setActiveSoundboardId(sound.id);
  }

  // null = the self avatar (first in the strip) — back to "meus áudios", no network call needed.
  function handleSelectSoundboardPeer(peer: { peerId: string; displayName: string; avatarUrl: string | null } | null) {
    setSelectedSoundboardPeer(peer);
    if (!peer) return;
    // Always re-asks, even if a list from this peer already arrived earlier in the session —
    // it's cheap (just metadata) and picks up anything they've added since (decisions.md: ao vivo).
    onRequestPeerSoundList(peer.peerId);
  }

  function handleDownloadSound(entry: SoundListEntry) {
    if (!selectedSoundboardPeer) return;
    onRequestPeerSound(selectedSoundboardPeer.peerId, entry.soundId, null);
  }

  // Same single-Audio play/pause toggle pattern as SoundboardManagerModal's own-sounds preview —
  // this one just reads from the temp (not-yet-adopted) cache instead.
  function handleToggleTempPreview(soundId: string) {
    if (playingTempSoundId === soundId) {
      playingTempAudioRef.current?.pause();
      playingTempAudioRef.current = null;
      setPlayingTempSoundId(null);
      return;
    }
    const temp = tempSounds.find((sound) => sound.id === soundId);
    if (!temp) return;
    playingTempAudioRef.current?.pause();
    const audio = new Audio(temp.url);
    audio.onended = () => {
      setPlayingTempSoundId((current) => (current === soundId ? null : current));
      playingTempAudioRef.current = null;
    };
    playingTempAudioRef.current = audio;
    setPlayingTempSoundId(soundId);
    void audio.play();
  }

  function handleConfirmAddTemp(soundId: string) {
    const temp = tempSounds.find((sound) => sound.id === soundId);
    if (!temp) return;
    setConfirmAddTemp(temp);
  }

  async function handleSoundAdopted() {
    await Promise.all([refreshOwnSounds(), refreshTempSounds()]);
  }

  const selectedRoom = rooms.find((room) => room.id === selectedRoomId) ?? null;
  const canCreateOrDeleteRooms = myRole <= ROLE_DONO;
  const canRenameRooms = myRole <= ROLE_ADMIN;
  const canInvite = myRole <= ROLE_ADMIN;

  function submitCreateRoom() {
    const trimmed = newRoomName.trim();
    if (trimmed) onCreateRoom(trimmed);
    setNewRoomName('');
    setIsCreatingRoom(false);
  }

  function handleCreateKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') submitCreateRoom();
    if (event.key === 'Escape') {
      setNewRoomName('');
      setIsCreatingRoom(false);
    }
  }

  function startRenaming(room: RoomSummary) {
    setEditingRoomId(room.id);
    setEditingName(room.name);
  }

  function submitRename(roomId: string) {
    const trimmed = editingName.trim();
    if (trimmed) onRenameRoom(roomId, trimmed);
    setEditingRoomId(null);
  }

  function handleRenameKeyDown(event: KeyboardEvent<HTMLInputElement>, roomId: string) {
    if (event.key === 'Enter') submitRename(roomId);
    if (event.key === 'Escape') setEditingRoomId(null);
  }

  function confirmDeleteRoom() {
    if (roomPendingDelete) onDeleteRoom(roomPendingDelete.id);
    setRoomPendingDelete(null);
  }

  return (
    <aside className="room-sidebar">
      <header className="room-sidebar__header">
        <span className="room-sidebar__server-name">{server.name}</span>
        <div className="room-sidebar__header-actions">
          {canInvite && (
            <button className="room-sidebar__icon-button" title="Convidar pessoas" onClick={onOpenInvite}>
              <UserPlus size={24} />
            </button>
          )}
          <ChevronDown size={24} className="room-sidebar__chevron" />
        </div>
      </header>

      <div className="room-sidebar__rooms">
        <div className="room-sidebar__category">
          <div className="room-sidebar__category-label">
            <ChevronDown size={18} className="room-sidebar__category-chevron" />
            <span>Canais de Voz</span>
          </div>
          {canCreateOrDeleteRooms && (
            <button
              className="room-sidebar__icon-button"
              title="Criar sala"
              onClick={() => setIsCreatingRoom((prev) => !prev)}
            >
              <Plus size={24} />
            </button>
          )}
        </div>

        {isCreatingRoom && (
          <input
            className="room-sidebar__room-input"
            autoFocus
            placeholder="Nome da sala"
            value={newRoomName}
            onChange={(event) => setNewRoomName(event.target.value)}
            onKeyDown={handleCreateKeyDown}
            onBlur={submitCreateRoom}
          />
        )}

        {rooms.map((room) => {
          const isJoined = room.id === selectedRoomId;
          // Real roster for the joined room, driven by signaling. Rooms the user hasn't
          // joined have no presence protocol yet (server only tracks membership for the
          // connected socket's own room), so they show no participant preview.
          const participants: {
            key: string;
            name: string;
            avatarUrl: string | null;
            isSelf: boolean;
            isHost: boolean;
            isSpeaking: boolean;
            isBroadcasting: boolean;
            isMicMuted: boolean;
            isDeafened: boolean;
          }[] = isJoined
            ? [
                {
                  key: 'self',
                  name: currentUser.displayName,
                  avatarUrl: currentUser.avatarUrl,
                  isSelf: true,
                  isHost: selfPeerId !== null && selfPeerId === hostPeerId,
                  isSpeaking,
                  isBroadcasting: selfCameraOn || selfSharingScreen,
                  isMicMuted,
                  isDeafened
                },
                ...peers.map((peer) => ({
                  key: peer.peerId,
                  name: peer.displayName,
                  // Only ever populated after a P2P fetch from this peer succeeds — see
                  // useRoomConnection's onImageReceived. Falls back to the initial letter below
                  // until then, same as it did before P2P avatars existed at all.
                  avatarUrl: peer.avatarUrl,
                  isSelf: false,
                  isHost: peer.peerId === hostPeerId,
                  isSpeaking: peer.isSpeaking,
                  isBroadcasting:
                    (!!peer.personalStream && peer.personalStream.getVideoTracks().length > 0) ||
                    !!peer.screenStream,
                  isMicMuted: peer.isMicMuted,
                  isDeafened: peer.isDeafened
                }))
              ]
            : [];

          const isEditing = editingRoomId === room.id;

          return (
            <div key={room.id} className="room-sidebar__room-block">
              {isEditing ? (
                <input
                  className="room-sidebar__room-input"
                  autoFocus
                  value={editingName}
                  onChange={(event) => setEditingName(event.target.value)}
                  onKeyDown={(event) => handleRenameKeyDown(event, room.id)}
                  onBlur={() => submitRename(room.id)}
                />
              ) : (
                <div className="room-sidebar__room-row">
                  <button
                    className={'room-sidebar__room' + (isJoined ? ' room-sidebar__room--active' : '')}
                    onClick={() => onSelectRoom(room.id)}
                  >
                    <Volume2 size={16} className="room-sidebar__room-icon" />
                    <span className="room-sidebar__room-name">{room.name}</span>
                    <span className="room-sidebar__room-count">
                      {room.memberCount}/{room.maxMembers}
                    </span>
                  </button>
                  {(canRenameRooms || canCreateOrDeleteRooms) && (
                    <div className="room-sidebar__room-actions">
                      {canRenameRooms && (
                        <button
                          className="room-sidebar__room-action"
                          title="Renomear sala"
                          onClick={() => startRenaming(room)}
                        >
                          Renomear
                        </button>
                      )}
                      {canCreateOrDeleteRooms && (
                        <button
                          className="room-sidebar__room-action"
                          title="Excluir sala"
                          onClick={() => setRoomPendingDelete(room)}
                        >
                          Excluir
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {participants.length > 0 && (
                <div className="room-sidebar__participants">
                  {participants.map((participant) => (
                    <div key={participant.key} className="room-sidebar__participant">
                      <span
                        className={
                          'room-sidebar__participant-avatar' +
                          (participant.isSpeaking ? ' room-sidebar__participant-avatar--speaking' : '')
                        }
                        style={participant.avatarUrl ? undefined : { background: getAvatarColor(participant.name) }}
                      >
                        {participant.avatarUrl ? (
                          <img
                            src={participant.avatarUrl}
                            alt=""
                            className="room-sidebar__participant-avatar-image"
                          />
                        ) : (
                          participant.name.charAt(0)
                        )}
                      </span>
                      <span className="room-sidebar__participant-name">{participant.name}</span>
                      {participant.isMicMuted && (
                        <span
                          className="room-sidebar__mic-status"
                          title={participant.isDeafened ? 'Não está ouvindo nem falando' : 'Microfone desativado'}
                        >
                          <MicOff size={12} />
                          {participant.isDeafened && <HeadphoneOff size={12} />}
                        </span>
                      )}
                      {participant.isBroadcasting && <LiveBadge className="room-sidebar__live-badge" />}
                      {participant.isHost && <HostStarBadge className="room-sidebar__host-star" />}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="room-sidebar__overlay">
        <div className="room-sidebar__panel">
          {selectedRoom && (
            <VoiceConnectionStatus
              serverName={server.name}
              roomName={selectedRoom.name}
              latencyMs={latencyMs ?? 0}
              onLeave={onLeave}
            />
          )}

          {selectedRoom && (
            <div className="room-sidebar__quick-actions">
              <button
                className={
                  'room-sidebar__quick-action' + (selfCameraOn ? '' : ' room-sidebar__quick-action--off')
                }
                title={selfCameraOn ? 'Desligar câmera' : 'Ligar câmera'}
                onClick={onToggleCamera}
              >
                {selfCameraOn ? <Video size={18} /> : <VideoOff size={18} />}
              </button>
              <button
                className={
                  'room-sidebar__quick-action' + (selfSharingScreen ? ' room-sidebar__quick-action--active' : '')
                }
                title={selfSharingScreen ? 'Parar transmissão' : 'Transmitir tela'}
                onClick={onToggleScreenShare}
              >
                <ScreenShare size={18} />
              </button>
              <button className="room-sidebar__quick-action" title="Em breve" disabled>
                <LayoutGrid size={18} />
              </button>
              <button
                className={
                  'room-sidebar__quick-action' +
                  (isRnnoiseEnabled ? ' room-sidebar__quick-action--rnnoise-on' : ' room-sidebar__quick-action--rnnoise-off')
                }
                title={isRnnoiseEnabled ? 'Redução de ruído ativada' : 'Redução de ruído desativada'}
                onClick={handleToggleRnnoise}
              >
                {isRnnoiseEnabled ? <AudioLines size={18} /> : <AudioLinesOff size={18} />}
              </button>
              <button
                className="room-sidebar__quick-action"
                title="Áudios (clique direito para configurar)"
                onClick={handleMegafoneClick}
                onContextMenu={handleMegafoneContextMenu}
              >
                <Megaphone size={18} />
              </button>
            </div>
          )}

          <UserPanel
            isMicMuted={isMicMuted}
            isDeafened={isDeafened}
            isSpeaking={isSpeaking}
            showMutedSpeakingHint={showMutedSpeakingHint}
            onToggleMic={onToggleMic}
            onToggleDeafen={onToggleDeafen}
            onSelectMic={onSelectMic}
            onSelectSpeaker={onSelectSpeaker}
            onNoiseSuppressionChange={onNoiseSuppressionChange}
            displayName={currentUser.displayName}
            avatarUrl={currentUser.avatarUrl}
            onOpenProfile={onOpenProfile}
          />
        </div>
      </div>

      {roomPendingDelete && (
        <ConfirmModal
          title="Excluir sala"
          message={`Excluir a sala "${roomPendingDelete.name}"? Essa ação não pode ser desfeita.`}
          confirmLabel="Excluir"
          onCancel={() => setRoomPendingDelete(null)}
          onConfirm={confirmDeleteRoom}
        />
      )}

      {soundboardPopover?.mode === 'play' && (
        <SoundboardPopover
          mode="play"
          x={soundboardPopover.x}
          y={soundboardPopover.y}
          ownSounds={ownSounds}
          playingOwnSoundId={activeSoundboardId}
          onToggleOwnSound={handleToggleSound}
          selfDisplayName={currentUser.displayName}
          selfAvatarUrl={currentUser.avatarUrl}
          participants={peers.map((peer) => ({
            peerId: peer.peerId,
            displayName: peer.displayName,
            avatarUrl: peer.avatarUrl
          }))}
          selectedPeer={selectedSoundboardPeer}
          onSelectPeer={handleSelectSoundboardPeer}
          peerSounds={selectedSoundboardPeer ? (peerSoundLists[selectedSoundboardPeer.peerId] ?? null) : null}
          downloadedSoundIds={new Set(tempSounds.map((sound) => sound.id))}
          onDownloadSound={handleDownloadSound}
          playingTempSoundId={playingTempSoundId}
          onToggleTempPreview={handleToggleTempPreview}
          onConfirmAdd={handleConfirmAddTemp}
          onClose={() => {
            setSoundboardPopover(null);
            setSelectedSoundboardPeer(null);
          }}
        />
      )}

      {soundboardPopover?.mode === 'config' && (
        <SoundboardPopover
          mode="config"
          x={soundboardPopover.x}
          y={soundboardPopover.y}
          generalVolumePercent={generalVolumePercent}
          onGeneralVolumeChange={handleGeneralVolumeChange}
          onOpenManager={() => setIsSoundboardManagerOpen(true)}
          onClose={() => setSoundboardPopover(null)}
        />
      )}

      {isSoundboardManagerOpen && (
        <SoundboardManagerModal
          onClose={() => setIsSoundboardManagerOpen(false)}
          onSoundsChanged={refreshOwnSounds}
        />
      )}

      {confirmAddTemp && (
        <ConfirmAddSoundModal
          temp={confirmAddTemp}
          onClose={() => setConfirmAddTemp(null)}
          onAdded={handleSoundAdopted}
        />
      )}
    </aside>
  );
}
