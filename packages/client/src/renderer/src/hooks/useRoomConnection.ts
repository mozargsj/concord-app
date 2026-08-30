import { useEffect, useRef, useState } from 'react';
import type { DeviceKind, ServerToClientMessage } from '@concord/shared';
import { SignalingClient, type SignalingStatus } from '../lib/signalingClient';
import { MeshManager, setTurnIceServers, type ChatMessage, type SoundListEntry } from '../lib/webrtcMesh';
import { parseAndRollDiceCommand } from '../lib/diceRoller';
import type { StoredChatMessage } from '../types/window';
import { getPreferredDeviceId } from '../lib/devicePreferences';
import { playDeviceSwitch, playRoomJoin, playRoomLeave } from '../lib/soundEffects';
import { fetchTurnCredentials, getSessionToken, reportClientError } from '../lib/api';
import { fetchImageBytes, loadCachedImage, saveCachedImage, type ImageCacheKind } from '../lib/imageCache';
import { listOwnSounds, loadOwnSoundBytes } from '../lib/soundCache';
import { saveTempSound } from '../lib/soundTempCache';
import { createDenoisedTrack } from '../lib/rnnoise';
import { getRnnoiseEnabled } from '../lib/noiseSuppressionSettings';
import { createGatedTrack } from '../lib/noiseGate';
import { getMicSensitivity, onMicSensitivityChange, sensitivityToThresholdRms } from '../lib/micSensitivity';
import { getMicGain, micGainToMultiplier, onMicGainChange } from '../lib/micGain';
import { getHardwareEncodePreference } from '../lib/hardwareEncodePreference';

/** The server the joined room belongs to — just enough to know who to ask for its icon (its
 * owner) and, if that owner happens to be me, what to answer with. */
interface RoomServerInfo {
  id: string;
  ownerUserId: string;
  iconUrl: string | null;
}

// When RNNoise is on it replaces the browser's own noiseSuppression rather than stacking on top
// of it — running both risks double-processing artifacts for no proven benefit, and RNNoise (an
// actual denoising model) is the one that measurably stopped mouse-click/keyboard-tap bleed in
// testing, not the native gate-style suppressor.
const MIC_CONSTRAINTS = (preferredDeviceId: string | null, rnnoiseEnabled: boolean): MediaTrackConstraints => ({
  echoCancellation: true,
  noiseSuppression: !rnnoiseEnabled,
  autoGainControl: true,
  ...(preferredDeviceId ? { deviceId: { exact: preferredDeviceId } } : {})
});

interface MicPipeline {
  track: MediaStreamTrack;
  /** Tears down everything this pipeline created (the RNNoise graph, if any, and the raw
   * getUserMedia stream) — the one thing callers need to remember to call on swap/teardown. */
  cleanup: () => void;
}

/** Acquires the mic and, unless the user has turned RNNoise off (noiseSuppressionSettings.ts),
 * routes it through the RNNoise AudioWorklet graph, then through the noise gate (noiseGate.ts) —
 * every caller downstream (MeshManager: sending, speaking-detection, soundboard mixing) just sees
 * "the mic track" and never needs to know either stage is in the loop. Falls back to the raw
 * track if RNNoise itself fails to load/initialize (e.g. AudioWorklet unsupported) rather than
 * losing mic input entirely; returns null only if there's no mic at all (denied/unavailable). The
 * gate applies either way (raw or denoised) — it's cutting by *level*, not doing RNNoise's
 * spectral denoising, so the two are complementary, not redundant. */
async function acquireMicPipeline(preferredDeviceId: string | null): Promise<MicPipeline | null> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: MIC_CONSTRAINTS(preferredDeviceId, getRnnoiseEnabled())
    });
  } catch {
    return null; // no mic available/denied — proceed without local audio (video-only participation)
  }

  const rawTrack = stream.getAudioTracks()[0];
  if (!rawTrack) {
    stream.getTracks().forEach((track) => track.stop());
    return null;
  }

  const stopRawStream = () => stream.getTracks().forEach((track) => track.stop());

  let preGateTrack = rawTrack;
  let stopPreGate = stopRawStream;
  if (getRnnoiseEnabled()) {
    try {
      const denoised = await createDenoisedTrack(rawTrack);
      preGateTrack = denoised.track;
      stopPreGate = () => {
        denoised.stop();
        stopRawStream();
      };
    } catch {
      // RNNoise failed to load — preGateTrack/stopPreGate are still pointing at the raw track
    }
  }

  const gate = createGatedTrack(
    preGateTrack,
    sensitivityToThresholdRms(getMicSensitivity()),
    micGainToMultiplier(getMicGain())
  );
  const unsubscribeSensitivity = onMicSensitivityChange((value) =>
    gate.setThresholdRms(sensitivityToThresholdRms(value))
  );
  const unsubscribeGain = onMicGainChange((value) => gate.setGainMultiplier(micGainToMultiplier(value)));

  return {
    track: gate.track,
    cleanup: () => {
      unsubscribeSensitivity();
      unsubscribeGain();
      gate.stop();
      stopPreGate();
    }
  };
}

const PING_INTERVAL_MS = 4000;

