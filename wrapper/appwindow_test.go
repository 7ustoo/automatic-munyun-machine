package main

import (
	"runtime"
	"strings"
	"testing"
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

// With no port file the second-instance path must no-op (and never launch).
func TestOpenAppWindowFromPortFile_NoFile(t *testing.T) {
	if openAppWindowFromPortFile(t.TempDir()) {
		t.Errorf("with no port file, should report no window opened")
	}
}
