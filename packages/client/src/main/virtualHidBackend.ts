import net from 'node:net';
import { KeyboardReportBuilder, MouseReportBuilder } from '../common/hidReports';
import type { NegotiatedCaps } from '../common/deviceCaps';

// Client side of the Virtual HID backend (spec 6, 21, decision 9). A separate, privileged Windows
// service (not part of this repository yet — see native/virtual-hid/README.md) owns the virtual
// keyboard/mouse driver; this process only sends it ready-made HID input reports over a local
// named pipe, so the unprivileged UI never touches the driver and the service never executes
// anything it was not designed to: it receives opaque report bytes, nothing else.
//
// Wire protocol (one JSON object per line, UTF-8):
//   service -> client, right after connect:  {"hello":"concord-virtual-hid","v":1}
//   client  -> service:                      {"d":"kbd","r":"<8 bytes as hex>"}
//                                            {"d":"mouse","r":"<7 bytes as hex>"}
//                                            {"d":"config","buttons":1..5,"horizontalWheel":bool}  (optional,
//                                             once per session; a service may ignore it — it only describes
//                                             what the controller's real hardware can produce)
// Reports are exactly the ones described by common/hidReports.ts' descriptors.

export const DEFAULT_PIPE = '\\\\.\\pipe\\concord-virtual-hid';
const PROTOCOL_VERSION = 1;

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

export class VirtualHidBackend {
  private socket: net.Socket | null = null;
  readonly keyboard = new KeyboardReportBuilder();
  readonly mouse = new MouseReportBuilder();

  /** Connects and waits for the service's hello. False when the service isn't there / isn't ours. */
  connect(pipePath: string = process.env.CONCORD_VHID_PIPE || DEFAULT_PIPE, timeoutMs = 400): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.connect(pipePath);
      let settled = false;
      let buffer = '';
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ok) {
          this.socket = socket;
          socket.removeAllListeners('data');
        } else {
          socket.destroy();
        }
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        try {
          const hello = JSON.parse(buffer.slice(0, newline)) as { hello?: string; v?: number };
          finish(hello.hello === 'concord-virtual-hid' && hello.v === PROTOCOL_VERSION);
        } catch {
          finish(false);
        }
      });
      socket.on('error', () => finish(false));
      socket.on('close', () => {
        if (!settled) finish(false);
        else if (this.socket === socket) {
          this.socket = null;
          this.onLost?.(); // dropped mid-session, not closed on purpose (close() clears this.socket first)
        }
      });
    });
  }

  /** Called when the pipe dies mid-session — input would silently stop, so the session must end. */
  onLost: (() => void) | null = null;

  /** Ignores late socket errors (the close handler above already reports a lost connection). */
  watch(): void {
    this.socket?.on('error', () => {});
  }

  private send(device: 'kbd' | 'mouse', report: Uint8Array): void {
    this.socket?.write(`${JSON.stringify({ d: device, r: toHex(report) })}\n`);
  }

  sendConfig(negotiated: NegotiatedCaps): void {
    this.socket?.write(`${JSON.stringify({ d: 'config', buttons: negotiated.buttons, horizontalWheel: negotiated.horizontalWheel })}\n`);
  }

  sendKeyboard(): void {
    this.send('kbd', this.keyboard.report());
  }

  sendMouse(): void {
    this.send('mouse', this.mouse.report());
  }

  /** Input Reset: neutral reports for both devices. */
  releaseAll(): void {
    this.keyboard.reset();
    this.mouse.reset();
    this.sendKeyboard();
    this.sendMouse();
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}
