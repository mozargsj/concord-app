// Run: node src/common/diagReport.test.ts   (Node 22.6+ strips the types itself)
import assert from 'node:assert/strict';
import { CODE_TO_KEY, describeKey } from './keyScan.ts';
import { formatDiagReport, type DiagReportInput } from './diagReport.ts';

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const base: DiagReportInput = {
  generatedAt: T0 + 60_000,
  role: 'controller',
  perms: { mouse: true, keyboard: true, clipboard: false, files: false },
  keyHook: true,
  sessionStartedAt: T0,
  system: {
    appVersion: '0.0.97',
    electron: '31.7.7',
    os: 'Windows 10.0.26200',
    arch: 'x64',
    elevated: false,
    backend: 'sendinput',
    displays: [{ id: 2528732444, width: 1920, height: 1080, scale: 1.25, primary: true }]
  },
  diag: {
    role: 'controller', keyHook: true, swallowing: false, captureActive: true, windowFocused: false,
    hookEvents: 0, keyFramesIn: 0, keyDropped: 0, injected: 0, injectFailed: 0, elevated: false,
    captureWhy: 'o Concord perdeu o foco do Windows', hookRearms: 2, hookSeen: 14, hookSwallowed: 0, hookDelivered: 0,
    captureLog: [{ at: T0 + 1000, swallowing: false, why: 'o Concord perdeu o foco do Windows' }]
  },
  rows: [
    { at: T0 + 2000, kind: 'key', seq: 1, value: CODE_TO_KEY.KeyA, down: true, outcome: 'ok' },
    { at: T0 + 2050, kind: 'key', seq: 2, value: CODE_TO_KEY.KeyA, down: false, outcome: 'pending' },
    { at: T0 + 3000, kind: 'btn', seq: 1, value: 0, down: true, outcome: 'fail', detail: 'SendInput recusado (erro 5 — acesso negado)' },
    { at: T0 + 3100, kind: 'btn', seq: 2, value: 0, down: false, outcome: 'fail', detail: 'SendInput recusado (erro 5 — acesso negado)' },
    { at: T0 + 4000, kind: 'mv', seq: 9, value: 0, down: false, x: 0.5, y: 0.25, outcome: 'ok' },
    { at: T0 + 5000, kind: 'key', seq: 3, value: CODE_TO_KEY.Delete, down: true, outcome: 'guard' }
  ]
};

const report = formatDiagReport(base, describeKey);
const text = report.replace(/\r\n/g, '\n');

// Header, privacy warning, system, session.
assert.match(text, /RELATÓRIO DE DIAGNÓSTICO DE ENTRADA/);
assert.match(text, /Não compartilhe se alguma senha foi digitada/);
assert.match(text, /Concord: 0\.0\.97 \| Electron 31\.7\.7 \| Windows 10\.0\.26200 x64/);
assert.match(text, /Concord neste PC: SEM administrador/);
assert.match(text, /id 2528732444: 1920x1080 @1\.25x \(principal\)/);
assert.match(text, /Papel deste PC: CONTROLADOR/);
assert.match(text, /Duração até agora: 60 s/);
// Counters + capture timeline are what explain "sometimes it works".
assert.match(text, /Hook: viu 14 \| engoliu 0 \| entregou ao app 0 \| enviadas ao outro PC 0/);
assert.match(text, /Captura de teclado agora: DESLIGADA — o Concord perdeu o foco do Windows/);
assert.match(text, /DESLIGOU {2}o Concord perdeu o foco/);
// Per-type summary and grouped failure reasons.
assert.match(text, /botões +total +2 \| ok 0 \| falha 2/);
assert.match(text, /teclas +total +3 .*sem resposta 1/);
assert.match(text, /2× SendInput recusado \(erro 5 — acesso negado\)/);
// Event lines carry time, key name, scan code, ASCII and the outcome.
assert.match(text, /12:00:02\.000|\d\d:\d\d:02\.000/);
assert.match(text, /key#1 +DOWN KeyA scan=0x1E ascii=65 +OK \(aplicado\)/);
assert.match(text, /key#2 +UP {3}KeyA .*SEM RESPOSTA/);
assert.match(text, /key#3 +DOWN Delete scan=0x153 ascii=127 +BLOQUEADO \(Ctrl\+Alt\+Del\)/);
assert.match(text, /mv#9 +ponteiro 50\.0% , 25\.0% +OK/);
// Windows line endings, so Notepad shows it properly.
assert.ok(report.includes('\r\n') && !/[^\r]\n/.test(report));

// Controlled side: received-view wording, no "sem resposta" column, own counters.
const controlled = formatDiagReport(
  { ...base, role: 'controlled', diag: { ...base.diag!, role: 'controlled', keyFramesIn: 5, keyDropped: 1, injected: 3, injectFailed: 1 } },
  describeKey
).replace(/\r\n/g, '\n');
assert.match(controlled, /CONTROLADO \(recebe\)/);
assert.match(controlled, /EVENTOS RECEBIDOS/);
assert.match(controlled, /Teclas recebidas: 5 \| descartadas: 1 \| aplicadas: 3 \| recusadas pelo Windows: 1/);
assert.doesNotMatch(controlled, /sem resposta \d/);

// Empty session still produces a readable file.
const empty = formatDiagReport({ ...base, rows: [], diag: null }, describeKey);
assert.match(empty, /\(nenhum evento registrado\)/);

console.log('diag report ok');
