const STORAGE_KEY = 'concord.testMode.identity';

export interface TestIdentity {
  email: string;
  nickname: string;
}

// [MODO TESTE — TEMPORÁRIO] Local-only, sem validação — só pra não ter que redigitar
// email/nickname toda vez que abre a build de teste. localStorage (não o mecanismo de sessão
// real via safeStorage) de propósito: é dado fake, não precisa de criptografia, e mesmo padrão
// já usado por lib/devicePreferences.ts.
export function getStoredTestIdentity(): TestIdentity | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TestIdentity>;
    if (typeof parsed.email === 'string' && typeof parsed.nickname === 'string') {
      return { email: parsed.email, nickname: parsed.nickname };
    }
    return null;
  } catch {
    return null;
  }
}

export function setStoredTestIdentity(identity: TestIdentity): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
}

export function clearStoredTestIdentity(): void {
  localStorage.removeItem(STORAGE_KEY);
}
