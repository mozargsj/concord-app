import { useEffect, useMemo, useRef, useState } from 'react';
import type { RoomSummary, ServerSummary, UserProfile } from '@concord/shared';
import type { ScreenSource } from '../types/window';
import ServerRail from '../components/ServerRail';
import RoomSidebar from '../components/RoomSidebar';
import TopBar from '../components/TopBar';
import RoomView from '../components/RoomView';
import ServerActionsModal from '../components/ServerActionsModal';
import InviteCodeModal from '../components/InviteCodeModal';
import ScreenSharePicker from '../components/ScreenSharePicker';
import LoadingSpinner from '../components/LoadingSpinner';
import ProfilePage from './ProfilePage';
import {
  ApiError,
  TEST_MODE,
  createInvite,
  createRoom,
  deleteRoom,
  getServer,
  listMyServers,
  listRooms,
  renameRoom
} from '../lib/api';
import { useRoomConnection } from '../hooks/useRoomConnection';
import { getPreferredDeviceId } from '../lib/devicePreferences';
import { loadCachedImage } from '../lib/imageCache';
import {
  playCameraStart,
  playCameraStop,
  playDeafenMuted,
  playDeafenUnmuted,
  playMicMuted,
  playMicUnmuted,
  playRoomJoin,
  playRoomLeave,
  playTransmissionEnter,
  playTransmissionExit,
  setDeafened as setSoundsDeafened
} from '../lib/soundEffects';
import '../styles/ServerListPage.css';

interface ServerListPageProps {
  currentUser: UserProfile;
  onCurrentUserChange: (user: UserProfile) => void;
  onActiveServerChange: (serverName: string) => void;
}

interface InviteState {
  code: string | null;
  isLoading: boolean;
  error: string | null;
}

