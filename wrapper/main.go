// Package main is the AMM tray wrapper — a small native executable that
// owns the system-tray icon and supervises the node bot as a child.
//
// User-visible identity: AMM.exe (Windows) / AMM.app (macOS menubar) /
// amm-tray (Linux). Task Manager / Start menu / Apps & Features all see
// "Automatic Munyun Machine" instead of node.exe or cmd.exe.
//
// Build: cd wrapper && go build -ldflags="-H windowsgui -s -w" -o dist/AMM.exe .
// Cross-platform builds via the Makefile in this directory.
//
// Architecture (see ../.planning/wonderful-now-time-to-quirky-pizza.md):
//
//	Task Scheduler / launchd / systemd
//	   ↓ at logon
//	AMM.exe  (this binary — owns tray + supervises)
//	   ↓ spawns
//	node scripts/telegram-bot.mjs  (bot, unchanged from v1.1)
//	   ↓
//	data/heartbeat.json
//	   ↑ read by
//	scripts/watchdog.mjs  (independent, unchanged)
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"fyne.io/systray"
)

// AMMVersion is the wrapper version string. Bumped in lockstep with package.json.
// Kept here (not read from package.json at runtime) so the binary is self-
// contained — no need to know where the install dir lives just to render a
// tooltip.
//
// Declared as `var` (not `const`) so the Makefile / CI can inject the
// authoritative package.json version via `-ldflags "-X main.AMMVersion=..."`.
// Go's -X linker flag only patches package-level vars; constants are inlined
// at compile time and silently ignore -X. Without this, every release built
// since the wrapper landed would have shipped with whatever string happened
// to be on this line.
var AMMVersion = "7.1.0"

// CLI flags. The wrapper is usually invoked with no args from Task Scheduler /
// launchd / systemd; the flags exist for manual debugging.
var (
	flagBotPath    = flag.String("bot-path", "", "Path to scripts/telegram-bot.mjs (default: auto-detect relative to wrapper binary)")
	flagInstallDir = flag.String("install-dir", "", "AMM install directory (default: parent of wrapper binary's dir)")
	flagNoSpawn    = flag.Bool("no-spawn", false, "Don't spawn the node bot — useful for testing tray UI in isolation")
	flagVersion    = flag.Bool("version", false, "Print version and exit")
	// v2.2: the desktop shortcut launches with no flag → the dashboard opens
	// as an app window. The login auto-start task passes --background → it
	// starts quietly in the tray without stealing a window every boot.
	flagBackground = flag.Bool("background", false, "Start in the tray without opening the dashboard window (used by the login auto-start task)")
	// v2.9: the auto-updater relaunches with --after-update. A fresh in-place
	// upgrade means the dashboard HTTP server can lag a beat behind process
	// start; opening the app window immediately would race it and land the user
	// in the tray with no window (the reported bug). This flag makes launch wait
	// for the dashboard to actually serve before opening the window.
	flagAfterUpdate = flag.Bool("after-update", false, "Relaunched by the auto-updater: wait for the dashboard to be ready, then open its window")
	// v6.0: internal child mode used by openAppWindow on Windows. It owns the
	// native WebView2 window and exits when that window closes. Keeping it out
	// of the primary process avoids competing with systray's main-thread loop.
	flagWindowHost  = flag.Bool("window-host", false, "Internal: host the native dashboard window")
	flagWindowURL   = flag.String("window-url", "", "Internal: loopback dashboard URL for --window-host")
	flagWindowReady = flag.String("window-ready-file", "", "Internal: native window startup handshake path")
	// v8.3: Task Scheduler launches the GUI-subsystem wrapper for one-shot
	// background work instead of launching cmd.exe/node.exe directly. That
	// keeps scheduled jobs completely console-free on Windows.
	flagScheduledTask = flag.String("scheduled-task", "", "Internal: run daily, watchdog, or batch-missed without starting the tray")
)

