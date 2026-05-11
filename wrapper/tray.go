package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"fyne.io/systray"
)

// trayState bundles everything menu handlers need to read or mutate.
type trayState struct {
	sup        *supervisor
	installDir string
	botPath    string

	// Menu items — captured on init so the heartbeat poller can update labels.
	miStatus   *systray.MenuItem
	miScrape   *systray.MenuItem
	miPause    *systray.MenuItem
	miTelegram *systray.MenuItem
	miLogs     *systray.MenuItem
	miFolder   *systray.MenuItem
	miRestart  *systray.MenuItem
	miQuit     *systray.MenuItem

	currentIcon iconState
}

type iconState int

const (
	iconGray iconState = iota
	iconGreen
	iconYellow
	iconRed
)

// heartbeatStaleness thresholds — kept in sync with scripts/watchdog.mjs:42
// (STALE_THRESHOLD_MS = 10 min) so wrapper and watchdog agree on "dead."
const (
	heartbeatFreshThreshold = 5 * time.Minute  // < 5 min  → green
	heartbeatStaleThreshold = 10 * time.Minute // < 10 min → yellow, ≥ 10 min → red
	heartbeatPollInterval   = 10 * time.Second // tray refresh tick
)

// onTrayReady is called by systray.Run once the tray icon is mounted.
// Build the menu, fire the heartbeat poller, register click handlers.
func onTrayReady(sup *supervisor, installDir, botPath string) {
	systray.SetTitle("AMM")
	systray.SetTooltip(fmt.Sprintf("Automatic Munyun Machine v%s", AMMVersion))

	state := &trayState{
		sup:        sup,
		installDir: installDir,
		botPath:    botPath,
	}
	state.setIcon(iconGray) // initial state until first heartbeat read

	// --- Menu layout ---
	// 🟢 Status: alive / 12m uptime / pid 1234   (read-only label)
	state.miStatus = systray.AddMenuItem("Status: starting…", "Bot liveness — based on data/heartbeat.json")
	state.miStatus.Disable() // info-only

	systray.AddSeparator()

	state.miScrape = systray.AddMenuItem("Run scrape now", "Spawns a one-shot daily batch")
	state.miPause = systray.AddMenuItem("Pause daily batch", "Disables the scheduled 7am push (toggle)")
	state.miPause.SetIcon([]byte{}) // visual hint placeholder

	systray.AddSeparator()

	state.miTelegram = systray.AddMenuItem("Open Telegram chat", "Opens t.me chat in your browser")
	state.miLogs = systray.AddMenuItem("View logs", "Opens data/telegram-bot.log in default editor")
	state.miFolder = systray.AddMenuItem("Open install folder", "Opens the AMM install dir in Explorer/Finder")

	systray.AddSeparator()

	state.miRestart = systray.AddMenuItem("Restart bot", "Kills the node child; supervisor respawns it")
	state.miQuit = systray.AddMenuItem("Quit AMM", "Stops the bot and exits the tray")

	// --- Click handlers ---
	go state.handleClicks()

	// --- Heartbeat poller ---
	go state.pollHeartbeat()

	log.Printf("tray: ready (platform=%s)", runtime.GOOS)
}

// onTrayExit fires when systray.Quit() is called (from the Quit menu item or
// an OS termination signal). Shut down the supervisor here, not before, so
// "Quit AMM" → child is killed → wrapper exits cleanly.
func onTrayExit(sup *supervisor) {
	log.Printf("tray: exiting — signaling supervisor")
	sup.Quit()
	// Give the supervisor a moment to send SIGTERM and let the bot wind down.
	time.Sleep(500 * time.Millisecond)
}

// handleClicks blocks reading from each menu item's ClickedCh in a select.
// One goroutine handles all clicks so the menu code in onTrayReady stays linear.
func (s *trayState) handleClicks() {
	for {
		select {
		case <-s.miScrape.ClickedCh:
			actionRunScrape(s.installDir)
		case <-s.miPause.ClickedCh:
			actionTogglePause(s.installDir, s.miPause)
		case <-s.miTelegram.ClickedCh:
			actionOpenTelegram(s.installDir)
		case <-s.miLogs.ClickedCh:
			actionViewLogs(s.installDir)
		case <-s.miFolder.ClickedCh:
			actionOpenFolder(s.installDir)
		case <-s.miRestart.ClickedCh:
			s.sup.Restart()
		case <-s.miQuit.ClickedCh:
			log.Printf("tray: Quit clicked")
			systray.Quit()
			return
		}
	}
}

