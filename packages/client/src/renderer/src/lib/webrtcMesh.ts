import type { ClientToServerMessage } from '@concord/shared';
import type { ImageCacheKind } from './imageCache';

// STUN only, no TURN — explicit project decision (decisions.md §1), revisited only
// with real ICE-failure data from the alpha phase.
// Exported so lib/networkSelfTest.ts can run the exact same STUN gathering the real mesh does —
// a self-test using a different server wouldn't actually predict anything about this app.
//
// [TEMP — teste de diagnóstico, 2026-08-27] Trocado de stun.l.google.com pra stun.cloudflare.com
// pra descartar/confirmar a hipótese de que o STUN do Google especificamente estava degradado ou
// limitando esses IPs de teste depois de dezenas de tentativas repetidas no mesmo dia — a chamada
// real falhava com `errorCode=701 STUN binding request timed out` de forma consistente mesmo
// depois de descartar firewall/Defender/VPN/DNS/loop de reconexão/interferência de compartilhar
// tela, todos via teste real. Reverter pro Google (ou usar os dois) depois desse teste.
export const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

// [TEMP — teste de conectividade 2026-08-27] Fallback TURN opcional, além do STUN-only de sempre
// (ICE_SERVERS acima, que networkSelfTest.ts continua usando sozinho — o autoteste é sobre STUN
// puro, não deve mudar de significado por causa disto). Vazio até useRoomConnection.ts chamar
// setTurnIceServers com o que api.ts.fetchTurnCredentials trouxer do servidor — nenhuma conexão
// existente é afetada, só as criadas depois (getOrCreateConnection lê isto no momento da criação).
// Existe só pra descartar/confirmar TURN como causa da falha total de conectividade observada em
// teste real — reverter (remover isto e voltar `new RTCPeerConnection({ iceServers: ICE_SERVERS })`
// puro) depois desse teste, per decisions.md §1.
let turnIceServers: RTCIceServer[] = [];

export function setTurnIceServers(servers: RTCIceServer[]): void {
  turnIceServers = servers;
}

// How long iceConnectionState must stay 'disconnected' before it's reported as a real problem
// (see the oniceconnectionstatechange handler) — long enough that a brief, self-healing network
// blip doesn't get reported as if it were a stuck connection.
const ICE_DISCONNECTED_REPORT_DELAY_MS = 8000;

// getStats() poll for the "está falando" indicator — RFC 6464 audioLevel, per decisions.md.
const SPEAKING_POLL_INTERVAL_MS = 200;
const SPEAKING_THRESHOLD = 0.05;
const SPEAKING_DEBOUNCE_TICKS = 2; // consecutive ticks required before flipping state, avoids flicker

// [Teste, pedido do Mozar] O anel de "está falando" do próprio usuário sempre usou o mesmo poll
// de 200ms + debounce de 2 ticks dos peers remotos (getStats(), assíncrono) — até 400ms de
// latência no pior caso, perceptível o bastante pra render diferente da própria fala em tempo
// real ao lado. Separado num poll só do mic local, bem mais rápido: ler o AnalyserNode é síncrono
// e barato (não é getStats()), então não faz sentido — nem seria de graça — acelerar o poll dos
// peers remotos também só por causa disso (isso sim multiplicaria custo real por peer no mesh).
const LOCAL_SPEAKING_POLL_INTERVAL_MS = 15;
// [Corrigido — eram a mesma coisa antes, não deveriam ser] "Captação" (delay de falar até o anel
// ACENDER) e "duração do efeito" (quanto tempo o anel fica aceso depois que a fala pausa, antes de
// APAGAR) são dois momentos diferentes — a primeira versão usava um debounce único e simétrico
// pros dois, então acelerar a detecção também acelerava (e deixava mais "piscante") o apagar, que
// já estava bom do jeito que estava. Agora são independentes: liga quase na hora (attack, sem
// espera de verdade — qualquer amostra acima do limiar já acende), mas só apaga depois de ficar
// abaixo do limiar por um tempo contínuo (release) — mesma sensação de antes pra isso, só a
// captação (o "acender") que ficou mais rápida.
const LOCAL_SPEAKING_RELEASE_HOLD_MS = 400;

// Avatar/server-icon transfer over the 'images' data channel — small control frames as JSON
// text, the file itself as ordered binary chunks (channel is reliable+ordered by default, so a
// sequential meta-then-chunks protocol needs no sequence numbers).
const IMAGE_CHUNK_SIZE = 16 * 1024;
const IMAGE_CHUNK_HIGH_WATER = 1024 * 1024;
// [Achado de segurança] `meta` frames declare their own `size` — nothing capped it before, so a
// malicious/misbehaving peer could claim an arbitrary size and have this side accumulate chunks
// into `incomingImageTransfer.chunks` without bound (real or not, `handleImageChunk` just keeps
// pushing until `received >= size`). 25MB is far above any real avatar/server icon this app ever
// produces.
const MAX_IMAGE_TRANSFER_BYTES = 25 * 1024 * 1024;

// Soundboard clip transfer over the 'sounds' data channel — same chunked-transfer shape as
// images, plus a list-req/list step first since (unlike one avatar per owner) a peer can have
// many sounds and the UI needs their names/emojis before anyone downloads bytes.
const SOUND_CHUNK_SIZE = 16 * 1024;
const SOUND_CHUNK_HIGH_WATER = 1024 * 1024;
// Same rationale as MAX_IMAGE_TRANSFER_BYTES — soundboard clips are short, this is generous headroom.
const MAX_SOUND_TRANSFER_BYTES = 25 * 1024 * 1024;

interface SpeakingState {
  isSpeaking: boolean;
  consecutive: number;
}

type TrackRole = 'mic' | 'camera' | 'screenVideo' | 'screenAudio';

// Mic audio is fine at WebRTC's default Opus ceiling (~32kbps mono) — voice doesn't need more.
// Screen-share system audio (music, game/video sound) does: raising the ceiling here doesn't
// force this bitrate, it just gives the browser's native congestion control (same one already
// governing screen-share *video* quality, decisions.md §3 — no custom tiers, same philosophy)
// room to use more of it when the connection can support it, and back off same as video already
// does when it can't. Deliberately not touching stereo=1/usedtx=0 here — those need SDP fmtp
// munging (not exposed via setParameters), a fragile per-payload-type string edit that's a bigger
// step than this one; left for later, see decisions.md.
const SCREEN_AUDIO_MAX_BITRATE_BPS = 128_000;

type ImageAnswer =
  | { status: 'unchanged' }
  | { status: 'missing' }
  | { status: 'data'; data: ArrayBuffer; mimeType: string; hash: string };

interface ImageRequestFrame {
  t: 'req';
  kind: ImageCacheKind;
  ownerId: string;
  knownHash: string | null;
}
interface ImageUnchangedFrame {
  t: 'unchanged';
  // [Bug corrigido, 2026-08-29] Sem isso o requester não tinha como saber QUAL imagem esse
  // "unchanged" respondia (avatar? de quem? — o pedido original já tinha essa informação, a
  // resposta nunca ecoava de volta). Sem saber, não dava pra hidratar o próprio cache local no
  // estado da sala — só uma transferência real de dado ('meta'+chunks) atualizava peer.avatarUrl,
  // então um avatar já em cache de uma sessão anterior nunca aparecia até a pessoa trocar de novo.
  kind: ImageCacheKind;
  ownerId: string;
}
interface ImageMissingFrame {
  t: 'missing';
}
interface ImageMetaFrame {
  t: 'meta';
  kind: ImageCacheKind;
  ownerId: string;
  mimeType: string;
  hash: string;
  size: number;
}
type ImageControlFrame = ImageRequestFrame | ImageUnchangedFrame | ImageMissingFrame | ImageMetaFrame;

interface IncomingImageTransfer {
  kind: ImageCacheKind;
  ownerId: string;
  mimeType: string;
  hash: string;
  size: number;
  chunks: ArrayBuffer[];
  received: number;
}

/** One entry in a peer's own-sounds catalog — metadata only, exactly what the "list" step of
 * the 'sounds' data channel protocol exchanges before anyone downloads any actual bytes. */
export interface SoundListEntry {
  soundId: string;
  name: string;
  emoji: string;
  durationMs: number;
  hash: string;
}

type SoundAnswer =
  | { status: 'unchanged' }
  | { status: 'missing' }
  | { status: 'data'; data: ArrayBuffer; mimeType: string; hash: string };

interface SoundListRequestFrame {
  t: 'list-req';
}
interface SoundListFrame {
  t: 'list';
  sounds: SoundListEntry[];
}
interface SoundRequestFrame {
  t: 'req';
  soundId: string;
  knownHash: string | null;
}
interface SoundUnchangedFrame {
  t: 'unchanged';
  soundId: string;
}
interface SoundMissingFrame {
  t: 'missing';
  soundId: string;
}
interface SoundMetaFrame {
  t: 'meta';
  soundId: string;
  mimeType: string;
  hash: string;
  size: number;
}
type SoundControlFrame =
  | SoundListRequestFrame
  | SoundListFrame
  | SoundRequestFrame
  | SoundUnchangedFrame
  | SoundMissingFrame
  | SoundMetaFrame;

interface IncomingSoundTransfer {
  soundId: string;
  mimeType: string;
  hash: string;
  size: number;
  chunks: ArrayBuffer[];
  received: number;
}

interface PeerConnectionEntry {
  peerId: string;
  pc: RTCPeerConnection;
  pendingCandidates: RTCIceCandidateInit[];
  personalStreamId: string | null;
  screenStreamId: string | null;
  personalStream: MediaStream | null;
  screenStream: MediaStream | null;
  senders: Partial<Record<TrackRole, RTCRtpSender>>;
  imagesChannel: RTCDataChannel | null;
  pendingImageRequests: { kind: ImageCacheKind; ownerId: string; knownHash: string | null }[];
  incomingImageTransfer: IncomingImageTransfer | null;
  // Answering two 'req's back-to-back (e.g. avatar + server-icon from the same peer, both
  // legitimate at once) would otherwise interleave their meta/chunk sends on one channel — the
  // receiver's single incomingImageTransfer slot can't demux that. Chaining onto this promise
  // forces one full response (meta + all its chunks) to finish before the next one starts.
  imageSendQueue: Promise<void>;
  soundsChannel: RTCDataChannel | null;
  pendingSoundListRequest: boolean;
  pendingSoundRequests: { soundId: string; knownHash: string | null }[];
  incomingSoundTransfer: IncomingSoundTransfer | null;
  // Same rationale as imageSendQueue — a sound-list answer and a sound-bytes answer (or two
  // bytes answers back to back) must not interleave their sends on the one shared channel.
  soundSendQueue: Promise<void>;
  // Serializes every SDP-touching operation on this connection — outgoing renegotiate(), and
  // incoming handleOffer()/handleAnswer() — onto one chain, same shape as imageSendQueue/
  // soundSendQueue above. Before this existed, nothing stopped e.g. a local track-change
  // renegotiate() from running concurrently with an incoming handleAnswer() for a still-in-flight
  // offer on the very same RTCPeerConnection, which is exactly what produced the real "Failed to
  // set remote answer sdp: The order of m-lines..." / "Called in wrong state: stable" errors seen
  // in production logs (concord_system_logs) — two setLocalDescription/setRemoteDescription calls
  // racing each other on one pc. Queuing makes every one of those operations see a pc state that
  // reflects the *previous* operation having fully finished, never a half-applied one.
  negotiationQueue: Promise<void>;
  // Set when a renegotiate() is requested while the connection isn't 'stable' (an offer/answer
  // round is already in flight) — rather than racing a second offer on top of the first, it's
  // deferred and replayed the instant the in-flight round settles back to 'stable' (see
  // maybeFlushRenegotiate). This is what replaces the old fixed 500ms "hope the answer landed by
  // now" delay: the retry is triggered by the actual state transition, not a guessed timeout.
  renegotiateNeeded: boolean;
  // Deterministic per-connection glare resolution (the standard "perfect negotiation" polite/
  // impolite rule): computed once from comparing this side's own peerId against the remote one,
  // so both peers land on opposite roles for the same pair without any extra coordination message.
  // The polite side rolls back its own in-flight offer and accepts the incoming one on collision;
  // the impolite side ignores the incoming offer and keeps its own.
  isPolite: boolean;
  // [Diagnóstico, investigação de conectividade 2026-08-27] Data/hora de criação desta conexão —
  // todo log daqui pra frente inclui um `t+Nms` relativo a isto, já que os logs do servidor (
  // console.error puro, sem timestamp) não davam pra reconstruir a ordem/tempo real dos eventos
  // entre process/candidato/estado sem isso.
  connectionCreatedAt: number;
  // Garante que logIceStatsSummary só roda uma vez no primeiro sucesso desta conexão — sem isso,
  // toda oscilação connected->disconnected->connected voltaria a disparar o dump inteiro de novo.
  hasLoggedSuccessStats: boolean;
}

