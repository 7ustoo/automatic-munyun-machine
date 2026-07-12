package main

// v6.0: dashboard-window orchestration.
//
// On Windows, openAppWindow launches a lightweight child mode of AMM.exe that
// owns a native Win32/WebView2 window. The taskbar therefore sees AMM.exe —
// not chrome.exe — and pinning/relaunching uses AMM's own identity. Keeping
// the window in a child process also preserves the tray's main-thread event
// loop and the existing update handoff (closeAppWindows kills the child).
//
// macOS/Linux retain the proven Chromium app-mode host for now. Windows also
// falls back to that path from the primary process if the native child cannot
// report readiness. A dedicated data directory keeps either engine isolated
// from the user's normal browser profile.

import (
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// PIDs of app-window processes THIS wrapper spawned. On Windows these are
// AMM.exe --window-host children; on other platforms/fallback they are browser
// app-mode processes. The update flow closes them explicitly so a dead
// pre-update window cannot linger next to the relaunched one.
var appWindowPIDs struct {
	mu   sync.Mutex
	pids []int
}

var appWindowOpenMu sync.Mutex

func recordAppWindowPID(pid int) {
	appWindowPIDs.mu.Lock()
	appWindowPIDs.pids = append(appWindowPIDs.pids, pid)
	appWindowPIDs.mu.Unlock()
}

func trackAppWindowProcess(process *os.Process) {
	recordAppWindowPID(process.Pid)
	go func() {
		_, _ = process.Wait()
		appWindowPIDs.mu.Lock()
		for i, pid := range appWindowPIDs.pids {
			if pid == process.Pid {
				appWindowPIDs.pids = append(appWindowPIDs.pids[:i], appWindowPIDs.pids[i+1:]...)
				break
			}
		}
		appWindowPIDs.mu.Unlock()
	}()
}

// closeAppWindows force-closes every app window this process spawned.
// Tracked children are reaped and removed as soon as they exit, keeping stale
// PIDs out of this list. A process-tree kill also closes a browser fallback
// launched by a native host child.
func closeAppWindows() {
	appWindowPIDs.mu.Lock()
	pids := append([]int(nil), appWindowPIDs.pids...)
	appWindowPIDs.pids = nil
	appWindowPIDs.mu.Unlock()
	for _, pid := range pids {
		killProcessTree(pid)
		log.Printf("appwindow: closed app window tree (pid %d)", pid)
	}
}

// chromiumCandidates returns likely Chrome/Edge executable paths for the
// platform, Chrome first (users who installed it usually prefer it), then
// Edge (always present on Windows 10/11).
func chromiumCandidates() []string {
	switch runtime.GOOS {
	case "windows":
		pf := os.Getenv("ProgramFiles")
		pf86 := os.Getenv("ProgramFiles(x86)")
		la := os.Getenv("LOCALAPPDATA")
		return []string{
			filepath.Join(pf, "Google", "Chrome", "Application", "chrome.exe"),
			filepath.Join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
			filepath.Join(la, "Google", "Chrome", "Application", "chrome.exe"),
			filepath.Join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
			filepath.Join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
		}
	case "darwin":
		return []string{
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
		}
	default: // linux
		for _, name := range []string{"google-chrome", "chromium", "chromium-browser", "microsoft-edge"} {
			if p, err := exec.LookPath(name); err == nil {
				return []string{p}
			}
		}
		return nil
	}
}

func resolveChromium() string {
	for _, c := range chromiumCandidates() {
		if c == "" {
			continue
		}
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return ""
}

// openAppWindow opens url as a standalone application window. Windows first
// launches AMM's native WebView2 host. Other platforms use Chromium app mode.
// Returns false only when both the dedicated host and browser fallback fail.
func openAppWindow(installDir, url string) bool {
	appWindowOpenMu.Lock()
	defer appWindowOpenMu.Unlock()
	if launchNativeWindowHost(installDir, url) {
		log.Printf("appwindow: opened native AMM window host")
		return true
	}
	return openChromiumAppWindow(installDir, url)
}

// openChromiumAppWindow is the cross-platform compatibility fallback. It is
// deliberately separate from openAppWindow so --window-host can fall back
// without recursively spawning another AMM.exe child.
func openChromiumAppWindow(installDir, url string) bool {
	cmd, ok := startChromiumAppWindow(installDir, url)
	if !ok {
		return false
	}
	trackAppWindowProcess(cmd.Process)
	return true
}

func startChromiumAppWindow(installDir, url string) (*exec.Cmd, bool) {
	browser := resolveChromium()
	if browser == "" {
		log.Printf("appwindow: no Chrome/Edge found — opening dashboard in the default browser")
		_ = openURL(url)
		return nil, false
	}
	profileDir := filepath.Join(installDir, "data", "app-window")
	_ = os.MkdirAll(profileDir, 0o755)
	cmd := exec.Command(browser, appWindowArgs(profileDir, url)...)
	cmd.Dir = installDir
	applyChildHideWindow(cmd)
	if err := cmd.Start(); err != nil {
		log.Printf("appwindow: failed to launch app window (%v) — falling back to default browser", err)
		_ = openURL(url)
		return nil, false
	}
	log.Printf("appwindow: opened app window via %s", filepath.Base(browser))
	return cmd, true
}

// appWindowArgs builds the Chromium app-mode flags: a chromeless window
// (--app), an isolated profile so it's a clean standalone app (not the
// user's tabs/extensions), and a sensible window size.
func appWindowArgs(profileDir, url string) []string {
	return []string{
		"--app=" + url,
		"--user-data-dir=" + profileDir,
		"--window-size=1240,860",
		"--no-first-run",
		"--no-default-browser-check",
	}
}

// parsePortFromBytes extracts the first run of digits from a port file
// (tolerates a trailing newline / stray whitespace). "" when none.
func parsePortFromBytes(data []byte) string {
	port := ""
	for _, r := range string(data) {
		if r >= '0' && r <= '9' {
			port += string(r)
		} else if port != "" {
			break
		}
	}
	return port
}

// waitForDashboardReady polls <baseURL>/api/status until it answers HTTP 200
// or the attempts run out. Used on an auto-update relaunch (--after-update):
// the freshly upgraded dashboard's HTTP server can start a beat after the
// process, and opening the app window before it serves lands the user in the
// tray with a dead window. Returns true once it's serving, false on timeout.
func waitForDashboardReady(baseURL string, attempts int, delay time.Duration) bool {
	client := &http.Client{Timeout: 1500 * time.Millisecond}
	for i := 0; i < attempts; i++ {
		resp, err := client.Get(baseURL + "/api/status")
		if err == nil {
			code := resp.StatusCode
			_ = resp.Body.Close()
			if code == http.StatusOK {
				return true
			}
		}
		time.Sleep(delay)
	}
	return false
}

func dashboardWindowTokenPath(installDir string) string {
	return filepath.Join(installDir, "data", "dashboard-window-token.txt")
}

// openAppWindowForRunningInstance hands a double-click off to the AMM that
// is already running: read its port from data/dashboard-port.txt, PROBE the
// dashboard to confirm that instance is actually serving, then open the app
// window at its URL.
//
// Returns false when the handoff isn't possible — port file missing (an old
// pre-v2.2 binary is running; it never wrote one) or the probe fails (stale
// lock, crashed dashboard). The caller then takes over as the primary
// instance instead of exiting silently, which was the v2.3 failure mode:
// double-click appeared to do nothing.
func openAppWindowForRunningInstance(installDir string) bool {
	data, err := os.ReadFile(filepath.Join(installDir, "data", "dashboard-port.txt"))
	if err != nil {
		log.Printf("appwindow: no dashboard-port.txt (%v) — running instance predates v2.2 or never started its dashboard", err)
		return false
	}
	port := parsePortFromBytes(data)
	if port == "" {
		return false
	}
	if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
		return false
	}
	url := "http://127.0.0.1:" + port

	// Probe before opening a window: a stale port file pointing at nothing
	// would flash an unable-to-connect window and convince the user the app
	// is broken. 2s is generous for a localhost loopback.
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(url + "/api/status")
	if err != nil {
		log.Printf("appwindow: running instance not responding on %s (%v)", url, err)
		return false
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		log.Printf("appwindow: running instance answered %d on %s — treating as unhealthy", resp.StatusCode, url)
		return false
	}
	token, err := os.ReadFile(dashboardWindowTokenPath(installDir))
	if err != nil || strings.TrimSpace(string(token)) == "" {
		log.Printf("appwindow: window handoff token unavailable: %v", err)
		return false
	}
	return requestAppWindowOpen(url, strings.TrimSpace(string(token)))
}

func requestAppWindowOpen(baseURL, token string) bool {
	req, err := http.NewRequest(http.MethodPost, baseURL+"/api/window/open", nil)
	if err != nil {
		return false
	}
	req.Header.Set("X-AMM-Token", token)
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("appwindow: primary window handoff failed: %v", err)
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		log.Printf("appwindow: primary window handoff answered %d", resp.StatusCode)
		return false
	}
	return true
}
