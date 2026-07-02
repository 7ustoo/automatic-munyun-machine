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
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

//go:embed dashboard.html
var dashboardHTML []byte

//go:embed logo.png
var logoPNG []byte // v2.2: served as the app-window favicon

// dashboardServer owns the HTTP listener + handler mux. Construct with
// startDashboard(); release with Shutdown().
type dashboardServer struct {
	installDir string
	listener   net.Listener
	srv        *http.Server
	sup        *supervisor // v2.1: lets POST endpoints start/stop the bot poller
	csrfToken  string      // v2.1: required on POST; injected into the served HTML
}

// startDashboard binds a free port on 127.0.0.1 and starts serving in a
// goroutine. Returns immediately once the listener is bound so the caller
// can read Port()/URL() right away. The chosen port is also written to
// data/dashboard-port.txt for any external reader (CLI, scripts, debug).
//
// v2.1: takes the supervisor so the action endpoints (Scrape now, enable/
// disable Telegram) can drive the bot. A per-process CSRF token guards every
// state-changing POST — a random web page can reach 127.0.0.1 but can't read
// the served HTML (same-origin), so it can't learn the token.
func startDashboard(installDir string, sup *supervisor) (*dashboardServer, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("dashboard listen: %w", err)
	}

	tokBytes := make([]byte, 16)
	if _, err := rand.Read(tokBytes); err != nil {
		return nil, fmt.Errorf("dashboard csrf token: %w", err)
	}

	d := &dashboardServer{
		installDir: installDir,
		listener:   ln,
		sup:        sup,
		csrfToken:  hex.EncodeToString(tokBytes),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/", d.handleIndex)
	mux.HandleFunc("/favicon.png", d.handleFavicon) // v2.2: AMM icon in the app window
	mux.HandleFunc("/favicon.ico", d.handleFavicon)
	mux.HandleFunc("/api/status", d.handleStatus)
	mux.HandleFunc("/api/batch", d.handleBatch)       // GET: full ranked batch (all jobs + matched)
	mux.HandleFunc("/api/settings", d.handleSettings) // GET: editable knobs + search terms
	mux.HandleFunc("/api/jobs-txt", d.handleJobsTxt)  // GET: download newest jobs(date).txt
	// v2.1 state-changing endpoints — all gated by guardPost (token + Host).
	mux.HandleFunc("/api/scrape", d.guardPost(d.handleScrape))
	mux.HandleFunc("/api/job/action", d.guardPost(d.handleJobAction))
	mux.HandleFunc("/api/settings/set", d.guardPost(d.handleSettingsSet))
	mux.HandleFunc("/api/jobs/add", d.guardPost(d.handleJobsAdd))
	mux.HandleFunc("/api/jobs/remove", d.guardPost(d.handleJobsRemove))
	mux.HandleFunc("/api/jobs/mode", d.guardPost(d.handleJobsMode))
	mux.HandleFunc("/api/telegram/validate", d.guardPost(d.handleTelegramValidate))
	mux.HandleFunc("/api/telegram/detect", d.guardPost(d.handleTelegramDetect))
	mux.HandleFunc("/api/telegram/save", d.guardPost(d.handleTelegramSave))
	mux.HandleFunc("/api/telegram/disable", d.guardPost(d.handleTelegramDisable))

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
	// v2.4: drop the port breadcrumb on clean exit so a later double-click
	// doesn't probe a dead port. (Crash exits leave it behind — the probe in
	// openAppWindowForRunningInstance handles that case.)
	_ = os.Remove(filepath.Join(d.installDir, "data", "dashboard-port.txt"))
}

func (d *dashboardServer) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	// Inject the per-process CSRF token into the page. The placeholder lives
	// in a <meta> tag; the page's JS reads it and sends it as X-AMM-Token on
	// every POST.
	page := strings.Replace(string(dashboardHTML), "__AMM_TOKEN__", d.csrfToken, 1)
	_, _ = w.Write([]byte(page))
}

func (d *dashboardServer) handleStatus(w http.ResponseWriter, r *http.Request) {
	status := buildStatus(d.installDir)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(status)
}

// handleBatch (GET) returns the full ranked batch — all jobs with their
// matched keywords — for the dashboard's job list + "Why" popovers.
func (d *dashboardServer) handleBatch(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(readFullBatch(d.installDir))
}

// handleSettings (GET) relays the node helper's editable-settings snapshot
// (yoe, salary, filters, schedule, search mode, search terms).
func (d *dashboardServer) handleSettings(w http.ResponseWriter, r *http.Request) {
	d.relayDashboardAPI(w, 15*time.Second, "settings-get")
}

// handleFavicon serves the AMM logo so the app window shows the brand icon.
func (d *dashboardServer) handleFavicon(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "max-age=86400")
	_, _ = w.Write(logoPNG)
}