/** [Diagnóstico, investigação de conectividade 2026-08-27] `t+Nms` desde a criação da conexão —
 * prefixo comum pra todo log deste arquivo, pra dar pra reconstruir a ordem real dos eventos
 * (offer/answer/candidato/mudança de estado) batendo os logs de peers diferentes uns com os outros. */
function elapsedSince(entry: PeerConnectionEntry): string {
  return `t+${Date.now() - entry.connectionCreatedAt}ms`;
}

interface MeshManagerOptions {
  send: (message: ClientToServerMessage) => void;
  onRemoteStreamsChange: (
    peerId: string,
    streams: { personal: MediaStream | null; screen: MediaStream | null }
  ) => void;
  onSpeakingChange: (peerId: string, isSpeaking: boolean) => void;
  onLocalSpeakingChange: (isSpeaking: boolean) => void;
  /** Answers another peer's request for one of *my* images (my own avatar, or my server's icon
   * if I'm the one hosting it) — owned by the caller since it needs live access to whatever the
   * current avatar/icon bytes are, which MeshManager has no notion of. */
  onImageRequest: (kind: ImageCacheKind, ownerId: string, knownHash: string | null) => Promise<ImageAnswer>;
  /** A requested image finished downloading from a peer — caller persists it and updates UI state. */
  onImageReceived: (kind: ImageCacheKind, ownerId: string, data: ArrayBuffer, mimeType: string) => void;
  /** [2026-08-29] Peer confirmed my cached copy is already current (same hash) — no bytes sent,
   * so there's nothing to persist, but the caller's live UI state (peer.avatarUrl, unset until
   * something actually populates it this session) still needs to be hydrated from that existing
   * local cache. Without this, an avatar already cached from a previous session never shows up
   * until the owner changes it again — only a real transfer ever called onImageReceived. */
  onImageUnchanged: (kind: ImageCacheKind, ownerId: string) => void;
  /** Answers another peer's "what sounds do you have" — my own sounds list, read from local disk
   * cache (MeshManager has no notion of sound storage, same reasoning as onImageRequest). */
  onSoundListRequest: () => Promise<SoundListEntry[]>;
  /** A peer's sound catalog just arrived (in response to requestSoundList). */
  onSoundListReceived: (peerId: string, sounds: SoundListEntry[]) => void;
  /** Answers another peer's request for one specific sound of mine, by id. */
  onSoundRequest: (soundId: string, knownHash: string | null) => Promise<SoundAnswer>;
  /** A requested sound finished downloading from a peer — caller stashes it in the temporary
   * download cache (decisions.md: downloading ≠ adding to "meus áudios", that's a separate step). */
  onSoundReceived: (peerId: string, soundId: string, data: ArrayBuffer, mimeType: string) => void;
  /** A peer connection actually failed (ICE or overall), got stuck disconnected, or an ICE
   * candidate errored out — the CGNAT/symmetric-NAT scenario decisions.md §1 already flags as the
   * reason TURN might be needed. Optional: MeshManager works the same with or without a listener,
   * this is diagnostics. 'ice-disconnected' exists separately from 'ice-failed' because Chromium
   * doesn't always transition disconnected → failed — a connection can sit in 'disconnected'
   * indefinitely with no media flowing and never fire the 'failed' case at all, which is exactly
   * the kind of silent failure that left decisions.md's "TURN not needed, zero ICE failures
   * logged" conclusion unverifiable (that conclusion also assumed this callback was even wired up
   * for real connections, which it wasn't — see useRoomConnection.ts's fix). */
  onConnectionError?: (
    peerId: string,
    kind:
      | 'ice-failed'
      | 'ice-disconnected'
      | 'connection-failed'
      | 'ice-candidate-error'
      | 'ice-stats-summary'
      | 'ice-candidate-apply-failed'
      | 'negotiation-failed'
      // [Diagnóstico, adicionado 2026-08-27] Timeline completa de estado (antes só o veredito
      // final de falha era reportado) — ver os call sites em getOrCreateConnection.
      | 'ice-state-change'
      | 'connection-state-change'
      | 'signaling-state-change'
      | 'ice-gathering-state-change'
      | 'ice-gathering-complete',
    detail: string
  ) => void;
  /** Simplified per-peer status for a visual indicator (green/yellow/red dot on the avatar,
   * RoomSidebar.tsx) — derived from iceConnectionState. 'connecting' covers 'new'/'checking' and
   * a 'disconnected' still inside its grace window (see ICE_DISCONNECTED_REPORT_DELAY_MS); a
   * connection that's actually up (or was, and hasn't been confirmed lost yet) shouldn't flash red
   * for a blip that self-heals. 'failed' covers both a hard ICE failure and 'disconnected' that
   * outlasted the grace window. Fires once right when the connection is created ('connecting') and
   * again on every iceConnectionState change after that — no dedup needed, setting React state to
   * an unchanged value is already a no-op. */
  onConnectionStatusChange?: (peerId: string, status: 'connecting' | 'connected' | 'failed') => void;
}

/**
 * One RTCPeerConnection per remote peer, pure mesh (no SFU). Offerer/answerer role is
 * deterministic to avoid glare: whoever just joined offers to everyone already in the
 * room (addExistingPeer); everyone else waits for that offer to arrive (handleOffer
 * lazily creates the connection). Later track changes (camera/screen on/off) always
 * renegotiate from whichever side changed its local tracks, one connection at a time.
 */
export class MeshManager {
  private connections = new Map<string, PeerConnectionEntry>();
  // Own peerId for this room — only used to pick a deterministic polite/impolite role per
  // connection (see setSelfPeerId). Null until 'room-joined' arrives; every real connection is
  // only ever created after that, so it's always set by the time it's needed.
  private selfPeerId: string | null = null;
  private personalStream = new MediaStream();
  private screenStream = new MediaStream();
  private micTrack: MediaStreamTrack | null = null;
  private cameraTrack: MediaStreamTrack | null = null;
  private screenVideoTrack: MediaStreamTrack | null = null;
  private screenAudioTrack: MediaStreamTrack | null = null;
  private speakingStateByPeer = new Map<string, SpeakingState>();
  // Not a SpeakingState/applySpeakingLevel() — those give both directions the same debounce,
  // exactly the mix-up this replaced (see LOCAL_SPEAKING_RELEASE_HOLD_MS's comment). Plain
  // attack/release instead: isSpeaking flips true immediately, false only after a timer.
  private localIsSpeaking = false;
  private localSpeakingReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  private speakingPollHandle: ReturnType<typeof setInterval>;
  private localSpeakingPollHandle: ReturnType<typeof setInterval>;
  // Local level comes straight off the mic track via Web Audio, not getStats() on an
  // RTCRtpSender — a sender only exists once there's an actual peer connection, which
  // meant the local indicator silently never worked when alone in a room (no peers yet).
  private audioContext: AudioContext | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private micAnalyserSource: MediaStreamAudioSourceNode | null = null;
  // Mute never touches micTrack.enabled (that silences it for every consumer, including this
  // class's own analyser — which is exactly what "detect speech while muted" needs to survive).
  // Instead it's enforced per-connection via RTCRtpSender.replaceTrack(null), same mechanism
  // already used for device swaps, so it needs no renegotiation either.
  private micMuted = false;
  // User-configurable (SettingsModal.tsx, lib/hardwareEncodePreference.ts), default on — set once
  // at mesh creation via setHardwareEncodePreference(), read at track-add time by
  // preferH264ForScreenVideo(). Not reactive mid-share on purpose: a codec preference only takes
  // effect on the next offer/answer, so changing it while already sharing would need an explicit
  // renegotiation to do anything — simpler to just have it apply the next time sharing starts.
  private hardwareEncodePreferenceEnabled = true;
  // Content-dependent, user-picked per share (ScreenSharePicker.tsx) — see setScreenQualityMode
  // and applyScreenVideoDegradationPreference below. Default matches the app's original fixed
  // behavior (screen content favored resolution over framerate before this was a choice).
  private screenDegradationPreference: RTCDegradationPreference = 'maintain-resolution';
  // Soundboard mix (see playSoundboardClip) — a MediaStreamDestination shared by every
  // concurrently-playing clip, reference-counted so the sender only reverts to the plain mic
  // track once the last overlapping clip finishes.
  private soundboardMixDestination: MediaStreamAudioDestinationNode | null = null;
  private soundboardMicGain: GainNode | null = null;
  private soundboardActiveCount = 0;
  // Separate from soundboardActiveCount (which only tracks the broadcast half, skipped while
  // muted) — this counts every clip that's audible *locally*, muted or not, since it drives the
  // local "está falando" indicator: the AnalyserNode below only ever sees the dry mic track, so
  // without this a playing clip would otherwise light up peers' copy of your ring (they hear the
  // real mixed track) while your own local ring stays dark.
  private soundboardLocalPlaybackCount = 0;
  // Buffers a requestImage() call that arrives before the connection entry itself exists yet —
  // e.g. right after a fresh 'peer-joined' event, before their SDP offer has even arrived.
  // Flushed into the entry's own pendingImageRequests as soon as getOrCreateConnection makes one.
  private pendingImageRequestsByPeer = new Map<string, { kind: ImageCacheKind; ownerId: string; knownHash: string | null }[]>();
  // Same buffering rationale as pendingImageRequestsByPeer, for the 'sounds' channel.
  private pendingSoundListRequestsByPeer = new Set<string>();
  private pendingSoundRequestsByPeer = new Map<string, { soundId: string; knownHash: string | null }[]>();
  // [Bug corrigido, investigação de conectividade 2026-08-27] handleIceCandidate descartava em
  // silêncio qualquer candidato que chegasse ANTES da entry desse peer existir (this.connections
  // só ganha uma entry dentro de getOrCreateConnection, chamado a partir do primeiro offer/answer
  // processado — um candidato do outro lado pode teoricamente chegar antes disso, mesma classe de
  // corrida que pendingImageRequestsByPeer já existia pra resolver, só que faltava aqui). Dado
  // real que motivou a correção: getStats() mostrando cada lado reunindo os próprios candidatos
  // perfeitamente (inclusive srflx) mas "candidatos remotos recebidos: NENHUM" — o candidato do
  // outro lado nunca era aplicado. Mesmo padrão de buffer-até-a-entry-existir, igual a
  // pendingImageRequestsByPeer acima.
  private pendingIceCandidatesByPeer = new Map<string, RTCIceCandidateInit[]>();
  // [Diagnóstico, investigação de conectividade 2026-08-27, expandido] Rastreia o ciclo de vida
  // completo de um candidato remoto por peer, não só "chegou por sinalização":
  //   sent               → candidatos nossos que onicecandidate gerou e mandamos por sinalização
  //   receivedRaw        → mensagens 'ice-candidate' que de fato chegaram por sinalização
  //   bufferedNoRemoteDesc → desses, quantos foram bufferizados (remoteDescription ainda não
  //                          existia) em vez de aplicados na hora — se isso ficar muito maior que
  //                          `applied`, o candidato provavelmente está preso pra sempre porque
  //                          flushPendingCandidates nunca roda pra essa conexão
  //   applied            → addIceCandidate() retornou sucesso (direto ou via flush)
  //   rejected           → addIceCandidate() lançou (direto ou via flush)
  // sent+receivedRaw sozinhos só provam que a sinalização entrega — não provam que o candidato
  // chega a ser usado pelo RTCPeerConnection. applied/bufferedNoRemoteDesc/rejected juntos devem
  // somar receivedRaw; se não somarem, tem um 4º destino não rastreado ainda.
  private candidateCounters = new Map<
    string,
    { sent: number; receivedRaw: number; applied: number; bufferedNoRemoteDesc: number; rejected: number }
  >();

