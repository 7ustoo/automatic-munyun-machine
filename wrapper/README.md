# AMM tray wrapper (v1.2)

Small native Go executable that owns the system-tray icon and supervises
the node bot as a child. Built once, ships as the user-facing AMM binary
on all three platforms.

- Windows: `AMM.exe` (~3.6 MB stripped, `-H windowsgui` so no console window)
- macOS: `AMM-darwin-arm64` + `AMM-darwin-amd64` (bundled into `AMM.app` by `scripts/build/mac.sh`)
- Linux: `amm-tray` (installed to `/opt/automatic-munyun-machine/bin/` by `scripts/build/deb.sh`)

## Build

Prerequisites: Go ≥ 1.21.
- Windows: `winget install GoLang.Go`
- macOS: `brew install go` (Xcode CLT also required for CGO)
- Linux: `apt install golang gcc libgtk-3-dev libayatana-appindicator3-dev`

```bash
cd wrapper
make build      # auto-detects your host platform and builds for it
```

**Important: cross-compilation is platform-locked.** `fyne.io/systray` uses
Cocoa on macOS and GTK on Linux, both of which require CGO. You CAN'T
build a Mac binary from Windows (and vice versa) without setting up an
OSXCross / MinGW toolchain. In practice each platform builds natively —
the release pipeline (`.github/workflows/release.yml`) uses a matrix
with `windows-latest`, `macos-latest`, `ubuntu-latest` runners so all
three binaries get built in parallel from real OSes.

Output lands in `wrapper/dist/`. Binaries are gitignored — built fresh
by CI on every release.

## Run (dev)

```bash
cd wrapper
go run .                            # launches tray, spawns node bot from ../scripts/telegram-bot.mjs
go run . --no-spawn                 # tray UI only (no bot)
go run . --bot-path=/other/path.mjs # custom bot path
go run . --version
```

The wrapper writes its own log to `data/wrapper.log` (alongside the
existing `telegram-bot.log` and `watchdog.log`). The "View logs" tray menu
item opens `telegram-bot.log`.

## Architecture

```
Task Scheduler / launchd / systemd
   ↓ (at logon)
AMM.exe (this binary — owns tray, supervises)
   ├─ goroutine: supervisor (spawn + watch node child, 3-strikes/hr respawn)
   ├─ goroutine: heartbeat poller (every 10s, updates icon color)
   ├─ goroutine: tray menu click handler
   └─ spawns: node scripts/telegram-bot.mjs (the actual bot)
                ↓ writes
                data/heartbeat.json
                ↑ also read by
                scripts/watchdog.mjs (unchanged, independent)
```

Tray icon states (read from `data/heartbeat.json`):
- 🟢 **green**: heartbeat < 5 min old → bot is healthy
- 🟡 **yellow**: 5-10 min old → stale, but not yet dead
- 🔴 **red**: ≥ 10 min old or missing → dead; watchdog should restart soon
- ⚫ **gray**: wrapper starting up (initial state before first heartbeat read)

Stale thresholds mirror `scripts/watchdog.mjs:42` so wrapper and watchdog
agree on "dead." Restart-throttle math (3 strikes per hour) mirrors
`scripts/watchdog.mjs:43-44`.

## Single-instance lock

The wrapper writes its PID to `data/wrapper.lock` on startup. If another
wrapper is already running with a live PID at that path, the new instance
exits cleanly (exit 0) to avoid double-tray-icons. This prevents the race
where Task Scheduler restarts AMM.exe while a healthy wrapper is still
alive (see plan risk #4).

## File layout

| File | Purpose |
|---|---|
| `main.go` | Entry point, flag parsing, install-dir + bot-path resolution |
| `supervisor.go` | Spawn + watch node child + 3-strikes/hr respawn throttle |
| `tray.go` | Menu definition, click dispatch, heartbeat poller, icon color |
| `actions.go` | Implementations of tray menu items (scrape, pause, telegram, logs, folder, restart, quit) |
| `singleinstance.go` | PID-based single-instance lock at `data/wrapper.lock` |
| `icons.go` | `//go:embed` of the 4 icon states (×2 formats: ICO for Windows, PNG for Mac/Linux) |
| `platform_windows.go` | Win32-specific: hide child console, kill semantics |
| `platform_unix.go` | POSIX-specific: SIGTERM, process group |

## Dependencies

Only one third-party Go dep: `fyne.io/systray` (cross-platform tray library
— Windows + macOS menubar + Linux StatusNotifier). Pulls in
`github.com/godbus/dbus/v5` and `golang.org/x/sys` transitively.

Pure Go, CGO disabled — cross-compiles trivially from any host.
