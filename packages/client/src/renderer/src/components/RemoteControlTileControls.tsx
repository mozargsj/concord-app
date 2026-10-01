import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MousePointer2 } from 'lucide-react';
import type { PresenceStatus } from '@concord/shared';
import type { RemoteControlApi } from '../hooks/useRemoteControl';
import type { RoomPeer } from '../hooks/useRoomConnection';
import { PRESENCE_COLORS, PRESENCE_LABELS } from '../lib/presenceStatus';

export type TileRemoteControl =
  | {
      /** The sharer's own preview tile: the entry point for OFFERING control of this PC. */
      mode: 'own';
      rc: RemoteControlApi;
      peers: RoomPeer[];
      /** Sharing a whole screen — the only kind of share control works with. */
      sharingFullScreen: boolean;
    }
  | {
      /** Someone else's shared screen: where I can ASK to control their PC, or am controlling it. */
      mode: 'peer';
      rc: RemoteControlApi;
      peer: RoomPeer;
    };

function StatusDot({ status }: { status: PresenceStatus }) {
  return <span className="rc-dot" style={{ background: PRESENCE_COLORS[status] }} title={PRESENCE_LABELS[status]} />;
}

function formatWait(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  return seconds < 90 ? `${seconds} s` : `${Math.ceil(seconds / 60)} min`;
}

/** Overlay controls for one screen-share tile — see the two variants of TileRemoteControl. */
export default function RemoteControlTileControls({ control, isFocused }: { control: TileRemoteControl; isFocused: boolean }) {
  return control.mode === 'own' ? <OwnControls control={control} /> : <PeerControls control={control} isFocused={isFocused} />;
}

/** Floats above everything (portal + fixed) — the own-preview tile can be a small grid cell whose
 * overflow would clip a popover rendered inside it. */
function Popover({ anchor, onClose, children }: { anchor: DOMRect; onClose: () => void; children: ReactNode }) {
  const style: CSSProperties = { position: 'fixed', top: anchor.bottom + 6, left: anchor.left };
  return createPortal(
    <>
      <div className="rc-popover__backdrop" onClick={onClose} />
      <div className="rc-popover" style={style}>
        {children}
      </div>
    </>,
    document.body
  );
}

function OwnControls({ control }: { control: Extract<TileRemoteControl, { mode: 'own' }> }) {
  const { rc, peers, sharingFullScreen } = control;
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const anchor = buttonRef.current?.getBoundingClientRect();
  const controlledSession = rc.session?.role === 'controlled' ? rc.session : null;
  // Only Online peers can receive an offer (spec 13.5); a peer that recently refused stays listed
  // but disabled, with the time left.
  const candidates = peers.filter((peer) => peer.status === 'online');
  const disabledReason = !rc.available
    ? 'O controle remoto não está disponível neste computador.'
    : !sharingFullScreen
      ? 'O controle só funciona com transmissão de tela inteira, não de um aplicativo.'
      : null;

  return (
    <div className="screen-share-tile__rc" onClick={(event) => event.stopPropagation()}>
      <button
        ref={buttonRef}
        type="button"
        className={'rc-icon' + (controlledSession ? ' rc-icon--active' : '')}
        disabled={!!disabledReason && !controlledSession}
        title={controlledSession ? `${controlledSession.peerName} está controlando seu PC` : (disabledReason ?? 'Dar acesso ao seu PC')}
        onClick={() => setOpen((value) => !value)}
      >
        <MousePointer2 size={16} />
      </button>

      {open && anchor && controlledSession && (
        <Popover anchor={anchor} onClose={() => setOpen(false)}>
          <p className="rc-popover__title">Controle remoto ativo</p>
          <p className="rc-popover__row">
            {controlledSession.peerName} ·{' '}
            {[
              controlledSession.perms.mouse && 'Mouse',
              controlledSession.perms.keyboard && 'Teclado',
              controlledSession.perms.clipboard && 'Clipboard',
              controlledSession.perms.files && 'Arquivos'
            ]
              .filter(Boolean)
              .join(', ')}
          </p>
          {controlledSession.perms.keyboard && rc.diag && (
            <p className="rc-popover__row">
              Teclado: {rc.diag.keyFramesIn} recebidas, {rc.diag.injected} aplicadas
              {rc.diag.injectFailed > 0 && `, ${rc.diag.injectFailed} recusadas pelo Windows (janela elevada?)`}
              {rc.diag.keyDropped > 0 && `, ${rc.diag.keyDropped} descartadas`}
            </p>
          )}
          <button type="button" className="rc-popover__peer" onClick={() => rc.toggleDiag(!rc.diagOn)}>
            {rc.diagOn ? 'Ocultar diagnóstico de entrada' : 'Diagnóstico de entrada'}
          </button>
          {controlledSession.perms.files && (
            <button type="button" className="rc-popover__peer" onClick={() => void rc.files.send()}>
              Enviar arquivo
            </button>
          )}
          <button
            type="button"
            className="rc-popover__stop"
            onClick={() => {
              setOpen(false);
              rc.stopControl();
            }}
          >
            Parar controle
          </button>
        </Popover>
      )}

      {open && anchor && !controlledSession && (
        <Popover anchor={anchor} onClose={() => setOpen(false)}>
          <p className="rc-popover__title">Dar acesso ao seu PC</p>
          {candidates.length === 0 ? (
            <p className="rc-popover__row rc-popover__row--muted">Ninguém online na sala.</p>
          ) : (
            candidates.map((peer) => {
              const wait = (rc.cooldownUntil[peer.userId] ?? 0) - Date.now();
              return (
                <button
                  key={peer.peerId}
                  type="button"
                  className="rc-popover__peer"
                  disabled={wait > 0}
                  title={wait > 0 ? `Recusou recentemente. Tente de novo em ${formatWait(wait)}.` : undefined}
                  onClick={() => {
                    setOpen(false);
                    rc.openDialog('offer', peer.peerId);
                  }}
                >
                  <StatusDot status={peer.status} />
                  <span>{peer.displayName}</span>
                  {wait > 0 && <small>{formatWait(wait)}</small>}
                </button>
              );
            })
          )}
        </Popover>
      )}
    </div>
  );
}

