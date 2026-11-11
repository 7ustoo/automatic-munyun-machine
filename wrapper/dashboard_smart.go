package main

import (
	"encoding/json"
	"net/http"
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

func (d *dashboardServer) handleSmartMatch(w http.ResponseWriter, r *http.Request) {
	d.relayDashboardAPI(w, 20*time.Second, "smart-get", smartOptions(r))
}

func (d *dashboardServer) handleSmartTrends(w http.ResponseWriter, r *http.Request) {
	d.relayDashboardAPI(w, 20*time.Second, "smart-trends", smartOptions(r))
}

func (d *dashboardServer) handleSmartAction(w http.ResponseWriter, r *http.Request) {
	body := readBody(r)
	d.relayDashboardAPI(w, 20*time.Second, "smart-action", body["action"], body["id"])
}
