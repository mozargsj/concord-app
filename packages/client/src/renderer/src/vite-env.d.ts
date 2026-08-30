/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SIGNALING_URL: string;
  /** [MODO TESTE — TEMPORÁRIO] Ver lib/api.ts. */
  readonly VITE_TEST_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Baked in at build time from package.json's "version" — see vite.config.ts's `define`. */
declare const __APP_VERSION__: string;

/** Baked in at build time from Vite's own `mode` — "release" for a real `vite build` (no
 * --mode), "dev" for every other profile (plain `vite`/dev server, test-dev, test-real) — see
 * vite.config.ts's `define`. Lets a running build be told apart at a glance (TitleBar.tsx)
 * without needing a "Sobre" screen. */
declare const __APP_BUILD_TAG__: 'release' | 'dev';
