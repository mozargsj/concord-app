// Plain-text report of an input-diagnostics session, for offline analysis (the "Salvar relatório"
// button of the diagnostics panel). Pure formatting, no imports — the key describer is passed in so
// this runs under plain `node`. The report holds what the user typed while diagnostics were on, so
// the header says so; nothing here is ever sent anywhere, the user saves it to a file themselves.

import type { DiagKind, DiagOutcome, DiagSystemInfo, RcDiag, RcPermissions } from './remoteControl';

export interface ReportRow {
  at: number;
  kind: DiagKind;
  seq: number;
  value: number;
  down: boolean;
  x?: number;
  y?: number;
  dx?: number;
  dy?: number;
  outcome: DiagOutcome | 'pending';
  detail?: string;
}

export interface DiagReportInput {
  generatedAt: number;
  role: 'controller' | 'controlled';
  perms: RcPermissions;
  keyHook: boolean;
  sessionStartedAt: number | null;
  diag: RcDiag | null;
  system: DiagSystemInfo;
  rows: ReportRow[];
}

type DescribeKey = (keyId: number) => { name: string; hex: string; ascii: number | null };

const OUTCOME_LABEL: Record<DiagOutcome | 'pending', string> = {
  ok: 'OK (aplicado)',
  fail: 'FALHA (Windows recusou)',
  perm: 'DESCARTADO (sem permissão)',
  seq: 'DESCARTADO (sequência repetida/antiga)',
  guard: 'BLOQUEADO (Ctrl+Alt+Del)',
  pending: 'SEM RESPOSTA (a outra ponta não confirmou)'
};

const KINDS: DiagKind[] = ['key', 'btn', 'wheel', 'mv'];
const KIND_LABEL: Record<DiagKind, string> = { key: 'teclas', btn: 'botões', wheel: 'roda', mv: 'ponteiro' };
const BUTTONS = ['esquerdo', 'direito', 'meio', 'lateral 1', 'lateral 2'];

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
function clock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function describeRow(row: ReportRow, describeKey: DescribeKey): string {
  const arrow = row.down ? 'DOWN' : 'UP  ';
  switch (row.kind) {
    case 'key': {
      const key = describeKey(row.value);
      return `${arrow} ${key.name} scan=${key.hex}${key.ascii !== null ? ` ascii=${key.ascii}` : ''}`;
    }
    case 'btn':
      return `${arrow} botão ${BUTTONS[row.value] ?? row.value}`;
    case 'wheel':
      return `roda dx=${Math.round(row.dx ?? 0)} dy=${Math.round(row.dy ?? 0)}`;
    case 'mv':
      return `ponteiro ${((row.x ?? 0) * 100).toFixed(1)}% , ${((row.y ?? 0) * 100).toFixed(1)}%`;
  }
}

export function formatDiagReport(input: DiagReportInput, describeKey: DescribeKey): string {
  const { role, system, diag, rows } = input;
  const isController = role === 'controller';
  const lines: string[] = [];
  const section = (title: string) => lines.push('', `[${title}]`);

  lines.push('CONCORD — RELATÓRIO DE DIAGNÓSTICO DE ENTRADA');
  lines.push(`Gerado em: ${new Date(input.generatedAt).toISOString()}`);
  lines.push('ATENÇÃO: este arquivo contém as teclas e posições registradas enquanto o diagnóstico esteve ligado.');
  lines.push('Não compartilhe se alguma senha foi digitada. Ele foi salvo localmente; nada foi enviado a servidor.');

  section('SISTEMA');
  lines.push(`Concord: ${system.appVersion} | Electron ${system.electron} | ${system.os} ${system.arch}`);
  lines.push(`Concord neste PC: ${system.elevated ? 'ADMINISTRADOR' : 'SEM administrador'}`);
  lines.push(`Backend de entrada: ${system.backend}`);
  lines.push(`Monitores: ${system.displays.length}`);
  for (const d of system.displays) lines.push(`  - id ${d.id}: ${d.width}x${d.height} @${d.scale}x${d.primary ? ' (principal)' : ''}`);

  section('SESSÃO');
  lines.push(`Papel deste PC: ${isController ? 'CONTROLADOR (envia)' : 'CONTROLADO (recebe)'}`);
  lines.push(`Permissões: mouse=${input.perms.mouse} teclado=${input.perms.keyboard} clipboard=${input.perms.clipboard} arquivos=${input.perms.files}`);
  lines.push(`Hook de teclado nativo: ${input.keyHook ? 'ativo' : 'INDISPONÍVEL (modo reduzido)'}`);
  if (input.sessionStartedAt) lines.push(`Duração até agora: ${Math.round((input.generatedAt - input.sessionStartedAt) / 1000)} s`);

  if (diag) {
    section('CONTADORES');
    if (isController) {
      lines.push(`Captura de teclado agora: ${diag.swallowing ? 'LIGADA' : `DESLIGADA — ${diag.captureWhy}`}`);
      lines.push(`Hook: viu ${diag.hookSeen} | engoliu ${diag.hookSwallowed} | entregou ao app ${diag.hookDelivered} | enviadas ao outro PC ${diag.hookEvents}`);
      lines.push(`Hook reativado: ${diag.hookRearms}×`);
      lines.push('Linha do tempo da captura:');
      if (diag.captureLog.length === 0) lines.push('  (nenhuma transição registrada)');
      for (const entry of diag.captureLog) lines.push(`  ${clock(entry.at)}  ${entry.swallowing ? 'LIGOU   ' : 'DESLIGOU'}  ${entry.why}`);
    } else {
      lines.push(`Teclas recebidas: ${diag.keyFramesIn} | descartadas: ${diag.keyDropped} | aplicadas: ${diag.injected} | recusadas pelo Windows: ${diag.injectFailed}`);
    }
  }

  section('RESUMO POR TIPO');
  for (const kind of KINDS) {
    const mine = rows.filter((r) => r.kind === kind);
    const count = (outcome: DiagOutcome | 'pending') => mine.filter((r) => r.outcome === outcome).length;
    lines.push(
      `${KIND_LABEL[kind].padEnd(9)} total ${String(mine.length).padStart(4)} | ok ${count('ok')} | falha ${count('fail')} | sem permissão ${count('perm')} | sequência ${count('seq')} | bloqueado ${count('guard')}${isController ? ` | sem resposta ${count('pending')}` : ''}`
    );
  }
  const reasons = new Map<string, number>();
  for (const row of rows) if (row.outcome === 'fail') reasons.set(row.detail || '(sem detalhe)', (reasons.get(row.detail || '(sem detalhe)') ?? 0) + 1);
  if (reasons.size > 0) {
    lines.push('Motivos das falhas:');
    for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) lines.push(`  ${count}× ${reason}`);
  }

  section(isController ? 'EVENTOS ENVIADOS (com a confirmação do PC controlado)' : 'EVENTOS RECEBIDOS (e o que o Windows fez)');
  lines.push('hora          tipo#seq        evento                                         resultado');
  if (rows.length === 0) lines.push('(nenhum evento registrado)');
  for (const row of rows) {
    lines.push(
      `${clock(row.at)}  ${`${row.kind}#${row.seq}`.padEnd(14)}  ${describeRow(row, describeKey).padEnd(46)} ${OUTCOME_LABEL[row.outcome]}${row.detail ? ` — ${row.detail}` : ''}`
    );
  }

  lines.push('', '— fim do relatório —', '');
  return lines.join('\r\n');
}
