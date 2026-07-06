package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// v2.2: the app window is opened via a resolved Chrome/Edge in --app mode.
// These tests cover resolution + arg/port parsing WITHOUT actually launching
// a browser (no window pops during `go test`).

func TestChromiumCandidates_NotEmpty(t *testing.T) {
	if got := chromiumCandidates(); len(got) == 0 && runtime.GOOS != "linux" {
		t.Errorf("expected candidate browser paths on %s", runtime.GOOS)
	}
}

// On a Windows dev/CI box Edge is always present, so resolution must succeed.
// resolveChromium only stat()s files — it never launches anything.
func TestResolveChromium_FindsBrowserOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Edge-always-present assumption only holds on Windows")
	}
	if resolveChromium() == "" {
		t.Errorf("resolveChromium() found nothing — Edge should exist on Windows")
	}
}

func TestAppWindowArgs(t *testing.T) {
	args := appWindowArgs(`C:\amm\data\app-window`, "http://127.0.0.1:54321")
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "--app=http://127.0.0.1:54321") {
		t.Errorf("app-mode flag missing: %v", args)
	}
	if !strings.Contains(joined, "--user-data-dir=") {
		t.Errorf("isolated profile flag missing: %v", args)
	}
}

func TestParsePortFromBytes(t *testing.T) {
	cases := map[string]string{
		"54321\n":     "54321",
		"  60614 ":    "60614",
		"60614\r\n":   "60614",
		"":            "",
		"not-a-port":  "",
		"port: 8080;": "8080",
	}
	for in, want := range cases {
		if got := parsePortFromBytes([]byte(in)); got != want {
			t.Errorf("parsePortFromBytes(%q) = %q; want %q", in, got, want)
		}
	}
}

// With no port file the second-instance handoff must report failure (the
// caller then takes over as primary) — and never launch a browser.
func TestOpenAppWindowForRunningInstance_NoFile(t *testing.T) {
	if openAppWindowForRunningInstance(t.TempDir()) {
		t.Errorf("with no port file, should report handoff not possible")
	}
}

// A port file pointing at a dead port must fail the probe (stale instance),
// not open a window to nothing.
func TestOpenAppWindowForRunningInstance_DeadPort(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	// Port 1 on loopback: nothing listens there; connect fails fast.
	if err := os.WriteFile(filepath.Join(dir, "data", "dashboard-port.txt"), []byte("1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if openAppWindowForRunningInstance(dir) {
		t.Errorf("dead port must fail the probe and report handoff not possible")
	}
}

// v2.4 takeover helper: readLockPID round-trips the lock file.
func TestReadLockPID(t *testing.T) {
	dir := t.TempDir()
	if got := readLockPID(dir); got != 0 {
		t.Errorf("no lock file → want 0, got %d", got)
	}
	if err := os.MkdirAll(filepath.Join(dir, "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "data", "wrapper.lock"), []byte("4242"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := readLockPID(dir); got != 4242 {
		t.Errorf("want 4242, got %d", got)
	}
	if err := os.WriteFile(filepath.Join(dir, "data", "wrapper.lock"), []byte("garbage"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := readLockPID(dir); got != 0 {
		t.Errorf("garbage lock → want 0, got %d", got)
	}
}

// v2.9: waitForDashboardReady polls /api/status until it 200s. On an
// auto-update relaunch this is what stops us opening the app window before the
// freshly-restarted dashboard is serving (the "reopened in the tray, no window"
// bug). A server that 503s a couple times then 200s must be detected as ready.
func TestWaitForDashboardReady_BecomesReady(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/status" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		hits++
		if hits < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	if !waitForDashboardReady(srv.URL, 10, 5*time.Millisecond) {
		t.Errorf("expected ready once the server started answering 200 (hits=%d)", hits)
	}
}

// A server that never serves 200 must time out (return false) within the
// attempt budget — the caller then opens the window anyway rather than hang.
func TestWaitForDashboardReady_TimesOut(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	if waitForDashboardReady(srv.URL, 3, 5*time.Millisecond) {
		t.Errorf("never-200 server must not report ready")
	}
}

// No listener at all (connection refused) must also time out cleanly.
func TestWaitForDashboardReady_NoListener(t *testing.T) {
	if waitForDashboardReady("http://127.0.0.1:1", 2, 5*time.Millisecond) {
		t.Errorf("dead port must not report ready")
	}
}
