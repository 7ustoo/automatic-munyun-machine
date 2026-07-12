//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestIsLoopbackDashboardURL(t *testing.T) {
	tests := []struct {
		name string
		url  string
		want bool
	}{
		{"ipv4", "http://127.0.0.1:54321", true},
		{"localhost", "http://localhost:54321", true},
		{"ipv6", "http://[::1]:54321", true},
		{"missing port", "http://127.0.0.1", false},
		{"https", "https://127.0.0.1:54321", false},
		{"remote", "http://example.com:54321", false},
		{"userinfo", "http://user@127.0.0.1:54321", false},
		{"path", "http://127.0.0.1:54321/jobs", false},
		{"query", "http://127.0.0.1:54321?x=1", false},
		{"bad port", "http://127.0.0.1:99999", false},
		{"garbage", "://", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isLoopbackDashboardURL(tt.url); got != tt.want {
				t.Fatalf("isLoopbackDashboardURL(%q) = %v; want %v", tt.url, got, tt.want)
			}
		})
	}
}

func TestIsAllowedExternalURL(t *testing.T) {
	tests := []struct {
		url  string
		want bool
	}{
		{"https://jobs.example.com/apply?id=1", true},
		{"https://jobs.example.com/apply?a=1&b=2", true},
		{"http://jobs.example.com/apply", true},
		{"https://user@example.com/apply", false},
		{"file:///C:/Windows/System32/calc.exe", false},
		{"javascript:alert(1)", false},
		{"mailto:jobs@example.com", false},
		{"https://jobs.example.com/apply\nmalformed", false},
		{"://", false},
	}
	for _, tt := range tests {
		if got := isAllowedExternalURL(tt.url); got != tt.want {
			t.Errorf("isAllowedExternalURL(%q) = %v; want %v", tt.url, got, tt.want)
		}
	}
}

func TestNativeWindowUsesDedicatedProfile(t *testing.T) {
	installDir := `C:\AMM`
	got := nativeWindowDataPath(installDir)
	legacy := filepath.Join(installDir, "data", "app-window")
	if got == legacy || !strings.HasSuffix(got, `data\native-window`) {
		t.Fatalf("native WebView2 profile must stay separate from legacy Chrome profile: %q", got)
	}
}

func TestNativeWindowHostArgs(t *testing.T) {
	args := nativeWindowHostArgs(
		`C:\AMM Install`,
		"http://127.0.0.1:54321",
		`C:\AMM Install\data\.native-window-ready-123`,
	)
	joined := strings.Join(args, "\n")
	for _, want := range []string{
		"--window-host",
		"--window-url=http://127.0.0.1:54321",
		`--window-ready-file=C:\AMM Install\data\.native-window-ready-123`,
		`--install-dir=C:\AMM Install`,
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("native host args missing %q: %v", want, args)
		}
	}
}

func TestNativeWindowReadyPathStartsAbsent(t *testing.T) {
	path, err := nativeWindowReadyPath(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("readiness path must not exist before child signals: %v", err)
	}
}

func TestNativeWindowMarkerOwnership(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	marker := nativeWindowMarker{PID: 42, HWND: 99, URL: "http://127.0.0.1:54321"}
	if err := writeNativeWindowMarker(dir, marker); err != nil {
		t.Fatal(err)
	}
	got, err := readNativeWindowMarker(dir)
	if err != nil || got != marker {
		t.Fatalf("marker round trip = %+v, %v; want %+v", got, err, marker)
	}
	removeNativeWindowMarker(dir, nativeWindowMarker{PID: 43, HWND: 99})
	if _, err := os.Stat(nativeWindowMarkerPath(dir)); err != nil {
		t.Fatalf("different process must not remove marker: %v", err)
	}
	removeNativeWindowMarker(dir, marker)
	if _, err := os.Stat(nativeWindowMarkerPath(dir)); !os.IsNotExist(err) {
		t.Fatalf("owner marker should be removed: %v", err)
	}
}

func TestAMMAppUserModelIDStable(t *testing.T) {
	if ammAppUserModelID != "AutomaticMunyunMachine.Desktop" {
		t.Fatalf("AppUserModelID changed; installer shortcut and process must match: %q", ammAppUserModelID)
	}
	if ammWindowTitle != "Automatic Munyun Machine" {
		t.Fatalf("native window title is also used for single-window activation: %q", ammWindowTitle)
	}
	if ammWindowIconID != 2 {
		t.Fatalf("window icon resource id must match winres/winres.json: %d", ammWindowIconID)
	}
	if !strings.Contains(nativeExternalLinkScript, "ammOpenExternal") ||
		!strings.Contains(nativeExternalLinkScript, `a[target='_blank']`) {
		t.Fatal("native window must route target=_blank links through the system browser")
	}
}
