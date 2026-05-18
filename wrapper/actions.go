package main

import (
	"bufio"
	"fmt"
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

// actionRunSetup spawns the setup wizard in a visible terminal window. The
// wizard (scripts/setup-wizard.mjs) is a 10-step interactive prompt that
// writes .env + config.json. Once it finishes, the heartbeat poller in
// tray.go detects isConfigured() flipping to true and starts the bot.
//
// Spawned detached + visible (Start, not Run) so the wrapper stays
// responsive. If the terminal-spawn fails on this platform, log it and
// leave a clear hint — the user can always `npm run setup` manually.
func actionRunSetup(sup *supervisor, installDir string) {
	wizardPath := filepath.Join(installDir, "scripts", "setup-wizard.mjs")
	if _, err := os.Stat(wizardPath); err != nil {
		log.Printf("action.setup: wizard not found at %s — install may be corrupted", wizardPath)
		return
	}
	log.Printf("action.setup: spawning wizard in visible terminal")

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		// cmd /c start "Title" cmd /c "node ... & pause"
		// `start` detaches into a new visible cmd window. The inner cmd /c
		// runs the wizard, then `pause` lets the user read final messages
		// before the window closes. We Start() (not Run()) so the wrapper
		// doesn't block.
		cmd = exec.Command("cmd", "/c", "start", "AMM Setup", "cmd", "/c",
			fmt.Sprintf("node \"%s\" & echo. & echo. & echo Setup window. Press any key to close. & pause >nul", wizardPath))
	case "darwin":
		// AppleScript: open a new Terminal.app window running the wizard.
		script := fmt.Sprintf(
			`tell application "Terminal" to do script "cd '%s' && node scripts/setup-wizard.mjs"`,
			installDir)
		cmd = exec.Command("osascript", "-e", script)
	case "linux":
		// Prefer gnome-terminal, fall back to xterm. Each common DE has a
		// different terminal emulator; we try the two most universal.
		if path, _ := exec.LookPath("gnome-terminal"); path != "" {
			cmd = exec.Command(path, "--", "node", wizardPath)
		} else if path, _ := exec.LookPath("xterm"); path != "" {
			cmd = exec.Command(path, "-e", "node", wizardPath)
		} else if path, _ := exec.LookPath("konsole"); path != "" {
			cmd = exec.Command(path, "-e", "node", wizardPath)
		} else {
			log.Printf("action.setup: no terminal emulator found on Linux — run 'npm run setup' from a terminal manually")
			return
		}
	default:
		log.Printf("action.setup: unsupported platform %s — run 'npm run setup' manually", runtime.GOOS)
		return
	}

	cmd.Dir = installDir
	if err := cmd.Start(); err != nil {
		log.Printf("action.setup: spawn failed: %v — run 'npm run setup' from a terminal manually", err)
		return
	}
	log.Printf("action.setup: wizard pid=%d — tray heartbeat poller will detect when setup completes", cmd.Process.Pid)
	_ = cmd.Process.Release()
	// No polling goroutine needed here — tray.go's pollHeartbeat already
	// re-checks isConfigured() every 10s and transitions out of needs-setup
	// mode automatically once .env + config.json are present.
	_ = sup // silence unused param; kept for API symmetry + future use
}

// actionOpenDashboard opens the localhost dashboard URL in the user's
// default browser. v1.3. The wrapper bound the port at startup; we just
// open http://127.0.0.1:<port>.
func actionOpenDashboard(dash *dashboardServer) {
	if dash == nil || dash.Port() == 0 {
		log.Printf("action.dashboard: no dashboard server (start failed or not initialized)")
		return
	}
	url := dash.URL()
	log.Printf("action.dashboard: opening %s", url)
	if err := openURL(url); err != nil {
		log.Printf("action.dashboard: open failed: %v", err)
	}
}

// actionRunScrape spawns `node scripts/daily-batch.mjs` as a one-shot
// detached process. Same effect as /scrape via Telegram, but triggerable
// from the tray when the user is at their desk.
func actionRunScrape(installDir string) {
	scriptPath := filepath.Join(installDir, "scripts", "daily-batch.mjs")
	if _, err := os.Stat(scriptPath); err != nil {
		log.Printf("action.scrape: daily-batch.mjs not found at %s", scriptPath)
		return
	}
	cmd := exec.Command(findNode(), scriptPath)
	cmd.Dir = installDir
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
//   Windows: cmd /c start ""
//   macOS:   open
//   Linux:   xdg-open
func openURL(target string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		// `start` is a cmd builtin, must be invoked via cmd /c.
		// Empty "" as first arg is the window title (avoids "start" treating
		// the URL as a title if it contains spaces).
		cmd = exec.Command("cmd", "/c", "start", "", target)
		applyChildHideWindow(cmd)
	case "darwin":
		cmd = exec.Command("open", target)
	case "linux":
		cmd = exec.Command("xdg-open", target)
	default:
		return nil
	}
	return cmd.Start()
}
