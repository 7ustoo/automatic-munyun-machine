package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func smartOptions(r *http.Request) string {
	values := map[string]string{}
	for _, name := range []string{"scope", "keyword", "search", "band", "run", "page", "days", "day"} {
		values[name] = r.URL.Query().Get(name)
	}
	out, _ := json.Marshal(values)
	return string(out)
}

func (d *dashboardServer) handleBatchDescriptions(w http.ResponseWriter, r *http.Request) {
	d.relayDashboardAPI(w, 20*time.Second, "batch-descriptions-get")
}

func (d *dashboardServer) handleBatchDescriptionsRetry(w http.ResponseWriter, r *http.Request) {
	body, _ := json.Marshal(readBody(r))
	d.relayDashboardAPI(w, 30*time.Second, "batch-descriptions-retry", string(body))
}

func (d *dashboardServer) handleSmartMatch(w http.ResponseWriter, r *http.Request) {
	d.relayDashboardAPI(w, 20*time.Second, "smart-get", smartOptions(r))
}

func (d *dashboardServer) handleSmartConnection(w http.ResponseWriter, r *http.Request) {
	d.relayDashboardAPI(w, 20*time.Second, "smart-chatgpt-status")
}

func (d *dashboardServer) handleSmartConnect(w http.ResponseWriter, r *http.Request) {
	d.relayDashboardAPI(w, 20*time.Second, "smart-chatgpt-connect")
}

func (d *dashboardServer) handleSmartTrends(w http.ResponseWriter, r *http.Request) {
	d.relayDashboardAPI(w, 20*time.Second, "smart-trends", smartOptions(r))
}

func (d *dashboardServer) handleSmartAction(w http.ResponseWriter, r *http.Request) {
	body := readBody(r)
	d.relayDashboardAPI(w, 20*time.Second, "smart-action", body["action"], body["id"])
}

func (d *dashboardServer) handleSmartPrepare(w http.ResponseWriter, r *http.Request) {
	body := readBody(r)
	d.relayDashboardAPI(w, 30*time.Second, "smart-import-prepare", body["archive"])
}

func (d *dashboardServer) handleSmartReview(w http.ResponseWriter, r *http.Request) {
	body, _ := json.Marshal(readBody(r))
	d.relayDashboardAPI(w, 120*time.Second, "smart-import-review", string(body))
}

func (d *dashboardServer) handleSmartImport(w http.ResponseWriter, r *http.Request) {
	const limit int64 = 20 << 20
	r.Body = http.MaxBytesReader(w, r.Body, limit+(1<<20))
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
		writeJSONError(w, http.StatusOK, "CSV must be 20 MB or smaller and a valid upload.")
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	file, header, err := r.FormFile("csv")
	if err != nil {
		writeJSONError(w, http.StatusOK, "Choose a CSV file first.")
		return
	}
	defer file.Close()
	if strings.ToLower(filepath.Ext(header.Filename)) != ".csv" {
		writeJSONError(w, http.StatusOK, "Choose a .csv file.")
		return
	}
	dir := filepath.Join(d.installDir, "data", "uploads")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		writeJSONError(w, http.StatusOK, "Could not save this CSV.")
		return
	}
	dest, err := os.CreateTemp(dir, "jobs-*.csv")
	if err != nil {
		writeJSONError(w, http.StatusOK, "Could not save this CSV.")
		return
	}
	defer os.Remove(dest.Name())
	written, copyErr := io.Copy(dest, io.LimitReader(file, limit+1))
	closeErr := dest.Close()
	if copyErr != nil || closeErr != nil || written > limit {
		writeJSONError(w, http.StatusOK, "CSV must be 20 MB or smaller.")
		return
	}
	d.relayDashboardAPI(w, 45*time.Second, "smart-import-csv", dest.Name(), filepath.Base(header.Filename))
}
