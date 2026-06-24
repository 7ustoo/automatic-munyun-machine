package main

import _ "embed"

// Icons are embedded at build time so the binary is fully self-contained —
// no separate icon files to ship in the installer.
//
// Both ICO (Windows tray) and PNG (Mac menubar, Linux StatusNotifier) are
// embedded for every state. The tray-init code picks the right one per
// runtime.GOOS — see tray.go.

//go:embed icon-green.ico
var iconGreenICO []byte

//go:embed icon-yellow.ico
var iconYellowICO []byte

//go:embed icon-red.ico
var iconRedICO []byte

//go:embed icon-gray.ico
var iconGrayICO []byte

//go:embed icon-green.png
var iconGreenPNG []byte

//go:embed icon-yellow.png
var iconYellowPNG []byte

//go:embed icon-red.png
var iconRedPNG []byte

//go:embed icon-gray.png
var iconGrayPNG []byte

// v2.3: the AMM brand logo, shown as the tray icon for healthy/idle states
// (instead of a plain gray dot). The color-coded icons above are kept for
// genuine warning/error states (stale heartbeat / dead bot).
//
// Windows uses logo-tray.ico — a BMP/DIB-encoded ICO (scripts/build/
// make-tray-ico.mjs). NOT logo.ico: that one is PNG-compressed and the
// system-tray loader (fyne/systray → Win32) can't read PNG entries
// ("unable to load icon from file"). logo.ico stays the favicon/installer icon.
//
//go:embed logo-tray.ico
var iconLogoICO []byte

//go:embed logo.png
var iconLogoPNG []byte
