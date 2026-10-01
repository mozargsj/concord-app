import { screen } from 'electron';
import path from 'node:path';
import { VALID_KEY_IDS } from '../common/keyScan';
import { MOUSE_ABS_MAX } from '../common/hidReports';
import { InputGuard } from '../common/inputPolicy';
import { capsFromNative, type ControllerCaps, type NegotiatedCaps } from '../common/deviceCaps';
import { VirtualHidBackend } from './virtualHidBackend';

// Bridges native/input-control (SendInput + low-level keyboard hook) into the main process. This
// is the MVP "InputInjector" of the remote-control spec (decision 9): the session/authorization
// layer in remoteControl.ts only ever talks to this file, so a Virtual HID backend can replace it
// later without touching transport, authorization, sync or Input Reset. Everything here treats
// unavailability (wrong platform, addon missing or blocked by Smart App Control) as a normal
// signal — isInputAvailable() false simply means the feature can't run on this machine.
interface NativeModule {
  sendKey: (scan: number, extended: boolean, down: boolean) => boolean;
  sendMouseAbs: (x: number, y: number) => boolean;
  sendMouseButton: (button: number, down: boolean) => boolean;
  sendWheel: (delta: number, horizontal: boolean) => boolean;
  startHook: (onKey: (scan: number, extended: boolean, down: boolean, exitRequested: boolean) => void, swallow: boolean) => boolean;
  setSwallow: (swallow: boolean) => void;
  stopHook: () => void;
  getInputCapabilities?: () => {
    mouse: { count: number; buttons: number; horizontalWheel: boolean };
    keyboard: { count: number; keysTotal: number; functionKeys: number; type: number };
  };
}

let native: NativeModule | null | undefined; // undefined = load not yet attempted this run

function loadNative(): NativeModule | null {
  if (native !== undefined) return native;
  if (process.platform !== 'win32') {
    native = null;
    return native;
  }
  try {
    // Same asarUnpack'd relative path trick as processLoopbackAudio.ts (electron-builder.yml).
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binary, not a static import
    native = require(path.join(__dirname, '../../../native/input-control/build/Release/input_control.node'));
  } catch {
    native = null;
  }
  return native ?? null;
}

export function isInputAvailable(): boolean {
  return loadNative() !== null;
}

// ---- functional capabilities of THIS PC's real keyboard/mouse (controller side) ---------------------

/** Coarse, anonymous capability facts (button count, horizontal wheel, keyboard size/kind) — never
 * an identifier. Null when the addon is unavailable or predates this feature. */
export function readLocalCapabilities(): ControllerCaps | null {
  try {
    const raw = loadNative()?.getInputCapabilities?.();
    return raw ? capsFromNative(raw) : null;
  } catch {
    return null;
  }
}

/** Tells the Virtual HID service which capabilities the validated controller hardware has, so it can
 * shape the virtual devices to match (no-op with SendInput, which has nothing to shape). */
export function configureBackend(negotiated: NegotiatedCaps): void {
  virtualHid?.sendConfig(negotiated);
}

// ---- backend selection (SendInput vs Virtual HID service) --------------------------------------

/** Active Virtual HID connection for the current session, null = plain SendInput. */
let virtualHid: VirtualHidBackend | null = null;
let onBackendLost: (() => void) | null = null;

/** Called when the Virtual HID service connection dies mid-session (input would silently stop). */
export function setBackendLostHandler(handler: () => void): void {
  onBackendLost = handler;
}

/** Picks the input backend for a new controlled session: the Virtual HID service when it answers
 * on its pipe (CONCORD_INPUT_BACKEND=sendinput forces the fallback), otherwise SendInput. */
export async function prepareBackend(): Promise<'virtual-hid' | 'sendinput'> {
  releaseBackend();
  guard.reset();
  if (process.env.CONCORD_INPUT_BACKEND === 'sendinput') return 'sendinput';
  const backend = new VirtualHidBackend();
  if (!(await backend.connect())) return 'sendinput';
  backend.onLost = () => {
    if (virtualHid === backend) virtualHid = null;
    onBackendLost?.();
  };
  backend.watch();
  virtualHid = backend;
  return 'virtual-hid';
}

export function releaseBackend(): void {
  virtualHid?.close();
  virtualHid = null;
}

const WHEEL_DELTA = 120;
const DOM_WHEEL_PIXELS_PER_NOTCH = 100;

// ---- injection (controlled PC) ----------------------------------------------------------------

/** Keys/buttons currently held by injected input — exactly what Input Reset has to let go of. */
const pressedKeys = new Set<number>();

/** Per-session counters for diagnostics: how many keys Windows accepted vs refused (SendInput
 * returns false when the target is beyond reach, e.g. an elevated window from a non-elevated Concord). */
export const injectStats = { injected: 0, failed: 0 };
export function resetInjectStats(): void {
  injectStats.injected = 0;
  injectStats.failed = 0;
}
const pressedButtons = new Set<number>();

// Remote input must never complete Ctrl+Alt+Del (spec 20). SendInput can't trigger it anyway, but a
// Virtual HID keyboard is a real device to Windows and would — so it is refused here for every
// backend (and again by the privileged service, README of native/virtual-hid).
const guard = new InputGuard();

export function injectKey(keyId: number, down: boolean): 'ok' | 'fail' | 'guard' {
  if (!VALID_KEY_IDS.has(keyId)) return 'fail';
  if (!guard.allow(keyId, down)) return 'guard';
  const vhid = virtualHid;
  const addon = vhid ? null : loadNative();
  if (!vhid && !addon) return 'fail';
  if (down) pressedKeys.add(keyId);
  else pressedKeys.delete(keyId);
  if (vhid) {
    if (down) vhid.keyboard.press(keyId);
    else vhid.keyboard.release(keyId);
    vhid.sendKeyboard();
    injectStats.injected++;
    return 'ok';
  }
  const accepted = addon!.sendKey(keyId & 0xff, (keyId & 0x100) !== 0, down);
  if (accepted) injectStats.injected++;
  else injectStats.failed++;
  return accepted ? 'ok' : 'fail';
}

