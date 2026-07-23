package main

import (
	"os"
	"path/filepath"
	"testing"
)

// v7.7: the ✕ exclusions sidecar — Open All must skip excluded jobs, and a
// stale stamp (new scrape since the ✕ was clicked) must read as empty.

func writeExclusionsFile(t *testing.T, dir, stamp string, idxs string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "config.json"),
		[]byte(`{"active_profile":"default","profiles":{"default":{}}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	pd := filepath.Join(dir, "data", "profiles", "default")
	if err := os.MkdirAll(pd, 0o755); err != nil {
		t.Fatal(err)
	}
	body := `{"batchGeneratedAt":"` + stamp + `","excluded":` + idxs + `}`
	if err := os.WriteFile(filepath.Join(pd, "batch-exclusions.json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestReadBatchExclusions_MatchingStamp(t *testing.T) {
	dir := t.TempDir()
	writeExclusionsFile(t, dir, "S1", "[2,5]")
	ex := readBatchExclusions(dir, "S1")
	if len(ex) != 2 || !ex[2] || !ex[5] {
		t.Fatalf("want {2,5}, got %v", ex)
	}
}

func TestReadBatchExclusions_StaleStampOrMissing(t *testing.T) {
	dir := t.TempDir()
	writeExclusionsFile(t, dir, "OLD", "[2]")
	if ex := readBatchExclusions(dir, "NEW"); len(ex) != 0 {
		t.Fatalf("stale stamp must read empty, got %v", ex)
	}
	if ex := readBatchExclusions(dir, ""); len(ex) != 0 {
		t.Fatalf("empty stamp must read empty, got %v", ex)
	}
	if ex := readBatchExclusions(t.TempDir(), "S"); len(ex) != 0 {
		t.Fatalf("missing file must read empty, got %v", ex)
	}
}

func TestOpenAll_SkipsExcludedJobs(t *testing.T) {
	jobs := []batchJob{
		{Idx: 1, DirectURL: "https://a.example/1"},
		{Idx: 2, DirectURL: "https://a.example/2"},
		{Idx: 3, DirectURL: "https://a.example/3"},
	}
	excluded := map[int]bool{2: true}
	kept := jobs[:0:0]
	for _, j := range jobs {
		if !excluded[j.Idx] {
			kept = append(kept, j)
		}
	}
	var opened []string
	o, s, f := openBatchJobs(kept, func(u string) error { opened = append(opened, u); return nil })
	if o != 2 || s != 0 || f != 0 {
		t.Fatalf("want opened=2, got o=%d s=%d f=%d", o, s, f)
	}
	for _, u := range opened {
		if u == "https://a.example/2" {
			t.Fatal("excluded job #2 was opened")
		}
	}
}
