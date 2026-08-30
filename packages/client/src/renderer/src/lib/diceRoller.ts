// Parser + roller pro bot de dados nativo (decisions.md — "Bots nativos do Concord", seção do
// bot de dados). Puro, sem React/mesh — só reconhece um comando de texto e rola, o chamador
// (useRoomConnection.ts) decide o que fazer com o resultado (empacotar numa ChatMessage e
// transmitir pro resto da sala).

export type DiceOperation =
  | 'sum'
  | 'average'
  | 'max'
  | 'min'
  | 'multiply'
  | 'subtract'
  | 'divide'
  // "vant"/"desv" — mesmo cálculo de max/min (maior/menor dado, sem somar), mas com rótulo e
  // realce visual próprios (RoomChat.tsx destaca o dado vencedor/perdedor), pedido do Mozar
  // pra vocabulário de RPG (vantagem/desvantagem, D&D-style) em vez de só "maior"/"menor".
  | 'advantage'
  | 'disadvantage';

export type DiceTag = 'atk';

export interface DiceRollResult {
  raw: string;
  count: number;
  sides: number;
  rolls: number[];
  operation: DiceOperation;
  operand: number | null;
  modifier: number | null;
  // Marcador opcional, sem efeito no cálculo — só rotula o tipo de rolagem (ex. "atk" = ataque),
  // pedido do Mozar pra ficar igual ao vocabulário de bots de RPG de referência.
  tag: DiceTag | null;
  total: number;
  // Quando true, a tag "un" foi passada explicitamente (ex. "3d20+5 un") — cada dado é exibido
  // com seu próprio resultado final (roll + modifier, se houver), sem somar os dados entre si.
  // O padrão (sem "un") continua sendo somar tudo num total único, mesmo com modificador — pedido
  // do Mozar depois de uma tentativa anterior que invertia isso por padrão. Só dispara com mais de
  // um dado (com um dado só não há diferença entre somar e não somar) e é ignorado se vier junto
  // com um keyword de operação explícito (soma/vant/etc., já são agregações intencionais).
  perDie: boolean;
  // Valor final (roll + modifier) de cada dado, na mesma ordem de `rolls` — só preenchido quando
  // `perDie` é true; null caso contrário (RoomChat.tsx usa isto pra exibir cada dado já com o
  // modificador embutido, em vez do `total` agregado).
  dieTotals: number[] | null;
}

// Sem lista fixa de dados "clássicos" (d4/d6/d8/d10/d12/d20/d100) — qualquer lado entre esses
// limites é válido, pedido explícito do Mozar. O teto em quantidade não foi pedido, é só
// salvaguarda de implementação (evita uma rolagem de milhares de dados travando o parser/UI).
const MIN_SIDES = 2;
const MAX_SIDES = 1000;
const MAX_COUNT = 1000;

const OPERATION_BY_KEYWORD: Record<string, DiceOperation> = {
  soma: 'sum',
  media: 'average',
  max: 'max',
  min: 'min',
  mult: 'multiply',
  sub: 'subtract',
  div: 'divide',
  vant: 'advantage',
  desv: 'disadvantage'
};

// Só o "NdM" tem posição fixa, sempre no começo (ex. "3d20"). Tudo que vem depois — palavra de
// operação (soma/media/max/min/mult/sub/div/vant/desv, com operando pra mult/sub/div), modificador
// +X/-X, e as tags "atk"/"un" — pode aparecer em qualquer ordem entre si (pedido do Mozar: "3d20+5
// vant" e "3d20+5 un vant" precisam funcionar, não só "3d20 vant +5"). O operando de mult/sub/div
// continua preso ao seu keyword (tem que vir logo depois dele), porque é parte da própria operação,
// não um token solto.
const CORE_RE = /^(\d{1,4})?d(\d{1,4})/i;
const OPERATION_KEYWORDS = new Set(Object.keys(OPERATION_BY_KEYWORD));

interface RestToken {
  kind: 'word' | 'number';
  text: string;
  // Só números com sinal explícito (+5/-5) podem virar modificador — um número solto sem sinal
  // e sem ser operando de mult/sub/div não tem onde encaixar na gramática (comando malformado).
  signed: boolean;
}

/** Quebra o texto depois do "NdM" em tokens de palavra/número, ignorando espaços entre eles.
 * Retorna null se sobrar algum caractere que não é letra, dígito, espaço, "+" ou "-" — comando
 * malformado, não uma variação válida de ordem. */
