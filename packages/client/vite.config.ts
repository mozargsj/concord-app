import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgVersion = (JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8')) as { version: string })
  .version;

export default defineConfig(({ mode }) => ({
  root: 'src/renderer',
  envDir: __dirname,
  base: './',
  define: {
    // Baked in at build time from package.json — shown in the title bar (TitleBar.tsx) so a
    // build can be identified at a glance without opening a "Sobre" screen (not implemented yet).
    __APP_VERSION__: JSON.stringify(pkgVersion),
    // [Feature nova, pedido do Mozar] "release" só pro build de produção de verdade (`vite build`
    // sem --mode, que Vite já resolve pra mode 'production' sozinho) — qualquer outro perfil (dev
    // server sem --mode, 'development'; test-dev; test-real, os dois via `--mode`) vira "dev". Só
    // isso já distingue visualmente uma instalação de teste de uma release real na title bar,
    // sem precisar ler qual profile foi usado pra empacotar.
    __APP_BUILD_TAG__: JSON.stringify(mode === 'production' ? 'release' : 'dev')
  },
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: '../../out/renderer',
    emptyOutDir: true
  }
}));
