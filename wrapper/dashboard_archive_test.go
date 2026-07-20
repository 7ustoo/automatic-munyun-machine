package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// v7.2: previous scrapes (batch archive) endpoints — list, get, and the
// path-traversal guard on ids.

func writeArchive(t *testing.T, dir string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "config.json"),
		[]byte(`{"active_profile":"default","profiles":{"default":{}}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	ad := filepath.Join(dir, "data", "profiles", "default", "batch-archive")
	if err := os.MkdirAll(ad, 0o755); err != nil {
		t.Fatal(err)
	}
	idx := `{"lastUpdated":"2026-07-20T14:33:05.000Z","archives":[{"id":"batch-2026-07-20T14-33-05","date":"2026-07-20","sent":2,"avgPct":65,"strongCount":1}]}`
	if err := os.WriteFile(filepath.Join(ad, "index.json"), []byte(idx), 0o644); err != nil {
		t.Fatal(err)
	}
	snap := `{"date":"2026-07-20","jobs":[{"title":"IAM Engineer","matchPct":90},{"title":"Linux Admin","matchPct":40}]}`
	if err := os.WriteFile(filepath.Join(ad, "batch-2026-07-20T14-33-05.json"), []byte(snap), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestHandleArchiveList_ReturnsIndex(t *testing.T) {
	dir := t.TempDir()
	writeArchive(t, dir)
	d := &dashboardServer{installDir: dir}
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/api/archive", nil)
	rec := httptest.NewRecorder()
	d.handleArchiveList(rec, req)
	var out struct {
		OK       bool `json:"ok"`
		Archives []struct {
			ID   string `json:"id"`
			Sent int    `json:"sent"`
		} `json:"archives"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if !out.OK || len(out.Archives) != 1 || out.Archives[0].ID != "batch-2026-07-20T14-33-05" || out.Archives[0].Sent != 2 {
		t.Fatalf("unexpected list response: %s", rec.Body.String())
	}
}

func TestHandleArchiveList_MissingIndexIsEmptyOK(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "config.json"),
		[]byte(`{"active_profile":"default","profiles":{"default":{}}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	d := &dashboardServer{installDir: dir}
	rec := httptest.NewRecorder()
	d.handleArchiveList(rec, httptest.NewRequest(http.MethodGet, "http://127.0.0.1/api/archive", nil))
	var out struct {
		OK       bool              `json:"ok"`
		Archives []json.RawMessage `json:"archives"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if !out.OK || out.Archives == nil || len(out.Archives) != 0 {
		t.Fatalf("want ok+empty archives, got: %s", rec.Body.String())
	}
}

func TestHandleArchiveGet_ReturnsBatchAndGuardsIds(t *testing.T) {
	dir := t.TempDir()
	writeArchive(t, dir)
	d := &dashboardServer{installDir: dir}

	rec := httptest.NewRecorder()
	d.handleArchiveGet(rec, httptest.NewRequest(http.MethodGet, "http://127.0.0.1/api/archive/batch?id=batch-2026-07-20T14-33-05", nil))
	var out struct {
		OK    bool `json:"ok"`
		Batch struct {
			Jobs []struct {
				Title string `json:"title"`
			} `json:"jobs"`
		} `json:"batch"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if !out.OK || len(out.Batch.Jobs) != 2 || out.Batch.Jobs[0].Title != "IAM Engineer" {
		t.Fatalf("unexpected batch response: %s", rec.Body.String())
	}

	// Traversal / malformed ids → 400, never a file read.
	for _, id := range []string{"../../config", "batch-2026-07-20", "batch-2026-07-20T14-33-05.json", ""} {
		rec := httptest.NewRecorder()
		d.handleArchiveGet(rec, httptest.NewRequest(http.MethodGet, "http://127.0.0.1/api/archive/batch?id="+id, nil))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("id %q: want 400, got %d", id, rec.Code)
		}
	}

	// Well-formed but unknown id → 404.
	rec = httptest.NewRecorder()
	d.handleArchiveGet(rec, httptest.NewRequest(http.MethodGet, "http://127.0.0.1/api/archive/batch?id=batch-2099-01-01T00-00-00", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("unknown id: want 404, got %d", rec.Code)
	}
}