export interface RoomPeer {
  peerId: string;
  userId: string;
  displayName: string;
  personalStream: MediaStream | null;
  screenStream: MediaStream | null;
  /** [2026-08-30, pedido do Mozar] "Compartilhar áudio" — só áudio, nunca vídeo, sempre exibido
   * como um participante à parte ("Music <nome>") em vez de um tile próprio (não há imagem pra
   * mostrar). Mesmo padrão de screenStream: null enquanto não estiver compartilhando. */
  musicStream: MediaStream | null;
  isSpeaking: boolean;
  isMicMuted: boolean;
  isDeafened: boolean;
  /** True when THIS peer has muted the local user locally ("mutar pra mim" on their end) —
   * driven by peer-mute-status (see messages.ts), never by our own mute of them (that's
   * peerVolumePreferences.ts, purely local, never sent). Powers the "fulano te mutou" badge. */
  mutedMe: boolean;
  /** Only ever set after a successful P2P fetch from this peer (see requestImage in
   * webrtcMesh.ts) — null until then, even if the peer has an avatar set, since there's no
   * central store this could come from otherwise (decisions.md). */
  avatarUrl: string | null;
  /** Visual dot on the avatar (RoomSidebar.tsx) — driven by MeshManager's onConnectionStatusChange
   * (derived from iceConnectionState). Starts 'connecting' the instant the peer is known, before
   * any real ICE event has fired yet — matches the connection's own actual starting state. */
  connectionStatus: 'connecting' | 'connected' | 'failed';
}

interface RoomConnectionState {
  connectionStatus: SignalingStatus | 'idle';
  selfPeerId: string | null;
  hostPeerId: string | null;
  peers: RoomPeer[];
  latencyMs: number | null;
  selfIsSpeaking: boolean;
  /** Live-only (decisions.md — soundboard): a peer's catalog is only ever known while both are
   * online in the same room, keyed by peerId, cleared on peer-left/room-exit. */
  peerSoundLists: Record<string, SoundListEntry[]>;
  /** Live-only, same philosophy as peerSoundLists — no server-side history, cleared on room
   * change. Capped at MAX_STORED_CHAT_MESSAGES (decisions.md — safeguard, not a requested rule). */
  chatMessages: ChatMessage[];
}

// Implementation safeguard, not a requested rule (decisions.md) — keeps a long-running room's
// chat state from growing without bound in memory.
const MAX_STORED_CHAT_MESSAGES = 200;

const initialState: RoomConnectionState = {
  connectionStatus: 'idle',
  selfPeerId: null,
  hostPeerId: null,
  peers: [],
  latencyMs: null,
  selfIsSpeaking: false,
  peerSoundLists: {},
  chatMessages: []
};

/**
 * Owns the signaling connection + WebRTC mesh for the currently-joined room. Lives in
 * ServerListPage (not RoomView) because RoomSidebar also needs the real peer roster and
 * hostPeerId for the joined room — same "elevated to feed two places at once" pattern
 * already used for isSpeaking/latencyMs.
 */