function tokenizeRest(rest: string): RestToken[] | null {
  const tokens: RestToken[] = [];
  let i = 0;
  while (i < rest.length) {
    if (/\s/.test(rest[i])) {
      i++;
      continue;
    }
    const remainder = rest.slice(i);
    const numberMatch = /^[+-]?\d+(?:\.\d+)?/.exec(remainder);
    if (numberMatch) {
      tokens.push({ kind: 'number', text: numberMatch[0], signed: /^[+-]/.test(numberMatch[0]) });
      i += numberMatch[0].length;
      continue;
    }
    const wordMatch = /^[a-z]+/i.exec(remainder);
    if (wordMatch) {
      tokens.push({ kind: 'word', text: wordMatch[0].toLowerCase(), signed: false });
      i += wordMatch[0].length;
      continue;
    }
    return null;
  }
  return tokens;
}

/** Reconhece e resolve um comando de dados de ponta a ponta (parse + RNG) — a mensagem inteira
 * precisa casar com a gramática (sem prefixo, mas também sem texto extra ao redor), senão retorna
 * null e o chamador trata como mensagem de chat normal. A rolagem em si (Math.random) acontece
 * aqui, uma única vez — quem chama isto é sempre o cliente de quem digitou o comando, nunca quem
 * só recebeu o resultado pela rede (ver webrtcMesh.ts's ChatMessage — o resultado já pronto é o
 * que trafega, ninguém mais re-rola). */
export function parseAndRollDiceCommand(text: string): DiceRollResult | null {
  const trimmed = text.trim();
  const coreMatch = CORE_RE.exec(trimmed);
  if (!coreMatch) return null;

  const [core, countRaw, sidesRaw] = coreMatch;
  const count = countRaw ? parseInt(countRaw, 10) : 1;
  const sides = parseInt(sidesRaw, 10);
  if (count < 1 || count > MAX_COUNT || sides < MIN_SIDES || sides > MAX_SIDES) return null;

  const tokens = tokenizeRest(trimmed.slice(core.length));
  if (!tokens) return null;

  let keyword: string | null = null;
  let operand: number | null = null;
  let modifier: number | null = null;
  let tag: DiceTag | null = null;
  let explicitUnit = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === 'word') {
      if (OPERATION_KEYWORDS.has(token.text)) {
        if (keyword !== null) return null; // duas palavras de operação no mesmo comando
        keyword = token.text;
        const needsOperand =
          OPERATION_BY_KEYWORD[keyword] === 'multiply' ||
          OPERATION_BY_KEYWORD[keyword] === 'subtract' ||
          OPERATION_BY_KEYWORD[keyword] === 'divide';
        if (needsOperand) {
          const next = tokens[i + 1];
          if (!next || next.kind !== 'number') return null; // operando tem que vir logo depois
          operand = Number(next.text);
          i++;
        }
      } else if (token.text === 'atk') {
        if (tag !== null) return null; // "atk" repetido
        tag = 'atk';
      } else if (token.text === 'un') {
        if (explicitUnit) return null; // "un" repetido
        explicitUnit = true;
      } else {
        return null; // palavra desconhecida
      }
    } else {
      if (!token.signed) return null; // número solto sem sinal e sem ser operando de mult/sub/div
      if (modifier !== null) return null; // modificador repetido
      modifier = Number(token.text);
    }
  }

  const operation: DiceOperation = keyword ? OPERATION_BY_KEYWORD[keyword] : 'sum';
  if (operation === 'divide' && operand === 0) return null;

  const rolls: number[] = [];
  for (let i = 0; i < count; i++) rolls.push(Math.floor(Math.random() * sides) + 1);

  const sum = rolls.reduce((total, roll) => total + roll, 0);
  let base: number;
  switch (operation) {
    case 'sum':
      base = sum;
      break;
    case 'average':
      base = sum / rolls.length;
      break;
    case 'max':
    case 'advantage':
      base = Math.max(...rolls);
      break;
    case 'min':
    case 'disadvantage':
      base = Math.min(...rolls);
      break;
    case 'multiply':
      base = sum * (operand as number);
      break;
    case 'subtract':
      base = sum - (operand as number);
      break;
    case 'divide':
      base = sum / (operand as number);
      break;
  }

  const total = modifier !== null ? base + modifier : base;

  // Padrão é somar (pedido do Mozar, corrigindo uma tentativa anterior que assumia o oposto) —
  // só entra em modo "por dado" com a tag "un" explícita. Não depende de ter modificador: "un"
  // sozinho já significa "mostra cada dado separado, sem somar entre si". Combina com um keyword
  // de operação (ex. "3d20+5 un vant") — o keyword ainda decide o cálculo/destaque (ex. qual dado
  // é o "vencedor"), "un" só troca a exibição do total agregado por cada dado com seu próprio
  // valor final.
  const perDie = explicitUnit && count > 1;

  return {
    raw: trimmed,
    count,
    sides,
    rolls,
    operation,
    operand,
    modifier,
    tag,
    // Só "media"/"div" produzem fração real — arredondado a 2 casas pra exibição, não afeta soma/
    // max/min/mult/sub que já são sempre inteiros.
    total: Math.round(total * 100) / 100,
    perDie,
    dieTotals: perDie
      ? rolls.map((value) => Math.round((value + (modifier ?? 0)) * 100) / 100)
      : null
  };
}

