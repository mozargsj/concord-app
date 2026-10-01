// Input policy of the controlled PC (spec section 20): remote input must never be able to trigger
// the Secure Attention Sequence (Ctrl+Alt+Del). Windows itself blocks it for injected input
// (SendInput), but a Virtual HID keyboard is a real device to the input stack and WOULD trigger it —
// so Concord has to refuse that combination itself, in every backend. No imports; runs under `node`.

const CTRL = [0x1d, 0x11d]; // left / right Ctrl (key ids, see keyScan.ts)
const ALT = [0x38, 0x138]; // left / right Alt
const DELETE = [0x153, 0x53]; // Delete and numpad Delete (also the SAS key with NumLock off)

const anyHeld = (held: Set<number>, ids: number[]) => ids.some((id) => held.has(id));

/** Tracks what is held and rejects any key event that would complete Ctrl+Alt+Del, in whatever
 * order the three keys arrive. A rejected key-down also swallows its matching key-up, so nothing is
 * ever released that was never pressed. */
export class InputGuard {
  private held = new Set<number>();
  private blocked = new Set<number>();

  /** True = inject this event; false = drop it. */
  allow(keyId: number, down: boolean): boolean {
    if (!down) {
      this.held.delete(keyId);
      return !this.blocked.delete(keyId);
    }
    const next = new Set(this.held).add(keyId);
    const completesSas = anyHeld(next, CTRL) && anyHeld(next, ALT) && anyHeld(next, DELETE);
    if (completesSas && [...CTRL, ...ALT, ...DELETE].includes(keyId)) {
      this.blocked.add(keyId);
      return false;
    }
    this.held.add(keyId);
    return true;
  }

  /** Input Reset / new session: forget everything. */
  reset(): void {
    this.held.clear();
    this.blocked.clear();
  }
}
