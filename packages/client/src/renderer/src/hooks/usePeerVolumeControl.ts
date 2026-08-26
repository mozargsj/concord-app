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
  userId: string;
  name: string;
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

  function getEffectivePeerSettings(userId: string): PeerVolumeSettings {
    return peerVolumeOverrides[userId] ?? getPeerVolumeSettings(userId);
  }

  /** null userId (the self tile/row — no incoming stream to adjust) → undefined, meaning
   * "leave the media element's volume alone" to whichever caller passes this through. */
  function getEffectiveVolume(userId: string | null): number | undefined {
    if (!userId) return undefined;
    const settings = getEffectivePeerSettings(userId);
    return settings.muted ? 0 : (settings.volume / 100) * (masterVolume / 100);
  }

  function handlePeerVolumeChange(userId: string, volume: number) {
    setPeerVolumeOverrides((prev) => ({ ...prev, [userId]: { ...getEffectivePeerSettings(userId), volume } }));
    setPeerVolume(userId, volume);
  }

  function handleTogglePeerMute(userId: string) {
    const next = !getEffectivePeerSettings(userId).muted;
    setPeerVolumeOverrides((prev) => ({ ...prev, [userId]: { ...getEffectivePeerSettings(userId), muted: next } }));
    setPeerMuted(userId, next);
  }

  function openVolumeMenu(x: number, y: number, userId: string, name: string) {
    setVolumeMenu({ x, y, userId, name });
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
