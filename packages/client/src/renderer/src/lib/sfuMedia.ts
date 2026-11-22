import type {
  ClientToServerMessage,
  SfuPublishMessage,
  SfuRenegotiateMessage,
  SfuResultMessage,
  SfuSubscribeMessage,
  SfuTrackRole,
  SfuUnpublishMessage,
  SfuUnsubscribeMessage
} from '@concord/shared';

// Media through the Cloudflare Realtime SFU (MediaMode 'sfu', decided by the server only). Two
// RTCPeerConnections: `pub` only ever offers (publishing), `sub` only ever answers the SFU's offers
// (subscribing) — so there is never glare. All SDP goes through the signaling socket; the room's
// Durable Object calls the SFU API (messages.ts, "SFU mode"). Any failure on either connection
// rebuilds both with fresh sessions: simpler and more robust than repairing a half-applied state.

type StreamGroup = 'personal' | 'screen' | 'music';
export type RemoteStreams = { personal: MediaStream | null; screen: MediaStream | null; music: MediaStream | null };

// Same grouping the mesh gets from its per-MediaStream msids (webrtcMesh.ts pc.ontrack).
const GROUP_OF: Record<SfuTrackRole, StreamGroup> = {
  mic: 'personal',
  camera: 'personal',
  screenVideo: 'screen',
  screenAudio: 'screen',
  musicAudio: 'music'
};

const REQUEST_TIMEOUT_MS = 15_000;
const ICE_GATHER_WAIT_MS = 1_500;
// Like the mesh's ICE_DISCONNECTED_REPORT_DELAY_MS: Chromium can sit in 'disconnected' forever.
const DISCONNECTED_GRACE_MS = 8_000;
const REBUILD_DELAY_MIN_MS = 2_000;
const REBUILD_DELAY_MAX_MS = 30_000;
const PULL_RETRY_DELAY_MS = 2_000;
const PULL_MAX_RETRIES = 5;
// Ended subscriptions leave inactive m-lines behind; past this the subscriber SDP nears the
// signaling size cap, so the connections are rebuilt clean instead.
const MAX_SUB_TRANSCEIVERS = 60;
// Same ceiling the mesh gives screen-share and music audio (webrtcMesh.ts SCREEN_AUDIO_MAX_BITRATE_BPS).
const SHARED_AUDIO_MAX_BITRATE_BPS = 128_000;

type SfuRequest =
  | Omit<SfuPublishMessage, 'requestId'>
  | Omit<SfuUnpublishMessage, 'requestId'>
  | Omit<SfuSubscribeMessage, 'requestId'>
  | Omit<SfuRenegotiateMessage, 'requestId'>
  | Omit<SfuUnsubscribeMessage, 'requestId'>;

interface Subscription {
  peerId: string;
  trackName: string;
  role: SfuTrackRole;
  track: MediaStreamTrack | null;
}

export interface SfuMediaOptions {
  send: (message: ClientToServerMessage) => void;
  iceServers: RTCIceServer[];
  onRemoteStreamsChange: (peerId: string, streams: RemoteStreams) => void;
  /** Diagnostics only (goes to the same remote log as the mesh's connection errors). */
  onError: (detail: string) => void;
  /** Read when a video track is published (same user toggle the mesh uses for screen share). */
  preferH264: () => boolean;
  screenDegradation: () => RTCDegradationPreference;
}

/** H.264 first in the codec offer — the codec with a real hardware-encoder path on Windows
 * (NVENC/AMF/Quick Sync through Media Foundation). Best-effort: the default order stays otherwise. */
export function preferH264(transceiver: RTCRtpTransceiver): void {
  const codecs = RTCRtpSender.getCapabilities?.('video')?.codecs;
  if (!codecs || !transceiver.setCodecPreferences) return;
  const isH264 = (codec: { mimeType: string }) => codec.mimeType.toLowerCase() === 'video/h264';
  if (!codecs.some(isH264)) return;
  try {
    transceiver.setCodecPreferences([...codecs.filter(isH264), ...codecs.filter((codec) => !isH264(codec))]);
  } catch {
    // invalid for this transceiver's state — keep the default order
  }
}

