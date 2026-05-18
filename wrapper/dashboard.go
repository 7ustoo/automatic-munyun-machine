package main

// v1.3: local-only HTTP dashboard.
//
// A tiny status page bound to 127.0.0.1 on an OS-assigned port. The tray
// menu has a "Open dashboard" item that opens the URL in the user's
// default browser. The dashboard reads the same JSON files the tray
// + watchdog already read (heartbeat.json, last-batch.json, config.json)
// and presents them as a single-page view.
//
// Security model: localhost-only bind. There are no state-changing
// endpoints in MVP — pure read-only status surface. Anything action-y
// stays in the tray menu or Telegram.
//
// Lifecycle: started from main.go after isConfigured passes (or after
// the tray transitions out of needsSetup mode). Shut down via Shutdown()
// from onTrayExit so the wrapper exits cleanly with no leaked port.

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"time"
)

//go:embed dashboard.html
var dashboardHTML []byte

// dashboardServer owns the HTTP listener + handler mux. Construct with
// startDashboard(); release with Shutdown().
type dashboardServer struct {
	installDir string
	listener   net.Listener
	srv        *http.Server
}

// startDashboard binds a free port on 127.0.0.1 and starts serving in a
// goroutine. Returns immediately once the listener is bound so the caller
// can read Port()/URL() right away. The chosen port is also written to
// data/dashboard-port.txt for any external reader (CLI, scripts, debug).
func startDashboard(installDir string) (*dashboardServer, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("dashboard listen: %w", err)
	}

	d := &dashboardServer{installDir: installDir, listener: ln}

	mux := http.NewServeMux()
	mux.HandleFunc("/", d.handleIndex)
	mux.HandleFunc("/api/status", d.handleStatus)

	d.srv = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		if err := d.srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("dashboard: serve error: %v", err)
		}
	}()

	port := d.Port()
	portFile := filepath.Join(installDir, "data", "dashboard-port.txt")
	if err := os.MkdirAll(filepath.Dir(portFile), 0o755); err == nil {
		_ = os.WriteFile(portFile, []byte(fmt.Sprintf("%d\n", port)), 0o644)
	}

	log.Printf("dashboard: listening on http://127.0.0.1:%d", port)
	return d, nil
}

func (d *dashboardServer) Port() int {
	if d == nil || d.listener == nil {
		return 0
	}
	addr, ok := d.listener.Addr().(*net.TCPAddr)
	if !ok {
		return 0
	}
	return addr.Port
}

func (d *dashboardServer) URL() string {
	return fmt.Sprintf("http://127.0.0.1:%d", d.Port())
}

// Shutdown stops the HTTP server with a short grace window. Safe to call
// on a nil receiver or a never-started server.
func (d *dashboardServer) Shutdown() {
	if d == nil || d.srv == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := d.srv.Shutdown(ctx); err != nil {
		log.Printf("dashboard: shutdown: %v", err)
	}
}

func (d *dashboardServer) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(dashboardHTML)
}

func (d *dashboardServer) handleStatus(w http.ResponseWriter, r *http.Request) {
	status := buildStatus(d.installDir)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(status)
}

// --- Status aggregation (pure, testable) ---

type statusResponse struct {
	Wrapper   wrapperInfo   `json:"wrapper"`
	Bot       botInfo       `json:"bot"`
	Telegram  telegramInfo  `json:"telegram"`
	Profile   profileInfo   `json:"profile"`
	LastBatch lastBatchInfo `json:"lastBatch"`
	Now       string        `json:"now"`
}

type wrapperInfo struct {
	Version    string `json:"version"`
	Pid        int    `json:"pid"`
	InstallDir string `json:"installDir"`
}

type botInfo struct {
	// State is one of: "alive", "stale", "dead", "unknown".
	// Thresholds mirror scripts/watchdog.mjs and wrapper/tray.go.
	State               string `json:"state"`
	Pid                 int    `json:"pid"`
	Version             string `json:"version"`
	StartedAt           string `json:"startedAt"`
	LastHeartbeatAgeSec int64  `json:"lastHeartbeatAgeSec"`
	UptimeSec           int64  `json:"uptimeSec"`
	LastHeartbeatTs     string `json:"lastHeartbeatTs"`
}

type telegramInfo struct {
	Connected           bool `json:"connected"`
	LastPollOk          bool `json:"lastPollOk"`
	ConsecutiveFailures int  `json:"consecutiveFailures"`
}

type profileInfo struct {
	Active string   `json:"active"`
	All    []string `json:"all"`
}

type lastBatchInfo struct {
	Available   bool       `json:"available"`
	Date        string     `json:"date"`
	Profile     string     `json:"profile"`
	GeneratedAt string     `json:"generatedAt"`
	JobCount    int        `json:"jobCount"`
	Jobs        []batchJob `json:"jobs"`
}

type batchJob struct {
	Idx       int    `json:"idx"`
	Title     string `json:"title"`
	Company   string `json:"company"`
	Yoe       *int   `json:"yoe"`
	MatchPct  int    `json:"matchPct"`
	Score     int    `json:"score"`
	Query     string `json:"q"`
	DirectURL string `json:"directUrl"`
	ViewURL   string `json:"viewjobUrl"`
}

// dashboardJobLimit caps how many jobs from last-batch.json appear on the
// page. The full batch arrives in Telegram; the dashboard is a glance.
const dashboardJobLimit = 10

