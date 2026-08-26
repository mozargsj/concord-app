#!/usr/bin/env node
// Rebuilds the process-loopback native addon against Electron's own ABI (not plain Node's —
// Electron ships its own V8/Node build, so a module compiled against system Node's headers
// would load-fail with an ABI mismatch inside the packaged app). Windows-only feature — the
// addon's binding.gyp already reduces to a no-op target on other platforms, and this script
// just skips invoking node-gyp there instead of failing the whole `npm run build`.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

if (process.platform !== 'win32') {
  console.log('[process-loopback] skipping native build (Windows-only feature)');
  process.exit(0);
}

const electronVersion = require('electron/package.json').version;
const nativeDir = __dirname;

console.log(`[process-loopback] rebuilding native addon for Electron ${electronVersion} (${process.arch})`);

// Invoking node-gyp's own JS entry point directly via process.execPath (rather than shelling
// out to the npx.cmd wrapper) sidesteps an EINVAL that spawnSync hits against .cmd files under
// some shells/environments (e.g. Git Bash on Windows) with no functional downside here.
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

console.log('[process-loopback] build complete:', path.join(nativeDir, 'build', 'Release', 'process_loopback.node'));