// pollHeartbeat reads data/heartbeat.json every 10s and updates the icon
// color + status label accordingly. Same staleness thresholds as
// scripts/watchdog.mjs.
func (s *trayState) pollHeartbeat() {
	ticker := time.NewTicker(heartbeatPollInterval)
	defer ticker.Stop()

	for {
		s.refreshHeartbeat()
		<-ticker.C
	}
}

// heartbeat mirrors the bot's writeHeartbeat shape (telegram-bot.mjs:120-130).
type heartbeat struct {
	Ts                  string `json:"ts"`
	Pid                 int    `json:"pid"`
	Version             string `json:"version"`
	StartedAt           string `json:"startedAt"`
	LastPollOk          bool   `json:"lastPollOk"`
	ConsecutiveFailures int    `json:"consecutiveFailures"`
}

func (s *trayState) refreshHeartbeat() {
	hbPath := filepath.Join(s.installDir, "data", "heartbeat.json")
	data, err := os.ReadFile(hbPath)
	if err != nil {
		s.setStatus(iconRed, "Status: no heartbeat file — bot never started?")
		return
	}
	var hb heartbeat
	if err := json.Unmarshal(data, &hb); err != nil {
		s.setStatus(iconRed, "Status: heartbeat unreadable")
		return
	}
	ts, err := time.Parse(time.RFC3339Nano, hb.Ts)
	if err != nil {
		// Older bot may write a slightly different ISO format; try a fallback.
		if ts2, err2 := time.Parse(time.RFC3339, hb.Ts); err2 == nil {
			ts = ts2
		} else {
			s.setStatus(iconRed, fmt.Sprintf("Status: heartbeat ts unparseable (%s)", hb.Ts))
			return
		}
	}
	age := time.Since(ts)

	pollFlag := "✓"
	if !hb.LastPollOk {
		pollFlag = fmt.Sprintf("⚠ %d poll fails", hb.ConsecutiveFailures)
	}

	switch {
	case age < heartbeatFreshThreshold:
		s.setStatus(iconGreen, fmt.Sprintf("Status: alive · pid %d · last poll %s ago %s",
			hb.Pid, humanDuration(age), pollFlag))
	case age < heartbeatStaleThreshold:
		s.setStatus(iconYellow, fmt.Sprintf("Status: stale ~%s · pid %d %s",
			humanDuration(age), hb.Pid, pollFlag))
	default:
		s.setStatus(iconRed, fmt.Sprintf("Status: DEAD %s ago · watchdog should restart",
			humanDuration(age)))
	}
}

// setStatus updates both the icon and the disabled "Status:" menu label.
func (s *trayState) setStatus(state iconState, label string) {
	if state != s.currentIcon {
		s.setIcon(state)
		s.currentIcon = state
	}
	if s.miStatus != nil {
		s.miStatus.SetTitle(label)
	}
}

// setIcon picks the right embedded icon bytes for the platform + state.
func (s *trayState) setIcon(state iconState) {
	useICO := runtime.GOOS == "windows"
	var data []byte
	switch state {
	case iconGreen:
		if useICO {
			data = iconGreenICO
		} else {
			data = iconGreenPNG
		}
	case iconYellow:
		if useICO {
			data = iconYellowICO
		} else {
			data = iconYellowPNG
		}
	case iconRed:
		if useICO {
			data = iconRedICO
		} else {
			data = iconRedPNG
		}
	default: // iconGray
		if useICO {
			data = iconGrayICO
		} else {
			data = iconGrayPNG
		}
	}
	systray.SetIcon(data)
}

// humanDuration formats a duration concisely for menu labels: "12s", "3m",
// "1h47m", "2d". Never returns "0s" — clamps to 1s minimum.
func humanDuration(d time.Duration) string {
	if d < time.Second {
		return "<1s"
	}
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	if d < time.Hour {
		return fmt.Sprintf("%dm", int(d.Minutes()))
	}
	if d < 24*time.Hour {
		h := int(d.Hours())
		m := int(d.Minutes()) - h*60
		if m == 0 {
			return fmt.Sprintf("%dh", h)
		}
		return fmt.Sprintf("%dh%dm", h, m)
	}
	return fmt.Sprintf("%dd", int(d.Hours()/24))
}
