import { useEffect, useMemo, useRef, useState } from 'react';
import type { RoomSummary, ServerSummary, UserProfile } from '@concord/shared';
import type { ScreenSource } from '../types/window';
import ServerRail from '../components/ServerRail';
import RoomSidebar from '../components/RoomSidebar';
import TopBar from '../components/TopBar';
import RoomView from '../components/RoomView';
import RoomChat from '../components/RoomChat';
import ServerActionsModal from '../components/ServerActionsModal';
import InviteCodeModal from '../components/InviteCodeModal';
import ScreenSharePicker from '../components/ScreenSharePicker';
import AudioSharePicker from '../components/AudioSharePicker';
import LoadingSpinner from '../components/LoadingSpinner';
import NoInternetScreen from '../components/NoInternetScreen';
import ParticipantVolumeMenu from '../components/ParticipantVolumeMenu';
import ParticipantProfileModal from '../components/ParticipantProfileModal';
import ProfilePage from './ProfilePage';
import {
  ApiError,
  checkServerHealth,
  createInvite,
  createRoom,
  deleteRoom,
  getServer,
  listMyServers,
  listRooms,
  renameRoom,
  reorderRooms,
  reportClientError
} from '../lib/api';
import type { PresenceStatus } from '@concord/shared';
import RemoteControlLayer from '../components/RemoteControlLayer';
import { useRoomConnection } from '../hooks/useRoomConnection';
import { useRemoteControl } from '../hooks/useRemoteControl';
import { getPresenceStatus, onPresenceStatusChange } from '../lib/presenceStatus';
import { usePeerVolumeControl } from '../hooks/usePeerVolumeControl';
import { getPreferredDeviceId } from '../lib/devicePreferences';
import { loadCachedImage } from '../lib/imageCache';
import {
  startExcludedLoopbackAudio,
  startProcessLoopbackAudio,
  type LoopbackAudioSession
} from '../lib/processLoopbackAudio';
import type { ScreenQualityMode } from '../lib/screenSharePreferences';
import {
  playCameraStart,
  playCameraStop,
  playDeafenMuted,
  playDeafenUnmuted,
  playMicMuted,
  playMicUnmuted,
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

// How often to retry GET /health once the browser's own 'online' event fires but the server
// isn't actually reachable yet (e.g. the network interface came up before real WAN routing did).
const RECONNECT_RETRY_INTERVAL_MS = 3000;

// How long connectivity must look actually down before treating it as real — see the effect's own
// comment below. Long enough to ignore a brief wifi blip (the kind WebRTC's own ICE already rides
// out on its own), short enough that a genuine outage is still noticed quickly.
const OFFLINE_DEBOUNCE_MS = 5000;

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
  // [2026-08-30, pedido do Mozar] "Compartilhar áudio" — isMusicSharing (não uma MediaStream local
  // pra guardar, já que é só um track de áudio de captura por processo, sem preview visual próprio
  // como a tela tem) é o suficiente pra UI saber se está ativo agora.
  const [isMusicSharing, setIsMusicSharing] = useState(false);
  const [isAudioPickerOpen, setIsAudioPickerOpen] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [serverActionsMode, setServerActionsMode] = useState<'create' | 'join' | null>(null);
  const [inviteState, setInviteState] = useState<InviteState | null>(null);
  // System-level connectivity (navigator.onLine), not "is our server reachable" — that's the
  // separate App.tsx/ServerOfflineScreen check. Fully automatic: no retry button, just watches
  // for the browser's own online/offline events and confirms with a real health check before
  // declaring it fixed (an interface coming back up doesn't mean the internet actually works).
  const [connectivityStatus, setConnectivityStatus] = useState<'online' | 'offline' | 'reconnecting'>('online');
  // Captured at the moment connectivity drops so the room can be rejoined automatically once
  // confirmed back — the existing disconnect-cleanup effect below clears selectedRoomId shortly
  // after anyway, so this needs to be saved before that happens, not read back out of state later.
  const reconnectTargetRef = useRef<{ serverId: string; roomId: string } | null>(null);

  // Lifted here (not local to RoomView) so RoomView and RoomSidebar — siblings — share one live
  // copy of per-peer volume/mute state instead of only agreeing via localStorage on next mount.
  const peerVolume = usePeerVolumeControl();

  // Lifted here (not local to RoomSidebar/RoomView) so the "Ver perfil" entry in
  // ParticipantVolumeMenu — rendered at this level — can open it too, without needing to know
  // which of the two sibling components the right-click originated from.
  const [viewingProfile, setViewingProfile] = useState<{
    userId: string;
    name: string;
    avatarUrl: string | null;
  } | null>(null);

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

  // Owner-only (EditServerModal only reaches this via ServerRail's right-click, already gated to
  // the owner) — frees ownedServerId so they can create/own another server, and falls back to
  // whatever server remains (or the empty state) same as the mount-time auto-select logic below.
  function handleServerDeleted(deletedId: string): void {
    const remaining = (myServers ?? []).filter((server) => server.id !== deletedId);
    setMyServers(remaining);
    onCurrentUserChange({ ...currentUser, ownedServerId: null });
    setSelectedServerId((prev) => (prev !== deletedId ? prev : (remaining[0]?.id ?? null)));
  }

  // Bumped every time a P2P sound download finishes (see useRoomConnection's onSoundDownloaded)
  // — RoomSidebar watches this to know when to re-read the temp-cache list, since the actual
  // download happens deep inside the mesh, not in anything RoomSidebar itself calls.
  const [soundDownloadTick, setSoundDownloadTick] = useState(0);

  // Per-room text chat panel (RoomChat.tsx) — toggled by TopBar's existing "Conversa por texto"
  // icon, which never did anything before this. Only rendered while a room is actually joined
  // (see the JSX below); left true across a room switch is harmless since chatMessages itself
  // already resets per room (useRoomConnection).
  const [isChatOpen, setIsChatOpen] = useState(false);

  // Profile presence status (online/ocupado/indisponível/offline) — changed in ProfilePage, kept
  // here so it goes to the room (signaling) and to the main process's remote-control gate.
  const [presenceStatus, setPresenceStatusState] = useState<PresenceStatus>(getPresenceStatus);
  useEffect(() => onPresenceStatusChange(setPresenceStatusState), []);
  useEffect(() => {
    void window.concord.remoteControl.setStatus(presenceStatus);
  }, [presenceStatus]);
  // True only while THIS user shares a whole screen — the one case remote control exists for.
  const [sharingFullScreen, setSharingFullScreen] = useState(false);

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
    setLocalMusicTrack,
    switchMicDevice,
    refreshMicPipeline,
    sendDeviceSwitched,
    sendMuteStatus,
    playSoundboardClip,
    requestPeerSoundList,
    requestPeerSound,
    chatMessages,
    sendChatMessage,
    rerollChatMessage,
    controlHandlersRef,
    sendControlFrame,
    sendMoveFrame,
    sendFileFrame,
    sendFileChunk
  } = useRoomConnection(
    selectedRoomId,
    currentUser.displayName,
    currentUser.id,
    isMicMuted,
    isDeafened,
    currentUser.avatarUrl,
    roomServerInfo,
    handleServerIconReceived,
    () => setSoundDownloadTick((tick) => tick + 1),
    presenceStatus
  );

  const remoteControl = useRemoteControl({
    peers,
    selfPeerId,
    controlHandlersRef,
    sendControlFrame,
    sendMoveFrame,
    sendFileFrame,
    sendFileChunk,
    sharingFullScreen
  });

  const cameraStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  // Only set when handlePickScreenSource used the native excluded-loopback audio path (Windows,
  // addon available) instead of the legacy getUserMedia system-audio capture — its track lives
  // on screenStreamRef like any other, but the native capture thread + AudioContext behind it
  // need their own teardown call, which plain track.stop() doesn't reach.
  const loopbackAudioSessionRef = useRef<LoopbackAudioSession | null>(null);
  // [2026-08-30, pedido do Mozar] "Compartilhar áudio" — captura por processo (INCLUDE mode) é a
  // ÚNICA fonte possível pra isso, sem fallback nenhum (diferente do áudio de sistema da tela, que
  // cai pro getUserMedia legado se o addon nativo não estiver disponível) — não existe outra forma
  // de isolar o áudio de um app só.
  const musicLoopbackSessionRef = useRef<LoopbackAudioSession | null>(null);

  function stopScreenShareTracks() {
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current = null;
    loopbackAudioSessionRef.current?.stop();
    loopbackAudioSessionRef.current = null;
    // Whole-screen sharing is what remote control hangs on — ending the capture (for any reason)
    // ends any control session and cancels pending requests (main/remoteControl.ts).
    setSharingFullScreen(false);
    void window.concord.remoteControl.setShare(null);
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

  // Detects loss of system-level connectivity (distinct from "our server is unreachable" —
  // App.tsx/ServerOfflineScreen's GET /health check, which already assumes the internet itself is
  // fine). navigator.onLine + online/offline events are a known-imperfect signal on their own
  // (an interface coming back up doesn't mean real WAN routing works yet) — that's why 'online'
  // moves to 'reconnecting' rather than immediately declaring success; the effect below confirms
  // with a real health check before doing that.
  //
  // [Bug corrigido, achado numa investigação real de conexão] Isso reagia à primeira notícia de
  // queda — inclusive uma oscilação breve de alguns segundos, comum em wifi real — saindo da sala
  // e voltando (setSelectedRoomId) assim que a saúde do servidor confirmava "online" de novo. Cada
  // volta recria a RTCPeerConnection do zero (peerId novo do servidor), incluindo uma nova coleta
  // de candidato ICE. Numa rede com oscilações frequentes (não bloqueada, só instável), isso vira
  // um ciclo: a oscilação seguinte interrompe a negociação ICE antes dela terminar, gerando outra
  // saída-e-volta, sem nunca dar tempo da chamada estabilizar — sintoma real observado: múltiplos
  // `peerId` distintos e falhas de STUN repetidas num teste de poucos minutos, mesmo com a rede
  // comprovadamente capaz de STUN (autoteste de rede bem-sucedido nos dois lados, ver
  // decisions.md). WebRTC já tem seu próprio mecanismo de tolerância a oscilação breve (ICE
  // reconecta sozinho); sair da sala inteira é um remédio pesado demais pra isso. Agora só reage
  // depois de OFFLINE_DEBOUNCE_MS de queda contínua — uma oscilação mais curta que isso nunca
  // chega a virar estado nenhum, a sala e a chamada nem percebem.
  useEffect(() => {
    let offlineDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    function declareOffline() {
      offlineDebounceTimer = null;
      if (selectedServerId && selectedRoomId) {
        reconnectTargetRef.current = { serverId: selectedServerId, roomId: selectedRoomId };
      }
      setConnectivityStatus('offline');
    }

    if (!navigator.onLine) offlineDebounceTimer = setTimeout(declareOffline, OFFLINE_DEBOUNCE_MS);

    function handleOffline() {
      if (offlineDebounceTimer) return; // already waiting on one
      offlineDebounceTimer = setTimeout(declareOffline, OFFLINE_DEBOUNCE_MS);
    }

    function handleOnline() {
      // Blip never actually confirmed as real — cancel silently, nothing in the app ever knew.
      if (offlineDebounceTimer) {
        clearTimeout(offlineDebounceTimer);
        offlineDebounceTimer = null;
        return;
      }
      setConnectivityStatus((prev) => (prev === 'offline' ? 'reconnecting' : prev));
    }

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      if (offlineDebounceTimer) clearTimeout(offlineDebounceTimer);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, [selectedServerId, selectedRoomId]);

  // Poll GET /health until it actually succeeds, for 'reconnecting' AND 'offline' alike — not
  // just 'reconnecting'. [Bug corrigido] 'offline' used to only ever clear via the browser's own
  // 'online' event, but navigator.onLine's initial read can be a false negative right at window
  // startup (a known Chromium/Electron quirk — the network stack isn't always done initializing
  // yet), and if the interface was never actually toggled afterward, that event never fires,
  // leaving the app stuck on NoInternetScreen forever despite a perfectly working connection. A
  // real health check is ground truth regardless of what navigator.onLine believes, so it now
  // drives recovery from both states the same way; rejoining a room only actually happens if
  // reconnectTargetRef was set (i.e. connectivity genuinely dropped while in a room).
  useEffect(() => {
    if (connectivityStatus !== 'reconnecting' && connectivityStatus !== 'offline') return;
    let cancelled = false;

    async function attempt() {
      const healthy = await checkServerHealth();
      if (cancelled) return;
      if (!healthy) {
        setTimeout(() => void attempt(), RECONNECT_RETRY_INTERVAL_MS);
        return;
      }
      setConnectivityStatus('online');
      const target = reconnectTargetRef.current;
      reconnectTargetRef.current = null;
      if (target) {
        setSelectedServerId(target.serverId);
        setSelectedRoomId(target.roomId);
      }
    }
    void attempt();

    return () => {
      cancelled = true;
    };
  }, [connectivityStatus]);

  // Stop every local track on leaving the room — real local capture, never sent anywhere
  // once the room changes (no RTCPeerConnection yet for it), but the hardware indicator
  // light must still turn off like it would for any other app.
  useEffect(() => {
    if (selectedRoomId) return;
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    stopScreenShareTracks();
    musicLoopbackSessionRef.current?.stop();
    musicLoopbackSessionRef.current = null;
    setCameraStream(null);
    setScreenStream(null);
    setIsMusicSharing(false);
  }, [selectedRoomId]);

  useEffect(() => {
    return () => {
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      stopScreenShareTracks();
      musicLoopbackSessionRef.current?.stop();
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
      // A whole-screen source knows which display it captures; a window source doesn't, and gets
      // no remote control at all.
      setSharingFullScreen(!!source.displayId);
      void window.concord.remoteControl.setShare(source.displayId);
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

  // [2026-08-30, pedido do Mozar] "Compartilhar áudio" — mesmo padrão de stopScreenShare/
  // handleToggleScreenShare/handlePickScreenSource, só que sempre via captura por processo
  // (nunca getUserMedia — não existe outra forma de isolar o áudio de um app só) e sem vídeo.
  function stopMusicShare() {
    musicLoopbackSessionRef.current?.stop();
    musicLoopbackSessionRef.current = null;
    setIsMusicSharing(false);
    setLocalMusicTrack(null);
  }

  function handleToggleMusicShare() {
    if (isMusicSharing) {
      stopMusicShare();
      return;
    }
    setIsAudioPickerOpen(true);
  }

  async function handlePickAudioSource(session: { pid: number; name: string }) {
    setIsAudioPickerOpen(false);
    const loopbackSession = await startProcessLoopbackAudio(`music-${session.pid}`, 'include', session.pid);
    if (!loopbackSession) {
      setMediaError('Não foi possível capturar o áudio desse app.');
      return;
    }
    musicLoopbackSessionRef.current = loopbackSession;
    setMediaError(null);
    setIsMusicSharing(true);
    setLocalMusicTrack(loopbackSession.track);

    // Mirrors handlePickScreenSource's videoTrack.onended — the app closing (or its audio
    // session simply ending) is exactly this same signal on this track, see
    // processLoopbackAudio.ts's onStopped -> track.stop() bridge.
    loopbackSession.track.onended = () => {
      if (musicLoopbackSessionRef.current !== loopbackSession) return; // stale handler from an already-replaced session
      stopMusicShare();
    };
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

  function handleSelectRoom(roomId: string) {
    setSelectedRoomId(roomId);
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

  async function handleReorderRooms(roomIds: string[]) {
    if (!selectedServerId) return;
    setRooms(await reorderRooms(selectedServerId, roomIds));
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

  // [Feature nova] Full-app takeover só quando NÃO há sala selecionada (nada de sidebar/roster pra
  // preservar). Com uma sala ativa, a queda de conexão agora é tratada de forma mais leve — ver o
  // render da sala mais abaixo: RoomView troca só o próprio painel principal pelo mesmo
  // NoInternetScreen, e RoomSidebar (que continua montada) mostra "Reconectando" na minha própria
  // linha, mesmo tratamento visual que já existe pra ICE de peer (RoomSidebar.tsx/RoomView.tsx).
  if ((connectivityStatus === 'offline' || connectivityStatus === 'reconnecting') && !selectedRoomId) {
    return (
      <div className="server-list-page server-list-page--loading">
        <NoInternetScreen status={connectivityStatus} />
      </div>
    );
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
          onServerDeleted={handleServerDeleted}
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
        onServerDeleted={handleServerDeleted}
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
        onReorderRooms={handleReorderRooms}
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
        selfSharingMusic={isMusicSharing}
        onToggleCamera={handleToggleCamera}
        onToggleScreenShare={handleToggleScreenShare}
        onToggleMusicShare={handleToggleMusicShare}
        onPlaySoundboardClip={playSoundboardClip}
        peerSoundLists={peerSoundLists}
        onRequestPeerSoundList={requestPeerSoundList}
        onRequestPeerSound={requestPeerSound}
        soundDownloadTick={soundDownloadTick}
        onOpenVolumeMenu={peerVolume.openVolumeMenu}
        activeVolumeMenuUserId={peerVolume.volumeMenu?.volumeKey ?? null}
        isPeerMutedByMe={(volumeKey) => peerVolume.getEffectivePeerSettings(volumeKey).muted}
        onViewProfile={(userId, name, avatarUrl) => setViewingProfile({ userId, name, avatarUrl })}
        onToggleMusicMute={(volumeKey) => peerVolume.handleTogglePeerMute(volumeKey)}
        connectivityStatus={connectivityStatus}
      />

      <div className="server-list-page__main">
        <TopBar
          roomName={selectedRoom?.name ?? null}
          isChatOpen={isChatOpen}
          onToggleChat={() => setIsChatOpen((prev) => !prev)}
        />
        <div className="server-list-page__content">
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
            isSharingMusic={isMusicSharing}
            onToggleMusicShare={handleToggleMusicShare}
            getPeerVolume={peerVolume.getEffectiveVolume}
            onOpenVolumeMenu={peerVolume.openVolumeMenu}
            activeVolumeMenuUserId={peerVolume.volumeMenu?.volumeKey ?? null}
            isPeerMutedByMe={(volumeKey) => peerVolume.getEffectivePeerSettings(volumeKey).muted}
            onViewProfile={(userId, name, avatarUrl) => setViewingProfile({ userId, name, avatarUrl })}
            connectivityStatus={connectivityStatus}
            remoteControl={remoteControl}
            sharingFullScreen={sharingFullScreen}
          />
          {selectedRoom && isChatOpen && (
            <RoomChat
              messages={chatMessages}
              onSend={sendChatMessage}
              onReroll={rerollChatMessage}
              currentUserId={currentUser.id}
            />
          )}
        </div>
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

      <RemoteControlLayer rc={remoteControl} peers={peers} />

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

      {isAudioPickerOpen && (
        <AudioSharePicker onSelect={handlePickAudioSource} onClose={() => setIsAudioPickerOpen(false)} />
      )}

      {peerVolume.volumeMenu && (
        <ParticipantVolumeMenu
          x={peerVolume.volumeMenu.x}
          y={peerVolume.volumeMenu.y}
          name={peerVolume.volumeMenu.name}
          volume={peerVolume.getEffectivePeerSettings(peerVolume.volumeMenu.volumeKey).volume}
          isMuted={peerVolume.getEffectivePeerSettings(peerVolume.volumeMenu.volumeKey).muted}
          onVolumeChange={(value) => peerVolume.handlePeerVolumeChange(peerVolume.volumeMenu!.volumeKey, value)}
          onToggleMute={() => {
            const isMuted = peerVolume.handleTogglePeerMute(peerVolume.volumeMenu!.volumeKey);
            // Only a real "you muted this person's voice" is worth telling them about (drives
            // their own "fulano te mutou" badge) — a compound volumeKey (e.g. muting their shared
            // music) is a different, narrower thing than muting the person, never broadcast.
            if (peerVolume.volumeMenu!.volumeKey === peerVolume.volumeMenu!.userId) {
              sendMuteStatus(peerVolume.volumeMenu!.peerId, isMuted);
            }
          }}
          onViewProfile={() => {
            const targetUserId = peerVolume.volumeMenu!.userId;
            const peer = peers.find((p) => p.userId === targetUserId);
            setViewingProfile({
              userId: targetUserId,
              name: peerVolume.volumeMenu!.name,
              avatarUrl: peer?.avatarUrl ?? null
            });
            peerVolume.closeVolumeMenu();
          }}
          onClose={peerVolume.closeVolumeMenu}
        />
      )}

      {viewingProfile && (
        <ParticipantProfileModal
          serverId={selectedServer.id}
          userId={viewingProfile.userId}
          fallbackName={viewingProfile.name}
          avatarUrl={viewingProfile.avatarUrl}
          onClose={() => setViewingProfile(null)}
        />
      )}
    </div>
  );
}