  private getCandidateCounters(peerId: string): {
    sent: number;
    receivedRaw: number;
    applied: number;
    bufferedNoRemoteDesc: number;
    rejected: number;
  } {
    const existing = this.candidateCounters.get(peerId);
    if (existing) return existing;
    const fresh = { sent: 0, receivedRaw: 0, applied: 0, bufferedNoRemoteDesc: 0, rejected: 0 };
    this.candidateCounters.set(peerId, fresh);
    return fresh;
  }

  constructor(private opts: MeshManagerOptions) {
    this.speakingPollHandle = setInterval(() => void this.pollRemoteSpeaking(), SPEAKING_POLL_INTERVAL_MS);
    this.localSpeakingPollHandle = setInterval(() => this.pollLocalSpeaking(), LOCAL_SPEAKING_POLL_INTERVAL_MS);
  }

  addExistingPeer(peerId: string): void {
    const entry = this.getOrCreateConnection(peerId);
    // Only the side that offers creates the data channel — the answering side receives it via
    // pc.ondatachannel (registered in getOrCreateConnection, which runs for both roles). Created
    // before renegotiate() below so it rides along in that very first offer.
    if (!entry.imagesChannel) this.setupImagesChannel(entry, entry.pc.createDataChannel('images'));
    if (!entry.soundsChannel) this.setupSoundsChannel(entry, entry.pc.createDataChannel('sounds'));
    void this.renegotiate(entry);
  }

  /** Sets which peerId is "us" for this room — needed only to deterministically pick a polite/
   * impolite role per connection (see PeerConnectionEntry.isPolite) the moment each one is
   * created. Must be called before the first addExistingPeer/handleOffer for this room, which
   * useRoomConnection.ts guarantees (it's set from the same 'room-joined' message that triggers
   * the first addExistingPeer calls). */
  setSelfPeerId(peerId: string): void {
    this.selfPeerId = peerId;
  }

  handleOffer(fromPeerId: string, sdp: string): Promise<void> {
    const entry = this.getOrCreateConnection(fromPeerId);
    // .catch() right here, not left to the caller — a rejection stored in entry.negotiationQueue
    // itself would poison every later .then() chained onto it (offer/answer/renegotiate alike),
    // permanently breaking this connection's negotiation instead of just this one failed round.
    entry.negotiationQueue = entry.negotiationQueue.then(() => this.performHandleOffer(entry, sdp)).catch((error) => {
      // [Bug corrigido, investigação de conectividade 2026-08-27] console.error sozinho só
      // aparece no DevTools de quem tá com o problema na hora — nunca chegava aos logs remotos
      // que eu consigo consultar. Se setRemoteDescription/createAnswer estiver falhando aqui, era
      // exatamente o tipo de falha silenciosa que explicaria candidatos nunca aplicados (a
      // resposta nunca completa, então remoteDescription nunca fica pronta pra receber nada).
      console.error(`[MeshManager] handleOffer failed for ${entry.peerId}`, error);
      this.opts.onConnectionError?.(
        entry.peerId,
        'negotiation-failed',
        `handleOffer/performHandleOffer lançou: ${error instanceof Error ? error.message : String(error)}`
      );
    });
    return entry.negotiationQueue;
  }

  private async performHandleOffer(entry: PeerConnectionEntry, sdp: string): Promise<void> {
    // Glare: both sides decided to (re)negotiate at roughly the same time. entry.negotiationQueue
    // guarantees this check only ever runs after any of our own in-flight offer/answer work has
    // fully finished, so pc.signalingState here always reflects reality, never a half-applied
    // state — that's what makes this check reliable (see negotiationQueue's own comment).
    const offerCollision = entry.pc.signalingState !== 'stable';
    if (offerCollision) {
      if (!entry.isPolite) {
        // Impolite: keep our own in-flight offer, ignore theirs. The polite peer on the other end
        // resolves the same collision by rolling back and accepting our offer instead.
        return;
      }
      await entry.pc.setLocalDescription({ type: 'rollback' });
      // [Correção preventiva, investigação de conectividade 2026-08-27] Qualquer candidato
      // remoto ainda em pendingCandidates nesse momento foi recebido enquanto esperava a
      // remoteDescription da nossa própria oferta (agora abandonada pelo rollback) — não há
      // garantia de que o sdpMid/sdpMLineIndex desses candidatos ainda corresponda a algo válido
      // na remoteDescription nova que estamos prestes a aceitar (a oferta deles) em vez da nossa.
      // Aplicar às cegas arrisca uma rejeição do addIceCandidate sem ganho nenhum. Descartar não é
      // isento de custo (esses candidatos específicos se perdem, não são reenviados
      // automaticamente por ninguém) — mas ICE não depende de nenhum candidato específico, só de
      // pelo menos um par válido entre os que continuam sendo trocados depois da rodada nova
      // começar, então o custo real é pequeno frente ao risco de aplicar algo incompatível.
      entry.pendingCandidates = [];
    }

    await entry.pc.setRemoteDescription({ type: 'offer', sdp });
    await this.flushPendingCandidates(entry);
    const answer = await entry.pc.createAnswer();
    await entry.pc.setLocalDescription(answer);
    this.opts.send({ type: 'sdp-answer', targetPeerId: entry.peerId, sdp: answer.sdp ?? '' });

    // [Bug corrigido] A new joiner never saw an already-active screen share: getOrCreateConnection
    // above adds every current local track (addLocalTracksTo) — mic/camera/screen — *before*
    // createAnswer() runs, but an answer can only fill in m-lines the incoming offer already
    // defined; it can't spontaneously add new ones. A joiner's own offer only has m-lines for
    // *their* tracks (mic/camera, never screen, since they can't be sharing before even joining),
    // so an existing sharer's screenVideo/screenAudio transceivers were created but left with no
    // mid — never actually sent in that answer. Any transceiver still missing a mid after this
    // answer (also true right after the rollback-and-accept path above) needs a follow-up offer
    // from this side to actually get on the wire — deferred via renegotiateNeeded/
    // maybeFlushRenegotiate rather than a guessed setTimeout, so it fires exactly when this
    // connection is actually back in a state that can take a new offer, not "probably by now".
    const hasUnnegotiatedTracks = entry.pc.getTransceivers().some((transceiver) => transceiver.mid === null);
    if (hasUnnegotiatedTracks) entry.renegotiateNeeded = true;
    this.maybeFlushRenegotiate(entry);
  }

  handleAnswer(fromPeerId: string, sdp: string): Promise<void> {
    const entry = this.connections.get(fromPeerId);
    if (!entry) return Promise.resolve();
    entry.negotiationQueue = entry.negotiationQueue.then(() => this.performHandleAnswer(entry, sdp)).catch((error) => {
      // See handleOffer's own catch — same gap, same fix: console.error alone never reached the
      // remote logs I can actually query.
      console.error(`[MeshManager] handleAnswer failed for ${entry.peerId}`, error);
      this.opts.onConnectionError?.(
        entry.peerId,
        'negotiation-failed',
        `handleAnswer/performHandleAnswer lançou: ${error instanceof Error ? error.message : String(error)}`
      );
    });
    return entry.negotiationQueue;
  }

  private async performHandleAnswer(entry: PeerConnectionEntry, sdp: string): Promise<void> {
    if (entry.pc.signalingState !== 'have-local-offer') {
      // A stale/duplicate answer for a round that isn't current any more — most commonly because
      // we (as the polite peer) already rolled back that offer after a glare collision. Applying
      // it now would only throw "Called in wrong state"; dropping it is correct, not a workaround.
      // [Diagnóstico, investigação de conectividade 2026-08-27] Logado porque, se isso disparar
      // FORA de uma colisão real, é exatamente o tipo de descarte silencioso (sem exceção, sem
      // flushPendingCandidates nunca rodando) que explicaria candidatos presos no buffer pra
      // sempre sem nenhum erro visível em lugar nenhum — todos os outros suspeitos já descartados.
      this.opts.onConnectionError?.(
        entry.peerId,
        'negotiation-failed',
        `handleAnswer descartado — signalingState era '${entry.pc.signalingState}', esperava 'have-local-offer'`
      );
      return;
    }
    await entry.pc.setRemoteDescription({ type: 'answer', sdp });
    await this.flushPendingCandidates(entry);
    this.maybeFlushRenegotiate(entry);
  }

  /** Replays a renegotiate() that had to be deferred (see renegotiateNeeded) now that this
   * connection is back to 'stable' — called right after any operation that can produce that
   * transition (an answer just applied, or an incoming offer just answered). */
  private maybeFlushRenegotiate(entry: PeerConnectionEntry): void {
    if (!entry.renegotiateNeeded) return;
    entry.renegotiateNeeded = false;
    entry.negotiationQueue = entry.negotiationQueue.then(() => this.performOffer(entry));
  }

