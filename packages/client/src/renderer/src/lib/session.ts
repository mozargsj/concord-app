export async function getStoredSessionToken(): Promise<string | null> {
  return window.concord.session.load();
}

export async function setStoredSessionToken(token: string): Promise<void> {
  await window.concord.session.save(token);
}

export async function clearStoredSessionToken(): Promise<void> {
  await window.concord.session.clear();
}