func main() {
	flag.Parse()

	if *flagVersion {
		fmt.Printf("AMM tray wrapper v%s (%s/%s)\n", AMMVersion, runtime.GOOS, runtime.GOARCH)
		os.Exit(0)
	}

	if *flagScheduledTask != "" {
		installDir, err := resolveInstallDir(*flagInstallDir)
		if err != nil {
			os.Exit(2)
		}
		os.Exit(runScheduledHelper(installDir, *flagScheduledTask))
	}

	// Native window children deliberately bypass logging setup, the
	// single-instance lock, dashboard startup, supervisor, and tray. The
	// child reports readiness only after WebView2 has initialized; the
	// primary process owns browser fallback if this child fails or times out.
	if *flagWindowHost {
		installDir, err := resolveInstallDir(*flagInstallDir)
		if err != nil || *flagWindowURL == "" || *flagWindowReady == "" {
			os.Exit(2)
		}
		if !runNativeWindowHost(installDir, *flagWindowURL, *flagWindowReady) {
			os.Exit(3)
		}
		return
	}

	// Resolve install dir + bot path. Single-instance check + log setup
	// happens before tray init so a failure there exits cleanly without
	// flashing a half-initialized tray icon.
	installDir, err := resolveInstallDir(*flagInstallDir)
	if err != nil {
		fatal("Could not locate install directory: %v", err)
	}
	botPath := resolveBotPath(*flagBotPath, installDir)

	// Set up logging to data/wrapper.log so anything the wrapper says is
	// findable from "View logs" in the tray menu, alongside telegram-bot.log
	// and watchdog.log.
	logFile, err := openLogFile(installDir)
	if err != nil {
		// Don't fatal — log to stderr if we can't open the file, but keep going.
		log.SetOutput(os.Stderr)
		log.Printf("Could not open wrapper log: %v (continuing to stderr)", err)
	} else {
		log.SetOutput(logFile)
		defer logFile.Close()
	}
	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds)
	log.Printf("=== AMM wrapper v%s starting (pid=%d, %s/%s) ===", AMMVersion, os.Getpid(), runtime.GOOS, runtime.GOARCH)
	log.Printf("install_dir=%s", installDir)
	log.Printf("bot_path=%s", botPath)

	// Single-instance guard. If another AMM is already running, hand off to
	// it; if it turns out to be unresponsive, take over. This prevents both
	// the double-tray-icon scenario (watchdog restart racing a healthy
	// wrapper) AND the v2.3 "double-click does nothing" scenario (a stale or
	// pre-v2.2 instance holds the lock but can't show a window).
	released, err := acquireSingleInstanceLock(installDir)
	if err != nil {
		if *flagBackground {
			// Login auto-start racing a live instance — the healthy case.
			log.Printf("Single-instance lock failed: %v — another AMM is running. Exiting.", err)
			os.Exit(0)
		}
		// Foreground double-click: surface the running instance's dashboard.
		log.Printf("Another AMM instance is running — opening its dashboard window.")
		if openAppWindowForRunningInstance(installDir) {
			os.Exit(0)
		}
		// v2.4: the running instance can't show a window (old binary from
		// before the port file existed — upgrades used to leave the old exe
		// running — or a crashed dashboard). Take over: kill its process
		// tree (also frees the Telegram token from its bot child), grab the
		// lock, and continue starting up as the primary. The window opens
		// through the normal launch path below.
		log.Printf("Running instance is unresponsive — taking over as primary.")
		if pid := readLockPID(installDir); pid > 0 && pid != os.Getpid() {
			killProcessTree(pid)
		}
		_ = os.Remove(filepath.Join(installDir, "data", "wrapper.lock"))
		released, err = acquireSingleInstanceLock(installDir)
		if err != nil {
			log.Printf("Takeover failed (%v) — giving up.", err)
			os.Exit(0)
		}
	}
	defer released()

	// First-run UX: "needs setup" means the wizard hasn't run yet (no
	// config.json). v2.1 decouples this from Telegram — Telegram is now
	// optional, so "set up" no longer requires a bot token. The tray shows
	// "Run setup wizard" until config.json exists; once it does, the bot
	// supervisor starts (and itself idles unless Telegram is enabled).
	needsSetup := !isSetUp(installDir)
	if needsSetup {
		log.Printf("config.json missing — entering 'needs setup' state. User must click 'Run setup wizard' from the tray.")
	}

	// Supervisor runs in its own goroutine. It supervises the node bot poller
	// ONLY while Telegram is enabled (.env has a token); when Telegram is off
	// it idles, so a desktop-only install has a quiet, healthy wrapper with no
	// crash-looping token-less bot. The supervisor + tray + dashboard share it.
	sup := newSupervisor(botPath, installDir)
	if !*flagNoSpawn && !needsSetup {
		go sup.runForever()
	} else if *flagNoSpawn {
		log.Printf("--no-spawn set: skipping node bot spawn (tray-only test mode)")
	}

	// v1.3: localhost dashboard. Starts in any state (configured or not) so
	// users without a heartbeat yet can still see "no heartbeat" instead of
	// nothing. v2.1: it's now the primary control surface (Scrape now, set up
	// Telegram), so it takes the supervisor handle to start/stop the bot.
	dash, dashErr := startDashboard(installDir, sup)
	if dashErr != nil {
		log.Printf("dashboard: failed to start (%v) — tray menu item will be disabled", dashErr)
	}

	// v2.2: open the dashboard as an app window on launch, UNLESS we were
	// started in the background (the login auto-start task). So: double-click
	// the desktop icon → the window comes up; boot/login → quiet in the tray.
	// v2.9: on an auto-update relaunch (--after-update), wait for the freshly
	// upgraded dashboard to actually serve before opening the window — opening
	// too early races the just-restarted HTTP server and lands the user in the
	// tray with no dashboard (the reported post-update symptom).
	if dash != nil && !*flagBackground {
		if *flagAfterUpdate {
			if waitForDashboardReady(dash.URL(), 24, 500*time.Millisecond) {
				log.Printf("after-update: dashboard is serving — opening window")
			} else {
				log.Printf("after-update: dashboard not confirmed ready in time — opening window anyway")
			}
		}
		openAppWindow(installDir, dash.URL())
	}

	// Tray init blocks until systray.Quit() is called. Returns when the
	// user picks Quit from the menu or the OS sends a termination signal.
	systray.Run(
		func() { onTrayReady(sup, dash, installDir, botPath, needsSetup) },
		func() { onTrayExit(sup, dash) },
	)
}

