// KeyboardEvent.code -> hardware scan code (set 1), +0x100 for extended (E0) keys. The controlled
// PC injects by scan code, so its own layout decides what each physical key types. Used by the
// renderer's keyboard fallback when the native low-level hook isn't available; the hook itself
// reports scan codes directly. Pause is absent on purpose (E1 sequence, and it is the exit key).
const EXT = 0x100;

export const CODE_TO_KEY: Record<string, number> = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06, Digit6: 0x07,
  Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b, Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e,
  Tab: 0x0f, KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15, KeyU: 0x16,
  KeyI: 0x17, KeyO: 0x18, KeyP: 0x19, BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c,
  ControlLeft: 0x1d, KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23,
  KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27, Quote: 0x28, Backquote: 0x29,
  ShiftLeft: 0x2a, Backslash: 0x2b, KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30,
  KeyN: 0x31, KeyM: 0x32, Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36,
  NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39, CapsLock: 0x3a, F1: 0x3b, F2: 0x3c, F3: 0x3d,
  F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44, NumLock: 0x45,
  ScrollLock: 0x46, Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a,
  Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, NumpadAdd: 0x4e, Numpad1: 0x4f, Numpad2: 0x50,
  Numpad3: 0x51, Numpad0: 0x52, NumpadDecimal: 0x53, IntlBackslash: 0x56, F11: 0x57, F12: 0x58,
  NumpadEnter: 0x1c | EXT, ControlRight: 0x1d | EXT, NumpadDivide: 0x35 | EXT, PrintScreen: 0x37 | EXT,
  AltRight: 0x38 | EXT, Home: 0x47 | EXT, ArrowUp: 0x48 | EXT, PageUp: 0x49 | EXT,
  ArrowLeft: 0x4b | EXT, ArrowRight: 0x4d | EXT, End: 0x4f | EXT, ArrowDown: 0x50 | EXT,
  PageDown: 0x51 | EXT, Insert: 0x52 | EXT, Delete: 0x53 | EXT, MetaLeft: 0x5b | EXT,
  MetaRight: 0x5c | EXT, ContextMenu: 0x5d | EXT
};

/** Every valid key id the controlled side accepts — anything else on the wire is dropped. */
export const VALID_KEY_IDS = new Set(Object.values(CODE_TO_KEY));

/** DOM MouseEvent.button (0 left, 1 middle, 2 right, 3 back, 4 forward) -> wire button id. */
export const DOM_BUTTON_TO_WIRE = [0, 2, 1, 3, 4] as const; // wire: 0 left, 1 right, 2 middle, 3 x1, 4 x2
