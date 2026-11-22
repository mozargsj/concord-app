# Starts the dev Electron elevated, like the installed app (requireAdministrator, since 0.0.95), so
# bugs that only exist elevated show up in dev too — e.g. the WGC window capture that never started
# (decisions.md §3). Windows asks for admin (UAC) on every run. Waits for Electron to exit, so
# `concurrently -k` in `npm run dev` also stops Vite when the window closes. The elevated process
# gets a fresh environment, so ELECTRON_RUN_AS_NODE from an editor terminal does not leak into it.
$ErrorActionPreference = 'Stop'
$client = Split-Path $PSScriptRoot -Parent
$electron = Resolve-Path (Join-Path $client '..\..\node_modules\electron\dist\electron.exe')
$process = Start-Process -FilePath $electron -ArgumentList 'out\electron\main\index.js' -WorkingDirectory $client -Verb RunAs -PassThru -Wait
exit $process.ExitCode