/** The docs ask for gathered candidates in the SDP; bounded, the SFU also learns us from checks. */
function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(done, ICE_GATHER_WAIT_MS);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const pullKey = (peerId: string, trackName: string) => `${peerId}|${trackName}`;

export class SfuMedia {
  // Bumped on every rebuild/close: queued work from an older generation does nothing when it runs.
  private generation = 0;
  private pub!: RTCPeerConnection;
  private sub!: RTCPeerConnection;
  private pubQueue: Promise<void> = Promise.resolve();
  private subQueue: Promise<void> = Promise.resolve();
  private pubFresh = true;
  private subFresh = true;
  private senders = new Map<SfuTrackRole, RTCRtpTransceiver>();
  // Last track asked for per role — replayed onto the new connections after a rebuild.
  private localTracks = new Map<SfuTrackRole, MediaStreamTrack | null>();
  // What each peer currently publishes (peer-sfu-tracks): peerId → trackName → role.
  private announced = new Map<string, Map<string, SfuTrackRole>>();
  private subscriptions = new Map<string, Subscription>(); // by mid on the subscriber connection
  private pullRetries = new Map<string, number>();
  private remote = new Map<string, RemoteStreams>();
  private pending = new Map<
    string,
    { resolve: (message: SfuResultMessage) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private silence: { ctx: AudioContext; track: MediaStreamTrack } | null = null;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private rebuildDelayMs = REBUILD_DELAY_MIN_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private opts: SfuMediaOptions) {
    this.createConnections();
  }

  // ---- publishing ---------------------------------------------------------------------------

  /** Sets what each given role sends; roles left out are untouched. null stops that track — except
   * the mic, which keeps its publication alive with silence (the SFU drops a track that sends no
   * packets for 30 s, and mute/unmute must not cost every subscriber a renegotiation). */
  setTracks(changes: Partial<Record<SfuTrackRole, MediaStreamTrack | null>>): Promise<void> {
    for (const [role, track] of Object.entries(changes) as [SfuTrackRole, MediaStreamTrack | null][]) {
      this.localTracks.set(role, track ?? null);
    }
    return this.enqueue('pub', () => this.applyPublish(changes));
  }

  /** The screen-share video sender, for the encoder diagnostics (webrtcMesh.ts). */
  screenVideoSender(): RTCRtpSender | null {
    return this.senders.get('screenVideo')?.sender ?? null;
  }

  private async applyPublish(changes: Partial<Record<SfuTrackRole, MediaStreamTrack | null>>): Promise<void> {
    const added: SfuTrackRole[] = [];
    const removed: RTCRtpTransceiver[] = [];
    for (const [role, requested] of Object.entries(changes) as [SfuTrackRole, MediaStreamTrack | null | undefined][]) {
      if (requested === undefined) continue;
      const existing = this.senders.get(role);
      const track = requested ?? (role === 'mic' && existing ? this.silentTrack() : null);
      if (existing && track) {
        await existing.sender.replaceTrack(track);
      } else if (existing) {
        removed.push(existing);
        this.senders.delete(role);
      } else if (track) {
        const transceiver = this.pub.addTransceiver(track, { direction: 'sendonly' });
        if ((role === 'screenVideo' || role === 'camera') && this.opts.preferH264()) preferH264(transceiver);
        this.senders.set(role, transceiver);
        added.push(role);
      }
    }
    if (removed.length > 0) await this.unpublish(removed);
    if (added.length > 0) await this.publish(added);
  }

  private async publish(roles: SfuTrackRole[]): Promise<void> {
    await this.pub.setLocalDescription(await this.pub.createOffer());
    await waitForIceGathering(this.pub);
    const tracks = roles.map((role) => ({ role, mid: this.senders.get(role)?.mid ?? '' }));
    if (tracks.some((t) => !t.mid)) throw new Error('trilha sem mid depois da oferta');
    const result = await this.request({
      type: 'sfu-publish',
      fresh: this.pubFresh,
      sdp: this.pub.localDescription?.sdp ?? '',
      tracks
    });
    if (!result.sdp) throw new Error('sfu-publish sem SDP de resposta');
    await this.pub.setRemoteDescription({ type: 'answer', sdp: result.sdp });
    this.pubFresh = false;
    const failed = result.tracks?.filter((t) => t.error) ?? [];
    if (failed.length > 0) throw new Error(`publicação recusada: ${failed.map((t) => `${t.mid}=${t.error}`).join(', ')}`);
    for (const role of roles) this.applySenderParams(role);
    this.rebuildDelayMs = REBUILD_DELAY_MIN_MS;
  }