export function useRoomConnection(
  roomId: string | null,
  displayName: string,
  userId: string,
  isMicMuted: boolean,
  isDeafened: boolean,
  myAvatarUrl: string | null,
  server: RoomServerInfo | null,
  onServerIconReceived: (serverId: string, url: string) => void,
  onSoundDownloaded?: (tempSoundId: string) => void
) {
  const [state, setState] = useState<RoomConnectionState>(initialState);
  const meshRef = useRef<MeshManager | null>(null);
  const signalingRef = useRef<SignalingClient | null>(null);
  // Tears down whatever the current mic pipeline set up (RNNoise graph + raw stream, or just the
  // raw stream) — replaces a plain MediaStream ref since RNNoise being in the loop means there's
  // more than just tracks to stop now (see acquireMicPipeline).
  const micCleanupRef = useRef<(() => void) | null>(null);
  // Read inside the onImageRequest/requestPeerImages callbacks (created once per room
  // connection) — refs keep them seeing the latest value without needing to recreate the mesh
  // every time one changes, same trick as every other prop this hook watches via a side effect.
  const myAvatarUrlRef = useRef(myAvatarUrl);
  const serverRef = useRef(server);
  const onServerIconReceivedRef = useRef(onServerIconReceived);
  const onSoundDownloadedRef = useRef(onSoundDownloaded);
  // Same trick, for onSoundReceived below — it needs to look up the peer's displayName/userId
  // and the sound's own name/emoji/durationMs (from a previously-received list) synchronously,
  // without waiting on a setState round-trip.
  const peersRef = useRef<RoomPeer[]>([]);
  const peerSoundListsRef = useRef<Record<string, SoundListEntry[]>>({});
  // Same synchronous-read trick, for onChatHistoryRequest below — answering a peer's "what do you
  // have" can't wait on a setState round-trip either.
  const chatMessagesRef = useRef<ChatMessage[]>([]);

  useEffect(() => {
    myAvatarUrlRef.current = myAvatarUrl;
  }, [myAvatarUrl]);
  useEffect(() => {
    serverRef.current = server;
  }, [server]);
  useEffect(() => {
    onServerIconReceivedRef.current = onServerIconReceived;
  }, [onServerIconReceived]);
  useEffect(() => {
    onSoundDownloadedRef.current = onSoundDownloaded;
  }, [onSoundDownloaded]);
  useEffect(() => {
    peersRef.current = state.peers;
  }, [state.peers]);
  useEffect(() => {
    peerSoundListsRef.current = state.peerSoundLists;
  }, [state.peerSoundLists]);
  useEffect(() => {
    chatMessagesRef.current = state.chatMessages;
  }, [state.chatMessages]);

  // Encrypted local copy of this room's chat (decisions.md — pedido do Mozar: guardar com
  // criptografia caso alguém escreva algo sensível). Fires on every chatMessages change while in
  // a room — chat is low-frequency enough (RPG dice/text, not media) that saving on every message
  // costs nothing worth debouncing for. Cleared entirely when this user leaves the room (the big
  // effect's cleanup below), never a permanent log.
  useEffect(() => {
    if (!roomId) return;
    void window.concord.chatHistory.save(roomId, state.chatMessages as unknown as StoredChatMessage[]);
  }, [roomId, state.chatMessages]);

  /** Answers another peer's request for my avatar, or my server's icon if the request's
   * ownerId is a server I actually own — shared by both the offline-test and real mesh below. */
  async function onImageRequest(
    kind: ImageCacheKind,
    ownerId: string,
    knownHash: string | null
  ): Promise<
    { status: 'unchanged' } | { status: 'missing' } | { status: 'data'; data: ArrayBuffer; mimeType: string; hash: string }
  > {
    const server = serverRef.current;
    const url =
      kind === 'avatar'
        ? ownerId === userId
          ? myAvatarUrlRef.current
          : null
        : server && server.id === ownerId && server.ownerUserId === userId
          ? server.iconUrl
          : null;
    if (!url) return { status: 'missing' };
    const fetched = await fetchImageBytes(url);
    if (!fetched) return { status: 'missing' };
    if (knownHash && knownHash === fetched.hash) return { status: 'unchanged' };
    return { status: 'data', ...fetched };
  }

  /** A P2P download finished — cache it to disk and fold it into whichever piece of UI state
   * cares (a peer's roster entry, or the joined room's server icon). */
  function onImageReceived(kind: ImageCacheKind, ownerId: string, data: ArrayBuffer, mimeType: string): void {
    void saveCachedImage(kind, ownerId, data, mimeType).then(({ url }) => {
      if (kind === 'avatar') {
        setState((prev) => ({
          ...prev,
          peers: prev.peers.map((peer) => (peer.userId === ownerId ? { ...peer, avatarUrl: url } : peer))
        }));
      } else {
        onServerIconReceivedRef.current(ownerId, url);
      }
    });
  }

  /** [Bug corrigido, 2026-08-29] Peer confirmou que meu cache local já está atualizado (mesmo
   * hash) — sem bytes pra receber, mas o estado ao vivo da sala (peer.avatarUrl, começa null a
   * cada nova conexão) ainda precisa ser preenchido com o que já está em disco. Sem isso, um
   * avatar já em cache de uma sessão anterior nunca aparecia até a pessoa trocar de novo (só uma
   * transferência real disparava onImageReceived) — mesmo padrão de leitura de disco que
   * requestPeerImages já usa pra decidir o knownHash do pedido em primeiro lugar. */
  function onImageUnchanged(kind: ImageCacheKind, ownerId: string): void {
    void loadCachedImage(kind, ownerId).then((cached) => {
      if (!cached) return;
      if (kind === 'avatar') {
        setState((prev) => ({
          ...prev,
          peers: prev.peers.map((peer) => (peer.userId === ownerId ? { ...peer, avatarUrl: cached.url } : peer))
        }));
      } else {
        onServerIconReceivedRef.current(ownerId, cached.url);
      }
    });
  }

  /** Fires once per newly-known peer — asks them for their own avatar, and (if they're the
   * joined room's server owner) for the server's icon too. requestImage no-ops harmlessly if
   * the peer never answers (e.g. they have no avatar, or aren't really the owner). */
  function requestPeerImages(mesh: MeshManager, peerId: string, peerUserId: string): void {
    void loadCachedImage('avatar', peerUserId).then((cached) => {
      mesh.requestImage(peerId, 'avatar', peerUserId, cached?.hash ?? null);
    });
    const server = serverRef.current;
    if (!server || server.ownerUserId !== peerUserId) return;
    void loadCachedImage('server-icon', server.id).then((cached) => {
      mesh.requestImage(peerId, 'server-icon', server.id, cached?.hash ?? null);
    });
  }

  /** Answers another peer's "what sounds do you have" with my own local catalog. */
  async function onSoundListRequest(): Promise<SoundListEntry[]> {
    const sounds = await listOwnSounds();
    return sounds.map((sound) => ({
      soundId: sound.id,
      name: sound.name,
      emoji: sound.emoji,
      durationMs: sound.durationMs,
      hash: sound.hash
    }));
  }

  /** A peer's catalog just arrived — stashed both in state (UI reacts) and in the ref (so
   * onSoundReceived below can look entries up synchronously). */
  function onSoundListReceived(peerId: string, sounds: SoundListEntry[]): void {
    setState((prev) => ({ ...prev, peerSoundLists: { ...prev.peerSoundLists, [peerId]: sounds } }));
  }

  /** Answers another peer's request for one specific sound of mine, by id. */
  async function onSoundRequest(
    soundId: string,
    knownHash: string | null
  ): Promise<
    { status: 'unchanged' } | { status: 'missing' } | { status: 'data'; data: ArrayBuffer; mimeType: string; hash: string }
  > {
    const sounds = await listOwnSounds();
    const sound = sounds.find((entry) => entry.id === soundId);
    if (!sound) return { status: 'missing' };
    if (knownHash && knownHash === sound.hash) return { status: 'unchanged' };
    const bytes = await loadOwnSoundBytes(soundId);
    if (!bytes) return { status: 'missing' };
    return { status: 'data', data: bytes.data, mimeType: bytes.mimeType, hash: sound.hash };
  }

  /** A requested sound finished downloading — stashed in the temporary preview cache, never
   * straight into "meus áudios" (decisions.md: baixar ≠ adicionar à lista própria). Silently
   * drops a stray/stale download (peer left, or their list changed) rather than guessing. */
  function onSoundReceived(peerId: string, soundId: string, data: ArrayBuffer, mimeType: string): void {
    const peer = peersRef.current.find((candidate) => candidate.peerId === peerId);
    const entry = peerSoundListsRef.current[peerId]?.find((candidate) => candidate.soundId === soundId);
    if (!peer || !entry) return;
    void saveTempSound(
      {
        id: soundId,
        ownerId: peer.userId,
        ownerName: peer.displayName,
        name: entry.name,
        emoji: entry.emoji,
        durationMs: entry.durationMs,
        hash: entry.hash,
        mimeType
      },
      data
    ).then(() => onSoundDownloadedRef.current?.(soundId));
  }

  /** A peer's chat message (possibly a dice roll they already resolved) arrived — appended as-is,
   * never re-rolled here. Capped so a long session's chat can't grow the state without bound. */
  function onChatMessage(_peerId: string, message: ChatMessage): void {
    setState((prev) => ({
      ...prev,
      chatMessages: [...prev.chatMessages, message].slice(-MAX_STORED_CHAT_MESSAGES)
    }));
  }

  /** Combines two message lists (own + a peer's answer, or own + what was on disk), deduped by
   * id and reordered by sentAt — a peer's history can overlap heavily with what's already known
   * (everyone answers with everything they have, not just what the requester is missing). */
  function mergeChatMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
    const byId = new Map(existing.map((message) => [message.id, message]));
    for (const message of incoming) byId.set(message.id, message);
    return [...byId.values()].sort((a, b) => a.sentAt - b.sentAt).slice(-MAX_STORED_CHAT_MESSAGES);
  }

  /** Answers another peer's "what's the chat history so far" with whatever I locally know. */
  async function onChatHistoryRequest(): Promise<ChatMessage[]> {
    return chatMessagesRef.current;
  }

  /** A peer's chat history arrived (in response to requestChatHistory, sent once right after
   * joining) — merged into local state and persisted, never blindly replacing what's already
   * there (my own just-loaded disk copy, or another peer's answer that arrived first). */
  function onChatHistoryReceived(_peerId: string, messages: ChatMessage[]): void {
    setState((prev) => ({ ...prev, chatMessages: mergeChatMessages(prev.chatMessages, messages) }));
  }

  /** A peer re-rolled a dice message ("Re-rolar") — replaces that message's roll in place by id,
   * never appends a new one. No-op if the message isn't known locally (e.g. arrived before the
   * original message did, or was already trimmed by MAX_STORED_CHAT_MESSAGES). */
  function onChatEdit(_peerId: string, id: string, roll: ChatMessage['roll']): void {
    setState((prev) => ({
      ...prev,
      chatMessages: prev.chatMessages.map((message) => (message.id === id ? { ...message, roll } : message))
    }));
  }

  useEffect(() => {
    if (!roomId) {
      setState(initialState);
      return;
    }

    let cancelled = false;

    // A room always belongs to a server (join-room now needs serverId to let the signaling server
    // check real membership, roomManager.ts) — no server context means there's structurally
    // nothing valid to connect to yet, not a state worth attempting a WS connection over.
    if (!server) {
      setState(initialState);
      return;
    }

    const signaling = new SignalingClient();
    signalingRef.current = signaling;
    const pendingPings = new Map<string, number>();

    const mesh = new MeshManager({
      send: (message) => signaling.send(message),
      onRemoteStreamsChange: (peerId, streams) => {
        setState((prev) => ({
          ...prev,
          peers: prev.peers.map((peer) =>
            peer.peerId === peerId
              ? { ...peer, personalStream: streams.personal, screenStream: streams.screen, musicStream: streams.music }
              : peer
          )
        }));
      },
      onSpeakingChange: (peerId, isSpeaking) => {
        setState((prev) => ({
          ...prev,
          peers: prev.peers.map((peer) => (peer.peerId === peerId ? { ...peer, isSpeaking } : peer))
        }));
      },
      onLocalSpeakingChange: (isSpeaking) => {
        setState((prev) => ({ ...prev, selfIsSpeaking: isSpeaking }));
      },
      // [Feature nova] Bolinha verde/amarela/vermelha no avatar (RoomSidebar.tsx) — status real de
      // conexão por peer, não só "está na sala" (que o servidor já garante) — ICE pode ficar preso
      // sem nunca completar mesmo com o peer presente na sala.
      onConnectionStatusChange: (peerId, status) => {
        setState((prev) => ({
          ...prev,
          peers: prev.peers.map((peer) => (peer.peerId === peerId ? { ...peer, connectionStatus: status } : peer))
        }));
      },
      onImageRequest,
      onImageReceived,
      onImageUnchanged,
      onSoundListRequest,
      onSoundListReceived,
      onSoundRequest,
      onSoundReceived,
      onChatMessage,
      onChatHistoryRequest,
      onChatHistoryReceived,
      onChatEdit,
      // [Bug corrigido] Nunca era passado aqui — toda falha real de ICE/conexão em produção era
      // descartada em silêncio (onConnectionError é
      // opcional em MeshManagerOptions, então o `?.()` interno virava no-op sem avisar ninguém).
      // Isso invalidava qualquer conclusão tirada da ausência de `WebRTCConnectionError` nos logs
      // reais — a ausência não provava que o ICE nunca falhou, só que a falha nunca tinha como ser
      // registrada.
      onConnectionError: (peerId, kind, detail) =>
        void reportClientError('WebRTCConnectionError', detail, undefined, { peerId, kind })
    });
    meshRef.current = mesh;
    mesh.setHardwareEncodePreference(getHardwareEncodePreference());

    // Seeds chat with whatever this device already has saved locally for this room (e.g. a
    // reload while still in it) — separate from the live peer-to-peer backfill below (room-joined
    // handler), which is what actually catches this device up on anything it missed.
    void window.concord.chatHistory.load(roomId).then((stored) => {
      if (cancelled || stored.length === 0) return;
      setState((prev) => ({
        ...prev,
        chatMessages: mergeChatMessages(prev.chatMessages, stored as unknown as ChatMessage[])
      }));
    });

    // Both guarded by `cancelled` — closing a WebSocket is async (ws.onclose fires on a
    // later tick), so a leftover event from the room just left can otherwise arrive after
    // this effect has already torn down and a new one started, stomping the new room's
    // fresh 'idle'/'connecting' status back to 'disconnected' and tripping ServerListPage's
    // unexpected-drop effect — kicking you straight back out of the room you just rejoined.
    signaling.onStatusChange((status) => {
      if (cancelled) return;
      setState((prev) => ({ ...prev, connectionStatus: status }));
    });

    signaling.onMessage((message: ServerToClientMessage) => {
      if (cancelled) return;
      switch (message.type) {
        case 'room-joined':
          // Confirms my own join — plays even alone in an empty room, unlike 'peer-joined' below
          // (which only ever fires for someone ELSE arriving). Previously this side of "entrar
          // na sala" only had sound in TEST_MODE (a click-triggered stand-in, ServerListPage.tsx)
          // since production had no real event to hang it on — this is that real event.
          playRoomJoin();
          mesh.setSelfPeerId(message.peerId);
          setState((prev) => ({
            ...prev,
            selfPeerId: message.peerId,
            hostPeerId: message.hostPeerId,
            peers: message.peers.map((peer) => ({
              peerId: peer.peerId,
              userId: peer.userId,
              displayName: peer.displayName,
              personalStream: null,
              screenStream: null,
              musicStream: null,
              isSpeaking: false,
              isMicMuted: false,
              isDeafened: false,
              mutedMe: false,
              avatarUrl: null,
              connectionStatus: 'connecting'
            }))
          }));
          for (const peer of message.peers) {
            mesh.addExistingPeer(peer.peerId);
            requestPeerImages(mesh, peer.peerId, peer.userId);
            // Only ever needed from peers already here when I join — someone joining after me
            // gets nothing new from requesting my history in the other direction (see
            // MeshManager.requestChatHistory's own comment).
            mesh.requestChatHistory(peer.peerId);
          }
          break;
        case 'peer-joined':
          playRoomJoin();
          setState((prev) => ({
            ...prev,
            peers: [
              ...prev.peers,
              {
                peerId: message.peerId,
                userId: message.userId,
                displayName: message.displayName,
                personalStream: null,
                screenStream: null,
                musicStream: null,
                isSpeaking: false,
                isMicMuted: false,
                isDeafened: false,
                mutedMe: false,
                avatarUrl: null,
                connectionStatus: 'connecting'
              }
            ]
          }));
          requestPeerImages(mesh, message.peerId, message.userId);
          break;
        case 'peer-left':
          playRoomLeave();
          mesh.removePeer(message.peerId);
          setState((prev) => {
            const remainingSoundLists = Object.fromEntries(
              Object.entries(prev.peerSoundLists).filter(([peerId]) => peerId !== message.peerId)
            );
            return {
              ...prev,
              peers: prev.peers.filter((peer) => peer.peerId !== message.peerId),
              peerSoundLists: remainingSoundLists
            };
          });
          break;
        case 'sdp-offer':
          void mesh.handleOffer(message.fromPeerId, message.sdp);
          break;
        case 'sdp-answer':
          void mesh.handleAnswer(message.fromPeerId, message.sdp);
          break;
        case 'ice-candidate':
          void mesh.handleIceCandidate(message.fromPeerId, message.candidate);
          break;
        case 'host-changed':
          setState((prev) => ({ ...prev, hostPeerId: message.hostPeerId }));
          break;
        case 'host-candidate-notify':
          // Any connected peer can be host — the server already decided who to ask (ranked by
          // connection stability, decisions.md §2), so confirming is unconditional; the server's
          // own atomic lock (handleCandidateConfirm) picks whichever confirmation lands first and
          // ignores the rest of the batch. Without this handler, migration always timed out and
          // cascaded through every peer with nobody ever confirming, eventually closing the room.
          signaling.send({ type: 'host-candidate-confirm', roomId: message.roomId, epoch: message.epoch });
          break;
        case 'room-closed':
        case 'join-rejected':
          mesh.closeAll();
          setState((prev) => ({ ...prev, connectionStatus: 'disconnected' }));
          break;
        case 'pong': {
          const sentAt = pendingPings.get(message.nonce);
          if (sentAt !== undefined) {
            pendingPings.delete(message.nonce);
            setState((prev) => ({ ...prev, latencyMs: Math.round(performance.now() - sentAt) }));
          }
          break;
        }
        case 'peer-device-switched':
          playDeviceSwitch(message.kind);
          break;
        case 'peer-mic-state':
          setState((prev) => ({
            ...prev,
            peers: prev.peers.map((peer) =>
              peer.peerId === message.peerId
                ? { ...peer, isMicMuted: message.isMicMuted, isDeafened: message.isDeafened }
                : peer
            )
          }));
          break;
        case 'peer-screen-share-changed':
          // Only acts on "stopped" — "started" still waits for the real track to arrive via
          // ontrack, same as always; this message is just the reliable clear signal.
          if (!message.isSharing) {
            mesh.forceClearScreenStream(message.peerId);
            setState((prev) => ({
              ...prev,
              peers: prev.peers.map((peer) =>
                peer.peerId === message.peerId ? { ...peer, screenStream: null } : peer
              )
            }));
          }
          break;
        case 'peer-music-share-changed':
          // Mirrors peer-screen-share-changed exactly — see that case's comment.
          if (!message.isSharing) {
            mesh.forceClearMusicStream(message.peerId);
            setState((prev) => ({
              ...prev,
              peers: prev.peers.map((peer) =>
                peer.peerId === message.peerId ? { ...peer, musicStream: null } : peer
              )
            }));
          }
          break;
        case 'peer-mute-status':
          // Always addressed to us specifically (server relays by targetPeerId, see room.ts) —
          // fromPeerId is whoever just muted/unmuted the local user on their own end.
          setState((prev) => ({
            ...prev,
            peers: prev.peers.map((peer) =>
              peer.peerId === message.fromPeerId ? { ...peer, mutedMe: message.isMuted } : peer
            )
          }));
          break;
        case 'peer-avatar-changed':
          // Same request the initial peer-joined fetch makes (requestPeerImages) — the hash
          // comparison on the other end naturally turns this into a real transfer only when the
          // avatar actually changed, so re-asking unconditionally here is cheap and correct.
          void loadCachedImage('avatar', message.userId).then((cached) => {
            mesh.requestImage(message.peerId, 'avatar', message.userId, cached?.hash ?? null);
          });
          break;
        case 'peer-server-icon-changed':
          // Same idea as peer-avatar-changed above, just for the server's icon — re-ask whoever
          // sent this (always the server's owner, see the sending effect) for the current icon.
          void loadCachedImage('server-icon', message.serverId).then((cached) => {
            mesh.requestImage(message.peerId, 'server-icon', message.serverId, cached?.hash ?? null);
          });
          break;
      }
    });

    const preferredMic = getPreferredDeviceId('audioinput');
    void acquireMicPipeline(preferredMic).then((pipeline) => {
      if (!pipeline) return;
      if (cancelled) {
        pipeline.cleanup();
        return;
      }
      micCleanupRef.current = pipeline.cleanup;
      mesh.setLocalMicTrack(pipeline.track);
    });

    let pingInterval: ReturnType<typeof setInterval> | null = null;

    // [TEMP — teste de conectividade 2026-08-27] Busca o fallback TURN (setTurnIceServers,
    // webrtcMesh.ts) e só então conecta a sinalização — garante que TODA conexão desta sala,
    // inclusive a primeira (getOrCreateConnection lê turnIceServers na hora de criar cada
    // RTCPeerConnection), já nasce com TURN disponível, em vez de arriscar a corrida de um peer
    // chegar antes do fetch terminar. fetchTurnCredentials nunca lança (api.ts) — pior caso aqui é
    // lista vazia, mesmo comportamento de antes (STUN-only).
    void fetchTurnCredentials().then((turnServers) => {
      if (cancelled) return;
      setTurnIceServers(turnServers);
      // [Diagnóstico, adicionado 2026-08-27] Confirma, por sala/sessão (não por peer — isto roda
      // uma vez só, antes de qualquer RTCPeerConnection existir), se o fetch de credenciais TURN
      // deu certo e o que exatamente veio: lista vazia aqui já explicaria uma sessão inteira sem
      // TURN nenhum, sem precisar inferir isso indiretamente da ausência de candidato `relay` nos
      // logs por peer mais abaixo.
      void reportClientError(
        'TurnCredentialsFetch',
        turnServers.length > 0
          ? `${turnServers.length} iceServer(s) TURN recebido(s): ${turnServers.map((s) => JSON.stringify(s.urls)).join(' | ')}`
          : 'lista vazia — sem TURN disponível nesta sessão (backend sem TURN configurado, fetch falhou, ou TEST_MODE)',
        undefined,
        { roomId, serverId: server.id }
      );

      signaling.connect(
        import.meta.env.VITE_SIGNALING_URL,
        roomId,
        server.id,
        displayName,
        userId,
        getSessionToken() ?? ''
      );

      pingInterval = setInterval(() => {
        const nonce = Math.random().toString(36).slice(2);
        pendingPings.set(nonce, performance.now());
        signaling.send({ type: 'ping', nonce });
      }, PING_INTERVAL_MS);
    });

    return () => {
      cancelled = true;
      if (pingInterval) clearInterval(pingInterval);
      mesh.closeAll();
      micCleanupRef.current?.();
      micCleanupRef.current = null;
      signaling.close();
      meshRef.current = null;
      signalingRef.current = null;
      // Leaving the room — pedido do Mozar: só quem está na sala tem acesso ao histórico, sair
      // apaga a cópia local criptografada (nunca um log permanente). A reconexão automática por
      // instabilidade de rede também passa por aqui (roomId muda pra null e volta), então um
      // rejoin rápido também perde o histórico local e busca tudo de novo dos peers — aceitável,
      // mesma filosofia "descoberta é só ao vivo" já usada pro soundboard.
      void window.concord.chatHistory.clear(roomId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only roomId should trigger reconnect
  }, [roomId]);

  useEffect(() => {
    meshRef.current?.setMicMuted(isMicMuted);
  }, [isMicMuted]);

  // Lets every other client show a "not listening/speaking" indicator next to this peer's
  // name, same spot as the live-broadcast badge — no-op (send is null) outside a room or in
  // the offline test profile, same as everything else signaling-dependent.
  useEffect(() => {
    signalingRef.current?.send({ type: 'mic-state', isMicMuted, isDeafened });
  }, [isMicMuted, isDeafened]);

  // Fires on mount too (like mic-state above) — harmless, whoever's already in the room just
  // re-asks and gets 'unchanged' back if nothing really changed. Without this, changing your
  // avatar mid-call is invisible to everyone else until they leave and rejoin (peer-avatar-
  // changed in messages.ts).
  useEffect(() => {
    signalingRef.current?.send({ type: 'avatar-changed' });
  }, [myAvatarUrl]);

  // Same rationale/pattern as avatar-changed above, for the server's icon instead of the user's —
  // server icons are P2P-only too (decisions.md), so nothing tells an already-connected peer to
  // re-request one that just changed. Only the server's owner can actually change it, so only they
  // ever send this (everyone else's server prop update here is a no-op guard, not a permission
  // check — the Worker never trusted this message for anything but presence anyway).
  useEffect(() => {
    if (!server || server.ownerUserId !== userId) return;
    signalingRef.current?.send({ type: 'server-icon-changed', serverId: server.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the icon itself should resend, not every server field change (e.g. a rename)
  }, [server?.iconUrl]);

  function setLocalCameraTrack(track: MediaStreamTrack | null): void {
    void meshRef.current?.setLocalCameraTrack(track);
  }

  // qualityMode only matters when starting a share (ScreenSharePicker.tsx passes the choice made
  // there) — set before setLocalScreenTrack so it's already in place when the sender gets created.
  // [Bug corrigido] setHardwareEncodePreference used to only be read once, at mesh creation (room
  // join) — toggling it in Settings mid-room had zero effect until leaving and rejoining, which
  // isn't what "vale a partir da próxima transmissão" (SettingsModal.tsx's own hint text) promises.
  // Re-reading it fresh here, right as a share actually starts, makes that promise true.
  function setLocalScreenTrack(stream: MediaStream | null, qualityMode?: 'quality' | 'smoothness'): void {
    if (stream) meshRef.current?.setHardwareEncodePreference(getHardwareEncodePreference());
    if (qualityMode) meshRef.current?.setScreenQualityMode(qualityMode);
    void meshRef.current?.setLocalScreenTrack(stream);
    // Explicit signal (see messages.ts) — the WebRTC-level "track ended" alone was unreliable for
    // this transition, leaving viewers stuck on the last frame when sharing stopped.
    signalingRef.current?.send({ type: 'screen-share-changed', isSharing: !!stream });
  }

  /** [2026-08-30, pedido do Mozar] Mesmo padrão de setLocalScreenTrack — track já pronto (a
   * captura por processo já roda fora daqui, ver ServerListPage.tsx) em vez de uma MediaStream
   * inteira, já que "compartilhar áudio" nunca tem vídeo. */
  function setLocalMusicTrack(track: MediaStreamTrack | null): void {
    void meshRef.current?.setLocalMusicTrack(track);
    signalingRef.current?.send({ type: 'music-share-changed', isSharing: !!track });
  }

  /** Broadcasts a local soundboard clip to every peer as if it were the mic (see
   * MeshManager.playSoundboardClip) — no-ops outside a room, same as every other mesh action.
   * Returns a stop handle so the caller's play/pause toggle can cut it short. */
  function playSoundboardClip(
    buffer: AudioBuffer,
    volume: number,
    onEnded?: () => void
  ): { stop: () => void } | null {
    return meshRef.current?.playSoundboardClip(buffer, volume, onEnded) ?? null;
  }

  /** Asks one peer for their current soundboard catalog — answer arrives via peerSoundLists. */
  function requestPeerSoundList(peerId: string): void {
    meshRef.current?.requestSoundList(peerId);
  }

  /** Downloads one specific sound from a peer's already-received catalog — lands in the
   * temporary preview cache, not directly in "meus áudios" (onSoundDownloaded fires when done). */
  function requestPeerSound(peerId: string, soundId: string, knownHash: string | null): void {
    meshRef.current?.requestSound(peerId, soundId, knownHash);
  }

  /** Sends one chat message to the room — if `text` is recognized as a dice command
   * (diceRoller.ts), it's rolled right here, once, before broadcasting; every peer (including
   * this one) then renders the exact same already-resolved numbers, nobody re-rolls. Appended to
   * local state immediately (optimistic — no round trip needed to see your own message). No-op
   * outside a room, same as every other mesh action. */
  function sendChatMessage(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      userId,
      displayName,
      text: trimmed,
      sentAt: Date.now(),
      roll: parseAndRollDiceCommand(trimmed)
    };
    setState((prev) => ({
      ...prev,
      chatMessages: [...prev.chatMessages, message].slice(-MAX_STORED_CHAT_MESSAGES)
    }));
    meshRef.current?.sendChatMessage(message);
  }

  /** "Re-rolar" — resolves a brand-new roll for the same command (Math.random, right here, once)
   * and replaces the target message's roll in place for everyone, instead of posting a new
   * message (pedido do Mozar). `text` is always that message's own already-valid command
   * (RoomChat.tsx passes it straight from the message being re-rolled), so parseAndRollDiceCommand
   * failing here would mean the original message was never actually a dice roll — shouldn't
   * happen, but no-ops safely if it somehow does. */
  function rerollChatMessage(messageId: string, text: string): void {
    const roll = parseAndRollDiceCommand(text);
    if (!roll) return;
    setState((prev) => ({
      ...prev,
      chatMessages: prev.chatMessages.map((message) => (message.id === messageId ? { ...message, roll } : message))
    }));
    meshRef.current?.editChatMessage(messageId, roll);
  }

  /** Broadcasts the switch to the room (everyone else's client plays the sound) and plays it locally right away. */
  function sendDeviceSwitched(kind: DeviceKind): void {
    signalingRef.current?.send({ type: 'device-switched', kind });
    playDeviceSwitch(kind);
  }

  /** Tells one specific peer they've been muted/unmuted "for me" (usePeerVolumeControl.ts) — the
   * only reason this leaves the client at all is so that peer can show a "fulano te mutou" badge
   * on their own screen; it never affects anything on the sender's end (that's local-only state,
   * peerVolumePreferences.ts). Directed, not broadcast — matches sdp-offer/ice-candidate. */
  function sendMuteStatus(targetPeerId: string, isMuted: boolean): void {
    signalingRef.current?.send({ type: 'peer-mute-status', targetPeerId, isMuted });
  }

  async function switchMicDevice(deviceId: string | null): Promise<void> {
    const mesh = meshRef.current;
    if (!mesh) return;
    const pipeline = await acquireMicPipeline(deviceId);
    if (!pipeline) return; // swap failed — keep using the previous mic track
    const oldCleanup = micCleanupRef.current;
    micCleanupRef.current = pipeline.cleanup;
    mesh.setLocalMicTrack(pipeline.track);
    oldCleanup?.();
    sendDeviceSwitched('mic');
  }

  /** Re-acquires the current device through the mic pipeline from scratch — the only way to pick
   * up a just-changed RNNoise on/off setting, since the AudioWorklet graph (or its absence) is
   * built once at acquisition time, not read live. Called from the settings toggle, not a device
   * picker, so it doesn't announce a "device switched" sound — nothing actually changed hardware-wise. */
  async function refreshMicPipeline(): Promise<void> {
    const mesh = meshRef.current;
    if (!mesh) return;
    const pipeline = await acquireMicPipeline(getPreferredDeviceId('audioinput'));
    if (!pipeline) return;
    const oldCleanup = micCleanupRef.current;
    micCleanupRef.current = pipeline.cleanup;
    mesh.setLocalMicTrack(pipeline.track);
    oldCleanup?.();
  }

  return {
    connectionStatus: state.connectionStatus,
    selfPeerId: state.selfPeerId,
    hostPeerId: state.hostPeerId,
    peers: state.peers,
    latencyMs: state.latencyMs,
    selfIsSpeaking: state.selfIsSpeaking,
    peerSoundLists: state.peerSoundLists,
    chatMessages: state.chatMessages,
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
    sendChatMessage,
    rerollChatMessage
  };
}
