package main

// v2.2: open the dashboard as a real, standalone application window instead
// of a browser tab. We launch the user's installed Chrome/Edge in "app mode"
// (--app=<url>): a chromeless window with no tabs, no address bar, its own
// taskbar entry and (via the page's favicon) the AMM icon. To the user it is
// an application — double-click the icon, the window comes up with the
// dashboard. Under the hood it's the system's Chromium engine (the same one
// the scraper already uses), so there's nothing extra to bundle or install.
//
// A dedicated --user-data-dir keeps it a clean isolated window (no mixing
// with the user's normal browser tabs / extensions / sessions). If neither
// Chrome nor Edge is found we fall back to the default browser so the
// dashboard is still reachable.

import (
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

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

// openAppWindow opens url as a standalone app-mode window. Returns true if it
// launched a real app window, false if it fell back to the default browser.
func openAppWindow(installDir, url string) bool {
	browser := resolveChromium()
	if browser == "" {
		log.Printf("appwindow: no Chrome/Edge found — opening dashboard in the default browser")
		_ = openURL(url)
		return false
	}
	profileDir := filepath.Join(installDir, "data", "app-window")
	_ = os.MkdirAll(profileDir, 0o755)
	cmd := exec.Command(browser, appWindowArgs(profileDir, url)...)
	cmd.Dir = installDir
	applyChildHideWindow(cmd)
	if err := cmd.Start(); err != nil {
		log.Printf("appwindow: failed to launch app window (%v) — falling back to default browser", err)
		_ = openURL(url)
		return false
	}
	_ = cmd.Process.Release()
	log.Printf("appwindow: opened app window via %s", filepath.Base(browser))
	return true
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

// openAppWindowFromPortFile reads data/dashboard-port.txt and opens the app
// window at that URL. Used when a second AMM launch finds one already
// running: rather than a no-op exit, we surface the existing instance's
// dashboard so double-clicking the icon always shows the app.
func openAppWindowFromPortFile(installDir string) bool {
	data, err := os.ReadFile(filepath.Join(installDir, "data", "dashboard-port.txt"))
	if err != nil {
		log.Printf("appwindow: no dashboard-port.txt (%v) — cannot open window for the running instance", err)
		return false
	}
	port := parsePortFromBytes(data)
	if port == "" {
		return false
	}
	return openAppWindow(installDir, "http://127.0.0.1:"+port)
}
