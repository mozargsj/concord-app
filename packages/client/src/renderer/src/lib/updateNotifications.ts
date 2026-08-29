// Server-pushed "a new version exists" while the app is already open — separate from the
// electron-updater check that already runs once at boot (main/autoUpdate.ts). This never
// auto-installs anything on its own: it only tells the caller a version string arrived, so
// TitleBar.tsx can show an icon the user has to click to actually authorize the update (decisions
// .md — explicitly not automatic while the app is in use, unlike the boot-time check).
//
// No auto-reconnect, same philosophy as signalingClient.ts (kept simple for the alpha phase) — if
// this connection drops or never connects at all (e.g. a local/test signaling server that doesn't
// have this route), the user just doesn't get a live notification until the app is reopened; the
// boot-time check still covers them either way.
export function subscribeToUpdateNotifications(onUpdateAvailable: (version: string) => void): () => void {
  const base = import.meta.env.VITE_SIGNALING_URL;
  if (!base) return () => {};

  const ws = new WebSocket(`${base}/updates-ws`);

  ws.onmessage = (event) => {
    let message: unknown;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (
      message &&
      typeof message === 'object' &&
      (message as { type?: unknown }).type === 'update-available' &&
      typeof (message as { version?: unknown }).version === 'string'
    ) {
      onUpdateAvailable((message as { version: string }).version);
    }
  };

  return () => ws.close();
}
