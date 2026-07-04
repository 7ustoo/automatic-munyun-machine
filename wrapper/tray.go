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
	dash       *dashboardServer
	installDir string
	botPath    string
	needsSetup bool // true when launched without .env/config.json

	// Menu items — captured on init so the heartbeat poller can update labels.
	miSetup     *systray.MenuItem // v1.2: visible only when needsSetup; click → wizard
	miStatus    *systray.MenuItem
	miDashboard *systray.MenuItem // v1.3: opens http://127.0.0.1:<port> in browser
	miScrape    *systray.MenuItem
	miPause     *systray.MenuItem
	miTelegram  *systray.MenuItem
	miLogs      *systray.MenuItem
	miFolder    *systray.MenuItem
	miRestart   *systray.MenuItem
	miQuit      *systray.MenuItem

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
//
// v1.2: `needsSetup` controls whether the "Run setup wizard" item is at
// the top of the menu and whether the initial tooltip/status reflects
// the unconfigured state.
// v1.3: `dash` is the optional dashboard server — when non-nil the
// "Open dashboard" menu item routes through it.
func onTrayReady(sup *supervisor, dash *dashboardServer, installDir, botPath string, needsSetup bool) {
	systray.SetTitle("AMM")
	if needsSetup {
		systray.SetTooltip(fmt.Sprintf("Automatic Munyun Machine v%s — setup required", AMMVersion))
	} else {
		systray.SetTooltip(fmt.Sprintf("Automatic Munyun Machine v%s", AMMVersion))
	}

	state := &trayState{
		sup:        sup,
		dash:       dash,
		installDir: installDir,
		botPath:    botPath,
		needsSetup: needsSetup,
	}
	state.setIcon(iconGray) // initial state until first heartbeat read

	// --- Menu layout ---
	// Setup item ONLY visible when configuration is missing — keeps the menu
	// clean for the common case where everything's already set up.
	// v2.7: label + tooltip updated — the dashboard is now the setup surface,
	// not a terminal wizard.
	if needsSetup {
		state.miSetup = systray.AddMenuItem("⚙️ Open setup", "Opens the AMM setup panel in the dashboard window")
		systray.AddSeparator()
	}

	// 🟢 Status: alive / 12m uptime / pid 1234   (read-only label)
	statusInitial := "Status: starting…"
	if needsSetup {
		statusInitial = "Status: setup required — click 'Open setup'"
	}
	state.miStatus = systray.AddMenuItem(statusInitial, "Bot liveness — based on data/heartbeat.json")
	state.miStatus.Disable() // info-only

	// v1.3: localhost dashboard. Only show the item when the dashboard
	// server is up — startDashboard() may have failed (port exhaustion,
	// firewall, etc.) and in that case the action would be a no-op.
	if dash != nil {
		state.miDashboard = systray.AddMenuItem("Open dashboard", "Opens the AMM status page in your browser")
	}

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

	// When in needs-setup mode, disable the action items that depend on a
	// running bot — they'd just produce errors otherwise.
	if needsSetup {
		state.miScrape.Disable()
		state.miPause.Disable()
		state.miTelegram.Disable()
		state.miRestart.Disable()
		// Dashboard stays enabled even in needs-setup mode — it'll show
		// "No heartbeat yet" + the setup-required state, which is helpful.
	}

	// --- Click handlers ---
	go state.handleClicks()

	// --- Heartbeat poller ---
	go state.pollHeartbeat()

	log.Printf("tray: ready (platform=%s, needsSetup=%t)", runtime.GOOS, needsSetup)
}

// onTrayExit fires when systray.Quit() is called (from the Quit menu item or
// an OS termination signal). Shut down the supervisor + dashboard here, not
// before, so "Quit AMM" → child is killed → port is released → wrapper exits
// cleanly.
func onTrayExit(sup *supervisor, dash *dashboardServer) {
	log.Printf("tray: exiting — signaling supervisor")
	sup.Quit()
	if dash != nil {
		dash.Shutdown()
	}
	// Give the supervisor a moment to send SIGTERM and let the bot wind down.
	time.Sleep(500 * time.Millisecond)
}

// handleClicks blocks reading from each menu item's ClickedCh in a select.
// One goroutine handles all clicks so the menu code in onTrayReady stays linear.
//
// Setup + Dashboard items only exist when needsSetup=true / dashboard up;
// plumb them through nilable channels so the select doesn't deadlock on a
// nil ClickedCh.
func (s *trayState) handleClicks() {
	var setupCh <-chan struct{}
	if s.miSetup != nil {
		setupCh = s.miSetup.ClickedCh
	}
	var dashCh <-chan struct{}
	if s.miDashboard != nil {
		dashCh = s.miDashboard.ClickedCh
	}
	for {
		select {
		case <-setupCh:
			actionRunSetup(s.sup, s.dash, s.installDir)
		case <-dashCh:
			actionOpenDashboard(s.dash, s.installDir)
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
//
// v1.2: also handles the needsSetup→configured transition. On each tick,
// if we're in needsSetup mode AND isConfigured() now returns true, we:
//   - hide the Setup menu item
//   - enable the previously-disabled action items
//   - update tooltip
//   - spawn the supervisor (which starts the node bot)
//   - exit needsSetup mode
// After that, normal heartbeat tracking takes over.
func (s *trayState) pollHeartbeat() {
	ticker := time.NewTicker(heartbeatPollInterval)
	defer ticker.Stop()

	for {
		if s.needsSetup {
			if isSetUp(s.installDir) {
				s.exitNeedsSetupMode()
			} else {
				// Still waiting on setup. Logo icon + a clear status label.
				s.setStatus(iconGray, "Status: setup required — click 'Run setup wizard'")
			}
		} else if !telegramEnabled(s.installDir) {
			// v2.3: Telegram is optional. With it off there's no bot poller and
			// no heartbeat — that's healthy, not dead. Show the logo and say so
			// instead of a misleading "no heartbeat / DEAD".
			s.setStatus(iconGreen, "Status: running — Telegram off (desktop dashboard). Open dashboard from this menu.")
		} else {
			s.refreshHeartbeat()
		}
		<-ticker.C
	}
}

// exitNeedsSetupMode transitions the tray out of the first-run waiting state
// once setup is detected. Called from pollHeartbeat when isConfigured()
// flips from false → true.
func (s *trayState) exitNeedsSetupMode() {
	log.Printf("tray: setup detected — exiting needsSetup mode, starting supervisor")
	s.needsSetup = false
	systray.SetTooltip(fmt.Sprintf("Automatic Munyun Machine v%s", AMMVersion))
	if s.miSetup != nil {
		s.miSetup.Hide()
	}
	s.miScrape.Enable()
	s.miPause.Enable()
	s.miTelegram.Enable()
	s.miRestart.Enable()
	// Kick off the supervisor — the node bot now has its config and can run.
	go s.sup.runForever()
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
	case iconYellow: // stale heartbeat — keep the warning color
		if useICO {
			data = iconYellowICO
		} else {
			data = iconYellowPNG
		}
	case iconRed: // dead bot (Telegram on) — keep the alert color
		if useICO {
			data = iconRedICO
		} else {
			data = iconRedPNG
		}
	default: // v2.3: healthy / idle / startup → the AMM brand logo
		if useICO {
			data = iconLogoICO
		} else {
			data = iconLogoPNG
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
