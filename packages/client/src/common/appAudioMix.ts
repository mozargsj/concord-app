// Which processes to capture (WASAPI process loopback, INCLUDE mode) so their sum is "every app's
// audio except the ones the user excluded" — the screen-share system audio when the exclusion list
// isn't empty. Pure logic, no imports, so it runs under plain `node` in its test.
//
// Why INCLUDE and not EXCLUDE: the Windows API takes ONE target PID per capture, so "everything
// except Concord and these N apps" can't be a single EXCLUDE capture. Both modes take the target's
// whole process TREE, hence the two tree rules below.

export interface AudioSessionInfo {
  pid: number;
  /** Executable filename ("Spotify.exe") — stable across runs, unlike the pid. */
  exe: string;
  /** Parent, grandparent, ... (nearest first). */
  ancestors: number[];
}

export function pidsToCapture(sessions: AudioSessionInfo[], excludedExes: string[]): number[] {
  const excluded = new Set(excludedExes.map((exe) => exe.toLowerCase()));
  const isExcluded = (session: AudioSessionInfo) => excluded.has(session.exe.toLowerCase());
  const excludedSessions = sessions.filter(isExcluded);

  // Capturing a process's tree would also capture an excluded app running under it (a game
  // launched by a launcher that also makes sound): skip that ancestor, losing only its own sound.
  const safe = sessions.filter(
    (session) => !isExcluded(session) && !excludedSessions.some((other) => other.ancestors.includes(session.pid))
  );
  // A safe ancestor's capture already carries this one: capturing both would double its audio.
  return safe
    .filter((session) => !safe.some((other) => session.ancestors.includes(other.pid)))
    .map((session) => session.pid);
}
