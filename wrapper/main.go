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
	"runtime"
	"strings"

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
var AMMVersion = "1.3.0"

// CLI flags. The wrapper is usually invoked with no args from Task Scheduler /
// launchd / systemd; the flags exist for manual debugging.
var (
	flagBotPath   = flag.String("bot-path", "", "Path to scripts/telegram-bot.mjs (default: auto-detect relative to wrapper binary)")
	flagInstallDir = flag.String("install-dir", "", "AMM install directory (default: parent of wrapper binary's dir)")
	flagNoSpawn   = flag.Bool("no-spawn", false, "Don't spawn the node bot — useful for testing tray UI in isolation")
	flagVersion   = flag.Bool("version", false, "Print version and exit")
)

func main() {
	flag.Parse()

	if *flagVersion {
		fmt.Printf("AMM tray wrapper v%s (%s/%s)\n", AMMVersion, runtime.GOOS, runtime.GOARCH)
		os.Exit(0)
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

	// Single-instance guard. If another AMM is already running, log a notice
	// and exit cleanly. This prevents the double-tray-icon scenario when the
	// watchdog restarts the scheduled task while a healthy wrapper is still
	// alive. See risk #4 in the plan.
	released, err := acquireSingleInstanceLock(installDir)
	if err != nil {
		log.Printf("Single-instance lock failed: %v — another AMM may already be running. Exiting.", err)
		os.Exit(0) // exit 0 so scheduler doesn't flag this as a crash
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

// telegramEnabled returns true when .env carries a non-empty
// TELEGRAM_BOT_TOKEN — the wrapper's view of "Telegram is on," which gates
// whether the supervisor runs the bot poller. Mirrors telegramConfigured()
// in scripts/telegram-config.mjs (token presence is the load-bearing check;
// the JS side additionally validates shape).
func telegramEnabled(installDir string) bool {
	data, err := os.ReadFile(filepath.Join(installDir, ".env"))
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "TELEGRAM_BOT_TOKEN=") {
			parts := strings.SplitN(trimmed, "=", 2)
			if len(parts) == 2 && strings.TrimSpace(parts[1]) != "" {
				return true
			}
		}
	}
	return false
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
