import Button from './Button';
import '../styles/NativeLoopbackHelpModal.css';

interface NativeLoopbackHelpModalProps {
  onClose: () => void;
}

export default function NativeLoopbackHelpModal({ onClose }: NativeLoopbackHelpModalProps) {
  return (
    <div className="native-loopback-help__backdrop" onClick={onClose}>
      <div className="native-loopback-help" onClick={(event) => event.stopPropagation()}>
        <header className="native-loopback-help__header">
          <h2>Recursos avançados de áudio bloqueados</h2>
        </header>

        <p className="native-loopback-help__intro">
          O Windows tem uma proteção chamada Smart App Control que pode bloquear um addon nativo
          usado por dois recursos do Concord: a correção de eco ao incluir áudio do sistema na
          transmissão de tela, e o "Compartilhar áudio" de um app específico. Ativar esses recursos
          exige um passo manual — não é o Concord pedindo permissão, é uma configuração do próprio
          Windows.
        </p>

        <ol className="native-loopback-help__steps">
          <li>Abra as Configurações do Windows → Privacidade e segurança → Segurança do Windows</li>
          <li>Clique em "Controle de aplicativos e navegador"</li>
          <li>Clique em "Controle Inteligente de Aplicativos"</li>
          <li>Selecione "Desativado"</li>
          <li>Feche e abra o Concord de novo</li>
        </ol>

        <p className="native-loopback-help__warning">
          Isso desliga essa proteção do Windows por completo, não só pro Concord — o Smart App
          Control não tem opção de confiar só num aplicativo específico. É reversível a qualquer
          momento pela mesma tela.
        </p>

        <p className="native-loopback-help__fallback">
          Sem esse passo, a transmissão de tela com áudio do sistema continua funcionando
          normalmente — só sem a correção de eco. Já o "Compartilhar áudio" de um app específico
          não tem alternativa: depende diretamente desse addon pra funcionar.
        </p>

        <div className="native-loopback-help__actions">
          <Button variant="primary" onClick={onClose}>
            Entendi
          </Button>
        </div>
      </div>
    </div>
  );
}