  private async unpublish(transceivers: RTCRtpTransceiver[]): Promise<void> {
    const mids = transceivers.map((t) => t.mid).filter((mid): mid is string => mid !== null);
    for (const transceiver of transceivers) transceiver.stop();
    if (mids.length === 0) return; // never negotiated: nothing exists at the SFU
    await this.pub.setLocalDescription(await this.pub.createOffer());
    const result = await this.request({ type: 'sfu-unpublish', sdp: this.pub.localDescription?.sdp ?? '', mids });
    if (!result.sdp) throw new Error('sfu-unpublish sem SDP de resposta');
    await this.pub.setRemoteDescription({ type: 'answer', sdp: result.sdp });
  }

  /** After negotiation, when the encodings exist — same parameters the mesh applies per connection. */
  private applySenderParams(role: SfuTrackRole): void {
    const sender = this.senders.get(role)?.sender;
    if (!sender || (role !== 'screenVideo' && role !== 'screenAudio' && role !== 'musicAudio')) return;
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    if (role === 'screenVideo') params.degradationPreference = this.opts.screenDegradation();
    else params.encodings[0].maxBitrate = SHARED_AUDIO_MAX_BITRATE_BPS;
    void sender.setParameters(params).catch(() => {});
  }

  private silentTrack(): MediaStreamTrack {
    if (!this.silence) {
      const ctx = new AudioContext();
      this.silence = { ctx, track: ctx.createMediaStreamDestination().stream.getAudioTracks()[0] };
    }
    void this.silence.ctx.resume().catch(() => {});
    return this.silence.track;
  }

  // ---- subscribing --------------------------------------------------------------------------

  /** A peer's full current track list (peer-sfu-tracks). */
  handlePeerTracks(peerId: string, tracks: { role: SfuTrackRole; trackName: string }[]): void {
    this.announced.set(peerId, new Map(tracks.map((t) => [t.trackName, t.role])));
    this.syncSoon();
  }

  /** Peer left or rejoined (a rejoin republishes under new sessions and announces again). */
  removePeer(peerId: string): void {
    this.announced.delete(peerId);
    this.syncSoon();
  }

  /** Mirrors MeshManager.forceClearScreenStream/forceClearMusicStream: the explicit "stopped" signal
   * wins even before the track list update arrives. */
  forceClear(peerId: string, group: 'screen' | 'music'): void {
    const streams = this.remote.get(peerId);
    if (!streams?.[group]) return;
    streams[group] = null;
    this.emit(peerId);
  }

  /** Highest audio level per subscribed peer (RFC 6464, same scale the mesh polls). */
  async audioLevels(): Promise<Map<string, number>> {
    const levels = new Map<string, number>();
    for (const s of this.subscriptions.values()) {
      if (s.role !== 'camera' && s.role !== 'screenVideo') levels.set(s.peerId, levels.get(s.peerId) ?? 0);
    }
    if (levels.size === 0) return levels;
    const stats = await this.sub.getStats();
    stats.forEach((report: RTCStats & { kind?: string; audioLevel?: number; mid?: string; trackIdentifier?: string }) => {
      if (report.type !== 'inbound-rtp' || report.kind !== 'audio' || typeof report.audioLevel !== 'number') return;
      const subscription =
        (report.mid ? this.subscriptions.get(report.mid) : undefined) ??
        [...this.subscriptions.values()].find((s) => s.track?.id === report.trackIdentifier);
      if (subscription) levels.set(subscription.peerId, Math.max(levels.get(subscription.peerId) ?? 0, report.audioLevel));
    });
    return levels;
  }

  private syncSoon(): void {
    void this.enqueue('sub', () => this.syncSubscriptions());
  }