// buildStatus is pure given (installDir, now). Reads heartbeat.json,
// config.json, and data/profiles/<active>/last-batch.json. Missing or
// malformed files leave their section in its zero/unknown state — never
// panics, never errors out. Designed so the same fn drives both the HTTP
// handler and the unit tests.
func buildStatus(installDir string) statusResponse {
	return buildStatusAt(installDir, time.Now())
}

func buildStatusAt(installDir string, now time.Time) statusResponse {
	out := statusResponse{
		Wrapper: wrapperInfo{
			Version:    AMMVersion,
			Pid:        os.Getpid(),
			InstallDir: installDir,
		},
		Bot:       botInfo{State: "unknown"},
		Telegram:  telegramInfo{},
		Profile:   profileInfo{All: []string{}},
		LastBatch: lastBatchInfo{Jobs: []batchJob{}},
		Now:       now.UTC().Format(time.RFC3339),
	}

	readHeartbeatInto(installDir, now, &out)
	readConfigInto(installDir, &out)
	readLastBatchInto(installDir, out.Profile.Active, &out)

	return out
}

func readHeartbeatInto(installDir string, now time.Time, out *statusResponse) {
	data, err := os.ReadFile(filepath.Join(installDir, "data", "heartbeat.json"))
	if err != nil {
		return
	}
	var hb struct {
		Ts                  string `json:"ts"`
		Pid                 int    `json:"pid"`
		Version             string `json:"version"`
		StartedAt           string `json:"startedAt"`
		LastPollOk          bool   `json:"lastPollOk"`
		ConsecutiveFailures int    `json:"consecutiveFailures"`
	}
	if err := json.Unmarshal(data, &hb); err != nil || hb.Ts == "" {
		return
	}

	out.Bot.Pid = hb.Pid
	out.Bot.Version = hb.Version
	out.Bot.StartedAt = hb.StartedAt
	out.Bot.LastHeartbeatTs = hb.Ts

	if ts := parseAnyRFC3339(hb.Ts); !ts.IsZero() {
		age := now.Sub(ts)
		out.Bot.LastHeartbeatAgeSec = int64(age.Seconds())
		switch {
		case age < heartbeatFreshThreshold:
			out.Bot.State = "alive"
		case age < heartbeatStaleThreshold:
			out.Bot.State = "stale"
		default:
			out.Bot.State = "dead"
		}
	}
	if started := parseAnyRFC3339(hb.StartedAt); !started.IsZero() {
		out.Bot.UptimeSec = int64(now.Sub(started).Seconds())
	}

	out.Telegram.LastPollOk = hb.LastPollOk
	out.Telegram.ConsecutiveFailures = hb.ConsecutiveFailures
	// "Connected" means the last poll round-tripped AND the bot itself is
	// still considered alive. A stale-heartbeat bot might have a lastPollOk
	// from 11 minutes ago — that's not "connected" anymore.
	out.Telegram.Connected = hb.LastPollOk && out.Bot.State == "alive"
}

func readConfigInto(installDir string, out *statusResponse) {
	data, err := os.ReadFile(filepath.Join(installDir, "config.json"))
	if err != nil {
		return
	}
	var cfg struct {
		ActiveProfile string                     `json:"active_profile"`
		Profiles      map[string]json.RawMessage `json:"profiles"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return
	}
	out.Profile.Active = cfg.ActiveProfile
	for k := range cfg.Profiles {
		out.Profile.All = append(out.Profile.All, k)
	}
	sort.Strings(out.Profile.All)
}

func readLastBatchInto(installDir, activeProfile string, out *statusResponse) {
	if activeProfile == "" {
		return
	}
	lbPath := filepath.Join(installDir, "data", "profiles", activeProfile, "last-batch.json")
	data, err := os.ReadFile(lbPath)
	if err != nil {
		return
	}
	var lb struct {
		Date        string            `json:"date"`
		Profile     string            `json:"profile"`
		GeneratedAt string            `json:"generatedAt"`
		Jobs        []json.RawMessage `json:"jobs"`
	}
	if err := json.Unmarshal(data, &lb); err != nil {
		return
	}
	out.LastBatch.Available = true
	out.LastBatch.Date = lb.Date
	out.LastBatch.Profile = lb.Profile
	out.LastBatch.GeneratedAt = lb.GeneratedAt
	out.LastBatch.JobCount = len(lb.Jobs)

	limit := len(lb.Jobs)
	if limit > dashboardJobLimit {
		limit = dashboardJobLimit
	}
	for i := 0; i < limit; i++ {
		var j struct {
			Idx       int     `json:"idx"`
			Title     string  `json:"title"`
			Company   string  `json:"company"`
			Yoe       *int    `json:"yoe"`
			MatchPct  int     `json:"matchPct"`
			Score     float64 `json:"score"`
			Query     string  `json:"q"`
			DirectURL string  `json:"directUrl"`
			ViewURL   string  `json:"viewjobUrl"`
		}
		if err := json.Unmarshal(lb.Jobs[i], &j); err != nil {
			continue
		}
		out.LastBatch.Jobs = append(out.LastBatch.Jobs, batchJob{
			Idx:       j.Idx,
			Title:     j.Title,
			Company:   j.Company,
			Yoe:       j.Yoe,
			MatchPct:  j.MatchPct,
			Score:     int(j.Score),
			Query:     j.Query,
			DirectURL: j.DirectURL,
			ViewURL:   j.ViewURL,
		})
	}
}

// parseAnyRFC3339 accepts both nanosecond and second-precision ISO8601.
// The bot writes nanosecond precision; older heartbeats might be RFC3339.
func parseAnyRFC3339(s string) time.Time {
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t
	}
	return time.Time{}
}
