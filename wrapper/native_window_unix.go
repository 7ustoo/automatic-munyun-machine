//go:build !windows

package main

// macOS/Linux retain Chromium app mode in v6.0. These stubs keep the shared
// orchestration code platform-neutral without pulling the Windows-only
// WebView2 dependency into POSIX builds.
func launchNativeWindowHost(installDir, dashboardURL string) bool { return false }
func runNativeWindowHost(installDir, dashboardURL, readyPath string) bool {
	return false
}
