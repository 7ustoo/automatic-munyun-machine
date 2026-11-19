package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSimpleCSVExportPreservesArchiveAndCatalogScope(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "scripts"), 0o700); err != nil {
		t.Fatal(err)
	}
	helper := `console.log(JSON.stringify({ok:true,filename:"simple-jobs.csv",content:JSON.stringify(process.argv.slice(2))}));`
	if err := os.WriteFile(filepath.Join(dir, "scripts", "dashboard-api.mjs"), []byte(helper), 0o600); err != nil {
		t.Fatal(err)
	}
	d := &dashboardServer{installDir: dir}
	for _, query := range []string{"format=csv-simple", "format=csv-simple&archive=batch-2026-11-09T15-41-49", "format=csv-simple&catalog=excluded&keyword=linux&run=selected"} {
		rec := httptest.NewRecorder()
		d.guardGet(d.handleExport)(rec, httptest.NewRequest(http.MethodGet, "http://127.0.0.1/api/export?"+query, nil))
		if rec.Code != http.StatusOK || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/csv") || !strings.Contains(rec.Header().Get("Content-Disposition"), "simple-jobs.csv") {
			t.Fatalf("bad CSV response: %d %v %s", rec.Code, rec.Header(), rec.Body.String())
		}
		var args []string
		if err := json.Unmarshal(rec.Body.Bytes(), &args); err != nil {
			t.Fatal(err)
		}
		if args[1] != "csv-simple" {
			t.Fatalf("simple export downgraded: %v", args)
		}
		if strings.Contains(query, "archive=") && args[2] != "batch-2026-11-09T15-41-49" {
			t.Fatalf("archive identity lost: %v", args)
		}
		if strings.Contains(query, "catalog=") {
			var options map[string]string
			if err := json.Unmarshal([]byte(args[2]), &options); err != nil || args[0] != "smart-export" || options["scope"] != "excluded" || options["keyword"] != "linux" || options["run"] != "selected" {
				t.Fatalf("catalog filters lost: %v", args)
			}
		}
	}
}
