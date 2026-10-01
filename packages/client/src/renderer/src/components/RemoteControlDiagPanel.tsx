import type { DiagItem, DiagOutcome } from '../../../common/remoteControl';
import { describeKey } from '../../../common/keyScan';
import type { DiagRow, RemoteControlApi } from '../hooks/useRemoteControl';
import '../styles/RemoteControlDiagPanel.css';

const OUTCOME_TEXT: Record<DiagOutcome | 'pending', string> = {
  pending: '… aguardando',
  ok: '✓ aplicado',
  fail: '✗ o Windows recusou',
  perm: '✗ sem permissão',
  seq: '✗ descartado (sequência)',
  guard: '✗ bloqueado (Ctrl+Alt+Del)'
};

const BUTTON_NAMES = ['esquerdo', 'direito', 'meio', 'lateral 1', 'lateral 2'];

type Row = Pick<DiagItem, 'kind' | 'seq' | 'value' | 'down' | 'x' | 'y' | 'dx' | 'dy'> & { outcome: DiagOutcome | 'pending'; at?: number };

function describe(row: Row): string {
  const arrow = row.down ? '↓' : '↑';
  switch (row.kind) {
    case 'key': {
      const key = describeKey(row.value);
      return `${arrow} ${key.name} · scan ${key.hex}${key.ascii !== null ? ` · ASCII ${key.ascii}` : ''}`;
    }
    case 'btn':
      return `${arrow} botão ${BUTTON_NAMES[row.value] ?? row.value}`;
    case 'wheel':
      return `roda dx ${Math.round(row.dx ?? 0)} · dy ${Math.round(row.dy ?? 0)}`;
    case 'mv':
      return `ponteiro ${((row.x ?? 0) * 100).toFixed(1)}% , ${((row.y ?? 0) * 100).toFixed(1)}%`;
  }
}

function tally(rows: Row[], kind: Row['kind']): string {
  const mine = rows.filter((r) => r.kind === kind);
  const ok = mine.filter((r) => r.outcome === 'ok').length;
  const pending = mine.filter((r) => r.outcome === 'pending').length;
  const bad = mine.length - ok - pending;
  return `${mine.length} (${ok} ✓${bad ? ` · ${bad} ✗` : ''}${pending ? ` · ${pending} …` : ''})`;
}

/** Opt-in input diagnostics. Controller: every event it sent, joined (by sequence number) with what
 * the controlled PC reported doing with it. Controlled: every event that arrived and what Windows did.
 * Shows the real keys/positions, so it is off by default, in memory only and never logged. */
export default function RemoteControlDiagPanel({ rc }: { rc: RemoteControlApi }) {
  const session = rc.session;
  if (!session || !rc.diagOn) return null;
  const isController = session.role === 'controller';
  const rows: Row[] = isController
    ? rc.diagSent.map((row: DiagRow) => ({ ...row, at: row.sentAt }))
    : rc.diagRecv.map((item) => ({ ...item }));
  const recent = rows.slice(-18).reverse();

  return (
    <div className="rc-diag" role="dialog" aria-label="Diagnóstico de entrada">
      <header className="rc-diag__header">
        <strong>Diagnóstico de entrada</strong>
        <span>{isController ? 'enviado → resultado no PC controlado' : 'chegou neste PC → o que o Windows fez'}</span>
        <button type="button" onClick={() => rc.toggleDiag(false)} title="Desligar o diagnóstico">
          Desligar
        </button>
      </header>
      <p className="rc-diag__totals">
        teclas {tally(rows, 'key')} · botões {tally(rows, 'btn')} · roda {tally(rows, 'wheel')} · ponteiro {tally(rows, 'mv')}
      </p>
      {isController && rc.diag && (
        <div className="rc-diag__capture">
          <strong>Captura de teclado:</strong> {rc.diag.swallowing ? 'LIGADA' : `DESLIGADA (${rc.diag.captureWhy})`}
          {rc.diag.hookRearms > 0 && ` · hook reativado ${rc.diag.hookRearms}×`}
          <ul>
            {rc.diag.captureLog.slice(-5).reverse().map((entry) => (
              <li key={entry.at}>
                {new Date(entry.at).toLocaleTimeString()} · {entry.swallowing ? 'ligou' : 'desligou'} — {entry.why}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ul className="rc-diag__list">
        {recent.length === 0 && <li className="rc-diag__empty">Nenhum evento ainda. Use o mouse e o teclado.</li>}
        {recent.map((row, index) => (
          <li key={`${row.kind}-${row.seq}-${index}`} className={'rc-diag__row' + (row.outcome === 'ok' ? '' : row.outcome === 'pending' ? ' rc-diag__row--pending' : ' rc-diag__row--bad')}>
            <span className="rc-diag__seq">{row.kind}#{row.seq}</span>
            <span className="rc-diag__what">{describe(row)}</span>
            <span className="rc-diag__result">{OUTCOME_TEXT[row.outcome]}</span>
          </li>
        ))}
      </ul>
      <p className="rc-diag__note">Só em memória; nada é gravado nem enviado a servidor. Desliga sozinho ao fim da sessão.</p>
    </div>
  );
}
