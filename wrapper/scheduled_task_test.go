package main

import (
	"path/filepath"
	"testing"
)

func TestScheduledHelperPath(t *testing.T) {
	root := filepath.Join("C:", "AMM")
	cases := map[string]string{
		"daily":        "daily-batch.mjs",
		"watchdog":     "watchdog.mjs",
		"batch-missed": "batch-missed-watcher.mjs",
	}
	for task, wantFile := range cases {
		got, err := scheduledHelperPath(root, task)
		if err != nil {
			t.Fatalf("%s: %v", task, err)
		}
		if filepath.Base(got) != wantFile {
			t.Errorf("%s: got %s, want %s", task, got, wantFile)
		}
	}
}

func TestScheduledHelperRejectsUnknownTask(t *testing.T) {
	if _, err := scheduledHelperPath("C:\\AMM", "anything-else"); err == nil {
		t.Fatal("unknown task must be rejected")
	}
}
