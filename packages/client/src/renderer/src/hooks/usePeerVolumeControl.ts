import { useEffect, useState } from 'react';
import { getMasterVolume, onMasterVolumeChange } from '../lib/masterVolume';
import {
  type PeerVolumeSettings,
  getPeerVolumeSettings,
  setPeerMuted,
  setPeerVolume
} from '../lib/peerVolumePreferences';

export interface VolumeMenuState {
  x: number;
  y: number;
  peerId: string;
  userId: string;
  name: string;
  /** [2026-08-30, pedido do Mozar] Normalmente === userId — só difere pra um alvo "extra" do
   * mesmo peer que precisa de volume/mudo independentes da voz dele, hoje só "Music <nome>"
   * (compartilhar áudio, RoomSidebar.tsx passa `${userId}:music`). Tudo que só lê/grava
   * preferência local (getEffectivePeerSettings/handlePeerVolumeChange/handleTogglePeerMute) usa
   * este campo; userId/peerId continuam sendo a pessoa de verdade, pra "Ver perfil" e pro aviso
   * de "fulano te mutou" (sendMuteStatus, ServerListPage.tsx) nunca dispararem pra um mudo que só
   * era sobre a música dela, não a voz. */
  volumeKey: string;
}

/**
 * Shared by RoomView and RoomSidebar (siblings under ServerListPage) so muting/adjusting someone
 * from either place stays in sync live, not just after a remount — each held its own copy of this
 * state before, which only agreed via localStorage on next mount, not during the same session.
 */
export function usePeerVolumeControl() {
  const [peerVolumeOverrides, setPeerVolumeOverrides] = useState<Record<string, PeerVolumeSettings>>({});
  const [masterVolume, setMasterVolumeState] = useState(getMasterVolume());
  const [volumeMenu, setVolumeMenu] = useState<VolumeMenuState | null>(null);

  useEffect(() => onMasterVolumeChange(setMasterVolumeState), []);

  function getEffectivePeerSettings(volumeKey: string): PeerVolumeSettings {
    return peerVolumeOverrides[volumeKey] ?? getPeerVolumeSettings(volumeKey);
  }

  /** null volumeKey (the self tile/row — no incoming stream to adjust) → undefined, meaning
   * "leave the media element's volume alone" to whichever caller passes this through. */
  function getEffectiveVolume(volumeKey: string | null): number | undefined {
    if (!volumeKey) return undefined;
    const settings = getEffectivePeerSettings(volumeKey);
    return settings.muted ? 0 : (settings.volume / 100) * (masterVolume / 100);
  }

  function handlePeerVolumeChange(volumeKey: string, volume: number) {
    setPeerVolumeOverrides((prev) => ({
      ...prev,
      [volumeKey]: { ...getEffectivePeerSettings(volumeKey), volume }
    }));
    setPeerVolume(volumeKey, volume);
  }

  /** Returns the new muted value — the caller (ServerListPage.tsx) needs it to tell the peer
   * about the change via signaling (sendMuteStatus) when volumeKey === userId (a real "you muted
   * this person's voice" — never sent for a compound volumeKey like the music one, muting
   * someone's shared music isn't "you muted them"), which this hook has no access to itself. */
  function handleTogglePeerMute(volumeKey: string): boolean {
    const next = !getEffectivePeerSettings(volumeKey).muted;
    setPeerVolumeOverrides((prev) => ({
      ...prev,
      [volumeKey]: { ...getEffectivePeerSettings(volumeKey), muted: next }
    }));
    setPeerMuted(volumeKey, next);
    return next;
  }

  function openVolumeMenu(
    x: number,
    y: number,
    peerId: string,
    userId: string,
    name: string,
    volumeKey: string = userId
  ) {
    setVolumeMenu({ x, y, peerId, userId, name, volumeKey });
  }

  function closeVolumeMenu() {
    setVolumeMenu(null);
  }

  return {
    getEffectivePeerSettings,
    getEffectiveVolume,
    handlePeerVolumeChange,
    handleTogglePeerMute,
    volumeMenu,
    openVolumeMenu,
    closeVolumeMenu
  };
}