const OPERATION_LABEL: Record<DiceOperation, string> = {
  sum: 'soma',
  average: 'média',
  max: 'maior',
  min: 'menor',
  multiply: 'multiplicação',
  subtract: 'subtração',
  divide: 'divisão',
  advantage: 'vantagem',
  disadvantage: 'desvantagem'
};

export function formatDiceOperationLabel(operation: DiceOperation): string {
  return OPERATION_LABEL[operation];
}

/** [Bug corrigido, achado real pelo Mozar em teste] O cartão da rolagem mostrava os dados e o
 * total, mas nunca o operando/modificador em si — um "d20 +5" saindo "20" no dado e "= 25" no
 * total parecia um bug (conta não bate à primeira vista) quando na verdade a conta estava certa,
 * só o "+5" que nunca aparecia em lugar nenhum. Isto monta o texto que fecha essa lacuna (ex.
 * "× 5", "+5", "menor"), renderizado entre a lista de dados e o total (RoomChat.tsx) — null
 * quando não há nada a acrescentar (soma pura, sem modificador, a lista de dados já fala por si). */
export function formatRollDetail(roll: DiceRollResult): string | null {
  // O modificador já aparece embutido em cada dado (dieTotals) nesse modo — repeti-lo aqui como
  // "+5" agregado sugeriria (de novo) que ele se aplica a um total único, o próprio bug relatado.
  if (roll.perDie) return null;
  const parts: string[] = [];
  switch (roll.operation) {
    case 'multiply':
      parts.push(`× ${roll.operand}`);
      break;
    case 'subtract':
      parts.push(`− ${roll.operand}`);
      break;
    case 'divide':
      parts.push(`÷ ${roll.operand}`);
      break;
    case 'average':
      parts.push('média');
      break;
    case 'max':
    case 'advantage':
      parts.push('maior');
      break;
    case 'min':
    case 'disadvantage':
      parts.push('menor');
      break;
    case 'sum':
      break;
  }
  if (roll.modifier !== null) parts.push(roll.modifier >= 0 ? `+${roll.modifier}` : `${roll.modifier}`);
  return parts.length > 0 ? parts.join(' ') : null;
}

const TAG_LABEL: Record<DiceTag, string> = {
  atk: 'ataque'
};

export function formatDiceTagLabel(tag: DiceTag): string {
  return TAG_LABEL[tag];
}

/** Whether an individual die's value should be highlighted as the "winning" one for
 * advantage/max-style rolls (RoomChat.tsx — verde, sem interferir no realce de crítico do d20,
 * que tem sua própria regra abaixo e sempre tem prioridade visual quando os dois se sobrepõem). */
export function isWinningDie(roll: DiceRollResult, value: number): boolean {
  return (roll.operation === 'max' || roll.operation === 'advantage') && value === Math.max(...roll.rolls);
}

/** Same idea as isWinningDie, for disadvantage/min-style rolls (vermelho). */
export function isLosingDie(roll: DiceRollResult, value: number): boolean {
  return (roll.operation === 'min' || roll.operation === 'disadvantage') && value === Math.min(...roll.rolls);
}

/** d20 nato 20/1, independente da operação escolhida — decisions.md: sempre destacado, não
 * precisa da tag "atk" pra aparecer (confirmado pelo exemplo do Mozar, que mostrava crítico numa
 * rolagem "mult 6d20 5" sem nenhuma tag). Quando os dois aparecem na mesma rolagem (ex. 6d20 com
 * um 20 E um 1 entre os resultados), acerto crítico tem prioridade sobre falha — mesmo
 * comportamento do exemplo de referência. */
export function criticalCallout(roll: DiceRollResult): 'success' | 'failure' | null {
  if (roll.sides !== 20) return null;
  if (roll.rolls.includes(20)) return 'success';
  if (roll.rolls.includes(1)) return 'failure';
  return null;
}
