import type { ClientToServerMessage } from '@concord/shared';

// STUN only, no TURN — explicit project decision (decisions.md §1), revisited only
// with real ICE-failure data from the alpha phase.
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

type TrackRole = 'mic' | 'camera' | 'screenVideo' | 'screenAudio';

interface PeerConnectionEntry {
  peerId: string;
  pc: RTCPeerConnection;
  pendingCandidates: RTCIceCandidateInit[];
  personalStreamId: string | null;
  screenStreamId: string | null;
  personalStream: MediaStream | null;
  screenStream: MediaStream | null;
  senders: Partial<Record<TrackRole, RTCRtpSender>>;
}

interface MeshManagerOptions {
  send: (message: ClientToServerMessage) => void;
  onRemoteStreamsChange: (
    peerId: string,
    streams: { personal: MediaStream | null; screen: MediaStream | null }
  ) => void;
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

  constructor(private opts: MeshManagerOptions) {}

  addExistingPeer(peerId: string): void {
    const entry = this.getOrCreateConnection(peerId);
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
    this.opts.onRemoteStreamsChange(peerId, { personal: null, screen: null });
  }

  setLocalMicTrack(track: MediaStreamTrack | null): void {
    if (this.micTrack) this.personalStream.removeTrack(this.micTrack);
    this.micTrack = track;
    if (track) this.personalStream.addTrack(track);
    for (const entry of this.connections.values()) {
      if (this.applyTrack(entry, 'mic', track, this.personalStream)) void this.renegotiate(entry);
    }
  }

  setMicEnabled(enabled: boolean): void {
    if (this.micTrack) this.micTrack.enabled = enabled;
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
    for (const peerId of [...this.connections.keys()]) this.removePeer(peerId);
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
      senders: {}
    };
    this.connections.set(peerId, entry);

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
    if (this.micTrack) entry.senders.mic = entry.pc.addTrack(this.micTrack, this.personalStream);
    if (this.cameraTrack) entry.senders.camera = entry.pc.addTrack(this.cameraTrack, this.personalStream);
    if (this.screenVideoTrack) {
      entry.senders.screenVideo = entry.pc.addTrack(this.screenVideoTrack, this.screenStream);
    }
    if (this.screenAudioTrack) {
      entry.senders.screenAudio = entry.pc.addTrack(this.screenAudioTrack, this.screenStream);
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

  private emitRemoteStreams(peerId: string): void {
    const entry = this.connections.get(peerId);
    if (!entry) return;
    this.opts.onRemoteStreamsChange(peerId, {
      personal: entry.personalStream,
      screen: entry.screenStream
    });
  }
}
