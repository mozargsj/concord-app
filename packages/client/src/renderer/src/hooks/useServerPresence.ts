import { useEffect, useRef, useState } from 'react';
import type { PresencePeer, PresenceServerMessage, PresenceSubscribeMessage } from '@concord/shared';
import { getSessionToken } from '../lib/api';
import { loadCachedAvatarForPresence } from '../lib/imageCache';

// The socket drops on every Worker deploy and on network blips. Unlike the update channel, a stale
// roster is visibly wrong, so this one reconnects on its own.
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
// The server closes with 1008 when this user is not a member: retrying would not change that.
const CLOSE_NOT_MEMBER = 1008;

export interface ServerPresenceState {
  /** roomId → who is in that room right now (no key = empty room). */
  rooms: Record<string, PresencePeer[]>;
  /** userId → avatar already cached on this machine (avatars are P2P-only, so not everyone has one). */
  avatars: Record<string, string>;
}

/** Who is in each room of the open server, including rooms this user is not in (pedido do Mozar,
 * 2026-11-22). Backed by the server's ServerPresence Durable Object (signaling-worker/src/presence.ts). */
export function useServerPresence(serverId: string | null): ServerPresenceState {
  const [rooms, setRooms] = useState<Record<string, PresencePeer[]>>({});
  const [avatars, setAvatars] = useState<Record<string, string>>({});
  const requestedAvatars = useRef(new Set<string>());

  useEffect(() => {
    setRooms({});
    const base = import.meta.env.VITE_SIGNALING_URL;
    if (!serverId || !base) return;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let stopped = false;

    const open = () => {
      const url = new URL(`${base}/presence-ws`);
      url.searchParams.set('serverId', serverId);
      const ws = new WebSocket(url.toString());
      socket = ws;
      ws.onopen = () => {
        attempt = 0;
        const subscribe: PresenceSubscribeMessage = { type: 'presence-subscribe', sessionToken: getSessionToken() ?? '' };
        ws.send(JSON.stringify(subscribe));
      };
      ws.onmessage = (event) => {
        let message: PresenceServerMessage;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === 'presence-snapshot') {
          setRooms(message.rooms ?? {});
        } else if (message.type === 'presence-room') {
          setRooms((prev) => {
            const next = { ...prev };
            if (message.peers.length > 0) next[message.roomId] = message.peers;
            else delete next[message.roomId];
            return next;
          });
        }
      };
      ws.onclose = (event) => {
        if (stopped || socket !== ws || event.code === CLOSE_NOT_MEMBER) return;
        retryTimer = setTimeout(open, RECONNECT_DELAYS_MS[Math.min(attempt++, RECONNECT_DELAYS_MS.length - 1)]);
      };
    };
    open();
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    };
  }, [serverId]);

  // Each person's cached picture is read once per app run; no picture keeps the initial letter.
  useEffect(() => {
    for (const { userId } of Object.values(rooms).flat()) {
      if (requestedAvatars.current.has(userId)) continue;
      requestedAvatars.current.add(userId);
      void loadCachedAvatarForPresence(userId).then((url) => {
        if (url) setAvatars((prev) => ({ ...prev, [userId]: url }));
      });
    }
  }, [rooms]);

  return { rooms, avatars };
}
