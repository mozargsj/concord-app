import type { ClientToServerMessage } from '@concord/shared';
import type { ImageCacheKind } from './imageCache';

// STUN only, no TURN — explicit project decision (decisions.md §1), revisited only
// with real ICE-failure data from the alpha phase.
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

// getStats() poll for the "está falando" indicator — RFC 6464 audioLevel, per decisions.md.
const SPEAKING_POLL_INTERVAL_MS = 200;
const SPEAKING_THRESHOLD = 0.05;
const SPEAKING_DEBOUNCE_TICKS = 2; // consecutive ticks required before flipping state, avoids flicker

// Avatar/server-icon transfer over the 'images' data channel — small control frames as JSON
// text, the file itself as ordered binary chunks (channel is reliable+ordered by default, so a
// sequential meta-then-chunks protocol needs no sequence numbers).
const IMAGE_CHUNK_SIZE = 16 * 1024;
const IMAGE_CHUNK_HIGH_WATER = 1024 * 1024;

interface SpeakingState {
  isSpeaking: boolean;
  consecutive: number;
}

type TrackRole = 'mic' | 'camera' | 'screenVideo' | 'screenAudio';

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
  private localSpeakingState: SpeakingState = { isSpeaking: false, consecutive: 0 };
  private speakingPollHandle: ReturnType<typeof setInterval>;
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
  // Buffers a requestImage() call that arrives before the connection entry itself exists yet —
  // e.g. right after a fresh 'peer-joined' event, before their SDP offer has even arrived.
  // Flushed into the entry's own pendingImageRequests as soon as getOrCreateConnection makes one.
  private pendingImageRequestsByPeer = new Map<string, { kind: ImageCacheKind; ownerId: string; knownHash: string | null }[]>();

  constructor(private opts: MeshManagerOptions) {
    this.speakingPollHandle = setInterval(() => void this.pollSpeaking(), SPEAKING_POLL_INTERVAL_MS);
  }

  addExistingPeer(peerId: string): void {
    const entry = this.getOrCreateConnection(peerId);
    // Only the side that offers creates the data channel — the answering side receives it via
    // pc.ondatachannel (registered in getOrCreateConnection, which runs for both roles). Created
    // before renegotiate() below so it rides along in that very first offer.
    if (!entry.imagesChannel) this.setupImagesChannel(entry, entry.pc.createDataChannel('images'));
    void this.renegotiate(entry);
  }

  async handleOffer(fromPeerId: string, sdp: string): Promise<void> {
    const entry = this.getOrCreateConnection(fromPeerId);
    await entry.pc.setRemoteDescription({ type: 'offer', sdp });
    await this.flushPendingCandidates(entry);
    const answer = await entry.pc.createAnswer();
    await entry.pc.setLocalDescription(answer);
    this.opts.send({ type: 'sdp-answer', targetPeerId: fromPeerId, sdp: answer.sdp ?? '' });
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

  /** Mutes/unmutes what's sent to peers only — capture and the local speaking analyser keep
   * running either way, so a muted user who's still talking can be flagged locally. */
  setMicMuted(muted: boolean): void {
    this.micMuted = muted;
    const sendTrack = muted ? null : this.micTrack;
    for (const entry of this.connections.values()) {
      void entry.senders.mic?.replaceTrack(sendTrack);
    }
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

  /** Accepts the whole local screen-share stream (video + optional system audio). */
  async setLocalScreenTrack(stream: MediaStream | null): Promise<void> {
    const videoTrack = stream?.getVideoTracks()[0] ?? null;
    const audioTrack = stream?.getAudioTracks()[0] ?? null;

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
    for (const peerId of [...this.connections.keys()]) this.removePeer(peerId);
    this.micAnalyserSource?.disconnect();
    this.micAnalyserSource = null;
    this.micAnalyser = null;
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
      imageSendQueue: Promise.resolve()
    };
    this.pendingImageRequestsByPeer.delete(peerId);
    this.connections.set(peerId, entry);

    // Only fires on the answering side — the offering side already has its own channel
    // reference from the createDataChannel() call in addExistingPeer.
    pc.ondatachannel = (event) => {
      if (event.channel.label === 'images' && !entry.imagesChannel) {
        this.setupImagesChannel(entry, event.channel);
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
      entry.senders.screenVideo = entry.pc.addTrack(this.screenVideoTrack, this.screenStream);
    }
    if (this.screenAudioTrack) {
      entry.senders.screenAudio = entry.pc.addTrack(this.screenAudioTrack, this.screenStream);
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

  /** Adds/removes/swaps one local track role on one connection. Returns whether a fresh offer is needed. */
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
      entry.senders[role] = entry.pc.addTrack(track, groupStream);
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

  private async pollSpeaking(): Promise<void> {
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
        this.applySpeakingLevel(state, level, (isSpeaking) => this.opts.onSpeakingChange(entry.peerId, isSpeaking));
      } catch {
        // transient stats failure — skip this tick
      }
    }

    if (!this.micAnalyser) return;
    // Byte time-domain samples, converted to linear RMS 0..1 — same scale as the RFC 6464
    // audioLevel used for peers above, so both share SPEAKING_THRESHOLD.
    const samples = new Uint8Array(this.micAnalyser.fftSize);
    this.micAnalyser.getByteTimeDomainData(samples);
    let sumSquares = 0;
    for (let i = 0; i < samples.length; i++) {
      const normalized = (samples[i] - 128) / 128;
      sumSquares += normalized * normalized;
    }
    const level = Math.sqrt(sumSquares / samples.length);
    this.applySpeakingLevel(this.localSpeakingState, level, (isSpeaking) =>
      this.opts.onLocalSpeakingChange(isSpeaking)
    );
  }

  private applySpeakingLevel(state: SpeakingState, level: number, onChange: (isSpeaking: boolean) => void): void {
    const aboveThreshold = level > SPEAKING_THRESHOLD;
    if (aboveThreshold === state.isSpeaking) {
      state.consecutive = 0;
      return;
    }
    state.consecutive += 1;
    if (state.consecutive >= SPEAKING_DEBOUNCE_TICKS) {
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
