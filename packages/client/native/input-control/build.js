#!/usr/bin/env node
// Rebuilds the input-control native addon against Electron's own ABI — same reasoning and same
// shape as ../process-loopback/build.js (read its header for the full story). Windows-only: the
// binding.gyp reduces to a no-op target elsewhere and this script just skips node-gyp there.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

if (process.platform !== 'win32') {
  console.log('[input-control] skipping native build (Windows-only feature)');
  process.exit(0);
}

const electronVersion = require('electron/package.json').version;
const nativeDir = __dirname;

console.log(`[input-control] rebuilding native addon for Electron ${electronVersion} (${process.arch})`);

const nodeGypBin = require.resolve('node-gyp/bin/node-gyp.js');

execFileSync(
  process.execPath,
  [
    nodeGypBin,
    'rebuild',
    `--target=${electronVersion}`,
    `--arch=${process.arch}`,
    '--dist-url=https://electronjs.org/headers',
    ...(process.env.PYTHON ? [`--python=${process.env.PYTHON}`] : [])
  ],
  { cwd: nativeDir, stdio: 'inherit' }
);

console.log('[input-control] build complete:', path.join(nativeDir, 'build', 'Release', 'input_control.node'));
