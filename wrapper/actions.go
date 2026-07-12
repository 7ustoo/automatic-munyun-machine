package main

import (
	"bufio"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"fyne.io/systray"
)

// Menu-action handlers. Each is a small function that shells out to the
// existing JS scripts so we never reimplement bot logic in Go.

// actionRunSetup opens the dashboard's first-run setup panel. v2.7: the
// terminal wizard is gone from the user-facing surface — the dashboard's
// setup overlay (rendered when needsSetup=true) is now the onboarding UI.
// This handler just makes sure the app window is up; the setup panel appears
// automatically because /api/status returns needsSetup=true.
//
// scripts/setup-wizard.mjs still exists and works via `npm run setup` for
// developers and CI, but no menu item, installer step, or shortcut points
// at it. If dash is nil (dashboard failed to bind) the tray logs the error;
// the user's only recovery is a terminal.
func actionRunSetup(sup *supervisor, dash *dashboardServer, installDir string) {
	if dash == nil {
		log.Printf("action.setup: dashboard is not running — cannot open setup panel. Fallback: run `npm run setup` from a terminal.")
		return
	}
	log.Printf("action.setup: opening dashboard app window for first-run setup")
	openAppWindow(installDir, dash.URL())
	_ = sup // silence unused; kept for API symmetry
}

// actionOpenDashboard opens the localhost dashboard in the platform app
// window. The wrapper already bound the loopback port at startup.
func actionOpenDashboard(dash *dashboardServer, installDir string) {
	if dash == nil || dash.Port() == 0 {
		log.Printf("action.dashboard: no dashboard server (start failed or not initialized)")
		return
	}
	// v2.2: open the real app window (not a plain browser tab).
	log.Printf("action.dashboard: opening app window at %s", dash.URL())
	openAppWindow(installDir, dash.URL())
}

// actionRunScrape spawns `node scripts/daily-batch.mjs` as a one-shot
// detached process. Same effect as /scrape via Telegram, but triggerable
// from the tray when the user is at their desk.
//
// v2.9: showBrowser toggles "watch the scrape" — it sets AMM_SHOW_BROWSER=1 so
// daily-batch.mjs places the (always-headful) Chromium window on-screen instead
// of parking it off-screen. The scheduled 7am run and the tray trigger pass
// false; only the dashboard's "Watch" checkbox passes true.
func actionRunScrape(installDir string, showBrowser bool) {
	scriptPath := filepath.Join(installDir, "scripts", "daily-batch.mjs")
	if _, err := os.Stat(scriptPath); err != nil {
		log.Printf("action.scrape: daily-batch.mjs not found at %s", scriptPath)
		return
	}
	cmd := exec.Command(findNode(), scriptPath)
	cmd.Dir = installDir
	if showBrowser {
		cmd.Env = append(os.Environ(), "AMM_SHOW_BROWSER=1")
	}
	applyChildHideWindow(cmd)
	// Detach: don't wait, don't tie stdio to the wrapper.
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		log.Printf("action.scrape: spawn failed: %v", err)
		return
	}
	log.Printf("action.scrape: started pid=%d", cmd.Process.Pid)
	// Release so we don't accumulate zombies on POSIX
	_ = cmd.Process.Release()
}

// actionTogglePause toggles the daily-batch scheduled task. Reads the
// current state via the platform's scheduler probe, then disables or
// enables accordingly. Updates the menu item title to reflect new state.
func actionTogglePause(installDir string, miPause *systray.MenuItem) {
	// We don't try to read scheduler state — just attempt both operations
	// and see which one a fresh state would be in. Simpler approach:
	// track "is paused" in a tiny file at data/.wrapper-paused so the tray
	// has a single source of truth. Bot's own /pause + /resume-bot still
	// work; they just don't update this file. (Minor inconsistency — the
	// tray and the bot can disagree on the paused label. Acceptable.)
	marker := filepath.Join(installDir, "data", ".wrapper-paused")
	currentlyPaused := false
	if _, err := os.Stat(marker); err == nil {
		currentlyPaused = true
	}

	if currentlyPaused {
		// Resume: enable the scheduled task
		if err := schedulerToggle(installDir, false); err != nil {
			log.Printf("action.pause: scheduler enable failed: %v", err)
			return
		}
		_ = os.Remove(marker)
		miPause.SetTitle("Pause daily batch")
		log.Printf("action.pause: resumed daily-batch task")
	} else {
		if err := schedulerToggle(installDir, true); err != nil {
			log.Printf("action.pause: scheduler disable failed: %v", err)
			return
		}
		_ = os.WriteFile(marker, []byte("paused"), 0o644)
		miPause.SetTitle("Resume daily batch")
		log.Printf("action.pause: paused daily-batch task")
	}
}

