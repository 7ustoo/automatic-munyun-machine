; Inno Setup script for Automatic Munyun Machine v1.0
; Build with: iscc installer\amm.iss
; Output: installer\dist\amm-setup-vX.Y.Z.exe (unsigned for v1.0; code-signing arrives in v1.1).
;
; Requires Inno Setup 6.x — https://jrsoftware.org/isinfo.php

#define MyAppName "Automatic Munyun Machine"
#define MyAppShort "amm"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Justin Williams"
#define MyAppURL "https://github.com/7ustoo/automatic-munyun-machine"
#define MyAppExeName "node.exe"

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
UninstallDisplayIcon={app}\node_modules\.bin\node.exe
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
Name: "{group}\{#MyAppName}"; Filename: "{app}\scripts\start-bot.cmd"
Name: "{group}\Setup wizard"; Filename: "{app}\scripts\setup-wizard.mjs"
Name: "{group}\Uninstall"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\scripts\start-bot.cmd"; Tasks: desktopicon

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
