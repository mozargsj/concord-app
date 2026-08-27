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

/** Baked in at build time from package.json's "version" — see vite.config.ts's `define`. */
declare const __APP_VERSION__: string;
