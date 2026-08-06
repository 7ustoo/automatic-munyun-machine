package main

import (
	"os"
	"path/filepath"
	"testing"
)

// v8.1: the .app bundle layout. These are pure path tests so they run on every
// CI platform, not just macOS — the bundle rules are the one piece of the Mac
// packaging that can be verified without a Mac.

// buildBundle lays out a minimal AMM.app under root and returns the exe path.
func buildBundle(t *testing.T, root string, withPayload, withNode bool) string {
	t.Helper()
	macos := filepath.Join(root, "AMM.app", "Contents", "MacOS")
	if err := os.MkdirAll(macos, 0o755); err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(macos, "AMM")
	if err := os.WriteFile(exe, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	if withPayload {
		app := filepath.Join(root, "AMM.app", "Contents", "Resources", "app")
		if err := os.MkdirAll(app, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(app, "package.json"), []byte(`{"name":"amm"}`), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if withNode {
		bin := filepath.Join(root, "AMM.app", "Contents", "Resources", "node", "bin")
		if err := os.MkdirAll(bin, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(bin, "node"), []byte("node"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return exe
}

func TestMacAppPayloadDir_ResolvesToResourcesApp(t *testing.T) {
	root := t.TempDir()
	exe := buildBundle(t, root, true, false)
	got, ok := macAppPayloadDir(exe)
	if !ok {
		t.Fatal("expected a bundle payload dir")
	}
	want := filepath.Join(root, "AMM.app", "Contents", "Resources", "app")
	if got != want {
		t.Fatalf("want %q, got %q", want, got)
	}
}

func TestMacAppPayloadDir_RejectsNonBundlePaths(t *testing.T) {
	// The normal Windows/Linux layout must NOT be treated as a bundle,
	// otherwise every platform would resolve its install dir wrong.
	root := t.TempDir()
	normal := filepath.Join(root, "wrapper", "dist", "AMM")
	if err := os.MkdirAll(filepath.Dir(normal), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, ok := macAppPayloadDir(normal); ok {
		t.Fatal("plain <install>/wrapper/dist/AMM must not resolve as a bundle")
	}
}

func TestMacAppPayloadDir_PartialBundleFallsThrough(t *testing.T) {
	// Bundle shape is right but the payload never got copied — better to fall
	// through to normal resolution than to hand back a directory with no
	// package.json in it.
	root := t.TempDir()
	exe := buildBundle(t, root, false, false)
	if _, ok := macAppPayloadDir(exe); ok {
		t.Fatal("a bundle with no payload must not resolve")
	}
}

func TestMacBundledNode(t *testing.T) {
	root := t.TempDir()
	exe := buildBundle(t, root, true, true)
	got, ok := macBundledNode(exe)
	if !ok {
		t.Fatal("expected the bundled node runtime")
	}
	want := filepath.Join(root, "AMM.app", "Contents", "Resources", "node", "bin", "node")
	if got != want {
		t.Fatalf("want %q, got %q", want, got)
	}

	// No runtime in the bundle → caller falls back to PATH.
	root2 := t.TempDir()
	exe2 := buildBundle(t, root2, true, false)
	if _, ok := macBundledNode(exe2); ok {
		t.Fatal("missing runtime must not resolve")
	}
}