export function injectButton(button: number, down: boolean): 'ok' | 'fail' {
  if (!Number.isInteger(button) || button < 0 || button > 4) return 'fail';
  const vhid = virtualHid;
  const addon = vhid ? null : loadNative();
  if (!vhid && !addon) return 'fail';
  if (down) pressedButtons.add(button);
  else pressedButtons.delete(button);
  if (vhid) {
    vhid.mouse.setButton(button, down);
    vhid.sendMouse();
    return 'ok';
  }
  return addon!.sendMouseButton(button, down) ? 'ok' : 'fail';
}

export function injectWheel(dxPixels: number, dyPixels: number): 'ok' | 'fail' {
  const vhid = virtualHid;
  const addon = vhid ? null : loadNative();
  if (!vhid && !addon) return 'fail';
  // DOM deltaY is positive scrolling down, Windows wheel delta is positive scrolling up; deltaX
  // is positive to the right on both.
  const toDelta = (pixels: number) => Math.max(-1200, Math.min(1200, Math.round((pixels / DOM_WHEEL_PIXELS_PER_NOTCH) * WHEEL_DELTA)));
  const vertical = toDelta(-dyPixels);
  const horizontal = toDelta(dxPixels);
  if (vhid) {
    // HID wheel is in notches (+-127), SendInput's in 1/120ths of one.
    if (vertical || horizontal) {
      vhid.mouse.scroll(vertical / WHEEL_DELTA, horizontal / WHEEL_DELTA);
      vhid.sendMouse();
    }
    return 'ok';
  }
  let accepted = true;
  if (vertical) accepted = addon!.sendWheel(vertical, false) && accepted;
  if (horizontal) accepted = addon!.sendWheel(horizontal, true) && accepted;
  return accepted ? 'ok' : 'fail';
}

/** Moves the pointer to (x, y) in 0..1 of the shared display. SendInput's absolute space is the
 * whole virtual desktop (0..65535 over its physical-pixel bounds), so the display's rectangle is
 * converted with dipToScreenRect — correct for any DPI scale or monitor arrangement. */
export function injectMoveNormalized(displayId: string, x: number, y: number): 'ok' | 'fail' {
  const vhid = virtualHid;
  const addon = vhid ? null : loadNative();
  if (!vhid && !addon) return 'fail';
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 'fail';
  const displays = screen.getAllDisplays();
  const target = displays.find((d) => String(d.id) === displayId);
  if (!target) return 'fail';
  const rects = displays.map((d) => screen.dipToScreenRect(null, d.bounds));
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const width = Math.max(...rects.map((r) => r.x + r.width)) - left;
  const height = Math.max(...rects.map((r) => r.y + r.height)) - top;
  const rect = screen.dipToScreenRect(null, target.bounds);
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const px = rect.x + clamp01(x) * (rect.width - 1);
  const py = rect.y + clamp01(y) * (rect.height - 1);
  const absX = ((px - left) * 65535) / Math.max(1, width - 1);
  const absY = ((py - top) * 65535) / Math.max(1, height - 1);
  if (vhid) {
    // The virtual pointer's logical range is 0..32767 (MOUSE_DESCRIPTOR), SendInput's is 0..65535.
    vhid.mouse.moveAbs((absX * MOUSE_ABS_MAX) / 65535, (absY * MOUSE_ABS_MAX) / 65535);
    vhid.sendMouse();
    return 'ok';
  }
  return addon!.sendMouseAbs(Math.round(absX), Math.round(absY)) ? 'ok' : 'fail';
}

/** Lets go of every key/button whose state is not in the given sets (the controller's periodic
 * full-state sync, spec 30). */
export function reconcilePressed(keys: number[], buttons: number[]): void {
  const keepKeys = new Set(keys);
  const keepButtons = new Set(buttons);
  for (const key of [...pressedKeys]) if (!keepKeys.has(key)) injectKey(key, false);
  for (const button of [...pressedButtons]) if (!keepButtons.has(button)) injectButton(button, false);
}

/** Input Reset (spec 12): releases everything this process ever pressed. */
export function resetInjectedInput(): void {
  for (const key of [...pressedKeys]) injectKey(key, false);
  for (const button of [...pressedButtons]) injectButton(button, false);
  virtualHid?.releaseAll(); // neutral reports even for state the builders hold but nothing tracked
  guard.reset();
}

// ---- low-level keyboard hook -------------------------------------------------------------------

export interface HookKeyEvent {
  /** Same wire format as the key frames: scan code, +0x100 when extended. */
  keyId: number;
  down: boolean;
  exitRequested: boolean;
}

/** Starts the hook; `swallow` decides whether keys are also kept from the local PC. Ctrl+Shift+Pause
 * is always reported as `exitRequested` and never swallowed. Returns false when unavailable. */
export function startKeyHook(onKey: (event: HookKeyEvent) => void, swallow: boolean): boolean {
  const addon = loadNative();
  if (!addon) return false;
  return addon.startHook((scan, extended, down, exitRequested) => {
    onKey({ keyId: (scan & 0xff) | (extended ? 0x100 : 0), down, exitRequested });
  }, swallow);
}

export function setKeyHookSwallow(swallow: boolean): void {
  loadNative()?.setSwallow(swallow);
}

export function stopKeyHook(): void {
  loadNative()?.stopHook();
}
