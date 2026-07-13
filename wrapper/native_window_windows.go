//go:build windows

package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
	"github.com/jchv/go-webview2/webviewloader"
)

const (
	ammAppUserModelID        = "AutomaticMunyunMachine.Desktop"
	ammWindowIconID          = 2
	ammWindowTitle           = "Automatic Munyun Machine"
	nativeExternalLinkScript = `
function ammRouteExternal(event) {
  var anchor = event.target && event.target.closest
    ? event.target.closest("a[target='_blank']")
    : null;
  if (!anchor || !anchor.href || typeof window.ammOpenExternal !== "function") return;
  event.preventDefault();
  window.ammOpenExternal(anchor.href).catch(function () {});
}
document.addEventListener("click", ammRouteExternal, true);
document.addEventListener("auxclick", ammRouteExternal, true);
document.addEventListener("submit", function (event) {
  var form = event.target;
  if (!form || String(form.target).toLowerCase() !== "_blank" ||
      typeof window.ammOpenExternal !== "function") return;
  event.preventDefault();
  window.ammOpenExternal(form.action).catch(function () {});
}, true);
var ammOriginalWindowOpen = window.open.bind(window);
window.open = function (url, target, features) {
  if (url && url !== "about:blank" && typeof window.ammOpenExternal === "function") {
    window.ammOpenExternal(String(url)).catch(function () {});
    return null;
  }
  return ammOriginalWindowOpen(url, target, features);
};`
)

var shell32 = syscall.NewLazyDLL("shell32.dll")
var setCurrentProcessExplicitAppUserModelID = shell32.NewProc("SetCurrentProcessExplicitAppUserModelID")
var user32 = syscall.NewLazyDLL("user32.dll")
var isWindow = user32.NewProc("IsWindow")
var getWindowThreadProcessID = user32.NewProc("GetWindowThreadProcessId")
var showWindow = user32.NewProc("ShowWindow")
var setForegroundWindow = user32.NewProc("SetForegroundWindow")

type nativeWindowMarker struct {
	PID  int    `json:"pid"`
	HWND uint64 `json:"hwnd"`
	URL  string `json:"url"`
}

// launchNativeWindowHost starts a child mode of this same AMM.exe. The child
// owns the WebView2/Win32 message loop while the primary process remains free
// to own the tray. Because the executable is AMM.exe and both the process and
// installer shortcuts use the same AppUserModelID, Windows groups and pins it
// as Automatic Munyun Machine rather than Microsoft Edge or Google Chrome.
func launchNativeWindowHost(installDir, dashboardURL string) bool {
	if !isLoopbackDashboardURL(dashboardURL) {
		log.Printf("appwindow: refusing non-loopback native window URL %q", dashboardURL)
		return false
	}
	if activateExistingNativeWindow(installDir, dashboardURL) {
		log.Printf("appwindow: activated existing native AMM window")
		return true
	}
	readyPath, err := nativeWindowReadyPath(installDir)
	if err != nil {
		log.Printf("appwindow: create native readiness path: %v", err)
		return false
	}
	defer os.Remove(readyPath)
	exe, err := os.Executable()
	if err != nil {
		log.Printf("appwindow: locate AMM.exe: %v", err)
		return false
	}
	cmd := exec.Command(exe, nativeWindowHostArgs(installDir, dashboardURL, readyPath)...)
	cmd.Dir = installDir
	if err := cmd.Start(); err != nil {
		log.Printf("appwindow: start native window host: %v", err)
		return false
	}
	for attempt := 0; attempt < 150; attempt++ {
		if _, err := os.Stat(readyPath); err == nil {
			trackAppWindowProcess(cmd.Process)
			return true
		}
		if !isProcessAlive(cmd.Process.Pid) {
			_, _ = cmd.Process.Wait()
			_ = os.Remove(nativeWindowMarkerPath(installDir))
			log.Printf("appwindow: native host exited before readiness; using browser fallback")
			return false
		}
		time.Sleep(100 * time.Millisecond)
	}
	killProcessTree(cmd.Process.Pid)
	_, _ = cmd.Process.Wait()
	_ = os.Remove(nativeWindowMarkerPath(installDir))
	log.Printf("appwindow: native host readiness timed out; using browser fallback")
	return false
}

func nativeWindowHostArgs(installDir, dashboardURL, readyPath string) []string {
	return []string{
		"--window-host",
		"--window-url=" + dashboardURL,
		"--window-ready-file=" + readyPath,
		"--install-dir=" + installDir,
	}
}

