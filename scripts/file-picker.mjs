#!/usr/bin/env node
// Windows native file-picker dialog spawned from PowerShell.
//
// Returns the absolute path of the selected file, or null if the user
// cancelled. Throws if PowerShell is unavailable or the dialog fails to
// open (e.g. no GUI session). Caller should fall back to typed-path input.

import { spawn } from 'node:child_process';
import path from 'node:path';

const POWERSHELL = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
);

const SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dlg = New-Object System.Windows.Forms.OpenFileDialog
$dlg.Filter = 'Resumes (*.pdf;*.docx;*.md;*.txt)|*.pdf;*.docx;*.md;*.txt|All files (*.*)|*.*'
$dlg.Title = 'Select your resume'
$dlg.Multiselect = $false
$dlg.CheckFileExists = $true
if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dlg.FileName
} else {
  exit 2
}
`.trim();

export async function pickResumeFile() {
  return new Promise((resolve, reject) => {
    const child = spawn(POWERSHELL, ['-NoProfile', '-STA', '-Command', SCRIPT], {
      windowsHide: true
    });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', e => reject(new Error('File picker unavailable: ' + e.message)));
    child.on('exit', code => {
      if (code === 0) {
        const picked = out.trim();
        if (picked) resolve(picked);
        else resolve(null);
      } else if (code === 2) {
        resolve(null);
      } else {
        reject(new Error(`File picker exit ${code}: ${err.trim() || '(no stderr)'}`));
      }
    });
  });
}
