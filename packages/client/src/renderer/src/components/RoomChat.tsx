import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Dices, RotateCcw, Send } from 'lucide-react';
import type { ChatMessage } from '../lib/webrtcMesh';
import {
  criticalCallout,
  formatDiceOperationLabel,
  formatDiceTagLabel,
  formatRollDetail,
  isLosingDie,
  isWinningDie
} from '../lib/diceRoller';
import '../styles/RoomChat.css';

interface RoomChatProps {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  onReroll: (messageId: string, text: string) => void;
  currentUserId: string;
}

// Nome/ícone do "bot" que responde as rolagens — pedido do Mozar: o resultado aparece como se
// fosse mais um participante na sala (igual às referências de bot de Discord que ele mostrou),
// não como se a própria pessoa tivesse escrito o resultado. O comando em si (o texto que a pessoa
// digitou) continua sendo dela — só a RESPOSTA da rolagem é que assume essa identidade separada.
const BOT_NAME = 'Mesa de Dados';

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/** Rótulo pequeno acima da rolagem — operação (quando não é a soma padrão) + tag opcional
 * ("atk"), ex. "vantagem" ou "ataque · vantagem". */
function rollSubtitle(roll: NonNullable<ChatMessage['roll']>): string | null {
  const parts: string[] = [];
  if (roll.tag) parts.push(formatDiceTagLabel(roll.tag));
  if (roll.operation !== 'sum') parts.push(formatDiceOperationLabel(roll.operation));
  // Deixa explícito que os dados não foram somados entre si — mesmo motivo do formatRollDetail:
  // sem isso, "3d20+5 un" mostrando cada dado lado a lado parece rolagem crua não processada.
  if (roll.perDie) {
    parts.push(roll.modifier !== null ? `cada ${roll.modifier >= 0 ? '+' : ''}${roll.modifier}` : 'individual');
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

function RollCard({
  message,
  onReroll
}: {
  message: ChatMessage;
  onReroll: (messageId: string, text: string) => void;
}) {
  const roll = message.roll;
  if (!roll) return null;
  const callout = criticalCallout(roll);
  const subtitle = rollSubtitle(roll);
  const detail = formatRollDetail(roll);

  return (
    <div className="room-chat__bot-message">
      <div className="room-chat__bot-avatar">
        <Dices size={16} />
      </div>
      <div className="room-chat__bot-body">
        <div className="room-chat__bot-header">
          <span className="room-chat__bot-name">{BOT_NAME}</span>
          <span className="room-chat__bot-tag">BOT</span>
          <span className="room-chat__message-time">{formatTime(message.sentAt)}</span>
        </div>
        <p className="room-chat__roll-attribution">
          <strong>{message.displayName}</strong> rolou {roll.count}d{roll.sides}
          {subtitle ? ` (${subtitle})` : ''}
        </p>
        <div className={'room-chat__roll' + (callout ? ` room-chat__roll--${callout}` : '')}>
          {/* Sem total agregado no modo perDie — cada dado já é seu próprio resultado final
              (raw + modificador), não faz sentido somá-los num único número em destaque. */}
          {!roll.perDie && <div className="room-chat__roll-total">{roll.total}</div>}
          <div className={'room-chat__roll-dice' + (roll.perDie ? ' room-chat__roll-dice--primary' : '')}>
            {roll.rolls.map((value, index) => (
              <span
                key={index}
                className={
                  'room-chat__roll-die' +
                  (roll.sides === 20 && value === 20 ? ' room-chat__roll-die--crit' : '') +
                  (roll.sides === 20 && value === 1 ? ' room-chat__roll-die--fail' : '') +
                  (isWinningDie(roll, value) ? ' room-chat__roll-die--winner' : '') +
                  (isLosingDie(roll, value) ? ' room-chat__roll-die--loser' : '')
                }
              >
                {roll.perDie ? roll.dieTotals![index] : value}
                {/* Conta embaixo do resultado final de cada dado ("4+5") — só no modo "un" com
                    modificador, senão dieTotals já é igual a value e não há conta a mostrar. */}
                {roll.perDie && roll.modifier !== null && (
                  <small className="room-chat__roll-die-raw">
                    {value}
                    {roll.modifier >= 0 ? '+' : ''}
                    {roll.modifier}
                  </small>
                )}
              </span>
            ))}
          </div>
          {detail && <div className="room-chat__roll-detail">{detail}</div>}
          {callout && (
            <div className={'room-chat__roll-callout room-chat__roll-callout--' + callout}>
              {callout === 'success' ? 'ACERTO CRÍTICO' : 'FALHA CRÍTICA'}
            </div>
          )}
        </div>
        <button type="button" className="room-chat__reroll" onClick={() => onReroll(message.id, message.text)}>
          <RotateCcw size={13} />
          Re-rolar
        </button>
      </div>
    </div>
  );
}

/** Per-room text chat (decisions.md — "Bots nativos", bot de dados). P2P/live-only enquanto
 * alguém está na sala (com backfill entre peers e cópia local criptografada — ver
 * useRoomConnection.ts), zero histórico persistido depois que a pessoa sai. */
export default function RoomChat({ messages, onSend, onReroll, currentUserId }: RoomChatProps) {
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  // Sticks to the bottom on every new message — this panel has no "scrolled up reading history"
  // affordance yet (messages are capped at 200 and live-only), so always-follow is the right
  // default for now.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setDraft('');
  }

  return (
    <aside className="room-chat">
      <div className="room-chat__list" ref={listRef}>
        {messages.length === 0 && (
          <p className="room-chat__empty">
            Nenhuma mensagem ainda. Digite <code>d20</code> pra rolar um dado.
          </p>
        )}
        {messages.map((message) =>
          message.roll ? (
            <RollCard key={message.id} message={message} onReroll={onReroll} />
          ) : (
            <div
              key={message.id}
              className={
                'room-chat__message' + (message.userId === currentUserId ? ' room-chat__message--self' : '')
              }
            >
              <div className="room-chat__message-header">
                <span className="room-chat__message-name">{message.displayName}</span>
                <span className="room-chat__message-time">{formatTime(message.sentAt)}</span>
              </div>
              <p className="room-chat__message-text">{message.text}</p>
            </div>
          )
        )}
      </div>

      <form className="room-chat__composer" onSubmit={handleSubmit}>
        <input
          className="room-chat__input"
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Mensagem, ou d20…"
        />
        <button type="submit" className="room-chat__send" disabled={!draft.trim()} title="Enviar">
          <Send size={16} />
        </button>
      </form>
    </aside>
  );
}
