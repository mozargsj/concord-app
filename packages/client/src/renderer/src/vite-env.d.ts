/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SIGNALING_URL: string;
  /** [MODO TESTE — TEMPORÁRIO] Ver lib/api.ts. */
  readonly VITE_TEST_MODE?: string;
  /** [MODO TESTE OFFLINE — TEMPORÁRIO] Ver lib/api.ts. */
  readonly VITE_TEST_OFFLINE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
