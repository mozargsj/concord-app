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
import ParticipantVolumeMenu from '../components/ParticipantVolumeMenu';
import ProfilePage from './ProfilePage';
import {
  ApiError,
  TEST_OFFLINE,
  createInvite,
  createRoom,
  deleteRoom,
  getServer,
  listMyServers,
  listRooms,
  renameRoom,
  reportClientError
} from '../lib/api';
import { useRoomConnection } from '../hooks/useRoomConnection';
import { usePeerVolumeControl } from '../hooks/usePeerVolumeControl';
import { getPreferredDeviceId } from '../lib/devicePreferences';
import { loadCachedImage } from '../lib/imageCache';
import { startExcludedLoopbackAudio, type LoopbackAudioSession } from '../lib/processLoopbackAudio';
import type { ScreenQualityMode } from '../lib/screenSharePreferences';
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
  onLogout: () => void;
}

interface InviteState {
  code: string | null;
  isLoading: boolean;
  error: string | null;
  isForbidden: boolean;
}

export default function ServerListPage({
  currentUser,
  onCurrentUserChange,
  onActiveServerChange,
  onLogout
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

  // Lifted here (not local to RoomView) so RoomView and RoomSidebar — siblings — share one live
  // copy of per-peer volume/mute state instead of only agreeing via localStorage on next mount.
  const peerVolume = usePeerVolumeControl();

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
  // Only set when handlePickScreenSource used the native excluded-loopback audio path (Windows,
  // addon available) instead of the legacy getUserMedia system-audio capture — its track lives
  // on screenStreamRef like any other, but the native capture thread + AudioContext behind it
  // need their own teardown call, which plain track.stop() doesn't reach.
  const loopbackAudioSessionRef = useRef<LoopbackAudioSession | null>(null);

  function stopScreenShareTracks() {
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current = null;
    loopbackAudioSessionRef.current?.stop();
    loopbackAudioSessionRef.current = null;
  }

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
    cameraStreamRef.current = null;
    stopScreenShareTracks();
    setCameraStream(null);
    setScreenStream(null);
  }, [selectedRoomId]);

  useEffect(() => {
    return () => {
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      stopScreenShareTracks();
    };
  }, []);

  // Shared by the manual "turn camera off" path and the unexpected-failure path below — both end
  // up at the exact same cleanup, just triggered differently.
  function teardownCamera() {
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    setCameraStream(null);
    setLocalCameraTrack(null);
  }

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
      const track = stream.getVideoTracks()[0] ?? null;
      setLocalCameraTrack(track);
      // Fires only when the track ends for a reason outside our control (device unplugged,
      // driver crash, OS revoking the permission mid-call) — never from our own track.stop()
      // calls (teardownCamera/device-switch), which the spec explicitly excludes from this event.
      // Without this, RoomView still shows the last frame frozen forever (or, if focused, a dead
      // 16:9 box) since nothing ever told the rest of the app the camera was gone.
      if (track) {
        track.onended = () => {
          if (cameraStreamRef.current !== stream) return; // stale handler from an already-replaced stream
          teardownCamera();
          playCameraStop();
          setMediaError('A câmera parou de responder e a transmissão foi encerrada.');
          void reportClientError('CameraEndedUnexpectedly', 'Camera track ended without user action (device disconnected or driver error)');
        };
      }
    } catch (error) {
      setMediaError(error instanceof Error ? error.message : 'Não foi possível acessar a câmera.');
      void reportClientError('CameraAccessError', error instanceof Error ? error.message : String(error), error instanceof Error ? error.stack : undefined);
    }
  }

  async function handleToggleCamera() {
    if (cameraStream) {
      teardownCamera();
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

  // Shared by the manual "stop sharing" path and the shared-window-closed path below — both end
  // up at the exact same cleanup, just triggered differently (same pattern as teardownCamera).
  function stopScreenShare() {
    stopScreenShareTracks();
    setScreenStream(null);
    setLocalScreenTrack(null);
    playTransmissionExit();
  }

  function handleToggleScreenShare() {
    if (screenStream) {
      stopScreenShare();
      return;
    }
    setIsScreenPickerOpen(true);
  }

  async function handlePickScreenSource(source: ScreenSource, includeAudio: boolean, qualityMode: ScreenQualityMode) {
    setIsScreenPickerOpen(false);
    // Excludes Concord's own audio from the loopback (processLoopbackAudio.ts) — fixes viewers
    // hearing their own voice echoed back during a transmission with system audio (only reported
    // with system audio on, matches: Concord's own playback of everyone else's mic was getting
    // folded into the sharer's captured system audio and sent back out). Windows-only; returns
    // null on any other platform or if the native addon isn't available/blocked, in which case
    // the legacy whole-desktop-loopback capture below runs completely unchanged.
    const loopbackSession = includeAudio ? await startExcludedLoopbackAudio() : null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // Electron's documented desktopCapturer pattern — legacy constraint shape is still
        // how Chromium wires a specific screen/window id in. System-audio loopback via
        // chromeMediaSource:'desktop' is Windows-only and only reliable for whole-screen
        // sources, not individual windows.
        //
        // [Tentativa revertida] googEchoCancellation/googAutoGainControl/googNoiseSuppression/
        // googHighpassFilter:false foram testados aqui pra atacar um relato de efeito "reverb"/
        // "dentro do banheiro" + retorno de fala na transmissão de tela (decisions.md, pontos em
        // aberto) — piorou na prática (áudio picotando, efeito pior), então revertido. Não ficou
        // confirmado se a causa raiz é mesmo processamento de áudio indevido nessa track (a
        // teoria original) ou outra coisa (rede/CPU de quem testa, comportamento diferente dessas
        // constraints legadas nessa versão do Chromium) — investigar com dados reais (getStats())
        // antes de tentar de novo, não só trocar flags no escuro.
        //
        // [Bug corrigido] channelCount:2 tinha sido colocado como propriedade solta ao lado de
        // `mandatory` — Chromium rejeita isso de cara ("Malformed constraint: Cannot use both
        // optional/mandatory and specific or advanced constraints"), quebrando getUserMedia por
        // completo sempre que includeAudio era true (compartilhar tela SEM áudio continuava
        // funcionando, por nunca passar por esse objeto). Constraint legada (`mandatory`) só
        // aceita se misturar com outra propriedade padrão dentro do array `optional` — não solta
        // no mesmo objeto. Pedido de estéreo continua o mesmo, só a forma de pedir mudou.
        //
        // includeAudio && !loopbackSession: só pede áudio por aqui quando o caminho nativo acima
        // não rodou ou não deu certo — com ele, o áudio vem de loopbackSession.track em vez desta
        // constraint, e pedir os dois ao mesmo tempo botaria dois sistemas de captura de sistema
        // rodando ao mesmo tempo.
        audio:
          includeAudio && !loopbackSession
            ? ({ mandatory: { chromeMediaSource: 'desktop' }, optional: [{ channelCount: 2 }] } as MediaTrackConstraints)
            : false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: source.id
          }
        } as MediaTrackConstraints
      });
      if (loopbackSession) {
        loopbackAudioSessionRef.current = loopbackSession;
        stream.addTrack(loopbackSession.track);
      }
      screenStreamRef.current = stream;
      setScreenStream(stream);
      setMediaError(null);
      setLocalScreenTrack(stream, qualityMode);
      playTransmissionEnter();

      // Fires when the captured source itself disappears (the shared window/app/game was closed,
      // not the user clicking "parar de compartilhar") — same rationale and guard as the camera's
      // track.onended above: without this, the sharer's own state never updates, so nothing ever
      // tells viewers to stop either (setLocalScreenTrack(null) is what sends screen-share-changed:
      // false), leaving their tile stuck on a dead track forever instead of closing automatically.
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.onended = () => {
          if (screenStreamRef.current !== stream) return; // stale handler from an already-replaced stream
          stopScreenShare();
          setMediaError('O aplicativo compartilhado foi fechado e a transmissão foi encerrada.');
          void reportClientError('ScreenShareEndedUnexpectedly', 'Screen share video track ended without user action (shared window/app/process closed)');
        };
      }
    } catch (error) {
      loopbackSession?.stop();
      setMediaError(error instanceof Error ? error.message : 'Não foi possível capturar a tela escolhida.');
      void reportClientError('ScreenCaptureError', error instanceof Error ? error.message : String(error), error instanceof Error ? error.stack : undefined);
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

  // [MODO TESTE OFFLINE — TEMPORÁRIO] `useRoomConnection` agora toca o som de entrar de verdade
  // via `room-joined` (evento real de sinalização, funciona sozinho numa sala vazia e em produção
  // — não é mais exclusivo de teste). Só o modo 100% offline não tem nenhum WebSocket real, então
  // nunca recebe esse evento — mantém o disparo direto no clique só pra esse caso específico.
  function handleSelectRoom(roomId: string) {
    setSelectedRoomId(roomId);
    if (TEST_OFFLINE) playRoomJoin();
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
    setInviteState({ code: null, isLoading: true, error: null, isForbidden: false });
    try {
      const code = await createInvite(selectedServerId);
      setInviteState({ code, isLoading: false, error: null, isForbidden: false });
    } catch (error) {
      const isForbidden = error instanceof ApiError && error.code === 'forbidden';
      setInviteState({
        code: null,
        isLoading: false,
        error: isForbidden ? 'Só admins ou o dono podem gerar convites.' : 'Não foi possível gerar o convite.',
        isForbidden
      });
      void reportClientError(
        'CreateInviteError',
        error instanceof Error ? error.message : String(error),
        error instanceof Error ? error.stack : undefined,
        { serverId: selectedServerId ?? undefined }
      );
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
            serverId={selectedServerId ?? undefined}
            onClose={() => setIsProfileOpen(false)}
            onUserChange={onCurrentUserChange}
            onLogout={onLogout}
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
        onOpenVolumeMenu={peerVolume.openVolumeMenu}
        activeVolumeMenuUserId={peerVolume.volumeMenu?.userId ?? null}
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
          getPeerVolume={peerVolume.getEffectiveVolume}
          onOpenVolumeMenu={peerVolume.openVolumeMenu}
          activeVolumeMenuUserId={peerVolume.volumeMenu?.userId ?? null}
        />
      </div>

      {isProfileOpen && (
        <ProfilePage
          user={currentUser}
          serverId={selectedServerId ?? undefined}
          onClose={() => setIsProfileOpen(false)}
          onUserChange={onCurrentUserChange}
          onLogout={onLogout}
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
          isForbidden={inviteState.isForbidden}
          onClose={() => setInviteState(null)}
        />
      )}

      {isScreenPickerOpen && (
        <ScreenSharePicker onSelect={handlePickScreenSource} onClose={() => setIsScreenPickerOpen(false)} />
      )}

      {peerVolume.volumeMenu && (
        <ParticipantVolumeMenu
          x={peerVolume.volumeMenu.x}
          y={peerVolume.volumeMenu.y}
          name={peerVolume.volumeMenu.name}
          volume={peerVolume.getEffectivePeerSettings(peerVolume.volumeMenu.userId).volume}
          isMuted={peerVolume.getEffectivePeerSettings(peerVolume.volumeMenu.userId).muted}
          onVolumeChange={(value) => peerVolume.handlePeerVolumeChange(peerVolume.volumeMenu!.userId, value)}
          onToggleMute={() => peerVolume.handleTogglePeerMute(peerVolume.volumeMenu!.userId)}
          onClose={peerVolume.closeVolumeMenu}
        />
      )}
    </div>
  );
}