  async handleIceCandidate(fromPeerId: string, candidateJson: string): Promise<void> {
    // [Diagnóstico, investigação de conectividade 2026-08-27] Incrementado ANTES de qualquer
    // parse/lookup — confirma que a mensagem 'ice-candidate' realmente chegou por sinalização,
    // independente do que acontece depois (candidato inválido, entry ainda não existindo, etc.).
    // Sem isso não dava pra distinguir "nunca chegou" de "chegou e algo depois descartou".
    const counterEntry = this.getCandidateCounters(fromPeerId);
    counterEntry.receivedRaw += 1;
    let candidate: RTCIceCandidateInit;
    try {
      candidate = JSON.parse(candidateJson);
    } catch (error) {
      this.opts.onConnectionError?.(
        fromPeerId,
        'ice-candidate-apply-failed',
        `JSON.parse falhou: ${error instanceof Error ? error.message : String(error)} — raw: ${candidateJson.slice(0, 200)}`
      );
      return;
    }
    // See onicecandidate's own comment — same rationale, same 12-sample cap (ampliado de 3 em
    // 2026-08-27 pra dar mais amostra num teste real com testers), outro lado da comparação (o que
    // de fato foi parseado do payload de sinalização recebido pra este candidato).
    if (counterEntry.receivedRaw <= 12) {
      this.opts.onConnectionError?.(
        fromPeerId,
        'ice-candidate-apply-failed',
        `RECEBIDO #${counterEntry.receivedRaw}: candidate="${candidate.candidate}" sdpMid=${candidate.sdpMid} sdpMLineIndex=${candidate.sdpMLineIndex} ufrag=${candidate.usernameFragment}`
      );
    }
    const entry = this.connections.get(fromPeerId);
    if (!entry) {
      // See pendingIceCandidatesByPeer's own comment — buffered instead of dropped, flushed into
      // the real entry's own pendingCandidates the moment getOrCreateConnection makes one.
      const queued = this.pendingIceCandidatesByPeer.get(fromPeerId) ?? [];
      queued.push(candidate);
      this.pendingIceCandidatesByPeer.set(fromPeerId, queued);
      // [Diagnóstico, adicionado 2026-08-27] Esta entry (this.connections) só existe a partir do
      // primeiro offer/answer processado — se isto disparar bastante, o candidato está
      // sistematicamente chegando ANTES da negociação SDP começar deste lado, não só num caso raro.
      this.opts.onConnectionError?.(
        fromPeerId,
        'ice-candidate-apply-failed',
        `bufferizado em pendingIceCandidatesByPeer (entry da conexão ainda não existe) — fila agora com ${queued.length}`
      );
      return;
    }
    // [Corrigido, investigação de conectividade 2026-08-27] Antes, o resto deste método (checar
    // remoteDescription, aplicar via addIceCandidate) rodava fora de entry.negotiationQueue —
    // diferente de handleOffer/handleAnswer/renegotiate, que são todos serializados nela. Um
    // candidato podia chegar por sinalização bem no meio de uma colisão de oferta em andamento
    // (rollback + aceitar a oferta do outro lado, ver performHandleOffer), ver remoteDescription
    // como "existe" (a antiga, ainda não rolada de volta) e acabar aplicado depois, já contra a
    // SDP nova — sdpMid/sdpMLineIndex/ufrag de uma rodada, candidato de outra. Bate exatamente com
    // as hipóteses "candidato não corresponde ao SDP ativo" e "lifecycle/ordem de negociação"
    // levantadas na investigação. Enfileirar aqui, mesmo padrão das outras operações que tocam
    // SDP/ICE nesta conexão, elimina a race por construção: este candidato só é checado/aplicado
    // depois que qualquer rollback/setRemoteDescription em andamento já tiver terminado de verdade.
    entry.negotiationQueue = entry.negotiationQueue
      .then(() => this.performHandleIceCandidate(entry, candidate))
      .catch((error) => {
        console.error(`[MeshManager] handleIceCandidate failed for ${entry.peerId}`, error);
        this.opts.onConnectionError?.(
          entry.peerId,
          'ice-candidate-apply-failed',
          `handleIceCandidate/performHandleIceCandidate lançou: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    return entry.negotiationQueue;
  }

  private async performHandleIceCandidate(entry: PeerConnectionEntry, candidate: RTCIceCandidateInit): Promise<void> {
    const counters = this.getCandidateCounters(entry.peerId);
    if (!entry.pc.remoteDescription) {
      // [Diagnóstico, adicionado 2026-08-27] Este era o único ramo de todo o fluxo de candidato
      // sem NENHUM log — se remoteDescription nunca fica pronta pra esta conexão por algum motivo
      // (sem nenhuma exceção em handleOffer/handleAnswer, que já são logadas), todo candidato
      // recebido cairia aqui pra sempre, silenciosamente, e é exatamente essa a explicação que
      // sobrava sem prova nenhuma até agora. bufferedNoRemoteDesc conta quantos; se esse número
      // ficar muito maior que `applied` no resumo final, é isso que está acontecendo.
      counters.bufferedNoRemoteDesc += 1;
      this.opts.onConnectionError?.(
        entry.peerId,
        'ice-candidate-apply-failed',
        `bufferizado em entry.pendingCandidates (remoteDescription ainda não existe, signalingState=${entry.pc.signalingState}) — fila agora com ${entry.pendingCandidates.length + 1}, ${elapsedSince(entry)}`
      );
      entry.pendingCandidates.push(candidate);
      return;
    }
    try {
      await entry.pc.addIceCandidate(candidate);
      counters.applied += 1;
      // [Diagnóstico, adicionado 2026-08-27] Sucesso nunca tinha log nenhum — só o fracasso. Sem
      // isto não dava pra confirmar se addIceCandidate estava sendo chamado com sucesso silencioso
      // (contraditório com getStats() vazio) ou nunca chegando a ser chamado de verdade.
      if (counters.applied <= 12) {
        this.opts.onConnectionError?.(
          entry.peerId,
          'ice-candidate-apply-failed',
          `APLICADO #${counters.applied}: addIceCandidate resolveu sem erro — candidate="${candidate.candidate}" sdpMid=${candidate.sdpMid}, ${elapsedSince(entry)}`
        );
      }
    } catch (error) {
      // [Diagnóstico, investigação de conectividade 2026-08-27] Antes descartava em silêncio total
      // — dado real motivou expor isso: contadores confirmaram que os candidatos CHEGAM por
      // sinalização (enviados de um lado batem com recebidos do outro), mas getStats() nunca
      // mostrava nenhum candidato remoto aplicado. Essa é a única explicação que sobra: addIceCandidate
      // está rejeitando todos eles, e sem logar o erro de verdade não dava pra saber por quê.
      counters.rejected += 1;
      this.opts.onConnectionError?.(
        entry.peerId,
        'ice-candidate-apply-failed',
        `addIceCandidate rejeitou: ${error instanceof Error ? error.message : String(error)} — candidate: ${JSON.stringify(candidate).slice(0, 300)}, ${elapsedSince(entry)}`
      );
    }
  }

  removePeer(peerId: string): void {
    const entry = this.connections.get(peerId);
    if (!entry) return;
    entry.pc.close();
    this.connections.delete(peerId);
    this.pendingImageRequestsByPeer.delete(peerId);
    this.pendingSoundListRequestsByPeer.delete(peerId);
    this.pendingSoundRequestsByPeer.delete(peerId);
    this.pendingIceCandidatesByPeer.delete(peerId);
    this.candidateCounters.delete(peerId);
    this.speakingStateByPeer.delete(peerId);
    this.opts.onRemoteStreamsChange(peerId, { personal: null, screen: null });
  }

  /** Asks one peer for an image (their own avatar, or a server icon they host) — queued until
   * the data channel opens if it isn't ready yet. `knownHash` lets the peer skip re-sending
   * bytes we already have cached from a previous session. */
  requestImage(peerId: string, kind: ImageCacheKind, ownerId: string, knownHash: string | null): void {
    const entry = this.connections.get(peerId);
    if (!entry) {
      // No connection entry yet at all — buffer at the manager level; getOrCreateConnection
      // adopts it into the entry's own queue the moment one is created for this peer.
      const queued = this.pendingImageRequestsByPeer.get(peerId) ?? [];
      queued.push({ kind, ownerId, knownHash });
      this.pendingImageRequestsByPeer.set(peerId, queued);
      return;
    }
    if (entry.imagesChannel?.readyState === 'open') {
      this.sendImageControl(entry.imagesChannel, { t: 'req', kind, ownerId, knownHash });
    } else {
      entry.pendingImageRequests.push({ kind, ownerId, knownHash });
    }
  }

  /** Asks one peer for their current soundboard catalog (names/emojis, no audio bytes yet) —
   * answered via onSoundListReceived. Queued the same way requestImage is if the connection or
   * channel isn't ready yet. */
  requestSoundList(peerId: string): void {
    const entry = this.connections.get(peerId);
    if (!entry) {
      this.pendingSoundListRequestsByPeer.add(peerId);
      return;
    }
    if (entry.soundsChannel?.readyState === 'open') {
      this.sendSoundControl(entry.soundsChannel, { t: 'list-req' });
    } else {
      entry.pendingSoundListRequest = true;
    }
  }

  /** Asks one peer for one specific sound of theirs (by id, from a list already received via
   * requestSoundList) — `knownHash` skips re-downloading bytes already cached from before. */
  requestSound(peerId: string, soundId: string, knownHash: string | null): void {
    const entry = this.connections.get(peerId);
    if (!entry) {
      const queued = this.pendingSoundRequestsByPeer.get(peerId) ?? [];
      queued.push({ soundId, knownHash });
      this.pendingSoundRequestsByPeer.set(peerId, queued);
      return;
    }
    if (entry.soundsChannel?.readyState === 'open') {
      this.sendSoundControl(entry.soundsChannel, { t: 'req', soundId, knownHash });
    } else {
      entry.pendingSoundRequests.push({ soundId, knownHash });
    }
  }

  setLocalMicTrack(track: MediaStreamTrack | null): void {
    if (this.micTrack) this.personalStream.removeTrack(this.micTrack);
    this.micTrack = track;
    if (track) this.personalStream.addTrack(track);
    for (const entry of this.connections.values()) {
      if (this.applyTrack(entry, 'mic', track, this.personalStream)) void this.renegotiate(entry);
    }
    // applyTrack above always sends the real track — re-silence it if a mute is in effect
    // (e.g. switching mic device while muted must not un-mute as a side effect).
    if (this.micMuted) {
      for (const entry of this.connections.values()) {
        void entry.senders.mic?.replaceTrack(null);
      }
    }
    this.rewireMicAnalyser(track);
  }

  /** (Re)connects the local speaking-level analyser to whichever mic track is active — torn
   * down and rebuilt on every device switch since a MediaStreamAudioSourceNode is tied to one
   * specific track. */
  private rewireMicAnalyser(track: MediaStreamTrack | null): void {
    this.micAnalyserSource?.disconnect();
    this.micAnalyserSource = null;

    if (!track) return;

    if (!this.audioContext) this.audioContext = new AudioContext();
    void this.audioContext.resume().catch(() => {});

    if (!this.micAnalyser) {
      this.micAnalyser = this.audioContext.createAnalyser();
      this.micAnalyser.fftSize = 512;
    }

    this.micAnalyserSource = this.audioContext.createMediaStreamSource(new MediaStream([track]));
    this.micAnalyserSource.connect(this.micAnalyser);
  }

  /** User-configurable toggle for preferring H.264 (hardware-encode-capable) on screen-share
   * video — see hardwareEncodePreferenceEnabled's own comment above for why this only affects the
   * next screen share, not one already in progress. */
  setHardwareEncodePreference(enabled: boolean): void {
    this.hardwareEncodePreferenceEnabled = enabled;
  }

