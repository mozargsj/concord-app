import { ipcMain } from 'electron';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

// Smart App Control status isn't exposed by any public Windows API — this reads the same
// registry value third-party status checkers use. HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy
// \VerifiedAndReputablePolicyState: 0 = Off, 1 = On (Enforced), 2 = Evaluation. Missing key/value
// (older Windows, or a machine that never had SAC) is treated as inactive — nothing to warn about.
const execAsync = promisify(exec);
const REG_PATH = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy';
const REG_VALUE = 'VerifiedAndReputablePolicyState';

async function readSmartAppControlActive(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    const { stdout } = await execAsync(`reg query "${REG_PATH}" /v ${REG_VALUE}`);
    const match = stdout.match(/VerifiedAndReputablePolicyState\s+REG_DWORD\s+0x([0-9a-fA-F]+)/);
    if (!match) return false;
    return parseInt(match[1], 16) !== 0;
  } catch {
    return false;
  }
}

ipcMain.handle('smart-app-control:is-active', () => readSmartAppControlActive());