function PeerControls({ control, isFocused }: { control: Extract<TileRemoteControl, { mode: 'peer' }>; isFocused: boolean }) {
  const { rc, peer } = control;
  const controllingThisPeer = rc.session?.role === 'controller' && rc.session.peerId === peer.peerId;

  if (controllingThisPeer && rc.session) {
    return (
      <div className="rc-banner" onClick={(event) => event.stopPropagation()}>
        <span className="rc-banner__dot" />
        <span className="rc-banner__text">
          Controlando {peer.displayName}
          {!rc.session.keyHook && ' (sem teclas de sistema)'} · Ctrl+Shift+Pause para sair
          {rc.session.perms.keyboard && rc.diag && (
            <small className="rc-banner__diag">
              {rc.diag.swallowing || !rc.session.keyHook
                ? `Teclado capturado · ${rc.diag.hookEvents} teclas enviadas`
                : `Teclado NÃO capturado: ${rc.diag.captureWhy}`}
            </small>
          )}
        </span>
        <button type="button" className="rc-banner__stop" onClick={() => rc.toggleDiag(!rc.diagOn)} title="Mostra o que foi enviado e o que chegou no outro PC">
          {rc.diagOn ? 'Ocultar diagnóstico' : 'Diagnóstico'}
        </button>
        {rc.session.perms.files && (
          <button type="button" className="rc-banner__stop" onClick={() => void rc.files.send()}>
            Enviar arquivo
          </button>
        )}
        <button type="button" className="rc-banner__stop" onClick={rc.stopControl}>
          Parar controle
        </button>
      </div>
    );
  }

  // Nothing to offer on a tile that isn't a whole-screen share, or while I'm already in a session.
  if (!isFocused || !rc.peerFullScreen[peer.peerId] || rc.session) return null;

  const wait = (rc.cooldownUntil[peer.userId] ?? 0) - Date.now();
  const reason = !rc.available
    ? 'O controle remoto não está disponível neste computador.'
    : peer.status !== 'online'
      ? `${peer.displayName} não está online.`
      : rc.outgoing
        ? 'Já existe um pedido em andamento.'
        : wait > 0
          ? `${peer.displayName} recusou recentemente. Tente de novo em ${formatWait(wait)}.`
          : null;

  return (
    <div className="screen-share-tile__rc screen-share-tile__rc--peer" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        className="rc-request"
        disabled={!!reason}
        title={reason ?? 'Pedir para controlar este PC'}
        onClick={() => rc.openDialog('request', peer.peerId)}
      >
        <MousePointer2 size={15} />
        <span>Solicitar controle</span>
      </button>
    </div>
  );
}
