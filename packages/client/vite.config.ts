import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: 'src/renderer',
  envDir: __dirname,
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: '../../out/renderer',
    emptyOutDir: true
  }
});
