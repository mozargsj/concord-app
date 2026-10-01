import { useEffect, useState } from 'react';
import Button from './Button';
import type { RemoteControlApi } from '../hooks/useRemoteControl';
import type { RoomPeer } from '../hooks/useRoomConnection';
import type { RcPermissions } from '../../../common/remoteControl';
import '../styles/RemoteControlLayer.css';

interface Props {
  rc: RemoteControlApi;
  peers: RoomPeer[];
}

const PERMISSION_LABELS: Array<[keyof RcPermissions, string]> = [
  ['mouse', 'Mouse'],
  ['keyboard', 'Teclado'],
  ['clipboard', 'Clipboard (Ctrl+C / Ctrl+V entre os PCs)'],
  ['files', 'Arquivos (enviar e receber, com confirmação a cada arquivo)']
];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function permissionSummary(perms: RcPermissions): string {
  const parts = PERMISSION_LABELS.filter(([key]) => perms[key]).map(([, label]) => label.split(' ')[0]);
  return parts.length > 0 ? parts.join(', ') : 'nenhuma';
}

/** Everything the remote-control flow shows outside the tiles: the permission popup (spec 13.3),
 * the discreet green request/offer notification (bottom-left) and short result notices. */
export default function RemoteControlLayer({ rc, peers }: Props) {
  const { dialog, incoming, outgoing, notice, files } = rc;
  const dialogPeer = dialog ? peers.find((peer) => peer.peerId === dialog.peerId) : undefined;

  return (
    <>
      {dialog && dialogPeer && (
        <PermissionDialog
          kind={dialog.kind}
          peerName={dialogPeer.displayName}
          onCancel={rc.closeDialog}
          onSubmit={rc.submitDialog}
        />
      )}

      <div className="rc-stack" aria-live="polite">
        {incoming && (
          <div className="rc-toast rc-toast--incoming" role="alert" key={incoming.id}>
            <p className="rc-toast__text">
              {incoming.kind === 'offer'
                ? `${incoming.name} está fornecendo acesso ao PC dele. Deseja aceitar?`
                : `${incoming.name} quer controlar o seu PC. Deseja aceitar?`}
            </p>
            <p className="rc-toast__sub">Permissões: {permissionSummary(incoming.perms)}</p>
            <div className="rc-toast__actions">
              <button type="button" className="rc-toast__btn rc-toast__btn--accept" onClick={() => void rc.respondIncoming(true)}>
                Aceitar
              </button>
              <button type="button" className="rc-toast__btn" onClick={() => void rc.respondIncoming(false)}>
                Recusar
              </button>
            </div>
            <span className="rc-toast__timer" />
          </div>
        )}

        {files.offer && (
          <div className="rc-toast rc-toast--incoming" role="alert" key={files.offer.xid}>
            <p className="rc-toast__text">
              {files.offer.peerName} quer enviar “{files.offer.name}” ({formatSize(files.offer.size)}). Aceitar?
            </p>
            <p className="rc-toast__sub">
              {files.offer.risky
                ? 'Atenção: é um arquivo executável. Só abra se confiar em quem enviou.'
                : 'Vai para Downloads\\Concord Recebidos. Nada é aberto automaticamente.'}
            </p>
            <div className="rc-toast__actions">
              <button type="button" className="rc-toast__btn rc-toast__btn--accept" onClick={() => void files.answerOffer(true)}>
                Aceitar
              </button>
              <button type="button" className="rc-toast__btn" onClick={() => void files.answerOffer(false)}>
                Recusar
              </button>
            </div>
            <span className="rc-toast__timer" />
          </div>
        )}

        {files.transfers.map((transfer) => (
          <div className="rc-toast rc-toast--neutral" key={transfer.xid}>
            <p className="rc-toast__text">
              {transfer.direction === 'out' ? 'Enviando' : 'Recebendo'} {transfer.name}
            </p>
            <p className="rc-toast__sub">
              {transfer.status === 'waiting'
                ? 'Aguardando confirmação...'
                : transfer.status === 'active'
                  ? `${formatSize(transfer.done)} de ${formatSize(transfer.size)}`
                  : (transfer.detail ?? '')}
            </p>
            {transfer.status === 'active' && (
              <progress className="rc-toast__progress" max={transfer.size} value={transfer.done} />
            )}
            {(transfer.status === 'active' || transfer.status === 'waiting') && (
              <div className="rc-toast__actions">
                <button type="button" className="rc-toast__btn" onClick={() => files.cancel(transfer.xid)}>
                  Cancelar
                </button>
              </div>
            )}
          </div>
        ))}

        {outgoing && (
          <div className="rc-toast rc-toast--neutral" key={outgoing.id}>
            <p className="rc-toast__text">
              {outgoing.kind === 'offer' ? 'Convite enviado' : 'Pedido enviado'} para {outgoing.name}. Aguardando resposta...
            </p>
            <div className="rc-toast__actions">
              <button type="button" className="rc-toast__btn" onClick={rc.cancelOutgoing}>
                Cancelar
              </button>
            </div>
          </div>
        )}

        {notice && (
          <div className="rc-toast rc-toast--neutral" key={notice.nonce}>
            <p className="rc-toast__text">{notice.text}</p>
          </div>
        )}
      </div>
    </>
  );
}

function PermissionDialog({
  kind,
  peerName,
  onCancel,
  onSubmit
}: {
  kind: 'request' | 'offer';
  peerName: string;
  onCancel: () => void;
  onSubmit: (perms: RcPermissions) => void;
}) {
  // Every permission starts off (spec 41): nothing is enabled unless chosen explicitly.
  const [perms, setPerms] = useState<RcPermissions>({ mouse: false, keyboard: false, clipboard: false, files: false });
  const canSend = perms.mouse || perms.keyboard || perms.clipboard || perms.files;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="rc-dialog__backdrop" onClick={onCancel}>
      <div className="rc-dialog" onClick={(event) => event.stopPropagation()}>
        <h2>{kind === 'offer' ? `Dar acesso ao seu PC a ${peerName}` : `Pedir controle do PC de ${peerName}`}</h2>
        <p className="rc-dialog__hint">
          {kind === 'offer'
            ? 'Quem aceitar poderá usar o que você marcar abaixo, enquanto você transmitir a tela inteira. Você pode parar a qualquer momento.'
            : 'O pedido só é aceito se o outro usuário estiver online e transmitindo a tela inteira.'}
        </p>
        <div className="rc-dialog__perms">
          {PERMISSION_LABELS.map(([key, label]) => (
            <label key={key} className="rc-dialog__perm">
              <input type="checkbox" checked={perms[key]} onChange={(event) => setPerms((prev) => ({ ...prev, [key]: event.target.checked }))} />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <div className="rc-dialog__actions">
          <Button variant="ghost" onClick={onCancel}>
            Cancelar
          </Button>
          <Button variant="primary" disabled={!canSend} onClick={() => onSubmit(perms)}>
            {kind === 'offer' ? 'Enviar convite' : 'Enviar pedido'}
          </Button>
        </div>
      </div>
    </div>
  );
}