// runNativeWindowHost blocks until the user closes the native window. It is
// called only by the internal --window-host process mode, before tray or
// single-instance initialization.
func runNativeWindowHost(installDir, dashboardURL, readyPath string) bool {
	if !isLoopbackDashboardURL(dashboardURL) {
		log.Printf("appwindow: invalid native window URL %q", dashboardURL)
		return false
	}
	version, err := webviewloader.GetInstalledVersion()
	if err != nil || strings.TrimSpace(version) == "" {
		log.Printf("appwindow: WebView2 runtime unavailable (%v); browser fallback will be used", err)
		return false
	}

	// WebView2 and its Win32 window/message loop must stay on one OS thread.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	if err := setProcessAppUserModelID(ammAppUserModelID); err != nil {
		// Identity failure should not make the dashboard unavailable. The exe and
		// shortcut still carry AMM's icon; log and continue.
		log.Printf("appwindow: set AppUserModelID: %v", err)
	}

	// Never reuse data/app-window: that directory belongs to the legacy
	// Chrome app-mode profile and its on-disk format/session state is not a
	// WebView2 user-data folder. A clean, dedicated UDF avoids profile
	// corruption and stale browser content during the v5 → v6 migration.
	dataPath := nativeWindowDataPath(installDir)
	if err := os.MkdirAll(dataPath, 0o755); err != nil {
		log.Printf("appwindow: create WebView2 data directory: %v", err)
		return false
	}

	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     false,
		DataPath:  dataPath,
		AutoFocus: true,
		WindowOptions: webview2.WindowOptions{
			Title:  ammWindowTitle,
			Width:  1240,
			Height: 860,
			IconId: ammWindowIconID,
			// go-webview2 centers with unsigned subtraction, which can place
			// an 860px window off-screen on a 768px-tall display.
			Center: false,
		},
	})
	if w == nil {
		log.Printf("appwindow: WebView2 initialization failed; browser fallback will be used")
		return false
	}
	defer w.Destroy()
	if err := w.Bind("ammOpenExternal", func(raw string) error {
		if !isAllowedExternalURL(raw) {
			return fmt.Errorf("refusing unsupported external URL")
		}
		return openURL(raw)
	}); err != nil {
		log.Printf("appwindow: register external-link bridge: %v", err)
		return false
	}
	w.Init(nativeExternalLinkScript)
	w.SetSize(900, 640, webview2.HintMin)
	w.Navigate(dashboardURL)
	marker := nativeWindowMarker{
		PID:  os.Getpid(),
		HWND: uint64(uintptr(w.Window())),
		URL:  dashboardURL,
	}
	if err := writeNativeWindowMarker(installDir, marker); err != nil {
		log.Printf("appwindow: write native window marker: %v", err)
		return false
	}
	defer removeNativeWindowMarker(installDir, marker)
	if readyPath == "" {
		log.Printf("appwindow: native host missing readiness path")
		return false
	}
	if err := os.WriteFile(readyPath, []byte("ready\n"), 0o600); err != nil {
		log.Printf("appwindow: signal native readiness: %v", err)
		return false
	}
	w.Run()
	return true
}

func nativeWindowDataPath(installDir string) string {
	return filepath.Join(installDir, "data", "native-window")
}

func nativeWindowReadyPath(installDir string) (string, error) {
	dataDir := filepath.Join(installDir, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return "", err
	}
	f, err := os.CreateTemp(dataDir, ".native-window-ready-*")
	if err != nil {
		return "", err
	}
	name := f.Name()
	if err := f.Close(); err != nil {
		return "", err
	}
	if err := os.Remove(name); err != nil {
		return "", err
	}
	return name, nil
}

func setProcessAppUserModelID(appID string) error {
	ptr, err := syscall.UTF16PtrFromString(appID)
	if err != nil {
		return err
	}
	hresult, _, callErr := setCurrentProcessExplicitAppUserModelID.Call(uintptr(unsafe.Pointer(ptr)))
	if hresult != 0 {
		return fmt.Errorf("HRESULT 0x%08x (%v)", uint32(hresult), callErr)
	}
	return nil
}

func activateExistingNativeWindow(installDir, dashboardURL string) bool {
	marker, err := readNativeWindowMarker(installDir)
	if err != nil || marker.URL != dashboardURL || marker.PID <= 0 || marker.HWND == 0 ||
		!isProcessAlive(marker.PID) {
		return false
	}
	hwnd := uintptr(marker.HWND)
	valid, _, _ := isWindow.Call(hwnd)
	if valid == 0 {
		return false
	}
	var windowPID uint32
	_, _, _ = getWindowThreadProcessID.Call(hwnd, uintptr(unsafe.Pointer(&windowPID)))
	if int(windowPID) != marker.PID {
		return false
	}
	const swRestore = 9
	_, _, _ = showWindow.Call(hwnd, swRestore)
	_, _, _ = setForegroundWindow.Call(hwnd)
	return true
}

func nativeWindowMarkerPath(installDir string) string {
	return filepath.Join(installDir, "data", "native-window-host.json")
}

func readNativeWindowMarker(installDir string) (nativeWindowMarker, error) {
	var marker nativeWindowMarker
	data, err := os.ReadFile(nativeWindowMarkerPath(installDir))
	if err != nil {
		return marker, err
	}
	err = json.Unmarshal(data, &marker)
	return marker, err
}

func writeNativeWindowMarker(installDir string, marker nativeWindowMarker) error {
	data, err := json.Marshal(marker)
	if err != nil {
		return err
	}
	return os.WriteFile(nativeWindowMarkerPath(installDir), data, 0o600)
}

func removeNativeWindowMarker(installDir string, owned nativeWindowMarker) {
	current, err := readNativeWindowMarker(installDir)
	if err == nil && current.PID == owned.PID && current.HWND == owned.HWND {
		_ = os.Remove(nativeWindowMarkerPath(installDir))
	}
}

func isLoopbackDashboardURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	host := u.Hostname()
	if host != "127.0.0.1" && host != "localhost" && host != "::1" {
		return false
	}
	port := u.Port()
	if port == "" {
		return false
	}
	n, err := strconv.Atoi(port)
	return err == nil && n >= 1 && n <= 65535
}
