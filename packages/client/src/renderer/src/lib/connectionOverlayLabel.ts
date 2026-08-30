/** Shared by RoomSidebar.tsx and RoomView.tsx — same "Conectando"/"Reconectando" overlay logic
 * for a peer's name in both places (see decisions.md). Pulled into a function with an explicit
 * return type so the string literals survive: inlined directly as a ternary inside a
 * `.flatMap()` return (RoomSidebar.tsx's peer rows), TypeScript widens 'Conectando'/'Reconectando'
 * to plain `string` for lack of a contextual type at that depth, which then fails to match the
 * sibling rows built directly in the outer, already-annotated array literal (still narrow there).
 */
export function getConnectionOverlayLabel(
  connectionStatus: 'connecting' | 'connected' | 'failed',
  hasConnectedOnce: boolean
): 'Conectando' | 'Reconectando' | null {
  if (connectionStatus !== 'connecting') return null;
  return hasConnectedOnce ? 'Reconectando' : 'Conectando';
}