  /** Mutes/unmutes what's sent to peers only — capture and the local speaking analyser keep
   * running either way, so a muted user who's still talking can be flagged locally. */
  setMicMuted(muted: boolean): void {
    this.micMuted = muted;
    const sendTrack = this.currentMicSendTrack();
    for (const entry of this.connections.values()) {
      void entry.senders.mic?.replaceTrack(sendTrack);
    }
  }

  /** What should actually be riding the 'mic' sender right now — the soundboard mix while a
   * clip is playing (see playSoundboardClip), otherwise the raw mic track, or null while muted.
   * Muted always wins: decisions.md is explicit that a muted user sends nothing at all, soundboard
   * included, so this never has to special-case "muted but a clip happens to be playing". */
  private currentMicSendTrack(): MediaStreamTrack | null {
    if (this.micMuted) return null;
    if (this.soundboardActiveCount > 0 && this.soundboardMixDestination) {
      return this.soundboardMixDestination.stream.getAudioTracks()[0] ?? this.micTrack;
    }
    return this.micTrack;
  }

  /**
   * Plays a soundboard clip two ways at once: locally, straight to this machine's own speakers
   * (so whoever triggered it hears it too — that's independent of anything below), and, unless
   * muted, broadcast to every connected peer as if it were the microphone — mixed with the live
   * mic signal (if any) via a Web Audio graph, on the same sender/track slot the raw mic normally
   * occupies (RTCRtpSender.replaceTrack, no renegotiation, same mechanism as mute/device-swap).
   * Muted only skips the broadcast half (decisions.md: a muted user sends nothing to others, no
   * soundboard bypass) — local monitoring still plays either way. Reference-counted so overlapping
   * clips share one mix destination and the sender only reverts to the plain mic track once every
   * concurrent broadcasting clip has finished. Returns a `stop()` handle so a caller can cut
   * playback short (e.g. a play/pause toggle) — stopping a source fires the same 'onended' path
   * as playing to completion, so `onEnded` fires either way and callers don't need to tell the
   * two cases apart.
   */
  playSoundboardClip(buffer: AudioBuffer, volume: number, onEnded?: () => void): { stop: () => void } {
    if (!this.audioContext) this.audioContext = new AudioContext();
    const ctx = this.audioContext;
    void ctx.resume().catch(() => {});

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = Math.max(0, Math.min(1, volume));
    source.connect(gain);
    gain.connect(ctx.destination); // local monitoring — always on, regardless of mute
    this.soundboardLocalPlaybackCount += 1;

    const shouldBroadcast = !this.micMuted;
    if (shouldBroadcast) {
      if (!this.soundboardMixDestination) this.soundboardMixDestination = ctx.createMediaStreamDestination();
      const mixDestination = this.soundboardMixDestination;
      gain.connect(mixDestination);

      if (this.soundboardActiveCount === 0) {
        // First broadcasting clip of a burst — route the live mic signal into the mix too (so
        // speaking while a sound plays sends both), then swap every peer's sender onto it.
        if (this.micAnalyserSource) {
          this.soundboardMicGain = ctx.createGain();
          this.micAnalyserSource.connect(this.soundboardMicGain);
          this.soundboardMicGain.connect(mixDestination);
        }
        const mixedTrack = mixDestination.stream.getAudioTracks()[0] ?? null;
        for (const entry of this.connections.values()) {
          void entry.senders.mic?.replaceTrack(mixedTrack);
        }
      }
      this.soundboardActiveCount += 1;
    }

    source.onended = () => {
      source.disconnect();
      gain.disconnect();
      this.soundboardLocalPlaybackCount -= 1;
      onEnded?.();
      if (!shouldBroadcast) return;

      this.soundboardActiveCount -= 1;
      if (this.soundboardActiveCount > 0) return;

      this.soundboardMicGain?.disconnect();
      this.soundboardMicGain = null;
      const restoreTrack = this.currentMicSendTrack();
      for (const entry of this.connections.values()) {
        void entry.senders.mic?.replaceTrack(restoreTrack);
      }
    };
    source.start();
    return {
      stop: () => {
        try {
          source.stop();
        } catch {
          // already stopped/ended — onended already ran, nothing left to do
        }
      }
    };
  }

  async setLocalCameraTrack(track: MediaStreamTrack | null): Promise<void> {
    if (this.cameraTrack) this.personalStream.removeTrack(this.cameraTrack);
    this.cameraTrack = track;
    if (track) this.personalStream.addTrack(track);

    const toRenegotiate: PeerConnectionEntry[] = [];
    for (const entry of this.connections.values()) {
      if (this.applyTrack(entry, 'camera', track, this.personalStream)) toRenegotiate.push(entry);
    }
    await Promise.all(toRenegotiate.map((entry) => this.renegotiate(entry)));
  }

  /** Authoritative "this peer stopped sharing" — called from the explicit screen-share-changed
   * signal (messages.ts), not from WebRTC track lifecycle events, which turned out unreliable
   * for this specific transition (removeTrack + renegotiation doesn't consistently fire 'ended'
   * on the remote track, leaving viewers stuck on the last frame). Clears this manager's own
   * bookkeeping too, so a later unrelated emitRemoteStreams call (e.g. from a personal-stream
   * update) can't resurrect the stale reference. */
  forceClearScreenStream(peerId: string): void {
    const entry = this.connections.get(peerId);
    if (!entry) return;
    entry.screenStream = null;
    entry.screenStreamId = null;
    this.emitRemoteStreams(peerId);
  }

  /** Accepts the whole local screen-share stream (video + optional system audio). */
  async setLocalScreenTrack(stream: MediaStream | null): Promise<void> {
    const videoTrack = stream?.getVideoTracks()[0] ?? null;
    const audioTrack = stream?.getAudioTracks()[0] ?? null;
    // Tells Chromium's encoder this is screen/text content, not a camera — it weighs spatial
    // detail (sharp edges/text legibility) over temporal smoothness, the opposite trade-off a
    // camera track wants. Standard MediaStreamTrack API, no custom encoding logic involved.
    if (videoTrack) videoTrack.contentHint = 'detail';

    if (this.screenVideoTrack) this.screenStream.removeTrack(this.screenVideoTrack);
    if (this.screenAudioTrack) this.screenStream.removeTrack(this.screenAudioTrack);
    this.screenVideoTrack = videoTrack;
    this.screenAudioTrack = audioTrack;
    if (videoTrack) this.screenStream.addTrack(videoTrack);
    if (audioTrack) this.screenStream.addTrack(audioTrack);

    const toRenegotiate = new Set<PeerConnectionEntry>();
    for (const entry of this.connections.values()) {
      if (this.applyTrack(entry, 'screenVideo', videoTrack, this.screenStream)) toRenegotiate.add(entry);
      if (this.applyTrack(entry, 'screenAudio', audioTrack, this.screenStream)) toRenegotiate.add(entry);
    }
    await Promise.all([...toRenegotiate].map((entry) => this.renegotiate(entry)));
  }

  closeAll(): void {
    clearInterval(this.speakingPollHandle);
    clearInterval(this.localSpeakingPollHandle);
    if (this.localSpeakingReleaseTimer) clearTimeout(this.localSpeakingReleaseTimer);
    for (const peerId of [...this.connections.keys()]) this.removePeer(peerId);
    this.micAnalyserSource?.disconnect();
    this.micAnalyserSource = null;
    this.micAnalyser = null;
    this.soundboardMicGain?.disconnect();
    this.soundboardMicGain = null;
    this.soundboardMixDestination = null;
    this.soundboardActiveCount = 0;
    this.soundboardLocalPlaybackCount = 0;
    void this.audioContext?.close().catch(() => {});
    this.audioContext = null;
  }

  private getOrCreateConnection(peerId: string): PeerConnectionEntry {
    const existing = this.connections.get(peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: [...ICE_SERVERS, ...turnIceServers] });
    const entry: PeerConnectionEntry = {
      peerId,
      pc,
      pendingCandidates: this.pendingIceCandidatesByPeer.get(peerId) ?? [],
      personalStreamId: null,
      screenStreamId: null,
      personalStream: null,
      screenStream: null,
      senders: {},
      imagesChannel: null,
      pendingImageRequests: this.pendingImageRequestsByPeer.get(peerId) ?? [],
      incomingImageTransfer: null,
      imageSendQueue: Promise.resolve(),
      soundsChannel: null,
      pendingSoundListRequest: this.pendingSoundListRequestsByPeer.has(peerId),
      pendingSoundRequests: this.pendingSoundRequestsByPeer.get(peerId) ?? [],
      incomingSoundTransfer: null,
      soundSendQueue: Promise.resolve(),
      negotiationQueue: Promise.resolve(),
      renegotiateNeeded: false,
      // See PeerConnectionEntry.isPolite — deterministic as long as both sides compare the same
      // two ids (their own + the other's), which they always do, each from their own perspective.
      isPolite: (this.selfPeerId ?? '') < peerId,
      connectionCreatedAt: Date.now(),
      hasLoggedSuccessStats: false
    };
    this.pendingImageRequestsByPeer.delete(peerId);
    this.pendingSoundListRequestsByPeer.delete(peerId);
    this.pendingSoundRequestsByPeer.delete(peerId);
    this.pendingIceCandidatesByPeer.delete(peerId);
    this.connections.set(peerId, entry);

