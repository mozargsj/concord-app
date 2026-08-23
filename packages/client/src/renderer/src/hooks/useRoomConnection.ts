import { useEffect, useRef, useState } from 'react';
import type { ServerToClientMessage } from '@concord/shared';
import { SignalingClient, type SignalingStatus } from '../lib/signalingClient';
import { MeshManager } from '../lib/webrtcMesh';
import { getPreferredDeviceId } from '../lib/devicePreferences';

export interface RoomPeer {
  peerId: string;
  displayName: string;
  personalStream: MediaStream | null;
  screenStream: MediaStream | null;
}

interface RoomConnectionState {
  connectionStatus: SignalingStatus | 'idle';
  selfPeerId: string | null;
  hostPeerId: string | null;
  peers: RoomPeer[];
}

const initialState: RoomConnectionState = {
  connectionStatus: 'idle',
  selfPeerId: null,
  hostPeerId: null,
  peers: []
};

/**
 * Owns the signaling connection + WebRTC mesh for the currently-joined room. Lives in
 * ServerListPage (not RoomView) because RoomSidebar also needs the real peer roster and
 * hostPeerId for the joined room — same "elevated to feed two places at once" pattern
 * already used for isSpeaking/latencyMs.
 */
export function useRoomConnection(roomId: string | null, displayName: string, isMicMuted: boolean) {
  const [state, setState] = useState<RoomConnectionState>(initialState);
  const meshRef = useRef<MeshManager | null>(null);

  useEffect(() => {
    if (!roomId) {
      setState(initialState);
      return;
    }

    let cancelled = false;
    const signaling = new SignalingClient();

    const mesh = new MeshManager({
      send: (message) => signaling.send(message),
      onRemoteStreamsChange: (peerId, streams) => {
        setState((prev) => ({
          ...prev,
          peers: prev.peers.map((peer) =>
            peer.peerId === peerId
              ? { ...peer, personalStream: streams.personal, screenStream: streams.screen }
              : peer
          )
        }));
      }
    });
    meshRef.current = mesh;

    signaling.onStatusChange((status) => {
      setState((prev) => ({ ...prev, connectionStatus: status }));
    });

    signaling.onMessage((message: ServerToClientMessage) => {
      switch (message.type) {
        case 'room-joined':
          setState((prev) => ({
            ...prev,
            selfPeerId: message.peerId,
            hostPeerId: message.hostPeerId,
            peers: message.peers.map((peer) => ({
              peerId: peer.peerId,
              displayName: peer.displayName,
              personalStream: null,
              screenStream: null
            }))
          }));
          for (const peer of message.peers) mesh.addExistingPeer(peer.peerId);
          break;
        case 'peer-joined':
          setState((prev) => ({
            ...prev,
            peers: [
              ...prev.peers,
              {
                peerId: message.peerId,
                displayName: message.displayName,
                personalStream: null,
                screenStream: null
              }
            ]
          }));
          break;
        case 'peer-left':
          mesh.removePeer(message.peerId);
          setState((prev) => ({ ...prev, peers: prev.peers.filter((peer) => peer.peerId !== message.peerId) }));
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
        case 'room-closed':
        case 'join-rejected':
          mesh.closeAll();
          setState((prev) => ({ ...prev, connectionStatus: 'disconnected' }));
          break;
      }
    });

    let localMicStream: MediaStream | null = null;
    const preferredMic = getPreferredDeviceId('audioinput');
    navigator.mediaDevices
      .getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          ...(preferredMic ? { deviceId: { exact: preferredMic } } : {})
        }
      })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        localMicStream = stream;
        const track = stream.getAudioTracks()[0] ?? null;
        if (track) track.enabled = !isMicMuted;
        mesh.setLocalMicTrack(track);
      })
      .catch(() => {
        // No mic available/denied — proceed without local audio (video-only participation).
      });

    signaling.connect(import.meta.env.VITE_SIGNALING_URL, roomId, displayName);

    return () => {
      cancelled = true;
      mesh.closeAll();
      localMicStream?.getTracks().forEach((track) => track.stop());
      signaling.close();
      meshRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only roomId should trigger reconnect
  }, [roomId]);

  useEffect(() => {
    meshRef.current?.setMicEnabled(!isMicMuted);
  }, [isMicMuted]);

  function setLocalCameraTrack(track: MediaStreamTrack | null): void {
    void meshRef.current?.setLocalCameraTrack(track);
  }

  function setLocalScreenTrack(stream: MediaStream | null): void {
    void meshRef.current?.setLocalScreenTrack(stream);
  }

  return {
    connectionStatus: state.connectionStatus,
    selfPeerId: state.selfPeerId,
    hostPeerId: state.hostPeerId,
    peers: state.peers,
    setLocalCameraTrack,
    setLocalScreenTrack
  };
}
