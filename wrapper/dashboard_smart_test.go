package main

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSmartCSVUploadGuardsLimitsAndRemovesOriginal(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "scripts"), 0o700); err != nil {
		t.Fatal(err)
	}
	helper := `const fs=require('fs');const file=process.argv[3];console.log(JSON.stringify({ok:true,filename:process.argv[4],temporary:file,content:fs.readFileSync(file,'utf8')}));`
	if err := os.WriteFile(filepath.Join(dir, "scripts", "dashboard-api.mjs"), []byte("import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"+helper), 0o600); err != nil {
		t.Fatal(err)
	}
	d := &dashboardServer{installDir: dir, csrfToken: "token"}
	request := func(filename, content, token string) *httptest.ResponseRecorder {
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		file, err := writer.CreateFormFile("csv", filename)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = file.Write([]byte(content))
		_ = writer.Close()
		r := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/api/smart-match/import", &body)
		r.Header.Set("Content-Type", writer.FormDataContentType())
		r.Header.Set("X-AMM-Token", token)
		w := httptest.NewRecorder()
		d.guardPost(d.handleSmartImport)(w, r)
		return w
	}
	if w := request("jobs.csv", "Title,URL", "wrong"); w.Code != http.StatusForbidden {
		t.Fatal("upload bypassed token guard")
	}
	if w := request("jobs.exe", "bad", "token"); !strings.Contains(w.Body.String(), ".csv file") {
		t.Fatal(w.Body.String())
	}
	w := request("jobs.csv", "Title,URL\nLinux,https://jobs.example.com/1", "token")
	var result struct {
		OK        bool   `json:"ok"`
		Temporary string `json:"temporary"`
		Content   string `json:"content"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || !result.OK {
		t.Fatalf("upload failed: %s", w.Body.String())
	}
	if !strings.Contains(result.Content, "Linux") {
		t.Fatal("helper lost CSV contents")
	}
	if _, err := os.Stat(result.Temporary); !os.IsNotExist(err) {
		t.Fatal("uploaded original remained on disk")
	}
	w = request("large.csv", strings.Repeat("x", (20<<20)+1), "token")
	if !strings.Contains(w.Body.String(), "20 MB") {
		t.Fatal("large CSV accepted")
	}
}
