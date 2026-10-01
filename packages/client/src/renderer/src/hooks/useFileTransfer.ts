import { useEffect, useRef, useState } from 'react';
import { RC_FILES, RC_TIMING, type FileFrame, type RcSessionInfo } from '../../../common/remoteControl';

// Renderer side of file transfer inside a control session (spec 35). The bytes live in the main
// process (main/fileTransfer.ts: picked file in, quarantined download out) — this hook only drives
// the data channel and the UI state. Either peer may send while the session carries the `files`
// permission; the receiver confirms every file.

export interface Transfer {
  xid: number;
  name: string;
  size: number;
  done: number;
  direction: 'in' | 'out';
  status: 'waiting' | 'active' | 'done' | 'failed';
  /** Short result text for finished transfers (saved-as name, who refused...). */
  detail?: string;
}

export interface FileOffer {
  xid: number;
  name: string;
  size: number;
  risky: boolean;
}

interface Args {
  session: RcSessionInfo | null;
  sendFileFrame: (peerId: string, frame: FileFrame) => boolean;
  sendFileChunk: (peerId: string, chunk: ArrayBuffer) => Promise<boolean>;
  showNotice: (text: string) => void;
}

const FINISHED_VISIBLE_MS = 6000;

export function useFileTransfer({ session, sendFileFrame, sendFileChunk, showNotice }: Args) {
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [offer, setOffer] = useState<(FileOffer & { peerName: string }) | null>(null);
  const live = useRef({ session, sendFileFrame, sendFileChunk, showNotice, transfers, offer });
  live.current = { session, sendFileFrame, sendFileChunk, showNotice, transfers, offer };
  const cancelled = useRef(new Set<number>());

  const api = () => window.concord.remoteControl.files;

  function patch(xid: number, change: Partial<Transfer>): void {
    setTransfers((prev) => prev.map((t) => (t.xid === xid ? { ...t, ...change } : t)));
    if (change.status === 'done' || change.status === 'failed') {
      setTimeout(() => setTransfers((prev) => prev.filter((t) => t.xid !== xid)), FINISHED_VISIBLE_MS);
    }
  }

  // Whatever was in flight dies with the session (main discards the partial files itself).
  const sid = session?.sid;
  useEffect(() => {
    if (!sid) {
      setTransfers([]);
      setOffer(null);
      cancelled.current.clear();
    }
  }, [sid]);

  useEffect(() => {
    return window.concord.remoteControl.on('files-expired', ({ xid }) => {
      setOffer((current) => (current && current.xid === xid ? null : current)); // expiring is not a refusal
    });
  }, []);

  /** Streams the picked file out in chunks, honoring the channel's backpressure. */
  async function pump(peerId: string, sessionId: string, xid: number, size: number): Promise<void> {
    let sent = 0;
    let lastReported = 0;
    for (;;) {
      if (cancelled.current.has(xid)) return;
      const chunk = await api().read(xid);
      if (!chunk) break;
      const framed = new Uint8Array(4 + chunk.byteLength);
      new DataView(framed.buffer).setUint32(0, xid, true);
      framed.set(chunk, 4);
      const ok = await live.current.sendFileChunk(peerId, framed.buffer);
      if (!ok) {
        patch(xid, { status: 'failed', detail: 'Conexão perdida.' });
        void api().abort(xid);
        return;
      }
      sent += chunk.byteLength;
      if (sent - lastReported >= RC_FILES.progressEveryBytes) {
        lastReported = sent;
        patch(xid, { done: sent });
      }
    }
    if (cancelled.current.has(xid)) return;
    live.current.sendFileFrame(peerId, { t: 'done', sid: sessionId, xid, bytes: size });
    patch(xid, { status: 'done', done: size, detail: 'Enviado.' });
  }

  async function send(): Promise<void> {
    const s = live.current.session;
    if (!s || !s.perms.files) {
      live.current.showNotice('A permissão de arquivos não foi concedida nesta sessão.');
      return;
    }
    const picked = await api().pick();
    if (!picked) return;
    if ('error' in picked) {
      live.current.showNotice(
        picked.error === 'ocupado'
          ? 'Já existe um envio em andamento.'
          : picked.error === 'tamanho'
            ? 'Arquivo vazio ou maior que o limite de 2 GB.'
            : 'Não foi possível enviar arquivos agora.'
      );
      return;
    }
    const { xid, name, size } = picked;
    setTransfers((prev) => [...prev, { xid, name, size, done: 0, direction: 'out', status: 'waiting' }]);
    if (!live.current.sendFileFrame(s.peerId, { t: 'offer', sid: s.sid, xid, name, size })) {
      patch(xid, { status: 'failed', detail: 'Conexão indisponível.' });
      void api().abort(xid);
      return;
    }
    // The receiver has the solicitation timeout to answer; past that this offer is dead.
    setTimeout(() => {
      const t = live.current.transfers.find((x) => x.xid === xid);
      if (t && t.status === 'waiting') {
        cancelled.current.add(xid);
        live.current.sendFileFrame(s.peerId, { t: 'cancel', sid: s.sid, xid });
        void api().abort(xid);
        patch(xid, { status: 'failed', detail: 'Sem resposta.' });
      }
    }, RC_TIMING.solicitationTimeoutMs + 1000);
  }

  async function handleFrame(peerId: string, frame: FileFrame): Promise<void> {
    const s = live.current.session;
    if (!s || !s.perms.files || s.peerId !== peerId || frame.sid !== s.sid) return;
    const find = (xid: number) => live.current.transfers.find((t) => t.xid === xid);

    switch (frame.t) {
      case 'offer': {
        const verdict = await api().incoming(peerId, frame);
        if (!verdict.ok) {
          live.current.sendFileFrame(peerId, { t: 'reject', sid: s.sid, xid: frame.xid });
          return;
        }
        setOffer({ xid: frame.xid, name: verdict.name, size: verdict.size, risky: verdict.risky, peerName: s.peerName });
        break;
      }
      case 'accept': {
        const t = find(frame.xid);
        if (!t || t.direction !== 'out' || t.status !== 'waiting') return;
        patch(frame.xid, { status: 'active' });
        void pump(peerId, s.sid, frame.xid, t.size);
        break;
      }
      case 'reject':
        if (find(frame.xid)?.direction === 'out') {
          cancelled.current.add(frame.xid);
          void api().abort(frame.xid);
          patch(frame.xid, { status: 'failed', detail: `${s.peerName} recusou.` });
        }
        break;
      case 'done': {
        const t = find(frame.xid);
        if (!t || t.direction !== 'in') return;
        const result = await api().finish(peerId, frame.xid);
        if (result.ok) {
          patch(frame.xid, { status: 'done', done: t.size, detail: `Salvo em ${result.folder}\\${result.name}` });
          live.current.showNotice(`Arquivo recebido: ${result.name} (pasta Downloads\\Concord Recebidos).`);
        } else {
          patch(frame.xid, { status: 'failed', detail: 'O arquivo chegou incompleto e foi descartado.' });
        }
        break;
      }
      case 'cancel':
        if (find(frame.xid)) {
          cancelled.current.add(frame.xid);
          void api().abort(frame.xid);
          patch(frame.xid, { status: 'failed', detail: `${s.peerName} cancelou.` });
        }
        setOffer((current) => (current && current.xid === frame.xid ? null : current));
        break;
    }
  }

  const received = useRef(new Map<number, number>());
  function handleChunk(peerId: string, buffer: ArrayBuffer): void {
    const s = live.current.session;
    if (!s || !s.perms.files || s.peerId !== peerId || buffer.byteLength <= 4) return;
    const xid = new DataView(buffer).getUint32(0, true);
    const t = live.current.transfers.find((x) => x.xid === xid);
    if (!t || t.direction !== 'in' || t.status !== 'active') return;
    const data = new Uint8Array(buffer, 4);
    api().write(peerId, xid, data);
    const total = (received.current.get(xid) ?? 0) + data.byteLength;
    received.current.set(xid, total);
    if (total - t.done >= RC_FILES.progressEveryBytes) patch(xid, { done: total });
  }

  async function answerOffer(accept: boolean): Promise<void> {
    const current = live.current.offer;
    const s = live.current.session;
    if (!current || !s) return;
    setOffer(null);
    if (accept) {
      const result = await api().accept(current.xid, true);
      if (!result.ok) {
        live.current.sendFileFrame(s.peerId, { t: 'reject', sid: s.sid, xid: current.xid });
        live.current.showNotice('Não foi possível salvar o arquivo.');
        return;
      }
      received.current.set(current.xid, 0);
      setTransfers((prev) => [...prev, { xid: current.xid, name: current.name, size: current.size, done: 0, direction: 'in', status: 'active' }]);
      live.current.sendFileFrame(s.peerId, { t: 'accept', sid: s.sid, xid: current.xid });
    } else {
      await api().accept(current.xid, false);
      live.current.sendFileFrame(s.peerId, { t: 'reject', sid: s.sid, xid: current.xid });
    }
  }

  function cancel(xid: number): void {
    const s = live.current.session;
    const t = live.current.transfers.find((x) => x.xid === xid);
    if (!s || !t) return;
    cancelled.current.add(xid);
    live.current.sendFileFrame(s.peerId, { t: 'cancel', sid: s.sid, xid });
    void api().abort(xid);
    patch(xid, { status: 'failed', detail: 'Cancelado.' });
  }

  return { transfers, offer, send, answerOffer, cancel, handleFrame, handleChunk };
}
