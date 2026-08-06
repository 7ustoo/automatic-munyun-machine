package main

import (
	"os"
	"path/filepath"
	"strings"
)

// macOS .app bundle layout support (v8.1).
//
// AMM ships on macOS as a real application bundle so it installs by dragging
// it to /Applications like any other Mac app:
//
//	AMM.app/Contents/MacOS/AMM              ← this binary (macOS requires it here)
//	AMM.app/Contents/Resources/app/         ← the JS payload (package.json, scripts/, wrapper/)
//	AMM.app/Contents/Resources/node/bin/node ← bundled Node runtime
//
// The default install-dir rule ("up two from the binary") is built for the
// Windows/Linux layout <install>/wrapper/dist/AMM and does not survive that
// move, so macAppPayloadDir special-cases the bundle. Kept in its own file
// (and pure, taking the path as an argument) so it unit-tests on any OS —
// the CI matrix runs Go tests on Linux and Windows too.

// macAppPayloadDir maps a bundled executable path to the payload directory.
// Returns ok=false when exePath isn't inside a .app bundle, or when the
// payload directory isn't actually present (a malformed/partial bundle should
// fall through to the normal resolution rather than point at a missing dir).
func macAppPayloadDir(exePath string) (string, bool) {
	dir := filepath.Dir(exePath) // .../AMM.app/Contents/MacOS
	if filepath.Base(dir) != "MacOS" {
		return "", false
	}
	contents := filepath.Dir(dir) // .../AMM.app/Contents
	if filepath.Base(contents) != "Contents" {
		return "", false
	}
	if !strings.HasSuffix(filepath.Base(filepath.Dir(contents)), ".app") {
		return "", false
	}
	payload := filepath.Join(contents, "Resources", "app")
	if _, err := os.Stat(filepath.Join(payload, "package.json")); err != nil {
		return "", false
	}
	return payload, true
}

// macBundledNode returns the path to the Node runtime shipped inside the
// bundle, if present. macOS users are not expected to have Node installed —
// the same guarantee the Windows installer already makes by shipping
// runtime\node.exe. Returns ok=false outside a bundle or when the runtime is
// missing, so callers fall back to Node on PATH.
func macBundledNode(exePath string) (string, bool) {
	dir := filepath.Dir(exePath)
	if filepath.Base(dir) != "MacOS" {
		return "", false
	}
	contents := filepath.Dir(dir)
	node := filepath.Join(contents, "Resources", "node", "bin", "node")
	if fi, err := os.Stat(node); err != nil || fi.IsDir() {
		return "", false
	}
	return node, true
}
