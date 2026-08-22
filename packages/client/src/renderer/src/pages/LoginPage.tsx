import Button from '../components/Button';
import logo from '../assets/images/logo.svg';
import '../styles/LoginPage.css';

interface LoginPageProps {
  onContinue: () => void;
}

export default function LoginPage({ onContinue }: LoginPageProps) {
  return (
    <div className="login-page">
      <div className="login-page__card">
        <img src={logo} alt="Concord" className="login-page__logo" />
        <h1 className="login-page__title">Concord</h1>
        <p className="login-page__subtitle">Áudio ao vivo e transmissão de tela, P2P.</p>

        <Button className="login-page__google-button" onClick={onContinue}>
          Entrar com Google
        </Button>

        <p className="login-page__disclaimer">
          Login ainda não é funcional — este botão só avança a pré-visualização.
        </p>
      </div>
    </div>
  );
}