    // Only fires on the answering side — the offering side already has its own channel
    // reference from the createDataChannel() call in addExistingPeer.
    pc.ondatachannel = (event) => {
      if (event.channel.label === 'images' && !entry.imagesChannel) {
        this.setupImagesChannel(entry, event.channel);
      }
      if (event.channel.label === 'sounds' && !entry.soundsChannel) {
        this.setupSoundsChannel(entry, event.channel);
      }
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate) {
        // [Diagnóstico, adicionado 2026-08-27] Candidato nulo = "terminei de reunir" (fim do
        // gathering) — sinal explícito complementar a onicegatheringstatechange abaixo, direto no
        // ponto onde a última entrega de fato acontece.
        this.opts.onConnectionError?.(
          peerId,
          'ice-gathering-complete',
          `onicecandidate(null) — fim do gathering deste lado, ${elapsedSince(entry)}`
        );
        return;
      }
      const counterEntry = this.getCandidateCounters(peerId);
      counterEntry.sent += 1;
      // [Diagnóstico, investigação de conectividade 2026-08-27, ampliado 2026-08-27] Conteúdo
      // bruto dos candidatos enviados por conexão (cap ampliado de 3 pra 12 pra dar mais amostra
      // num teste real, e agora inclui `type` explicitamente — host/srflx/relay/prflx — pra
      // confirmar visualmente se o TURN novo está de fato gerando candidato relay).
      if (counterEntry.sent <= 12) {
        const c = event.candidate;
        this.opts.onConnectionError?.(
          peerId,
          'ice-candidate-apply-failed',
          `ENVIADO #${counterEntry.sent} type=${c.type ?? '?'}: candidate="${c.candidate}" sdpMid=${c.sdpMid} sdpMLineIndex=${c.sdpMLineIndex} ufrag=${c.usernameFragment}, ${elapsedSince(entry)}`
        );
      }
      this.opts.send({
        type: 'ice-candidate',
        targetPeerId: peerId,
        candidate: JSON.stringify(event.candidate.toJSON())
      });
    };

    // 'disconnected' is common and often transient (brief network blip that self-heals within a
    // couple seconds) — Chromium doesn't always follow it up with 'failed' either, so a connection
    // can also just sit in 'disconnected' forever with no media flowing and no further event ever
    // firing. Debounced: only reported if it's still 'disconnected' this long later, so a real
    // stuck connection is distinguishable from normal transient noise.
    let disconnectedTimer: ReturnType<typeof setTimeout> | null = null;
    pc.oniceconnectionstatechange = () => {
      // [Diagnóstico, adicionado 2026-08-27] Toda transição, incondicional — antes só 'failed'/
      // 'disconnected' geravam log; 'checking'/'connected'/'completed' nunca apareciam em lugar
      // nenhum, então não dava pra ver quanto tempo cada fase da negociação realmente levou.
      this.opts.onConnectionError?.(
        peerId,
        'ice-state-change',
        `iceConnectionState=${pc.iceConnectionState}, ${elapsedSince(entry)}`
      );
      if (disconnectedTimer) {
        clearTimeout(disconnectedTimer);
        disconnectedTimer = null;
      }
      if (pc.iceConnectionState === 'failed') {
        this.opts.onConnectionError?.(peerId, 'ice-failed', `iceConnectionState=failed (peer ${peerId})`);
        this.opts.onConnectionStatusChange?.(peerId, 'failed');
        void this.logIceStatsSummary(entry, 'falha real (iceConnectionState=failed, veredito do navegador)');
      } else if (pc.iceConnectionState === 'disconnected') {
        // Still 'connecting' (yellow), not 'failed' (red) yet — see onConnectionStatusChange's own
        // comment on why a transient blip shouldn't flash red before the grace window confirms it.
        this.opts.onConnectionStatusChange?.(peerId, 'connecting');
        disconnectedTimer = setTimeout(() => {
          disconnectedTimer = null;
          if (pc.iceConnectionState === 'disconnected') {
            this.opts.onConnectionError?.(
              peerId,
              'ice-disconnected',
              `iceConnectionState stuck at disconnected for ${ICE_DISCONNECTED_REPORT_DELAY_MS}ms (peer ${peerId})`
            );
            this.opts.onConnectionStatusChange?.(peerId, 'failed');
            void this.logIceStatsSummary(
              entry,
              `timeout interno (${ICE_DISCONNECTED_REPORT_DELAY_MS}ms em 'disconnected', o navegador NÃO chegou a declarar 'failed' sozinho — se o autoteste de rede funciona, a causa é algo nosso, não a rede)`
            );
          }
        }, ICE_DISCONNECTED_REPORT_DELAY_MS);
      } else if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        this.opts.onConnectionStatusChange?.(peerId, 'connected');
        // [Diagnóstico, adicionado 2026-08-27] Dump de getStats() também no PRIMEIRO sucesso, não
        // só na falha — sem isto não dava pra comparar o par que efetivamente funcionou (host?
        // srflx? relay/TURN?) contra os que falham, nem confirmar que os contadores
        // aplicados/rejeitados fazem sentido quando tudo dá certo. Só uma vez por conexão
        // (hasLoggedSuccessStats) pra não repetir a cada oscilação connected<->completed.
        if (!entry.hasLoggedSuccessStats) {
          entry.hasLoggedSuccessStats = true;
          void this.logIceStatsSummary(entry, 'sucesso (iceConnectionState=connected/completed)');
        }
      } else {
        // 'new' / 'checking' / 'closed' — 'closed' only happens after removePeer() already tore
        // this down and dropped the peer from state, so this call is harmless dead code for it.
        this.opts.onConnectionStatusChange?.(peerId, 'connecting');
      }
    };
    // Fresh connection, nothing negotiated yet — matches pc.iceConnectionState's own initial
    // value ('new'), emitted once up front so the indicator starts yellow immediately instead of
    // whatever default the caller's state initializes to before the first real event fires.
    this.opts.onConnectionStatusChange?.(peerId, 'connecting');
    pc.onconnectionstatechange = () => {
      // [Diagnóstico, adicionado 2026-08-27] Toda transição — mesma razão do
      // oniceconnectionstatechange acima: connectionState é o veredito "geral" (ICE + DTLS juntos)
      // e antes só aparecia no log quando já tinha dado 'failed'.
      this.opts.onConnectionError?.(
        peerId,
        'connection-state-change',
        `connectionState=${pc.connectionState}, ${elapsedSince(entry)}`
      );
      if (pc.connectionState === 'failed') {
        this.opts.onConnectionError?.(peerId, 'connection-failed', `connectionState=failed (peer ${peerId})`);
        void this.logIceStatsSummary(entry, 'falha real (connectionState=failed, veredito do navegador)');
      }
    };
    // [Diagnóstico, adicionado 2026-08-27] Timeline da negociação SDP em si (new/have-local-offer/
    // have-remote-offer/stable/...) — complementa ice-state-change/connection-state-change, que só
    // cobrem o lado ICE/geral. Junto dos outros dois, dá pra reconstruir a ordem exata offer →
    // answer → candidatos → conexão de qualquer round de negociação, incluindo colisões (um
    // rollback aparece como uma transição extra de volta pra 'stable').
    pc.onsignalingstatechange = () => {
      this.opts.onConnectionError?.(
        peerId,
        'signaling-state-change',
        `signalingState=${pc.signalingState}, ${elapsedSince(entry)}`
      );
    };
    // [Diagnóstico, adicionado 2026-08-27] Quando o gathering muda de fase — em especial 'complete'
    // — confirma rápido, sem esperar falha nenhuma, que este lado terminou de reunir candidatos
    // (combinado com os ENVIADO #N/type acima pra ver se algum deles foi `relay`, ou seja, se a
    // alocação TURN nova realmente gerou candidato).
    pc.onicegatheringstatechange = () => {
      this.opts.onConnectionError?.(
        peerId,
        'ice-gathering-state-change',
        `iceGatheringState=${pc.iceGatheringState}, ${elapsedSince(entry)}`
      );
    };
    pc.onicecandidateerror = (event) => {
      // [Diagnóstico, investigação de conectividade 2026-08-27] `url`/`address`/`port` incluídos
      // de propósito — sem isso não dava pra confirmar se "STUN binding request timed out" era
      // sobre o servidor STUN configurado (gathering) ou sobre a checagem direta entre os dois
      // peers (Chromium usa o mesmo mecanismo de erro pra ambos, e o texto sozinho não distingue).
      // `url` vazio/ausente aqui é o sinal de que é a segunda opção.
      const iceError = event as RTCPeerConnectionIceErrorEvent;
      this.opts.onConnectionError?.(
        peerId,
        'ice-candidate-error',
        `errorCode=${iceError.errorCode} ${iceError.errorText ?? ''} url=${iceError.url || '(nenhuma — não é o servidor STUN)'} local=${iceError.address ?? '?'}:${iceError.port ?? '?'}, ${elapsedSince(entry)}`.trim()
      );
    };

    // Camera and screen are both kind:'video', so which is which is determined by
    // grouping: local tracks are added via two distinct MediaStream objects
    // (personal vs screen), and that stream id survives the wire (msid) — the first
    // distinct stream id seen for a peer is always "personal" since the mic track is
    // always present from the very first offer, before screen share is ever possible.
    pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (!stream) return;
      const isPersonal = entry.personalStreamId === null || entry.personalStreamId === stream.id;
      if (isPersonal) {
        entry.personalStreamId = stream.id;
        entry.personalStream = stream;
      } else {
        entry.screenStreamId = stream.id;
        entry.screenStream = stream;
      }
      event.track.addEventListener('ended', () => {
        if (!isPersonal) {
          entry.screenStream = null;
          entry.screenStreamId = null;
          this.emitRemoteStreams(peerId);
        }
      });
      this.emitRemoteStreams(peerId);
    };

    this.addLocalTracksTo(entry);
    return entry;
  }

  private addLocalTracksTo(entry: PeerConnectionEntry): void {
    if (this.micTrack) {
      entry.senders.mic = entry.pc.addTrack(this.micTrack, this.personalStream);
      // addTrack can't take null directly — add the real track then immediately silence it,
      // before any ICE/DTLS negotiation has a chance to actually send anything.
      if (this.micMuted) void entry.senders.mic.replaceTrack(null);
    }
    if (this.cameraTrack) entry.senders.camera = entry.pc.addTrack(this.cameraTrack, this.personalStream);
    if (this.screenVideoTrack) {
      const sender = entry.pc.addTrack(this.screenVideoTrack, this.screenStream);
      entry.senders.screenVideo = sender;
      this.applyScreenVideoDegradationPreference(sender);
      this.preferH264ForScreenVideo(entry.pc, sender);
    }
    if (this.screenAudioTrack) {
      const sender = entry.pc.addTrack(this.screenAudioTrack, this.screenStream);
      entry.senders.screenAudio = sender;
      this.raiseScreenAudioBitrateCeiling(sender);
    }
  }

  private setupImagesChannel(entry: PeerConnectionEntry, channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';
    entry.imagesChannel = channel;

    channel.onopen = () => {
      const queued = entry.pendingImageRequests;
      entry.pendingImageRequests = [];
      for (const request of queued) this.sendImageControl(channel, { t: 'req', ...request });
    };

    channel.onmessage = (event) => {
      if (typeof event.data === 'string') {
        // [Achado de segurança] JSON.parse() sem try/catch aqui lançava direto dentro do
        // onmessage — um peer malicioso/com bug mandando um frame malformado quebrava esse
        // handler pra essa conexão inteira. handleIceCandidate já tinha esse cuidado, esse canal
        // não tinha.
        let frame: ImageControlFrame;
        try {
          frame = JSON.parse(event.data) as ImageControlFrame;
        } catch {
          return;
        }
        void this.handleImageControl(entry, channel, frame);
        return;
      }
      this.handleImageChunk(entry, event.data as ArrayBuffer);
    };
  }

  private sendImageControl(channel: RTCDataChannel, frame: ImageControlFrame): void {
    if (channel.readyState !== 'open') return;
    channel.send(JSON.stringify(frame));
  }

  private async answerImageRequest(channel: RTCDataChannel, frame: ImageRequestFrame): Promise<void> {
    const answer = await this.opts.onImageRequest(frame.kind, frame.ownerId, frame.knownHash);
    if (answer.status === 'unchanged') {
      this.sendImageControl(channel, { t: 'unchanged', kind: frame.kind, ownerId: frame.ownerId });
    } else if (answer.status === 'missing') {
      this.sendImageControl(channel, { t: 'missing' });
    } else {
      this.sendImageControl(channel, {
        t: 'meta',
        kind: frame.kind,
        ownerId: frame.ownerId,
        mimeType: answer.mimeType,
        hash: answer.hash,
        size: answer.data.byteLength
      });
      await this.sendImageData(channel, answer.data);
    }
  }

  private async handleImageControl(
    entry: PeerConnectionEntry,
    channel: RTCDataChannel,
    frame: ImageControlFrame
  ): Promise<void> {
    if (frame.t === 'req') {
      // Chained rather than awaited directly — see imageSendQueue's doc comment on why two
      // concurrent responses on one channel can't be allowed to interleave their chunks.
      entry.imageSendQueue = entry.imageSendQueue
        .then(() => this.answerImageRequest(channel, frame))
        .catch(() => {});
      return;
    }

    if (frame.t === 'meta') {
      if (typeof frame.size !== 'number' || frame.size <= 0 || frame.size > MAX_IMAGE_TRANSFER_BYTES) return;
      entry.incomingImageTransfer = {
        kind: frame.kind,
        ownerId: frame.ownerId,
        mimeType: frame.mimeType,
        hash: frame.hash,
        size: frame.size,
        chunks: [],
        received: 0
      };
      return;
    }
    if (frame.t === 'unchanged') {
      this.opts.onImageUnchanged(frame.kind, frame.ownerId);
      return;
    }
    // 'missing' needs no state — there's genuinely nothing to hydrate on the requester's end.
  }

  private handleImageChunk(entry: PeerConnectionEntry, chunk: ArrayBuffer): void {
    const transfer = entry.incomingImageTransfer;
    if (!transfer) return; // stray chunk with no matching meta — drop
    transfer.chunks.push(chunk);
    transfer.received += chunk.byteLength;
    if (transfer.received < transfer.size) return;

    entry.incomingImageTransfer = null;
    if (transfer.received !== transfer.size) return; // truncated/corrupt — drop rather than show garbage
    const data = new Uint8Array(transfer.received);
    let offset = 0;
    for (const part of transfer.chunks) {
      data.set(new Uint8Array(part), offset);
      offset += part.byteLength;
    }
    this.opts.onImageReceived(transfer.kind, transfer.ownerId, data.buffer, transfer.mimeType);
  }

  private async sendImageData(channel: RTCDataChannel, data: ArrayBuffer): Promise<void> {
    channel.bufferedAmountLowThreshold = IMAGE_CHUNK_HIGH_WATER / 2;
    for (let offset = 0; offset < data.byteLength; offset += IMAGE_CHUNK_SIZE) {
      if (channel.readyState !== 'open') return;
      if (channel.bufferedAmount > IMAGE_CHUNK_HIGH_WATER) {
        await new Promise<void>((resolve) => {
          channel.addEventListener('bufferedamountlow', () => resolve(), { once: true });
        });
      }
      channel.send(data.slice(offset, offset + IMAGE_CHUNK_SIZE));
    }
  }

  private setupSoundsChannel(entry: PeerConnectionEntry, channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';
    entry.soundsChannel = channel;

    channel.onopen = () => {
      if (entry.pendingSoundListRequest) {
        entry.pendingSoundListRequest = false;
        this.sendSoundControl(channel, { t: 'list-req' });
      }
      const queued = entry.pendingSoundRequests;
      entry.pendingSoundRequests = [];
      for (const request of queued) this.sendSoundControl(channel, { t: 'req', ...request });
    };

    channel.onmessage = (event) => {
      if (typeof event.data === 'string') {
        // Same fix as setupImagesChannel's own onmessage — JSON.parse() without a try/catch here
        // let a malformed frame from a peer throw uncaught inside this handler.
        let frame: SoundControlFrame;
        try {
          frame = JSON.parse(event.data) as SoundControlFrame;
        } catch {
          return;
        }
        void this.handleSoundControl(entry, channel, frame);
        return;
      }
      this.handleSoundChunk(entry, event.data as ArrayBuffer);
    };
  }

  private sendSoundControl(channel: RTCDataChannel, frame: SoundControlFrame): void {
    if (channel.readyState !== 'open') return;
    channel.send(JSON.stringify(frame));
  }

  private async answerSoundListRequest(channel: RTCDataChannel): Promise<void> {
    const sounds = await this.opts.onSoundListRequest();
    this.sendSoundControl(channel, { t: 'list', sounds });
  }

  private async answerSoundRequest(channel: RTCDataChannel, frame: SoundRequestFrame): Promise<void> {
    const answer = await this.opts.onSoundRequest(frame.soundId, frame.knownHash);
    if (answer.status === 'unchanged') {
      this.sendSoundControl(channel, { t: 'unchanged', soundId: frame.soundId });
    } else if (answer.status === 'missing') {
      this.sendSoundControl(channel, { t: 'missing', soundId: frame.soundId });
    } else {
      this.sendSoundControl(channel, {
        t: 'meta',
        soundId: frame.soundId,
        mimeType: answer.mimeType,
        hash: answer.hash,
        size: answer.data.byteLength
      });
      await this.sendSoundData(channel, answer.data);
    }
  }

  private async handleSoundControl(
    entry: PeerConnectionEntry,
    channel: RTCDataChannel,
    frame: SoundControlFrame
  ): Promise<void> {
    if (frame.t === 'list-req') {
      // Chained onto the same queue as byte requests — see soundSendQueue's doc comment (mirrors
      // imageSendQueue) on why two concurrent responses on one channel can't interleave.
      entry.soundSendQueue = entry.soundSendQueue.then(() => this.answerSoundListRequest(channel)).catch(() => {});
      return;
    }
    if (frame.t === 'list') {
      this.opts.onSoundListReceived(entry.peerId, frame.sounds);
      return;
    }
    if (frame.t === 'req') {
      entry.soundSendQueue = entry.soundSendQueue.then(() => this.answerSoundRequest(channel, frame)).catch(() => {});
      return;
    }
    if (frame.t === 'meta') {
      if (typeof frame.size !== 'number' || frame.size <= 0 || frame.size > MAX_SOUND_TRANSFER_BYTES) return;
      entry.incomingSoundTransfer = {
        soundId: frame.soundId,
        mimeType: frame.mimeType,
        hash: frame.hash,
        size: frame.size,
        chunks: [],
        received: 0
      };
    }
    // 'unchanged'/'missing' need no state — the requester just doesn't hear back with a sound.
  }

  private handleSoundChunk(entry: PeerConnectionEntry, chunk: ArrayBuffer): void {
    const transfer = entry.incomingSoundTransfer;
    if (!transfer) return; // stray chunk with no matching meta — drop
    transfer.chunks.push(chunk);
    transfer.received += chunk.byteLength;
    if (transfer.received < transfer.size) return;

    entry.incomingSoundTransfer = null;
    if (transfer.received !== transfer.size) return; // truncated/corrupt — drop rather than show garbage
    const data = new Uint8Array(transfer.received);
    let offset = 0;
    for (const part of transfer.chunks) {
      data.set(new Uint8Array(part), offset);
      offset += part.byteLength;
    }
    this.opts.onSoundReceived(entry.peerId, transfer.soundId, data.buffer, transfer.mimeType);
  }

  private async sendSoundData(channel: RTCDataChannel, data: ArrayBuffer): Promise<void> {
    channel.bufferedAmountLowThreshold = SOUND_CHUNK_HIGH_WATER / 2;
    for (let offset = 0; offset < data.byteLength; offset += SOUND_CHUNK_SIZE) {
      if (channel.readyState !== 'open') return;
      if (channel.bufferedAmount > SOUND_CHUNK_HIGH_WATER) {
        await new Promise<void>((resolve) => {
          channel.addEventListener('bufferedamountlow', () => resolve(), { once: true });
        });
      }
      channel.send(data.slice(offset, offset + SOUND_CHUNK_SIZE));
    }
  }

  /** Adds/removes/swaps one local track role on one connection. Returns whether a fresh offer is needed. */
  /** Best-effort — setParameters() can reject if the connection isn't in a state that allows it
   * yet (e.g. right after addTrack, before the first negotiation completes on some browsers).
   * Not fatal either way: without this the sender just keeps whatever default ceiling the
   * browser picked, same as before this existed. */
  private raiseScreenAudioBitrateCeiling(sender: RTCRtpSender): void {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = SCREEN_AUDIO_MAX_BITRATE_BPS;
    void sender.setParameters(params).catch(() => {});
  }

  /** Content-dependent choice (text/slides want resolution kept under bad bandwidth, a shared
   * game wants framerate kept — see setScreenQualityMode below) exposed to applyScreenVideo-
   * DegradationPreference. */
  setScreenQualityMode(mode: 'quality' | 'smoothness'): void {
    this.screenDegradationPreference = mode === 'smoothness' ? 'maintain-framerate' : 'maintain-resolution';
  }

  private applyScreenVideoDegradationPreference(sender: RTCRtpSender): void {
    const params = sender.getParameters();
    params.degradationPreference = this.screenDegradationPreference;
    void sender.setParameters(params).catch(() => {});
  }

  /** Reorders the codec offer to put H.264 first, best-effort (falls back silently to whatever
   * Chromium would've picked — VP8 by default — if H.264 isn't in this build's capability list,
   * or if setCodecPreferences itself isn't available). Not a compression change by itself (H.264
   * and VP8 are both lossy video codecs, similar quality/bitrate in software) — the real point is
   * that only H.264 has a real shot at Chromium's hardware encoder path on Windows (NVENC/AMD/
   * Quick Sync, all through the same generic Media Foundation Transform API — no per-vendor code
   * needed here); VP8 in Chromium is software-only regardless of GPU. Confirmed working on real
   * hardware (RTX 3080, this Electron/Chromium build): getStats() on the sender's outbound-rtp
   * report showed `encoderImplementation: "MediaFoundationVideoEncodeAccelerator"` and
   * `powerEfficientEncoder: true` — genuinely hardware-encoded, not just negotiated. Whether it
   * lands on hardware on a given machine still depends on that machine's GPU driver, so this
   * stays best-effort (falls back to software H.264/VP8 transparently if the driver can't). */
  private preferH264ForScreenVideo(pc: RTCPeerConnection, sender: RTCRtpSender): void {
    if (!this.hardwareEncodePreferenceEnabled) return; // user turned it off — leave Chromium's default order

    const transceiver = pc.getTransceivers().find((candidate) => candidate.sender === sender);
    if (!transceiver?.setCodecPreferences) return;

    const capabilities = RTCRtpSender.getCapabilities?.('video');
    if (!capabilities) return;

    const h264Codecs = capabilities.codecs.filter((codec) => codec.mimeType.toLowerCase() === 'video/h264');
    if (h264Codecs.length === 0) return; // this build's Chromium doesn't offer H.264 at all

    const otherCodecs = capabilities.codecs.filter((codec) => codec.mimeType.toLowerCase() !== 'video/h264');
    try {
      transceiver.setCodecPreferences([...h264Codecs, ...otherCodecs]);
    } catch {
      // invalid combination for this transceiver's current state — leave the default order
    }
  }

  private applyTrack(
    entry: PeerConnectionEntry,
    role: TrackRole,
    track: MediaStreamTrack | null,
    groupStream: MediaStream
  ): boolean {
    const existing = entry.senders[role];
    if (track && existing) {
      void existing.replaceTrack(track); // device swap — no SDP round-trip needed
      return false;
    }
    if (track && !existing) {
      const sender = entry.pc.addTrack(track, groupStream);
      entry.senders[role] = sender;
      if (role === 'screenAudio') this.raiseScreenAudioBitrateCeiling(sender);
      if (role === 'screenVideo') {
        this.applyScreenVideoDegradationPreference(sender);
        this.preferH264ForScreenVideo(entry.pc, sender);
      }
      return true;
    }
    if (!track && existing) {
      entry.pc.removeTrack(existing);
      delete entry.senders[role];
      return true;
    }
    return false;
  }

  private renegotiate(entry: PeerConnectionEntry): Promise<void> {
    entry.negotiationQueue = entry.negotiationQueue.then(() => this.performOffer(entry));
    return entry.negotiationQueue;
  }

  private async performOffer(entry: PeerConnectionEntry): Promise<void> {
    if (entry.pc.signalingState !== 'stable') {
      // An offer/answer round is already in flight on this connection (ours or theirs) —
      // negotiationQueue means this is never a race, just a real "not yet done" — defer this
      // request and replay it the instant the in-flight round actually settles.
      entry.renegotiateNeeded = true;
      return;
    }
    try {
      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      this.opts.send({ type: 'sdp-offer', targetPeerId: entry.peerId, sdp: offer.sdp ?? '' });
    } catch (error) {
      // Best-effort by design (a failed renegotiation leaves media as it was rather than tearing
      // down the call) — but silent before this was another blind spot in the same investigation
      // as handleOffer/handleAnswer's own catch, so it's now reported too instead of swallowed.
      this.opts.onConnectionError?.(
        entry.peerId,
        'negotiation-failed',
        `renegotiate/performOffer lançou: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async flushPendingCandidates(entry: PeerConnectionEntry): Promise<void> {
    const queued = entry.pendingCandidates;
    entry.pendingCandidates = [];
    const counters = this.getCandidateCounters(entry.peerId);
    // [Diagnóstico, adicionado 2026-08-27] Confirma que este flush de fato roda e quando —
    // remoteDescription acabou de ser setada (só é chamado logo depois disso, ver
    // performHandleOffer/performHandleAnswer) e é o único lugar que esvazia pendingCandidates.
    if (queued.length > 0) {
      this.opts.onConnectionError?.(
        entry.peerId,
        'ice-candidate-apply-failed',
        `flushPendingCandidates rodando com ${queued.length} candidato(s) bufferizado(s), ${elapsedSince(entry)}`
      );
    }
    for (const candidate of queued) {
      try {
        await entry.pc.addIceCandidate(candidate);
        counters.applied += 1;
      } catch (error) {
        // Same diagnostic rationale as handleIceCandidate's own catch — this is the OTHER call
        // site for addIceCandidate (candidates that arrived before remoteDescription was set,
        // buffered here until now), so it needs the same visibility.
        counters.rejected += 1;
        this.opts.onConnectionError?.(
          entry.peerId,
          'ice-candidate-apply-failed',
          `addIceCandidate (flush) rejeitou: ${error instanceof Error ? error.message : String(error)} — candidate: ${JSON.stringify(candidate).slice(0, 300)}, ${elapsedSince(entry)}`
        );
      }
    }
  }

  /** [Diagnóstico, investigação de conectividade 2026-08-27, ampliado] Dump de getStats() quando
   * uma conexão real chega a 'failed' — lista os candidatos que cada lado realmente reuniu (tipo,
   * protocolo) e o estado de cada par tentado entre eles. Sem isso não dava pra saber se os dois
   * lados sequer chegaram a trocar candidato nenhum entre si (bug de sinalização) ou se trocaram
   * e a checagem direta peer-a-peer que falhou de verdade (NAT/firewall no meio, cenário de
   * TURN). Desde 2026-08-27 também roda no PRIMEIRO sucesso (connected/completed) — ver o call
   * site em oniceconnectionstatechange — pra comparar o par que funcionou contra os que falham.
   * Ainda não roda em toda chamada — getStats() tem custo, não é pra rodar toda hora, só nos dois
   * eventos que realmente decidem algo (primeira falha, primeiro sucesso). `reason` distingue as
   * formas de chegar aqui: falha real declarada pelo próprio navegador
   * (`iceConnectionState`/`connectionState` === 'failed') vs. o timeout de
   * `ICE_DISCONNECTED_REPORT_DELAY_MS` que ESTE código impõe sobre um 'disconnected' sustentado —
   * pedido do Mozar: se for o timeout interno E o autoteste de rede (que usa STUN de verdade)
   * funciona normalmente, a causa não pode ser a rede, só pode ser algo neste código. */
  private async logIceStatsSummary(entry: PeerConnectionEntry, reason: string): Promise<void> {
    try {
      const stats = await entry.pc.getStats();
      const candidates = new Map<string, string>();
      const localCandidates: string[] = [];
      const remoteCandidates: string[] = [];
      const pairs: string[] = [];
      stats.forEach((report: RTCStats & Record<string, unknown>) => {
        if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
          const label = `${report.candidateType}/${report.protocol}`;
          candidates.set(report.id, `${report.type === 'local-candidate' ? 'local' : 'remote'}:${label}`);
          (report.type === 'local-candidate' ? localCandidates : remoteCandidates).push(label);
        }
      });
      stats.forEach((report: RTCStats & Record<string, unknown>) => {
        if (report.type !== 'candidate-pair') return;
        const local = candidates.get(report.localCandidateId as string) ?? '?';
        const remote = candidates.get(report.remoteCandidateId as string) ?? '?';
        pairs.push(`[${report.state}] ${local} <-> ${remote}`);
      });
      // Quando não há par nenhum, isso é o que de fato distingue as duas causas possíveis: se
      // localCandidates está vazio, esse lado nem conseguiu reunir candidato próprio (mesma falha
      // de STUN vista em onicecandidateerror); se remoteCandidates está vazio mas local não,
      // reuniu os próprios mas nunca recebeu nenhum do outro peer (aponta pra sinalização, não
      // STUN) — os dois vazios juntos com candidato local presente seria o cenário clássico de
      // symmetric NAT/TURN necessário.
      const counters = this.getCandidateCounters(entry.peerId);
      // applied+bufferedNoRemoteDesc+rejected deveria bater com receivedRaw — se não bater, sobrou
      // candidato em algum estado intermediário (ainda dentro do negotiationQueue, por exemplo) no
      // exato instante deste dump; `emAndamento` deixa isso explícito em vez de forçar a soma.
      const emAndamento = counters.receivedRaw - (counters.applied + counters.bufferedNoRemoteDesc + counters.rejected);
      const counterSummary = `enviados=${counters.sent} recebidos-por-sinalização=${counters.receivedRaw} aplicados=${counters.applied} bufferizados-sem-remoteDesc=${counters.bufferedNoRemoteDesc} rejeitados=${counters.rejected} em-andamento=${emAndamento}`;
      const summary = pairs.length
        ? `[${reason}] ${pairs.join(' | ')} (${counterSummary}, ${elapsedSince(entry)})`
        : `[${reason}] nenhum par formado — candidatos locais: ${localCandidates.length ? localCandidates.join(', ') : 'NENHUM'}; candidatos remotos recebidos: ${remoteCandidates.length ? remoteCandidates.join(', ') : 'NENHUM'} (${counterSummary}, ${elapsedSince(entry)})`;
      this.opts.onConnectionError?.(
        entry.peerId,
        'ice-stats-summary',
        summary
      );
    } catch {
      // getStats() falhando não deve mascarar o erro real que motivou a chamada — best-effort.
    }
  }

  private async pollRemoteSpeaking(): Promise<void> {
    for (const entry of this.connections.values()) {
      try {
        const stats = await entry.pc.getStats();
        let level = 0;
        stats.forEach((report: RTCStats & { kind?: string; audioLevel?: number }) => {
          if (report.type === 'inbound-rtp' && report.kind === 'audio' && typeof report.audioLevel === 'number') {
            level = Math.max(level, report.audioLevel);
          }
        });
        let state = this.speakingStateByPeer.get(entry.peerId);
        if (!state) {
          state = { isSpeaking: false, consecutive: 0 };
          this.speakingStateByPeer.set(entry.peerId, state);
        }
        this.applySpeakingLevel(state, level, SPEAKING_DEBOUNCE_TICKS, (isSpeaking) =>
          this.opts.onSpeakingChange(entry.peerId, isSpeaking)
        );
      } catch {
        // transient stats failure — skip this tick
      }
    }
  }

  // Synchronous (no getStats() round-trip) and on its own much faster timer — see
  // LOCAL_SPEAKING_POLL_INTERVAL_MS's comment for why this is split out from the peers above.
  private pollLocalSpeaking(): void {
    // Bail out only if there's neither a mic to poll nor a clip playing — a user with no mic at
    // all (micAnalyser never set up) can still trigger a soundboard clip and should still see
    // their own ring light up for it.
    if (!this.micAnalyser && this.soundboardLocalPlaybackCount === 0) return;

    let level = 0;
    if (this.micAnalyser) {
      // Byte time-domain samples, converted to linear RMS 0..1 — same scale as the RFC 6464
      // audioLevel used for peers above, so both share SPEAKING_THRESHOLD.
      const samples = new Uint8Array(this.micAnalyser.fftSize);
      this.micAnalyser.getByteTimeDomainData(samples);
      let sumSquares = 0;
      for (let i = 0; i < samples.length; i++) {
        const normalized = (samples[i] - 128) / 128;
        sumSquares += normalized * normalized;
      }
      level = Math.sqrt(sumSquares / samples.length);
    }
    // The AnalyserNode only ever listens to the dry mic track (see rewireMicAnalyser) — it never
    // sees the soundboard mix, so a playing clip is forced in here instead of being picked up
    // naturally the way it already is on every remote peer's own copy of getStats().
    if (this.soundboardLocalPlaybackCount > 0) level = Math.max(level, 1);

    const aboveThreshold = level > SPEAKING_THRESHOLD;
    if (aboveThreshold) {
      // Fast attack: any single sample above threshold turns it on right away, and cancels a
      // pending "turn off" from a moment ago — still speaking through a brief dip/pause.
      if (this.localSpeakingReleaseTimer) {
        clearTimeout(this.localSpeakingReleaseTimer);
        this.localSpeakingReleaseTimer = null;
      }
      if (!this.localIsSpeaking) {
        this.localIsSpeaking = true;
        this.opts.onLocalSpeakingChange(true);
      }
    } else if (this.localIsSpeaking && !this.localSpeakingReleaseTimer) {
      // Slow release: only turns off after staying below threshold continuously for
      // LOCAL_SPEAKING_RELEASE_HOLD_MS, so the ring survives natural micro-pauses between
      // words instead of flickering off and back on mid-sentence.
      this.localSpeakingReleaseTimer = setTimeout(() => {
        this.localIsSpeaking = false;
        this.localSpeakingReleaseTimer = null;
        this.opts.onLocalSpeakingChange(false);
      }, LOCAL_SPEAKING_RELEASE_HOLD_MS);
    }
  }

  private applySpeakingLevel(
    state: SpeakingState,
    level: number,
    debounceTicks: number,
    onChange: (isSpeaking: boolean) => void
  ): void {
    const aboveThreshold = level > SPEAKING_THRESHOLD;
    if (aboveThreshold === state.isSpeaking) {
      state.consecutive = 0;
      return;
    }
    state.consecutive += 1;
    if (state.consecutive >= debounceTicks) {
      state.isSpeaking = aboveThreshold;
      state.consecutive = 0;
      onChange(state.isSpeaking);
    }
  }

  private emitRemoteStreams(peerId: string): void {
    const entry = this.connections.get(peerId);
    if (!entry) return;
    this.opts.onRemoteStreamsChange(peerId, {
      personal: entry.personalStream,
      screen: entry.screenStream
    });
  }
}
