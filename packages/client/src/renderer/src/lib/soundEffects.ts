interface Note {
  freq: number;
  duration: number;
  gap?: number;
}

let audioContext: AudioContext | null = null;
let deafened = false;

/** Suppresses every notification sound while the user has deafened themselves — matches the existing "deafen mutes all incoming audio" semantics. */
export function setDeafened(value: boolean): void {
  deafened = value;
}

function getAudioContext(): AudioContext {
  if (!audioContext) audioContext = new AudioContext();
  return audioContext;
}

/** Short synthesized tones (no audio asset files, no licensing concerns) — a quiet, quick beep sequence per event. */
function playToneRaw(notes: Note[]): void {
  const ctx = getAudioContext();
  let startTime = ctx.currentTime;

  for (const note of notes) {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.frequency.value = note.freq;
    oscillator.type = 'sine';
    gain.gain.setValueAtTime(0.15, startTime);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + note.duration);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(startTime);
    oscillator.stop(startTime + note.duration);
    startTime += note.duration + (note.gap ?? 0.02);
  }
}

function playTone(notes: Note[]): void {
  if (deafened) return;
  playToneRaw(notes);
}

export function playRoomJoin(): void {
  playTone([
    { freq: 440, duration: 0.08 },
    { freq: 660, duration: 0.1 }
  ]);
}

/** Mirrors playRoomJoin — same two notes, descending instead of ascending. */
export function playRoomLeave(): void {
  playTone([
    { freq: 660, duration: 0.08 },
    { freq: 440, duration: 0.1 }
  ]);
}

export function playDeviceSwitch(kind: 'mic' | 'speaker'): void {
  playTone(kind === 'mic' ? [{ freq: 523, duration: 0.09 }] : [{ freq: 392, duration: 0.09 }]);
}

export function playCameraStart(): void {
  playTone([
    { freq: 587, duration: 0.07 },
    { freq: 784, duration: 0.09 }
  ]);
}

/** Mirrors playCameraStart — same two notes, descending instead of ascending. */
export function playCameraStop(): void {
  playTone([
    { freq: 784, duration: 0.07 },
    { freq: 587, duration: 0.09 }
  ]);
}

export function playTransmissionEnter(): void {
  playTone([
    { freq: 660, duration: 0.07 },
    { freq: 880, duration: 0.1 }
  ]);
}

export function playTransmissionExit(): void {
  playTone([
    { freq: 880, duration: 0.07 },
    { freq: 660, duration: 0.07 },
    { freq: 440, duration: 0.09 }
  ]);
}

// Self mute/deafen feedback — uses playToneRaw (not playTone) deliberately: this is
// confirmation of the user's own action, not an ambient notification, so it must play even
// the instant deafen turns on (when the deafened-suppression flag would otherwise swallow it).
export function playMicMuted(): void {
  playToneRaw([
    { freq: 494, duration: 0.08 },
    { freq: 330, duration: 0.1 }
  ]);
}

export function playMicUnmuted(): void {
  playToneRaw([
    { freq: 330, duration: 0.08 },
    { freq: 494, duration: 0.1 }
  ]);
}

export function playDeafenMuted(): void {
  playToneRaw([
    { freq: 587, duration: 0.06 },
    { freq: 440, duration: 0.06 },
    { freq: 294, duration: 0.1 }
  ]);
}

export function playDeafenUnmuted(): void {
  playToneRaw([
    { freq: 294, duration: 0.06 },
    { freq: 440, duration: 0.06 },
    { freq: 587, duration: 0.1 }
  ]);
}
