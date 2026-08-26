import type { ClientToServerMessage } from '@concord/shared';
import type { ImageCacheKind } from './imageCache';

// STUN only, no TURN — explicit project decision (decisions.md §1), revisited only
// with real ICE-failure data from the alpha phase.
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

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

// Soundboard clip transfer over the 'sounds' data channel — same chunked-transfer shape as
// images, plus a list-req/list step first since (unlike one avatar per owner) a peer can have
// many sounds and the UI needs their names/emojis before anyone downloads bytes.
const SOUND_CHUNK_SIZE = 16 * 1024;
const SOUND_CHUNK_HIGH_WATER = 1024 * 1024;

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
  /** A peer connection actually failed (ICE or overall), or an ICE candidate errored out — the
   * CGNAT/symmetric-NAT scenario decisions.md §1 already flags as the reason TURN might be
   * needed. Optional: MeshManager works the same with or without a listener, this is diagnostics. */
  onConnectionError?: (peerId: string, kind: 'ice-failed' | 'connection-failed' | 'ice-candidate-error', detail: string) => void;
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

  async handleOffer(fromPeerId: string, sdp: string): Promise<void> {
    const entry = this.getOrCreateConnection(fromPeerId);
    await entry.pc.setRemoteDescription({ type: 'offer', sdp });
    await this.flushPendingCandidates(entry);
    const answer = await entry.pc.createAnswer();
    await entry.pc.setLocalDescription(answer);
    this.opts.send({ type: 'sdp-answer', targetPeerId: fromPeerId, sdp: answer.sdp ?? '' });

    // [Bug corrigido] A new joiner never saw an already-active screen share: getOrCreateConnection
    // above adds every current local track (addLocalTracksTo) — mic/camera/screen — *before*
    // createAnswer() runs, but an answer can only fill in m-lines the incoming offer already
    // defined; it can't spontaneously add new ones. A joiner's own offer only has m-lines for
    // *their* tracks (mic/camera, never screen, since they can't be sharing before even joining),
    // so an existing sharer's screenVideo/screenAudio transceivers were created but left with no
    // mid — never actually sent in that answer, and nothing afterward ever renegotiated to fix it.
    // Any transceiver still missing a mid after this answer needs a follow-up offer from this side
    // to actually get on the wire.
    const hasUnnegotiatedTracks = entry.pc.getTransceivers().some((transceiver) => transceiver.mid === null);
    if (hasUnnegotiatedTracks) void this.renegotiate(entry);
  }

  async handleAnswer(fromPeerId: string, sdp: string): Promise<void> {
    const entry = this.connections.get(fromPeerId);
    if (!entry) return;
    await entry.pc.setRemoteDescription({ type: 'answer', sdp });
    await this.flushPendingCandidates(entry);
  }

  async handleIceCandidate(fromPeerId: string, candidateJson: string): Promise<void> {
    const entry = this.connections.get(fromPeerId);
    if (!entry) return;
    let candidate: RTCIceCandidateInit;
    try {
      candidate = JSON.parse(candidateJson);
    } catch {
      return;
    }
    if (!entry.pc.remoteDescription) {
      entry.pendingCandidates.push(candidate);
      return;
    }
    try {
      await entry.pc.addIceCandidate(candidate);
    } catch {
      // stale/invalid candidate — safe to drop
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

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const entry: PeerConnectionEntry = {
      peerId,
      pc,
      pendingCandidates: [],
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
      soundSendQueue: Promise.resolve()
    };
    this.pendingImageRequestsByPeer.delete(peerId);
    this.pendingSoundListRequestsByPeer.delete(peerId);
    this.pendingSoundRequestsByPeer.delete(peerId);
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
      if (!event.candidate) return;
      this.opts.send({
        type: 'ice-candidate',
        targetPeerId: peerId,
        candidate: JSON.stringify(event.candidate.toJSON())
      });
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        this.opts.onConnectionError?.(peerId, 'ice-failed', `iceConnectionState=failed (peer ${peerId})`);
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        this.opts.onConnectionError?.(peerId, 'connection-failed', `connectionState=failed (peer ${peerId})`);
      }
    };
    pc.onicecandidateerror = (event) => {
      const iceError = event as RTCPeerConnectionIceErrorEvent;
      this.opts.onConnectionError?.(
        peerId,
        'ice-candidate-error',
        `errorCode=${iceError.errorCode} ${iceError.errorText ?? ''}`.trim()
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
        void this.handleImageControl(entry, channel, JSON.parse(event.data) as ImageControlFrame);
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
      this.sendImageControl(channel, { t: 'unchanged' });
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
      entry.incomingImageTransfer = {
        kind: frame.kind,
        ownerId: frame.ownerId,
        mimeType: frame.mimeType,
        hash: frame.hash,
        size: frame.size,
        chunks: [],
        received: 0
      };
    }
    // 'unchanged'/'missing' need no state — the requester just doesn't hear back with an image.
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
        void this.handleSoundControl(entry, channel, JSON.parse(event.data) as SoundControlFrame);
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

  private async renegotiate(entry: PeerConnectionEntry): Promise<void> {
    try {
      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      this.opts.send({ type: 'sdp-offer', targetPeerId: entry.peerId, sdp: offer.sdp ?? '' });
    } catch {
      // best-effort — a failed renegotiation leaves media as it was rather than tearing down the call
    }
  }

  private async flushPendingCandidates(entry: PeerConnectionEntry): Promise<void> {
    const queued = entry.pendingCandidates;
    entry.pendingCandidates = [];
    for (const candidate of queued) {
      try {
        await entry.pc.addIceCandidate(candidate);
      } catch {
        // stale/invalid candidate — safe to drop
      }
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
