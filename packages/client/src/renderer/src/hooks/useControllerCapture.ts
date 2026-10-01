import { useEffect, useRef, type RefObject } from 'react';
import { CODE_TO_KEY, DOM_BUTTON_TO_WIRE } from '../../../common/keyScan';
import type { RemoteControlApi } from './useRemoteControl';

/**
 * Captures the local mouse (always) and keyboard (only as a fallback) over the shared-screen
 * <video> while this user controls that screen, and feeds them to useRemoteControl's controller
 * API. `active` = controlling this peer AND the tile is the focused, live view.
 *
 * Mouse: position is normalized against the VIDEO CONTENT rectangle (the <video> letterboxes with
 * object-fit: contain), so 0..1 lands on the same spot of the shared display no matter its
 * resolution, DPI or aspect ratio. Keyboard: when the native low-level hook runs (session.keyHook)
 * the main process swallows and reports keys itself (Win, Alt+Tab... included), so the DOM
 * listeners below are only installed in the degraded no-hook case.
 */
export function useControllerCapture(
  videoRef: RefObject<HTMLVideoElement>,
  rc: RemoteControlApi | null,
  active: boolean,
  hasKeyHook: boolean
): void {
  const rcRef = useRef(rc);
  rcRef.current = rc;

  // Tells main whether the shared-screen view owns the keyboard (decides if the hook swallows keys).
  useEffect(() => {
    rcRef.current?.setCapture(active);
    return () => rcRef.current?.setCapture(false);
  }, [active]);

  useEffect(() => {
    const video = videoRef.current;
    if (!active || !video || !rcRef.current) return;
    const controller = () => rcRef.current!.controller; // active implies a live rc

    function normalize(event: MouseEvent): { x: number; y: number } | null {
      const el = videoRef.current;
      if (!el || !el.videoWidth || !el.videoHeight) return null;
      const box = el.getBoundingClientRect();
      const scale = Math.min(box.width / el.videoWidth, box.height / el.videoHeight);
      const contentWidth = el.videoWidth * scale;
      const contentHeight = el.videoHeight * scale;
      const left = box.left + (box.width - contentWidth) / 2;
      const top = box.top + (box.height - contentHeight) / 2;
      const clamp = (v: number) => Math.max(0, Math.min(1, v));
      return { x: clamp((event.clientX - left) / contentWidth), y: clamp((event.clientY - top) / contentHeight) };
    }

    // At most one move per animation frame — the unordered channel doesn't need every pixel.
    let frame = 0;
    let latest: { x: number; y: number } | null = null;
    function sendLatestMove() {
      frame = 0;
      if (latest) controller().sendMove(latest.x, latest.y);
    }
    function queueMove(event: MouseEvent) {
      latest = normalize(event);
      if (latest && !frame) frame = requestAnimationFrame(sendLatestMove);
    }

    function onMouseDown(event: MouseEvent) {
      event.preventDefault();
      const wire = DOM_BUTTON_TO_WIRE[event.button];
      if (wire === undefined) return;
      const position = normalize(event);
      if (position) controller().sendMove(position.x, position.y); // land exactly where the click is
      controller().sendButton(wire, true);
    }
    function onMouseUp(event: MouseEvent) {
      const wire = DOM_BUTTON_TO_WIRE[event.button];
      if (wire !== undefined) controller().sendButton(wire, false);
    }
    function onWheel(event: WheelEvent) {
      event.preventDefault();
      controller().sendWheel(event.deltaX, event.deltaY);
    }
    const blockContextMenu = (event: Event) => event.preventDefault();

    function onKey(down: boolean) {
      return (event: KeyboardEvent) => {
        // Ctrl+Shift+Pause is the exit; the DOM reports Ctrl+Pause as code "Pause" (or "Break").
        if (down && event.ctrlKey && event.shiftKey && (event.code === 'Pause' || event.key === 'Cancel')) {
          event.preventDefault();
          rcRef.current?.stopControl();
          return;
        }
        const keyId = CODE_TO_KEY[event.code];
        if (keyId === undefined) return;
        event.preventDefault();
        event.stopPropagation(); // RoomView's own Esc handler must not unfocus the tile mid-control
        if (down && event.repeat) return; // the remote PC generates its own auto-repeat
        controller().sendKey(keyId, down);
      };
    }
    const keyDown = onKey(true);
    const keyUp = onKey(false);

    function releaseAll() {
      controller().releaseAll();
    }

    video.addEventListener('mousemove', queueMove);
    video.addEventListener('mousedown', onMouseDown);
    video.addEventListener('wheel', onWheel, { passive: false });
    video.addEventListener('contextmenu', blockContextMenu);
    // Release outside the video still has to reach the remote PC, or a button would stay down.
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('blur', releaseAll);
    if (!hasKeyHook) {
      window.addEventListener('keydown', keyDown, true);
      window.addEventListener('keyup', keyUp, true);
    }
    return () => {
      if (frame) cancelAnimationFrame(frame);
      video.removeEventListener('mousemove', queueMove);
      video.removeEventListener('mousedown', onMouseDown);
      video.removeEventListener('wheel', onWheel);
      video.removeEventListener('contextmenu', blockContextMenu);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('blur', releaseAll);
      window.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('keyup', keyUp, true);
      releaseAll(); // focus left this view: nothing may stay pressed on the other PC
    };
  }, [active, hasKeyHook, videoRef]);
}
