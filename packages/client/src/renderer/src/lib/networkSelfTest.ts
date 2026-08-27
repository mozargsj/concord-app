import { ICE_SERVERS } from './webrtcMesh';

// Same idea as concord.undersoft.tec.br/teste-conexao.html — gathers ICE candidates against the
// exact same STUN server the real mesh uses, but from *inside* Concord's own Electron/Chromium
// runtime instead of a regular browser tab. Built to answer one specific question during the
// 2026-08-27 connectivity investigation: a real tester's browser found a srflx candidate fine on
// the same network, at the same moment, with firewall/Defender/VPN all ruled out — yet the actual
// Concord app still failed to connect. Running the identical gathering logic from within the app
// itself is the only way left to tell apart "something about this app's runtime" from "something
// about this network", since every other variable has already been controlled for.
const GATHER_TIMEOUT_MS = 10000;

export interface NetworkSelfTestCandidate {
  type: string;
  protocol: string;
  address: string;
}

export interface NetworkSelfTestResult {
  candidates: NetworkSelfTestCandidate[];
  hasReflexiveOrRelay: boolean;
  errorTexts: string[];
}

function parseCandidate(candidateString: string): NetworkSelfTestCandidate {
  const parts = candidateString.split(' ');
  const typeIndex = parts.indexOf('typ');
  return {
    type: typeIndex !== -1 ? parts[typeIndex + 1] : '?',
    protocol: parts[2] || '?',
    address: parts[4] || '?'
  };
}

export function runNetworkSelfTest(): Promise<NetworkSelfTestResult> {
  return new Promise((resolve) => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const candidates: NetworkSelfTestCandidate[] = [];
    const errorTexts: string[] = [];
    let settled = false;

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      pc.close();
      resolve({
        candidates,
        hasReflexiveOrRelay: candidates.some((c) => c.type === 'srflx' || c.type === 'relay'),
        errorTexts
      });
    }

    pc.onicecandidate = (event) => {
      if (!event.candidate) {
        finish();
        return;
      }
      candidates.push(parseCandidate(event.candidate.candidate));
    };

    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };

    pc.onicecandidateerror = (event) => {
      const iceError = event as RTCPeerConnectionIceErrorEvent;
      if (iceError.errorText) errorTexts.push(iceError.errorText);
    };

    // Same reason as teste-conexao.js — nothing to negotiate, nothing to gather, without at
    // least one data channel/track on the connection.
    pc.createDataChannel('network-self-test');

    const timeoutHandle = setTimeout(finish, GATHER_TIMEOUT_MS);

    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch(finish);
  });
}