export default function ServerListPage({
  currentUser,
  onCurrentUserChange,
  onActiveServerChange
}: ServerListPageProps) {
  const [myServers, setMyServers] = useState<ServerSummary[] | null>(null);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [selectedServer, setSelectedServer] = useState<ServerSummary | null>(null);
  const [myRole, setMyRole] = useState<number>(4);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [isScreenPickerOpen, setIsScreenPickerOpen] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [serverActionsMode, setServerActionsMode] = useState<'create' | 'join' | null>(null);
  const [inviteState, setInviteState] = useState<InviteState | null>(null);

  // Just enough of selectedServer for useRoomConnection to know who to ask for the room's
  // server icon (its owner) and what to answer with if that owner is me — memoized so the
  // hook's ref-sync effect doesn't re-run every render over an equivalent-but-new object.
  const roomServerInfo = useMemo(
    () =>
      selectedServer
        ? { id: selectedServer.id, ownerUserId: selectedServer.ownerUserId, iconUrl: selectedServer.iconUrl }
        : null,
    [selectedServer]
  );

  function handleServerIconReceived(serverId: string, url: string): void {
    setSelectedServer((prev) => (prev && prev.id === serverId ? { ...prev, iconUrl: url } : prev));
    setMyServers((prev) => prev?.map((server) => (server.id === serverId ? { ...server, iconUrl: url } : server)) ?? prev);
  }

  function handleServerUpdated(updated: ServerSummary): void {
    setSelectedServer((prev) => (prev && prev.id === updated.id ? updated : prev));
    setMyServers((prev) => prev?.map((server) => (server.id === updated.id ? updated : server)) ?? prev);
  }

  // Bumped every time a P2P sound download finishes (see useRoomConnection's onSoundDownloaded)
  // — RoomSidebar watches this to know when to re-read the temp-cache list, since the actual
  // download happens deep inside the mesh, not in anything RoomSidebar itself calls.
  const [soundDownloadTick, setSoundDownloadTick] = useState(0);

  const {
    connectionStatus,
    selfPeerId,
    hostPeerId,
    peers,
    latencyMs,
    selfIsSpeaking,
    peerSoundLists,
    setLocalCameraTrack,
    setLocalScreenTrack,
    switchMicDevice,
    refreshMicPipeline,
    sendDeviceSwitched,
    playSoundboardClip,
    requestPeerSoundList,
    requestPeerSound
  } = useRoomConnection(
    selectedRoomId,
    currentUser.displayName,
    currentUser.id,
    isMicMuted,
    isDeafened,
    currentUser.avatarUrl,
    roomServerInfo,
    handleServerIconReceived,
    () => setSoundDownloadTick((tick) => tick + 1)
  );

  const cameraStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    listMyServers().then((servers) => {
      setMyServers(servers);
      if (servers.length > 0) setSelectedServerId((prev) => prev ?? servers[0].id);
    });
  }, []);

  useEffect(() => {
    if (!selectedServerId) {
      setSelectedServer(null);
      return;
    }
    let cancelled = false;
    getServer(selectedServerId).then(({ server, myRole: role }) => {
      if (cancelled) return;
      setSelectedServer(server);
      setMyRole(role);
      // The backend's iconUrl may be null (nothing persisted server-side for it — see
      // decisions.md, images are P2P-only now) even though *I* am the one who set this icon
      // and it's sitting right here in my own disk cache from having picked it.
      if (!server.iconUrl && server.ownerUserId === currentUser.id) {
        loadCachedImage('server-icon', server.id).then((cached) => {
          if (!cancelled && cached) setSelectedServer((prev) => (prev ? { ...prev, iconUrl: cached.url } : prev));
        });
      }
    });
    listRooms(selectedServerId).then((list) => {
      if (!cancelled) setRooms(list);
    });
    setSelectedRoomId(null);
    return () => {
      cancelled = true;
    };
  }, [selectedServerId]);

  useEffect(() => {
    onActiveServerChange(selectedServer?.name ?? 'Concord');
  }, [selectedServer, onActiveServerChange]);

  // Before the window actually closes, drop out of the room the same way "Sair" does — reuses
  // useRoomConnection's existing cleanup (stop mic/camera, close mesh + signaling socket) so
  // other participants see the disconnect right away instead of a TCP timeout.
  useEffect(() => {
    return window.concord.app.onBeforeQuit(() => setSelectedRoomId(null));
  }, []);

  useEffect(() => {
    setSoundsDeafened(isDeafened);
  }, [isDeafened]);

  // Unexpected drop (not a manual "leave") — fall back to "Ninguém está em voz" instead of
  // showing a dead room view. No reconnect attempt in this pass, kept intentionally minimal.
  useEffect(() => {
    if (selectedRoomId && connectionStatus === 'disconnected') setSelectedRoomId(null);
  }, [connectionStatus, selectedRoomId]);

  // Stop every local track on leaving the room — real local capture, never sent anywhere
  // once the room changes (no RTCPeerConnection yet for it), but the hardware indicator
  // light must still turn off like it would for any other app.
  useEffect(() => {
    if (selectedRoomId) return;
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    screenStreamRef.current = null;
    setCameraStream(null);
    setScreenStream(null);
  }, [selectedRoomId]);

  useEffect(() => {
    return () => {
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

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
      setLocalCameraTrack(stream.getVideoTracks()[0] ?? null);
    } catch (error) {
      setMediaError(error instanceof Error ? error.message : 'Não foi possível acessar a câmera.');
    }
  }

  async function handleToggleCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
      setCameraStream(null);
      setLocalCameraTrack(null);
      playCameraStop();
      return;
    }
    await startCamera();
    if (cameraStreamRef.current) playCameraStart();
  }

  async function handleSelectCamera(deviceId: string) {
    if (cameraStream) {
      const previousStream = cameraStream;
      // startCamera() below calls setLocalCameraTrack with the new track while the old
      // sender is still attached — the mesh swaps it via replaceTrack (no renegotiation).
      // Stopping the previous device only after that keeps a picture on screen the whole time.
      await startCamera(deviceId);
      previousStream.getTracks().forEach((track) => track.stop());
    }
  }

  function handleToggleScreenShare() {
    if (screenStream) {
      screenStream.getTracks().forEach((track) => track.stop());
      screenStreamRef.current = null;
      setScreenStream(null);
      setLocalScreenTrack(null);
      playTransmissionExit();
      return;
    }
    setIsScreenPickerOpen(true);
  }

  async function handlePickScreenSource(source: ScreenSource, includeAudio: boolean) {
    setIsScreenPickerOpen(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // Electron's documented desktopCapturer pattern — legacy constraint shape is still
        // how Chromium wires a specific screen/window id in. System-audio loopback via
        // chromeMediaSource:'desktop' is Windows-only and only reliable for whole-screen
        // sources, not individual windows.
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
      setLocalScreenTrack(stream);
      playTransmissionEnter();
    } catch (error) {
      setMediaError(error instanceof Error ? error.message : 'Não foi possível capturar a tela escolhida.');
    }
  }

  function handleToggleMic() {
    setIsMicMuted((prev) => {
      const next = !prev;
      // Unmuting manually also lifts deafen — matches how Discord's headset behaves.
      if (!next && isDeafened) setIsDeafened(false);
      if (next) playMicMuted();
      else playMicUnmuted();
      return next;
    });
  }

  function handleToggleDeafen() {
    setIsDeafened((prev) => {
      const next = !prev;
      // Mic mirrors deafen both ways — deafening mutes it, un-deafening unmutes it too.
      setIsMicMuted(next);
      // One combined sound for "headset + mic together" — sets isMicMuted directly rather
      // than calling handleToggleMic, so its mic-only sound never fires alongside this one.
      if (next) playDeafenMuted();
      else playDeafenUnmuted();
      return next;
    });
  }

  function handleLeave() {
    playRoomLeave();
    setSelectedRoomId(null);
  }

  // [MODO TESTE — TEMPORÁRIO] Fora do modo teste, esse som só toca via peer-joined real (a
  // sinalização confirmando que outra pessoa entrou) — sozinho numa sala nunca dá pra ouvir.
  // Em teste, dispara também ao clicar pra entrar, sem esperar validação real do servidor, só
  // pra dar pra conferir o som sem precisar de uma segunda janela/peer.
  function handleSelectRoom(roomId: string) {
    setSelectedRoomId(roomId);
    if (TEST_MODE) playRoomJoin();
  }

  function handleServerCreated(server: ServerSummary) {
    setServerActionsMode(null);
    onCurrentUserChange({ ...currentUser, ownedServerId: server.id });
    setMyServers((prev) => [...(prev ?? []), server]);
    setSelectedServerId(server.id);
  }

  function handleServerJoined(server: ServerSummary) {
    setServerActionsMode(null);
    setMyServers((prev) => (prev?.some((s) => s.id === server.id) ? prev : [...(prev ?? []), server]));
    setSelectedServerId(server.id);
  }

  async function refreshRooms() {
    if (!selectedServerId) return;
    setRooms(await listRooms(selectedServerId));
  }

  async function handleCreateRoom(name: string) {
    if (!selectedServerId) return;
    await createRoom(selectedServerId, name);
    await refreshRooms();
  }

  async function handleRenameRoom(roomId: string, name: string) {
    if (!selectedServerId) return;
    await renameRoom(selectedServerId, roomId, name);
    await refreshRooms();
  }

  async function handleDeleteRoom(roomId: string) {
    if (!selectedServerId) return;
    await deleteRoom(selectedServerId, roomId);
    if (selectedRoomId === roomId) setSelectedRoomId(null);
    await refreshRooms();
  }

  async function handleOpenInvite() {
    if (!selectedServerId) return;
    setInviteState({ code: null, isLoading: true, error: null });
    try {
      const code = await createInvite(selectedServerId);
      setInviteState({ code, isLoading: false, error: null });
    } catch (error) {
      setInviteState({
        code: null,
        isLoading: false,
        error: error instanceof ApiError ? 'Só admins ou o dono podem gerar convites.' : 'Não foi possível gerar o convite.'
      });
    }
  }

  if (myServers === null) {
    return (
      <div className="server-list-page server-list-page--loading">
        <LoadingSpinner />
      </div>
    );
  }

  const hasOwnServer = currentUser.ownedServerId !== null;

  if (myServers.length === 0) {
    return (
      <div className="server-list-page">
        <ServerRail
          currentUser={currentUser}
          hasOwnServer={hasOwnServer}
          servers={[]}
          selectedServerId={null}
          onSelectServer={setSelectedServerId}
          onOpenProfile={() => setIsProfileOpen(true)}
          onOpenInvite={() => setServerActionsMode('join')}
          onOpenCreateServer={() => setServerActionsMode('create')}
          onServerUpdated={handleServerUpdated}
        />

        <div className="server-list-page__main server-list-page__main--empty">
          <p>Crie um servidor ou entre com um código de convite.</p>
        </div>

        {isProfileOpen && (
          <ProfilePage
            user={currentUser}
            onClose={() => setIsProfileOpen(false)}
            onUserChange={onCurrentUserChange}
          />
        )}

        {serverActionsMode && (
          <ServerActionsModal
            mode={serverActionsMode}
            onClose={() => setServerActionsMode(null)}
            onServerCreated={handleServerCreated}
            onServerJoined={handleServerJoined}
          />
        )}
      </div>
    );
  }

  if (!selectedServerId || !selectedServer) {
    return (
      <div className="server-list-page server-list-page--loading">
        <LoadingSpinner />
      </div>
    );
  }

  const selectedRoom = rooms.find((room) => room.id === selectedRoomId) ?? null;

  return (
    <div className="server-list-page">
      <ServerRail
        currentUser={currentUser}
        hasOwnServer={hasOwnServer}
        servers={myServers}
        selectedServerId={selectedServerId}
        onSelectServer={setSelectedServerId}
        onOpenProfile={() => setIsProfileOpen(true)}
        onOpenInvite={() => setServerActionsMode('join')}
        onOpenCreateServer={() => setServerActionsMode('create')}
        onServerUpdated={handleServerUpdated}
      />

      <RoomSidebar
        server={selectedServer}
        myRole={myRole}
        rooms={rooms}
        selectedRoomId={selectedRoomId}
        onSelectRoom={handleSelectRoom}
        onCreateRoom={handleCreateRoom}
        onRenameRoom={handleRenameRoom}
        onDeleteRoom={handleDeleteRoom}
        onOpenInvite={handleOpenInvite}
        isMicMuted={isMicMuted}
        isDeafened={isDeafened}
        onToggleMic={handleToggleMic}
        onToggleDeafen={handleToggleDeafen}
        onSelectMic={switchMicDevice}
        onSelectSpeaker={() => sendDeviceSwitched('speaker')}
        onNoiseSuppressionChange={refreshMicPipeline}
        isSpeaking={selfIsSpeaking && !isMicMuted}
        showMutedSpeakingHint={isMicMuted && selfIsSpeaking}
        latencyMs={latencyMs}
        onLeave={handleLeave}
        selfPeerId={selfPeerId}
        hostPeerId={hostPeerId}
        peers={peers}
        currentUser={currentUser}
        onOpenProfile={() => setIsProfileOpen(true)}
        selfCameraOn={!!cameraStream}
        selfSharingScreen={!!screenStream}
        onToggleCamera={handleToggleCamera}
        onToggleScreenShare={handleToggleScreenShare}
        onPlaySoundboardClip={playSoundboardClip}
        peerSoundLists={peerSoundLists}
        onRequestPeerSoundList={requestPeerSoundList}
        onRequestPeerSound={requestPeerSound}
        soundDownloadTick={soundDownloadTick}
      />

      <div className="server-list-page__main">
        <TopBar roomName={selectedRoom?.name ?? null} />
        <RoomView
          room={selectedRoom}
          isMicMuted={isMicMuted}
          onToggleMic={handleToggleMic}
          onSelectMic={switchMicDevice}
          isSpeaking={selfIsSpeaking}
          showMutedSpeakingHint={isMicMuted && selfIsSpeaking}
          onLeave={handleLeave}
          isDeafened={isDeafened}
          selfPeerId={selfPeerId}
          hostPeerId={hostPeerId}
          peers={peers}
          currentUserDisplayName={currentUser.displayName}
          currentUserAvatarUrl={currentUser.avatarUrl}
          cameraStream={cameraStream}
          screenStream={screenStream}
          mediaError={mediaError}
          onToggleCamera={handleToggleCamera}
          onSelectCamera={handleSelectCamera}
          onToggleScreenShare={handleToggleScreenShare}
        />
      </div>

      {isProfileOpen && (
        <ProfilePage
          user={currentUser}
          onClose={() => setIsProfileOpen(false)}
          onUserChange={onCurrentUserChange}
        />
      )}

      {serverActionsMode && (
        <ServerActionsModal
          mode={serverActionsMode}
          onClose={() => setServerActionsMode(null)}
          onServerCreated={handleServerCreated}
          onServerJoined={handleServerJoined}
        />
      )}

      {inviteState && (
        <InviteCodeModal
          code={inviteState.code}
          isLoading={inviteState.isLoading}
          error={inviteState.error}
          onClose={() => setInviteState(null)}
        />
      )}

      {isScreenPickerOpen && (
        <ScreenSharePicker onSelect={handlePickScreenSource} onClose={() => setIsScreenPickerOpen(false)} />
      )}
    </div>
  );
}
