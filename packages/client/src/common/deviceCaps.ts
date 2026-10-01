// Functional capabilities of the CONTROLLER's real keyboard/mouse, and what the controlled PC's
// virtual devices can reproduce (spec section 7). Only coarse, anonymous facts travel — counts and
// flags. No VID/PID, device name, manufacturer or serial is ever read, sent or stored: the virtual
// device keeps Concord's own identity, and capabilities are for fidelity and validation, never for
// imitating particular hardware. No imports, so it runs under plain `node`.

export interface ControllerCaps {
  mouse: { present: boolean; buttons: number; horizontalWheel: boolean };
  keyboard: {
    present: boolean;
    keysTotal: number;
    functionKeys: number;
    /** Raw Input keyboard type: 4 (enhanced 101/102) and 81 (what modern HID keyboards report) = enhanced, 7 Japanese, 8 Korean, anything else = other. */
    kind: 'enhanced' | 'japanese' | 'korean' | 'other';
  };
}

/** What the virtual devices expose (descriptors in hidReports.ts). */
export const VIRTUAL_SUPPORT = { maxButtons: 5, maxFunctionKeys: 12 } as const;

/** Result of validating the controller's hardware against the virtual devices. */
export interface NegotiatedCaps {
  /** Mouse buttons forwarded (1..VIRTUAL_SUPPORT.maxButtons): higher wire ids are dropped. */
  buttons: number;
  horizontalWheel: boolean;
  /** Human-readable limits the user should know about; empty = the virtual devices cover everything. */
  warnings: string[];
}

const clampInt = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;

/** Builds the wire/UI shape from the raw numbers the native addon returns. */
export function capsFromNative(raw: {
  mouse: { count: number; buttons: number; horizontalWheel: boolean };
  keyboard: { count: number; keysTotal: number; functionKeys: number; type: number };
}): ControllerCaps {
  return {
    mouse: {
      present: raw.mouse.count > 0,
      buttons: clampInt(raw.mouse.buttons, 0, 32, 0),
      horizontalWheel: !!raw.mouse.horizontalWheel
    },
    keyboard: {
      present: raw.keyboard.count > 0,
      keysTotal: clampInt(raw.keyboard.keysTotal, 0, 300, 0),
      functionKeys: clampInt(raw.keyboard.functionKeys, 0, 48, 0),
      kind: raw.keyboard.type === 4 || raw.keyboard.type === 81 ? 'enhanced' : raw.keyboard.type === 7 ? 'japanese' : raw.keyboard.type === 8 ? 'korean' : 'other'
    }
  };
}

/** Validates (untrusted) controller capabilities. Missing/garbled input — an older client — gets the
 * permissive default: everything the virtual devices support, no warnings. */
export function negotiateCaps(raw: unknown): NegotiatedCaps {
  const caps = raw as Partial<ControllerCaps> | null | undefined;
  const mouse = caps?.mouse;
  const keyboard = caps?.keyboard;
  const warnings: string[] = [];

  const reported = clampInt(mouse?.buttons, 0, 32, VIRTUAL_SUPPORT.maxButtons);
  // A pointing device always has at least a primary button, and 0 usually means "not reported".
  const wanted = reported === 0 ? 3 : reported;
  const buttons = Math.min(wanted, VIRTUAL_SUPPORT.maxButtons);
  if (wanted > VIRTUAL_SUPPORT.maxButtons) {
    warnings.push(`O mouse do controlador tem ${wanted} botões; só os ${VIRTUAL_SUPPORT.maxButtons} primeiros são encaminhados.`);
  }

  if (keyboard) {
    if (clampInt(keyboard.functionKeys, 0, 48, 12) > VIRTUAL_SUPPORT.maxFunctionKeys) {
      warnings.push('O teclado do controlador tem teclas de função além de F12; elas não são encaminhadas.');
    }
    if (keyboard.kind === 'japanese' || keyboard.kind === 'korean') {
      warnings.push('Teclado japonês/coreano: as teclas de IME (conversão, Han/Eng) não são encaminhadas.');
    }
  }

  return { buttons, horizontalWheel: typeof mouse?.horizontalWheel === 'boolean' ? mouse.horizontalWheel : true, warnings };
}
