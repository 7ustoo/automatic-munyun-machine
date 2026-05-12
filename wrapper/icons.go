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