// isSetUp returns true once the user has run the setup wizard — i.e.
// config.json exists. v2.1: this is deliberately independent of Telegram,
// which is now optional. A desktop-only install (no .env, no token) is still
// fully "set up."
func isSetUp(installDir string) bool {
	_, err := os.Stat(filepath.Join(installDir, "config.json"))
	return err == nil
}

// telegramTokenRe / telegramChatRe mirror telegramConfigured() in
// scripts/telegram-config.mjs exactly: BotFather token shape and a numeric
// chat id (optionally negative for groups).
var (
	telegramTokenRe = regexp.MustCompile(`^\d+:[\w-]+$`)
	telegramChatRe  = regexp.MustCompile(`^-?\d+$`)
)

// telegramEnabled returns true when .env carries BOTH a plausibly-valid
// TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID — the wrapper's view of "Telegram
// is on," which gates whether the supervisor runs the bot poller.
//
// v2.4: must match scripts/telegram-config.mjs#telegramConfigured EXACTLY.
// The old token-only check disagreed with the bot (which requires token AND
// chat): a half-finished Telegram setup made the supervisor spawn a bot that
// exited immediately, burn its 3-per-hour restart budget, and take the whole
// tray app down with it.
func telegramEnabled(installDir string) bool {
	data, err := os.ReadFile(filepath.Join(installDir, ".env"))
	if err != nil {
		return false
	}
	token, chat := "", ""
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if v, ok := strings.CutPrefix(trimmed, "TELEGRAM_BOT_TOKEN="); ok {
			token = strings.TrimSpace(v)
		} else if v, ok := strings.CutPrefix(trimmed, "TELEGRAM_CHAT_ID="); ok {
			chat = strings.TrimSpace(v)
		}
	}
	return telegramTokenRe.MatchString(token) && telegramChatRe.MatchString(chat)
}

// resolveInstallDir returns the AMM install directory. By default it's the
// parent of the wrapper binary's directory (binary lives at <install>/wrapper/dist/).
// Override with --install-dir for manual debugging.
func resolveInstallDir(override string) (string, error) {
	if override != "" {
		abs, err := filepath.Abs(override)
		if err != nil {
			return "", err
		}
		return abs, nil
	}
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	// v8.1 (macOS): inside a .app bundle the executable MUST live at
	// Contents/MacOS/, so the "up two directories" rule below lands on
	// Contents/ instead of the payload and we'd fall through to cwd — which
	// is "/" for a Finder launch. The JS payload ships at
	// Contents/Resources/app/, so resolve there directly.
	if dir, ok := macAppPayloadDir(exe); ok {
		return dir, nil
	}
	// <install>/wrapper/dist/AMM.exe  →  <install>
	exeDir := filepath.Dir(exe)
	installDir := filepath.Dir(filepath.Dir(exeDir))
	// Sanity check: package.json should exist there. If not, we're probably
	// running from `go run` during development — fall back to cwd.
	if _, err := os.Stat(filepath.Join(installDir, "package.json")); err != nil {
		cwd, _ := os.Getwd()
		// In dev (go run from wrapper/), cwd is wrapper/, install is parent.
		if filepath.Base(cwd) == "wrapper" {
			return filepath.Dir(cwd), nil
		}
		return cwd, nil
	}
	return installDir, nil
}

// resolveBotPath returns the path to scripts/telegram-bot.mjs.
func resolveBotPath(override, installDir string) string {
	if override != "" {
		abs, _ := filepath.Abs(override)
		return abs
	}
	return filepath.Join(installDir, "scripts", "telegram-bot.mjs")
}

// openLogFile opens data/wrapper.log for append-write.
func openLogFile(installDir string) (*os.File, error) {
	dataDir := filepath.Join(installDir, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, err
	}
	return os.OpenFile(
		filepath.Join(dataDir, "wrapper.log"),
		os.O_APPEND|os.O_CREATE|os.O_WRONLY,
		0o644,
	)
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "AMM wrapper: "+format+"\n", args...)
	os.Exit(1)
}
