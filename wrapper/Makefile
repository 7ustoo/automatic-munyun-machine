# Cross-platform build for the AMM tray wrapper.
#
# IMPORTANT: fyne.io/systray uses native APIs on macOS (Cocoa) and Linux
# (GTK / dbus), which means **CGO is required** on those platforms. You
# CANNOT cross-compile a Mac or Linux binary from a Windows host without
# setting up an OSXCross / MinGW toolchain (out of scope for this project).
#
# In practice:
#   - Windows builds run on a Windows host (or windows-latest GH Actions runner)
#   - Mac builds run on a macOS host (or macos-latest GH Actions runner)
#   - Linux builds run on a Linux host (or ubuntu-latest GH Actions runner)
#
# The release pipeline (.github/workflows/release.yml) uses a matrix to run
# the per-platform build natively on each runner. For local dev, `make build`
# auto-detects your host and builds for the right target.
#
# Targets:
#   make build       →  auto-detect host platform, build for it
#   make build-win   →  dist/AMM.exe          (must run on Windows host)
#   make build-mac   →  dist/AMM-darwin-arm64 + dist/AMM-darwin-amd64 (must run on macOS host)
#   make build-linux →  dist/amm-tray         (must run on Linux host)
#   make clean       →  rm -rf dist/
#   make run         →  go run . (foreground tray, dev mode)
#   make tidy        →  go mod tidy
#   make print-version → echoes resolved version (used by CI)

VERSION := $(shell node -p "require('../package.json').version" 2>/dev/null || echo "0.0.0")
LDFLAGS_WIN := -ldflags="-H windowsgui -s -w -X main.AMMVersion=$(VERSION)"
LDFLAGS_POSIX := -ldflags="-s -w -X main.AMMVersion=$(VERSION)"

DIST := dist
UNAME_S := $(shell uname -s 2>/dev/null || echo Windows)

.PHONY: build build-win build-mac build-linux clean run tidy print-version

build: $(DIST)
ifeq ($(OS),Windows_NT)
	@$(MAKE) build-win
else ifeq ($(UNAME_S),Darwin)
	@$(MAKE) build-mac
else
	@$(MAKE) build-linux
endif

build-win: $(DIST)
	@echo "→ Building Windows amd64 (v$(VERSION))"
	@echo "→ Embedding exe icon (go-winres, pinned)"
	go run github.com/tc-hib/go-winres@v0.3.3 make --in winres/winres.json
	go build $(LDFLAGS_WIN) -o $(DIST)/AMM.exe .

build-mac: $(DIST)
	@echo "→ Building macOS arm64 (v$(VERSION)) — CGO enabled"
	CGO_ENABLED=1 GOARCH=arm64 go build $(LDFLAGS_POSIX) -o $(DIST)/AMM-darwin-arm64 .
	@echo "→ Building macOS amd64 (v$(VERSION)) — CGO enabled"
	CGO_ENABLED=1 GOARCH=amd64 go build $(LDFLAGS_POSIX) -o $(DIST)/AMM-darwin-amd64 .

build-linux: $(DIST)
	@echo "→ Building Linux amd64 (v$(VERSION)) — CGO enabled"
	@echo "  (requires: apt install gcc libgtk-3-dev libayatana-appindicator3-dev)"
	CGO_ENABLED=1 go build $(LDFLAGS_POSIX) -o $(DIST)/amm-tray .

$(DIST):
	@mkdir -p $(DIST) 2>/dev/null || true

clean:
	rm -rf $(DIST)

run:
	go run .

tidy:
	go mod tidy

print-version:
	@echo "$(VERSION)"
