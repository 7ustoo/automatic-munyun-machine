#!/usr/bin/env node
// Cross-platform native file-picker dialog (v1.1).
//
// Branches by platform:
//   Win32  → PowerShell + System.Windows.Forms.OpenFileDialog
//   Darwin → osascript "choose file with prompt"
//   Linux  → zenity --file-selection (GTK), kdialog (KDE), or null fallback
//
// Returns the absolute path of the selected file, or null if the user
// cancelled / no GUI is available. Caller should fall back to typed-path
// input on null.

import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { POWERSHELL, OSASCRIPT, ZENITY, KDIALOG, IS_WIN32, IS_DARWIN, IS_LINUX } from './os-paths.mjs';

const PS_SCRIPT = `
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

// AppleScript: returns a POSIX path. Cancel raises NSError → exit non-zero.
const OSA_SCRIPT = `try
  set f to choose file with prompt "Select your resume" of type {"pdf", "docx", "md", "txt", "markdown"}
  return POSIX path of f
on error number -128
  return ""
end try`;

// 5-min ceiling (v2.0): a wedged dialog (broken GUI session, hung backend)
// used to freeze the setup wizard forever. Long enough that nobody browsing
// for their resume gets cut off; finite so the wizard can fall back to
// typed-path input.
const PICKER_TIMEOUT_MS = 5 * 60 * 1000;

function runChild(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error('File picker timed out after 5 minutes'));
    }, PICKER_TIMEOUT_MS);
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', e => { clearTimeout(timer); reject(new Error('File picker unavailable: ' + e.message)); });
    child.on('exit', code => {
      clearTimeout(timer);
      const trimmed = out.trim();
      if (code === 0) resolve(trimmed || null);
      else if (code === 2 || (cmd.endsWith('osascript') && trimmed === '')) resolve(null);
      else reject(new Error(`File picker exit ${code}: ${err.trim() || '(no stderr)'}`));
    });
  });
}

export async function pickResumeFile() {
  if (IS_WIN32) {
    if (!POWERSHELL) return null;
    return runChild(POWERSHELL, ['-NoProfile', '-STA', '-Command', PS_SCRIPT]);
  }
  if (IS_DARWIN) {
    if (!OSASCRIPT) return null;
    return runChild(OSASCRIPT, ['-e', OSA_SCRIPT]);
  }
  if (IS_LINUX) {
    if (ZENITY) {
      return runChild(ZENITY, [
        '--file-selection',
        '--title=Select your resume',
        '--file-filter=Resumes (pdf, docx, md, txt) | *.pdf *.docx *.md *.txt *.markdown',
        '--file-filter=All files | *'
      ]);
    }
    if (KDIALOG) {
      return runChild(KDIALOG, ['--getopenfilename', os.homedir(),
        '*.pdf *.docx *.md *.txt *.markdown|Resumes\n*|All files']);
    }
    // No GUI dialog backend — caller falls back to typed-path input.
    return null;
  }
  return null;
}
