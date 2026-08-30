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
import Tooltip from './Tooltip';
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
  Music2,
  Megaphone,
  MicOff,
  HeadphoneOff,
  EarOff,
  VolumeX,
  Pencil,
  Trash2,
  ArrowUpDown,
  Check,
  X,
  GripVertical
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

// Safety net for the soundboard "baixando" indicator — requestSound() has no failure signal of
// its own (see downloadingSoundIds below), so this bounds how long a stalled/never-answered
// request keeps the icon spinning.
const SOUND_DOWNLOAD_TIMEOUT_MS = 20000;

interface RoomSidebarProps {
  server: ServerSummary;
  myRole: number;
  rooms: RoomSummary[];
  selectedRoomId: string | null;
  onSelectRoom: (roomId: string) => void;
  onCreateRoom: (name: string) => void;
  onRenameRoom: (roomId: string, name: string) => void;
  onDeleteRoom: (roomId: string) => void;
  onReorderRooms: (roomIds: string[]) => void;
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
  selfSharingMusic: boolean;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onToggleMusicShare: () => void;
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
  /** Shared with RoomView via usePeerVolumeControl (lifted to ServerListPage) so muting/adjusting
   * someone from either place stays in sync live, not just after a remount. */
  onOpenVolumeMenu: (x: number, y: number, peerId: string, userId: string, name: string, volumeKey?: string) => void;
  isPeerMutedByMe: (volumeKey: string) => boolean;
  onViewProfile: (userId: string, name: string, avatarUrl: string | null) => void;
  /** [2026-08-30, pedido do Mozar] Só a linha "Music <nome>" usa isso — em vez do padrão de
   * clique-direito-abre-menu que um participante normal tem, o ícone de som dela mesma já é o
   * controle inteiro: clique esquerdo muta/desmuta na hora, clique direito abre o volume
   * (onOpenVolumeMenu, mesmo popup de sempre). Não precisa de sendMuteStatus — volumeKey
   * (`${userId}:music`) nunca é a voz de ninguém, então não existe aviso de "fulano te mutou"
   * pra disparar aqui, diferente do toggle de mute de um participante de verdade. */
  onToggleMusicMute: (volumeKey: string) => void;
  /** userId of whoever's volume popup is currently open — drives the "clicked" highlight so the
   * right-click action has visible feedback beyond the popup itself. */
  activeVolumeMenuUserId: string | null;
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
  onReorderRooms,
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
  selfSharingMusic,
  onToggleCamera,
  onToggleScreenShare,
  onToggleMusicShare,
  onPlaySoundboardClip,
  peerSoundLists,
  onRequestPeerSoundList,
  onRequestPeerSound,
  soundDownloadTick,
  onOpenVolumeMenu,
  activeVolumeMenuUserId,
  isPeerMutedByMe,
  onViewProfile,
  onToggleMusicMute
}: RoomSidebarProps) {
  // [2026-08-30, pedido do Mozar] Seta ao lado de "Canais de Voz" nunca tinha sido ligada a nada —
  // agora alterna entre a lista de participantes normal (nome + status, padrão) e uma versão
  // compacta (só avatares numa linha, sobrepostos, sem nome/mic/ao-vivo/etc — só o brilho de "está
  // falando" sobrevive). Padrão aberto (`false` = detalhado).
  const [isParticipantsCompact, setIsParticipantsCompact] = useState(false);
  const [isCreatingRoom, setIsCreatingRoom] = useState(false);
  const [newRoomName, setNewRoomName] = useState('');
  const [editingRoomId, setEditingRoomId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [roomPendingDelete, setRoomPendingDelete] = useState<RoomSummary | null>(null);
  // [2026-08-29, pedido do Mozar — reordenar salas] Cópia local editável durante o modo de
  // arrastar, null quando não está reordenando (nesse caso `rooms`, a prop/verdade do servidor, é
  // usada direto). Evita mandar um PATCH a cada arrasto — só confirma no fim.
  const [orderedRooms, setOrderedRooms] = useState<RoomSummary[] | null>(null);
  const [draggedRoomId, setDraggedRoomId] = useState<string | null>(null);
  const isReordering = orderedRooms !== null;
  const displayRooms = orderedRooms ?? rooms;
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
  // soundId -> currently mid-transfer over the 'sounds' data channel (requestSound() is
  // fire-and-forget on the mesh side, no progress/failure signal comes back) — cleared either
  // when the sound shows up in tempSounds (soundDownloadTick fired) or by the safety timeout
  // below, so a peer that goes silent mid-transfer doesn't leave the icon spinning forever.
  const [downloadingSoundIds, setDownloadingSoundIds] = useState<Set<string>>(new Set());
  const downloadTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
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

  // Once a sound actually lands in the temp cache, it's done downloading — clear its spinner
  // and cancel the safety timeout (whichever finishes first, this effect or the timeout, wins;
  // both are safe to run since removing an id already gone from the set/map is a no-op).
  useEffect(() => {
    if (tempSounds.length === 0) return;
    setDownloadingSoundIds((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      let changed = false;
      for (const sound of tempSounds) {
        if (next.delete(sound.id)) changed = true;
      }
      return changed ? next : prev;
    });
    for (const sound of tempSounds) {
      const timeout = downloadTimeoutsRef.current.get(sound.id);
      if (timeout) {
        clearTimeout(timeout);
        downloadTimeoutsRef.current.delete(sound.id);
      }
    }
  }, [tempSounds]);

  useEffect(() => {
    return () => {
      activeSoundboardStopRef.current?.();
      playingTempAudioRef.current?.pause();
      // Deliberately reads .current at cleanup time, not mount time — this ref holds a Map that
      // grows over the component's whole lifetime as downloads start, not a DOM node whose
      // identity effect this rule is meant to guard; capturing it at mount would just clear an
      // empty map instead of whatever downloads are actually still pending at unmount.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      for (const timeout of downloadTimeoutsRef.current.values()) clearTimeout(timeout);
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
    if (downloadingSoundIds.has(entry.soundId)) return; // already in flight — ignore a repeat click
    setDownloadingSoundIds((prev) => new Set(prev).add(entry.soundId));
    const timeout = setTimeout(() => {
      downloadTimeoutsRef.current.delete(entry.soundId);
      setDownloadingSoundIds((prev) => {
        if (!prev.has(entry.soundId)) return prev;
        const next = new Set(prev);
        next.delete(entry.soundId);
        return next;
      });
    }, SOUND_DOWNLOAD_TIMEOUT_MS);
    downloadTimeoutsRef.current.set(entry.soundId, timeout);
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

  function handleStartReorder() {
    setOrderedRooms(rooms);
  }

  function handleConfirmReorder() {
    if (orderedRooms) onReorderRooms(orderedRooms.map((room) => room.id));
    setOrderedRooms(null);
    setDraggedRoomId(null);
  }

  function handleCancelReorder() {
    setOrderedRooms(null);
    setDraggedRoomId(null);
  }

  function handleDropReorder(targetRoomId: string) {
    if (!orderedRooms || !draggedRoomId || draggedRoomId === targetRoomId) return;
    const fromIndex = orderedRooms.findIndex((room) => room.id === draggedRoomId);
    const toIndex = orderedRooms.findIndex((room) => room.id === targetRoomId);
    if (fromIndex === -1 || toIndex === -1) return;
    const next = [...orderedRooms];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    setOrderedRooms(next);
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
            <Tooltip label={isParticipantsCompact ? 'Mostrar detalhes dos participantes' : 'Ocultar detalhes dos participantes'}>
              <button
                className="room-sidebar__category-chevron-button"
                onClick={() => setIsParticipantsCompact((prev) => !prev)}
              >
                <ChevronDown
                  size={18}
                  className={
                    'room-sidebar__category-chevron' +
                    (isParticipantsCompact ? ' room-sidebar__category-chevron--collapsed' : '')
                  }
                />
              </button>
            </Tooltip>
            <span>Canais de Voz</span>
          </div>
          {canCreateOrDeleteRooms && (
            <div className="room-sidebar__category-actions">
              {isReordering ? (
                <>
                  <Tooltip label="Confirmar ordem">
                    <button className="room-sidebar__icon-button" onClick={handleConfirmReorder}>
                      <Check size={20} />
                    </button>
                  </Tooltip>
                  <Tooltip label="Cancelar">
                    <button className="room-sidebar__icon-button" onClick={handleCancelReorder}>
                      <X size={20} />
                    </button>
                  </Tooltip>
                </>
              ) : (
                <Tooltip label="Ordenar salas">
                  <button
                    className="room-sidebar__icon-button"
                    onClick={handleStartReorder}
                    disabled={rooms.length < 2}
                  >
                    <ArrowUpDown size={20} />
                  </button>
                </Tooltip>
              )}
              <Tooltip label="Criar sala">
                <button className="room-sidebar__icon-button" onClick={() => setIsCreatingRoom((prev) => !prev)}>
                  <Plus size={24} />
                </button>
              </Tooltip>
            </div>
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

        {displayRooms.map((room) => {
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
            // False for self — this badge means "this peer muted YOU", never applicable to your own row.
            mutedMe: boolean;
            // False for self — "you muted this peer" (peerVolumePreferences.ts, local-only).
            mutedByMe: boolean;
            // null for self — there's no incoming stream to adjust volume on for your own row.
            userId: string | null;
            // null for self — no P2P connection to yourself, so no dot to show (see the render
            // below, which only draws one when this isn't null).
            connectionStatus: 'connecting' | 'connected' | 'failed' | null;
            // [2026-08-30, pedido do Mozar] "Music <nome>" — mesmo peer/userId de uma linha de voz
            // já existente, mas volume/mudo próprios (volumeKey `${userId}:music`, ver
            // usePeerVolumeControl.ts) e sem os badges que não fazem sentido pra áudio compartilhado
            // (mic mutado/host — ver render abaixo, filtra por isMusicRow).
            isMusicRow: boolean;
            volumeKey: string;
          }[] = isJoined
            ? [
                {
                  key: 'self',
                  name: currentUser.displayName,
                  avatarUrl: currentUser.avatarUrl,
                  isSelf: true,
                  isHost: selfPeerId !== null && selfPeerId === hostPeerId,
                  isSpeaking,
                  isBroadcasting: selfCameraOn || selfSharingScreen || selfSharingMusic,
                  isMicMuted,
                  isDeafened,
                  mutedMe: false,
                  mutedByMe: false,
                  userId: null,
                  connectionStatus: null,
                  isMusicRow: false,
                  volumeKey: ''
                },
                ...peers.flatMap((peer) => {
                  const voiceRow = {
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
                    isDeafened: peer.isDeafened,
                    mutedMe: peer.mutedMe,
                    mutedByMe: isPeerMutedByMe(peer.userId),
                    userId: peer.userId,
                    connectionStatus: peer.connectionStatus,
                    isMusicRow: false,
                    volumeKey: peer.userId
                  };
                  if (!peer.musicStream) return [voiceRow];
                  const musicVolumeKey = `${peer.userId}:music`;
                  return [
                    voiceRow,
                    {
                      key: `${peer.peerId}-music`,
                      name: `Music ${peer.displayName}`,
                      avatarUrl: peer.avatarUrl,
                      isSelf: false,
                      isHost: false,
                      isSpeaking: false,
                      isBroadcasting: true,
                      isMicMuted: false,
                      isDeafened: false,
                      mutedMe: false,
                      mutedByMe: isPeerMutedByMe(musicVolumeKey),
                      userId: peer.userId,
                      connectionStatus: null,
                      isMusicRow: true,
                      volumeKey: musicVolumeKey
                    }
                  ];
                })
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
                <div
                  className={'room-sidebar__room-row' + (draggedRoomId === room.id ? ' room-sidebar__room-row--dragging' : '')}
                  draggable={isReordering}
                  onDragStart={isReordering ? () => setDraggedRoomId(room.id) : undefined}
                  onDragOver={isReordering ? (event) => event.preventDefault() : undefined}
                  onDrop={isReordering ? () => handleDropReorder(room.id) : undefined}
                  onDragEnd={isReordering ? () => setDraggedRoomId(null) : undefined}
                >
                  {isReordering && (
                    <span className="room-sidebar__drag-handle">
                      <GripVertical size={15} />
                    </span>
                  )}
                  <button
                    className={'room-sidebar__room' + (isJoined ? ' room-sidebar__room--active' : '')}
                    onClick={isReordering ? undefined : () => onSelectRoom(room.id)}
                  >
                    <Volume2 size={16} className="room-sidebar__room-icon" />
                    <span className="room-sidebar__room-name">{room.name}</span>
                    <span className="room-sidebar__room-count">
                      {room.memberCount}/{room.maxMembers}
                    </span>
                  </button>
                  {!isReordering && (canRenameRooms || canCreateOrDeleteRooms) && (
                    <div className="room-sidebar__room-actions">
                      {canRenameRooms && (
                        <Tooltip label="Renomear sala">
                          <button className="room-sidebar__room-action" onClick={() => startRenaming(room)}>
                            <Pencil size={15} />
                          </button>
                        </Tooltip>
                      )}
                      {canCreateOrDeleteRooms && (
                        <Tooltip label="Excluir sala">
                          <button className="room-sidebar__room-action" onClick={() => setRoomPendingDelete(room)}>
                            <Trash2 size={15} />
                          </button>
                        </Tooltip>
                      )}
                    </div>
                  )}
                </div>
              )}

              {participants.length > 0 && (
                <div
                  className={
                    'room-sidebar__participants' +
                    (isParticipantsCompact ? ' room-sidebar__participants--compact' : '')
                  }
                >
                  {participants.map((participant) => {
                    const isVolumeTarget = !participant.isSelf && !!participant.userId;
                    const isVolumeMenuActive = isVolumeTarget && participant.volumeKey === activeVolumeMenuUserId;
                    return (
                    <div
                      key={participant.key}
                      className={
                        'room-sidebar__participant' +
                        (isParticipantsCompact ? ' room-sidebar__participant--compact' : '') +
                        (isVolumeTarget ? ' room-sidebar__participant--volume-target' : '') +
                        (isVolumeMenuActive ? ' room-sidebar__participant--volume-active' : '')
                      }
                      title={isParticipantsCompact ? participant.name : undefined}
                      onClick={
                        isVolumeTarget
                          ? () => onViewProfile(participant.userId!, participant.name, participant.avatarUrl)
                          : undefined
                      }
                      onContextMenu={
                        // Music rows' right-click lives on their own icon instead (see below) —
                        // opening the same volume menu from anywhere on the row would be a second,
                        // redundant path to it.
                        isVolumeTarget && !participant.isMusicRow
                          ? (event) => {
                              event.preventDefault();
                              onOpenVolumeMenu(
                                event.clientX,
                                event.clientY,
                                participant.key,
                                participant.userId!,
                                participant.name,
                                participant.volumeKey
                              );
                            }
                          : undefined
                      }
                    >
                      <span className="room-sidebar__avatar-wrap">
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
                        {participant.connectionStatus && (
                          <span
                            className={
                              'room-sidebar__connection-dot room-sidebar__connection-dot--' +
                              participant.connectionStatus
                            }
                            title={
                              participant.connectionStatus === 'connected'
                                ? 'Conectado'
                                : participant.connectionStatus === 'connecting'
                                  ? 'Conectando...'
                                  : 'Falha de conexão'
                            }
                          />
                        )}
                      </span>
                      {/* [2026-08-30, pedido do Mozar] Modo compacto — só o avatar (com o anel de
                          "está falando", se aplicável) sobrevive; nome e os badges (mutado, ao vivo,
                          host, "te mutou"/"você mutou") somem, sobra só uma fita de avatares. */}
                      {!isParticipantsCompact && (
                        <>
                          <span className="room-sidebar__participant-name">{participant.name}</span>
                          {participant.isMicMuted && (
                            <span
                              className="room-sidebar__mic-status"
                              title={participant.isDeafened ? 'Não está ouvindo nem falando' : 'Microfone desativado'}
                            >
                              <MicOff size={18} />
                              {participant.isDeafened && <HeadphoneOff size={18} />}
                            </span>
                          )}
                          {participant.mutedMe && (
                            <span className="room-sidebar__muted-me-status" title={`${participant.name} te mutou`}>
                              <EarOff size={18} />
                            </span>
                          )}
                          {participant.mutedByMe && !participant.isMusicRow && (
                            <span className="room-sidebar__muted-by-me-status" title={`Você mutou ${participant.name}`}>
                              <VolumeX size={18} />
                            </span>
                          )}
                          {/* [2026-08-30, pedido do Mozar] "Music <nome>" não usa o padrão de
                              clique-direito-abre-menu de um participante normal — o ícone é o
                              controle inteiro: clique esquerdo muta/desmuta na hora, clique
                              direito abre o volume (mesmo popup de sempre, ParticipantVolumeMenu).
                              stopPropagation nos dois pra não também disparar o onClick/
                              onContextMenu da linha (Ver perfil / nada, já que o próprio
                              onContextMenu da linha é desligado pra linhas de música acima). */}
                          {participant.isMusicRow && (
                            <button
                              type="button"
                              className="room-sidebar__music-mute-button"
                              title={participant.mutedByMe ? `Desmutar ${participant.name}` : `Mutar ${participant.name}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                onToggleMusicMute(participant.volumeKey);
                              }}
                              onContextMenu={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                onOpenVolumeMenu(
                                  event.clientX,
                                  event.clientY,
                                  participant.key,
                                  participant.userId!,
                                  participant.name,
                                  participant.volumeKey
                                );
                              }}
                            >
                              {participant.mutedByMe ? <VolumeX size={18} /> : <Volume2 size={18} />}
                            </button>
                          )}
                          {participant.isBroadcasting && <LiveBadge className="room-sidebar__live-badge" />}
                          {participant.isHost && <HostStarBadge className="room-sidebar__host-star" />}
                        </>
                      )}
                    </div>
                    );
                  })}
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
              <button
                className={
                  'room-sidebar__quick-action' + (selfSharingMusic ? ' room-sidebar__quick-action--active' : '')
                }
                title={selfSharingMusic ? 'Parar de compartilhar áudio' : 'Compartilhar áudio'}
                onClick={onToggleMusicShare}
              >
                <Music2 size={18} />
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
          downloadingSoundIds={downloadingSoundIds}
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
