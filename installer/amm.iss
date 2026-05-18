; Inno Setup script for Automatic Munyun Machine v1.2
; Build with: iscc installer\amm.iss
; Output: installer\dist\amm-setup-vX.Y.Z.exe
;
; v1.2: ships AMM.exe (Go tray wrapper) as the user-facing launcher.
; Start menu, desktop shortcut, and Add/Remove Programs all point at the
; wrapper instead of start-bot.cmd. Wrapper binary must be built BEFORE
; running iscc — see CI release.yml or `cd wrapper && make build`.
;
; Code signing: build the wrapper, sign it (scripts/build/sign-windows.ps1),
; THEN run iscc, THEN sign the resulting installer .exe. Both signatures
; are required for SmartScreen reputation.
;
; Requires Inno Setup 6.x — https://jrsoftware.org/isinfo.php

#define MyAppName "Automatic Munyun Machine"
#define MyAppShort "amm"
; MyAppVersion is normally injected by CI via `iscc /DMyAppVersion=X.Y.Z` so
; the installer filename always tracks package.json. The literal below is
; only a fallback for someone running `iscc` directly on a dev box — leave
; it pointing at the current release branch so local builds still produce
; a sensibly-named .exe.
#ifndef MyAppVersion
  #define MyAppVersion "1.3.0"
#endif
#define MyAppPublisher "Justin Williams"
#define MyAppURL "https://github.com/7ustoo/automatic-munyun-machine"
#define MyAppExeName "AMM.exe"

; Preprocess-time check: the wrapper binary must exist before we package.
; This catches the most common build mistake (running `iscc` without first
; running `cd wrapper && make build`) at the right time — Inno Setup
; preprocess — instead of failing at the user's install time.
#if !FileExists(AddBackslash(SourcePath) + "..\wrapper\dist\AMM.exe")
  #error "wrapper\dist\AMM.exe not found. Build it first: cd wrapper && make build"
#endif

[Setup]
AppId={{E5E1A8C0-AMM1-4FA0-9C5E-AUTOMATICMUNYUN}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
AppUpdatesURL={#MyAppURL}/releases
DefaultDirName={localappdata}\automatic-munyun-machine
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
LicenseFile=..\LICENSE
OutputDir=dist
OutputBaseFilename=amm-setup-v{#MyAppVersion}
Compression=lzma
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\wrapper\dist\AMM.exe
UninstallFilesDir={app}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; Ship the entire repo under {app}. Source path is one level up since the .iss
; lives in installer/. Excludes are hardcoded in [Files] vs npm-install at
; runtime (see [Run] below).
Source: "..\*"; DestDir: "{app}"; \
  Excludes: "node_modules\*,data\*,.env,.env.*,*.log,installer\dist\*,.git\*,.github\*,.claude\*,*.zip,*.tmp"; \
  Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; v1.2: Start menu + desktop shortcuts launch AMM.exe (the Go tray wrapper),
; which owns the system-tray icon and supervises the node bot.
Name: "{group}\{#MyAppName}"; Filename: "{app}\wrapper\dist\AMM.exe"; IconFilename: "{app}\wrapper\dist\AMM.exe"
Name: "{group}\Setup wizard"; Filename: "{app}\scripts\setup-wizard.mjs"
Name: "{group}\Uninstall"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\wrapper\dist\AMM.exe"; IconFilename: "{app}\wrapper\dist\AMM.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional tasks:"; Flags: unchecked

[Run]
; Post-install: install npm deps + Playwright Chromium + run the wizard.
Filename: "cmd.exe"; \
  Parameters: "/C ""npm install --no-audit --no-fund && npx playwright install chromium"""; \
  WorkingDir: "{app}"; \
  StatusMsg: "Installing dependencies (this may take a few minutes)…"; \
  Flags: runhidden waituntilterminated

Filename: "node.exe"; \
  Parameters: """{app}\scripts\setup-wizard.mjs"""; \
  WorkingDir: "{app}"; \
  Description: "Run the {#MyAppName} setup wizard"; \
  Flags: postinstall nowait

[UninstallRun]
; v1.0 E6 — call uninstall.mjs in wipe mode so Add/Remove Programs gives
; the user a real cleanup, not just an "uninstall" that leaves the bot
; running and the secrets on disk.
Filename: "node.exe"; \
  Parameters: """{app}\scripts\uninstall.mjs"" --mode=wipe"; \
  WorkingDir: "{app}"; \
  Flags: runhidden

[UninstallDelete]
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\data"
Type: filesandordirs; Name: "{app}"