// handleJobsTxt (GET) streams the newest jobs(<date>).txt from the active
// profile as a download — the search-friendly full batch the user can keep.
func (d *dashboardServer) handleJobsTxt(w http.ResponseWriter, r *http.Request) {
	var active string
	if data, err := os.ReadFile(filepath.Join(d.installDir, "config.json")); err == nil {
		var cfg struct {
			ActiveProfile string `json:"active_profile"`
		}
		_ = json.Unmarshal(data, &cfg)
		active = cfg.ActiveProfile
	}
	if active == "" {
		active = "default"
	}
	dir := filepath.Join(d.installDir, "data", "profiles", active)
	matches, _ := filepath.Glob(filepath.Join(dir, "jobs(*).txt"))
	if len(matches) == 0 {
		http.Error(w, "No batch yet — run a scrape first.", http.StatusNotFound)
		return
	}
	sort.Strings(matches) // names are date-stamped, so lexical sort = chronological
	newest := matches[len(matches)-1]
	data, err := os.ReadFile(newest)
	if err != nil {
		http.Error(w, "Could not read the batch file.", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filepath.Base(newest)+`"`)
	_, _ = w.Write(data)
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
	Enabled             bool `json:"enabled"` // v2.1: token present in .env
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
	Idx       int      `json:"idx"`
	Title     string   `json:"title"`
	Company   string   `json:"company"`
	Yoe       *int     `json:"yoe"`
	MatchPct  int      `json:"matchPct"`
	Score     int      `json:"score"`
	Query     string   `json:"q"`
	Matched   []string `json:"matched"` // v2.1: CV keywords that matched — powers "Why"
	DirectURL string   `json:"directUrl"`
	ViewURL   string   `json:"viewjobUrl"`
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

	// v2.1: Telegram is optional; the page shows enabled/disabled + a setup
	// panel. "Connected" still requires an alive, polling bot.
	out.Telegram.Enabled = telegramEnabled(installDir)

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

	out.LastBatch.Jobs = parseBatchJobs(lb.Jobs, dashboardJobLimit)
}

// parseBatchJobs decodes raw last-batch.json job entries into batchJobs.
// limit <= 0 returns all of them (the /api/batch full list); a positive
// limit caps the count (the /api/status glance).
func parseBatchJobs(raw []json.RawMessage, limit int) []batchJob {
	n := len(raw)
	if limit > 0 && limit < n {
		n = limit
	}
	jobs := make([]batchJob, 0, n)
	for i := 0; i < n; i++ {
		var j struct {
			Idx       int      `json:"idx"`
			Title     string   `json:"title"`
			Company   string   `json:"company"`
			Yoe       *int     `json:"yoe"`
			MatchPct  int      `json:"matchPct"`
			Score     float64  `json:"score"`
			Query     string   `json:"q"`
			Matched   []string `json:"matched"`
			DirectURL string   `json:"directUrl"`
			ViewURL   string   `json:"viewjobUrl"`
		}
		if err := json.Unmarshal(raw[i], &j); err != nil {
			continue
		}
		if j.Matched == nil {
			j.Matched = []string{}
		}
		jobs = append(jobs, batchJob{
			Idx:       j.Idx,
			Title:     j.Title,
			Company:   j.Company,
			Yoe:       j.Yoe,
			MatchPct:  j.MatchPct,
			Score:     int(j.Score),
			Query:     j.Query,
			Matched:   j.Matched,
			DirectURL: j.DirectURL,
			ViewURL:   j.ViewURL,
		})
	}
	return jobs
}

// readFullBatch returns the entire active-profile batch (all jobs, with
// matched keywords) for GET /api/batch. Empty result when no batch exists.
func readFullBatch(installDir string) lastBatchInfo {
	info := lastBatchInfo{Jobs: []batchJob{}}
	var active string
	if data, err := os.ReadFile(filepath.Join(installDir, "config.json")); err == nil {
		var cfg struct {
			ActiveProfile string `json:"active_profile"`
		}
		if json.Unmarshal(data, &cfg) == nil {
			active = cfg.ActiveProfile
		}
	}
	if active == "" {
		return info
	}
	data, err := os.ReadFile(filepath.Join(installDir, "data", "profiles", active, "last-batch.json"))
	if err != nil {
		return info
	}
	var lb struct {
		Date        string            `json:"date"`
		Profile     string            `json:"profile"`
		GeneratedAt string            `json:"generatedAt"`
		Jobs        []json.RawMessage `json:"jobs"`
	}
	if json.Unmarshal(data, &lb) != nil {
		return info
	}
	info.Available = true
	info.Date = lb.Date
	info.Profile = lb.Profile
	info.GeneratedAt = lb.GeneratedAt
	info.JobCount = len(lb.Jobs)
	info.Jobs = parseBatchJobs(lb.Jobs, 0)
	return info
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