  private async syncSubscriptions(): Promise<void> {
    if (this.sub.getTransceivers().length > MAX_SUB_TRANSCEIVERS) throw new Error('assinaturas demais acumuladas');

    const ended = [...this.subscriptions]
      .filter(([, s]) => !this.announced.get(s.peerId)?.has(s.trackName))
      .map(([mid]) => mid);
    for (const mid of ended) this.detach(mid);
    if (ended.length > 0) {
      // Best-effort: a missed close only leaves an idle subscription the SFU reclaims on its own.
      await this.request({ type: 'sfu-unsubscribe', mids: ended }).catch((error) =>
        this.opts.onError(`[sfu-unsubscribe] ${errorText(error)}`)
      );
    }

    const subscribed = new Set([...this.subscriptions.values()].map((s) => pullKey(s.peerId, s.trackName)));
    const wanted: { peerId: string; trackName: string; role: SfuTrackRole }[] = [];
    for (const [peerId, tracks] of this.announced) {
      for (const [trackName, role] of tracks) {
        if (!subscribed.has(pullKey(peerId, trackName))) wanted.push({ peerId, trackName, role });
      }
    }
    if (wanted.length === 0) return;

    const result = await this.request({
      type: 'sfu-subscribe',
      fresh: this.subFresh,
      tracks: wanted.map(({ peerId, trackName }) => ({ peerId, trackName }))
    });
    this.subFresh = false;
    let retry = false;
    for (const w of wanted) {
      const key = pullKey(w.peerId, w.trackName);
      const pulled = result.tracks?.find((t) => t.peerId === w.peerId && t.trackName === w.trackName);
      if (pulled?.mid && !pulled.error) {
        // Registered before setRemoteDescription, which is what fires ontrack.
        this.subscriptions.set(pulled.mid, { ...w, track: null });
        this.pullRetries.delete(key);
        continue;
      }
      // Usually a race (the publisher's track not ready yet at the SFU) — retried a few times.
      const attempts = (this.pullRetries.get(key) ?? 0) + 1;
      this.pullRetries.set(key, attempts);
      if (attempts < PULL_MAX_RETRIES) retry = true;
      else this.opts.onError(`[sfu-subscribe] desistiu de ${w.role} de ${w.peerId}: ${pulled?.error ?? 'sem resposta'}`);
    }

    if (result.sdp) {
      await this.sub.setRemoteDescription({ type: 'offer', sdp: result.sdp });
      await this.sub.setLocalDescription(await this.sub.createAnswer());
      await waitForIceGathering(this.sub);
      await this.request({ type: 'sfu-renegotiate', sdp: this.sub.localDescription?.sdp ?? '' });
      this.rebuildDelayMs = REBUILD_DELAY_MIN_MS;
    }
    if (retry && !this.retryTimer) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.syncSoon();
      }, PULL_RETRY_DELAY_MS);
    }
  }

  private attachRemoteTrack(event: RTCTrackEvent): void {
    const mid = event.transceiver.mid;
    const subscription = mid ? this.subscriptions.get(mid) : undefined;
    if (!subscription) return;
    subscription.track = event.track;
    const streams = this.streamsOf(subscription.peerId);
    const group = GROUP_OF[subscription.role];
    // A new MediaStream on every change, never a mutated one: MediaStreamVideo builds its volume
    // graph once per stream object, so audio added to a video-only stream would stay silent (a
    // camera published before the mic, a mic pull that needed a retry).
    streams[group] = new MediaStream([...(streams[group]?.getTracks() ?? []), event.track]);
    this.emit(subscription.peerId);
  }

  private detach(mid: string): void {
    const subscription = this.subscriptions.get(mid);
    if (!subscription) return;
    this.subscriptions.delete(mid);
    const streams = this.remote.get(subscription.peerId);
    const group = GROUP_OF[subscription.role];
    const stream = streams?.[group];
    if (streams && stream && subscription.track) {
      const remaining = stream.getTracks().filter((track) => track !== subscription.track);
      streams[group] = remaining.length > 0 ? new MediaStream(remaining) : null; // see attachRemoteTrack
    }
    this.emit(subscription.peerId);
  }

  private streamsOf(peerId: string): RemoteStreams {
    let streams = this.remote.get(peerId);
    if (!streams) {
      streams = { personal: null, screen: null, music: null };
      this.remote.set(peerId, streams);
    }
    return streams;
  }

  private emit(peerId: string): void {
    const streams = this.remote.get(peerId) ?? { personal: null, screen: null, music: null };
    if (!streams.personal && !streams.screen && !streams.music) this.remote.delete(peerId);
    this.opts.onRemoteStreamsChange(peerId, { ...streams });
  }

  // ---- signaling round-trips ----------------------------------------------------------------

  handleResult(message: SfuResultMessage): void {
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message);
    else pending.reject(new Error(message.error ?? 'erro desconhecido'));
  }

  private request(message: SfuRequest): Promise<SfuResultMessage> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${message.type}: sem resposta em ${REQUEST_TIMEOUT_MS / 1000} s`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      this.opts.send({ ...message, requestId } as ClientToServerMessage);
    });
  }

  // ---- lifecycle ----------------------------------------------------------------------------

  /** Serializes all work per connection (the SFU API requires one mutation at a time per session). */
  private enqueue(side: 'pub' | 'sub', op: () => Promise<void>): Promise<void> {
    const generation = this.generation;
    const run = async () => {
      if (generation !== this.generation || this.closed) return;
      try {
        await op();
      } catch (error) {
        if (generation !== this.generation || this.closed) return; // work of a torn-down connection
        this.opts.onError(`[${side}] ${errorText(error)}`);
        this.scheduleRebuild();
      }
    };
    if (side === 'pub') return (this.pubQueue = this.pubQueue.then(run));
    return (this.subQueue = this.subQueue.then(run));
  }

  private createConnections(): void {
    const config: RTCConfiguration = { iceServers: this.opts.iceServers, bundlePolicy: 'max-bundle' };
    this.pub = new RTCPeerConnection(config);
    this.sub = new RTCPeerConnection(config);
    for (const [label, pc] of [
      ['pub', this.pub],
      ['sub', this.sub]
    ] as const) {
      let disconnectedTimer: ReturnType<typeof setTimeout> | null = null;
      pc.onconnectionstatechange = () => {
        if (disconnectedTimer) clearTimeout(disconnectedTimer);
        disconnectedTimer = null;
        if (pc.connectionState === 'failed') {
          this.opts.onError(`[${label}] connectionState=failed`);
          this.scheduleRebuild();
        } else if (pc.connectionState === 'disconnected') {
          disconnectedTimer = setTimeout(() => {
            if (pc.connectionState !== 'disconnected') return;
            this.opts.onError(`[${label}] preso em disconnected por ${DISCONNECTED_GRACE_MS / 1000} s`);
            this.scheduleRebuild();
          }, DISCONNECTED_GRACE_MS);
        }
      };
    }
    this.sub.ontrack = (event) => this.attachRemoteTrack(event);
  }

  private scheduleRebuild(): void {
    if (this.closed || this.rebuildTimer) return;
    const delay = this.rebuildDelayMs;
    this.rebuildDelayMs = Math.min(this.rebuildDelayMs * 2, REBUILD_DELAY_MAX_MS);
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.rebuild();
    }, delay);
  }

  /** New connections and new SFU sessions (`fresh`), then everything republished and resubscribed.
   * The server replaces this peer's track list on the fresh publish, so subscribers re-pull. */
  private rebuild(): void {
    if (this.closed) return;
    this.generation += 1;
    this.teardown();
    this.pubFresh = true;
    this.subFresh = true;
    this.pubQueue = Promise.resolve();
    this.subQueue = Promise.resolve();
    this.createConnections();
    this.opts.onError('[rebuild] conexões com o SFU recriadas');
    void this.enqueue('pub', () => this.applyPublish(Object.fromEntries(this.localTracks)));
    this.syncSoon();
  }

  private teardown(): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('conexão com o SFU encerrada'));
    }
    this.pending.clear();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.pullRetries.clear();
    for (const mid of [...this.subscriptions.keys()]) this.detach(mid);
    this.senders.clear();
    this.pub.close();
    this.sub.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = null;
    this.teardown();
    void this.silence?.ctx.close().catch(() => {});
    this.silence = null;
  }
}