// schedulerToggle disables (pause=true) or enables (pause=false) the
// scheduled daily-batch task. Branches by GOOS — same logic as
// scripts/os-paths.mjs but in Go.
func schedulerToggle(installDir string, pause bool) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		op := "Enable-ScheduledTask"
		if pause {
			op = "Disable-ScheduledTask"
		}
		ps := filepath.Join(os.Getenv("SystemRoot"), "System32",
			"WindowsPowerShell", "v1.0", "powershell.exe")
		if os.Getenv("SystemRoot") == "" {
			ps = `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
		}
		cmd = exec.Command(ps, "-NoProfile", "-Command",
			op+" -TaskName 'munyun-daily-batch' -ErrorAction SilentlyContinue")
	case "darwin":
		op := "enable"
		if pause {
			op = "disable"
		}
		cmd = exec.Command("launchctl", op,
			"gui/"+os.Getenv("UID")+"/com.amm.daily")
	case "linux":
		op := "enable"
		if pause {
			op = "disable"
		}
		args := []string{"--user", op, "--now", "munyun-daily.timer"}
		cmd = exec.Command("systemctl", args...)
	default:
		log.Printf("schedulerToggle: unsupported platform %s", runtime.GOOS)
		return nil
	}
	cmd.Dir = installDir
	applyChildHideWindow(cmd)
	return cmd.Run()
}

// actionOpenTelegram opens the bot's chat URL. We read the chat ID from
// .env (TELEGRAM_CHAT_ID) and build a tg://user?id=<chat> link.
//
// Note: for a private bot the easiest "open chat" URL is the bot's own
// t.me/<botUsername> link. We try to extract the bot username from the
// telegram-bot.log startup line, falling back to a generic tg:// link.
func actionOpenTelegram(installDir string) {
	url := resolveTelegramURL(installDir)
	if url == "" {
		log.Printf("action.telegram: could not determine bot URL")
		return
	}
	if err := openURL(url); err != nil {
		log.Printf("action.telegram: open failed: %v", err)
	}
}

// resolveTelegramURL reads telegram-bot.log to find the bot's @username
// (logged in the startup ping). Falls back to opening the user's last-
// known chat via tg://.
func resolveTelegramURL(installDir string) string {
	logPath := filepath.Join(installDir, "data", "telegram-bot.log")
	f, err := os.Open(logPath)
	if err != nil {
		return ""
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	// Look for lines like: "Connected as @some_bot_name"
	// or "Bot starting" lines that contain the username.
	for scanner.Scan() {
		line := scanner.Text()
		if idx := strings.Index(line, "@"); idx >= 0 {
			rest := line[idx+1:]
			end := strings.IndexFunc(rest, func(r rune) bool {
				return !(r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9'))
			})
			if end > 3 { // valid Telegram usernames are 5+ chars but tolerate
				return "https://t.me/" + rest[:end]
			}
		}
	}
	return "https://t.me/" // fallback: open Telegram, user navigates
}

// actionViewLogs opens data/telegram-bot.log in the platform default editor.
func actionViewLogs(installDir string) {
	logPath := filepath.Join(installDir, "data", "telegram-bot.log")
	if err := openURL(logPath); err != nil {
		log.Printf("action.logs: open failed: %v", err)
	}
}

// actionOpenFolder opens the install directory in Explorer / Finder / nautilus.
func actionOpenFolder(installDir string) {
	if err := openURL(installDir); err != nil {
		log.Printf("action.folder: open failed: %v", err)
	}
}

// openURL opens a URL or filesystem path using the platform default opener.
// The platform implementation must not involve a command shell: targets can
// contain untrusted job-board URL characters.
func openURL(target string) error {
	return openTarget(target)
}
