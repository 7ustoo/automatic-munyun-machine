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
	"encoding/base64"
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
	mux.HandleFunc("/api/export", d.handleExport)   // GET ?format=txt|csv: number·title·apply-link export (v2.4)
	mux.HandleFunc("/api/jobs-txt", d.handleExport) // legacy alias (pre-v2.4 bookmark) → txt export
	// v2.1 state-changing endpoints — all gated by guardPost (token + Host).
	mux.HandleFunc("/api/scrape", d.guardPost(d.handleScrape))
	mux.HandleFunc("/api/job/action", d.guardPost(d.handleJobAction))
	mux.HandleFunc("/api/settings/set", d.guardPost(d.handleSettingsSet))
	mux.HandleFunc("/api/score/mute", d.guardPost(d.handleScoreMute))       // v4.0
	mux.HandleFunc("/api/config/backups", d.handleConfigBackups)            // v4.0 (read-only)
	mux.HandleFunc("/api/config/restore", d.guardPost(d.handleConfigRestore)) // v4.0
	mux.HandleFunc("/api/jobs/add", d.guardPost(d.handleJobsAdd))
	mux.HandleFunc("/api/jobs/remove", d.guardPost(d.handleJobsRemove))
	mux.HandleFunc("/api/jobs/clear", d.guardPost(d.handleJobsClear)) // v2.8: clear all terms
	mux.HandleFunc("/api/jobs/mode", d.guardPost(d.handleJobsMode))
	mux.HandleFunc("/api/suggest", d.guardPost(d.handleSuggest)) // v2.8: re-suggest from current CV
	mux.HandleFunc("/api/telegram/validate", d.guardPost(d.handleTelegramValidate))
	mux.HandleFunc("/api/telegram/detect", d.guardPost(d.handleTelegramDetect))
	mux.HandleFunc("/api/telegram/save", d.guardPost(d.handleTelegramSave))
	mux.HandleFunc("/api/telegram/disable", d.guardPost(d.handleTelegramDisable))
	// v2.5: resume rescan + self-update.
	mux.HandleFunc("/api/update/check", d.handleUpdateCheck) // GET: current vs latest
	mux.HandleFunc("/api/resume/upload", d.guardPost(d.handleResumeUpload))
	mux.HandleFunc("/api/resume/apply", d.guardPost(d.handleResumeApply))
	mux.HandleFunc("/api/update/apply", d.guardPost(d.handleUpdateApply))
	// v2.6: profile CRUD from the dashboard. list is read-only (GET);
	// add/rename/delete/switch mutate config.json + data dirs (POST + CSRF).
	mux.HandleFunc("/api/profile/list", d.handleProfileList)
	mux.HandleFunc("/api/profile/add", d.guardPost(d.handleProfileAdd))
	mux.HandleFunc("/api/profile/rename", d.guardPost(d.handleProfileRename))
	mux.HandleFunc("/api/profile/delete", d.guardPost(d.handleProfileDelete))
	mux.HandleFunc("/api/profile/switch", d.guardPost(d.handleProfileSwitch))
	// v2.7: dashboard-native first-run setup. Geocode + hcafe-login/status are
	// read-only; hcafe-login/start + init + finalize mutate disk (POST + CSRF).
	mux.HandleFunc("/api/setup/geocode", d.handleSetupGeocode)
	mux.HandleFunc("/api/setup/hcafe-login/status", d.handleSetupHcafeLoginStatus)
	mux.HandleFunc("/api/setup/hcafe-login/start", d.guardPost(d.handleSetupHcafeLoginStart))
	// v4.1: persistent hiring.cafe sign-in status on the main dashboard.
	// GET reads the cached status (instant, no browser); POST runs the live
	// Playwright probe and refreshes the cache.
	mux.HandleFunc("/api/hcafe/auth", d.handleHcafeAuth)
	mux.HandleFunc("/api/hcafe/auth/refresh", d.guardPost(d.handleHcafeAuthRefresh))
	mux.HandleFunc("/api/setup/init", d.guardPost(d.handleSetupInit))
	mux.HandleFunc("/api/setup/finalize", d.guardPost(d.handleSetupFinalize))

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

// handleExport (GET /api/export?format=txt|csv) serves the minimal batch
// export — number · job title · apply link — built on demand by
// scripts/export-batch.mjs from the active profile's last-batch.json.
// v2.4: replaces the old jobs(<date>).txt passthrough; the CSV variant
// opens straight in Excel. Logic stays in Node (execDashboardAPI) per the
// never-reimplement-in-Go rule.
func (d *dashboardServer) handleExport(w http.ResponseWriter, r *http.Request) {
	format := r.URL.Query().Get("format")
	if format != "csv" && format != "xlsx" {
		format = "txt"
	}
	out, err := d.execDashboardAPI(20*time.Second, "export", format)
	if err != nil {
		http.Error(w, "Export failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	var res struct {
		OK            bool   `json:"ok"`
		Error         string `json:"error"`
		Filename      string `json:"filename"`
		Content       string `json:"content"`
		ContentBase64 string `json:"contentBase64"` // xlsx (binary) rides base64
	}
	if jsonErr := json.Unmarshal(out, &res); jsonErr != nil || !res.OK {
		msg := res.Error
		if msg == "" {
			msg = "No batch yet — run a scrape first."
		}
		http.Error(w, msg, http.StatusNotFound)
		return
	}
	var body []byte
	mime := "text/plain; charset=utf-8"
	switch format {
	case "xlsx":
		mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
		decoded, decErr := base64.StdEncoding.DecodeString(res.ContentBase64)
		if decErr != nil {
			http.Error(w, "Export failed: bad xlsx payload", http.StatusInternalServerError)
			return
		}
		body = decoded
	case "csv":
		mime = "text/csv; charset=utf-8"
		body = []byte(res.Content)
	default:
		body = []byte(res.Content)
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Content-Disposition", `attachment; filename="`+res.Filename+`"`)
	_, _ = w.Write(body)
}

// --- Status aggregation (pure, testable) ---

type statusResponse struct {
	Wrapper    wrapperInfo   `json:"wrapper"`
	Bot        botInfo       `json:"bot"`
	Telegram   telegramInfo  `json:"telegram"`
	Profile    profileInfo   `json:"profile"`
	LastBatch  lastBatchInfo `json:"lastBatch"`
	NeedsSetup bool          `json:"needsSetup"` // v2.7: gates the dashboard's setup panel
	// v4.0: outcome of the most recent scrape (data/scrape-status.json,
	// written by daily-batch on every exit path) + whether one is running
	// right now (data/scrape.lock freshness). Powers the red failure banner
	// and the progress bar for runs started outside this page.
	LastScrape    *scrapeStatusInfo `json:"lastScrape"`
	ScrapeRunning bool              `json:"scrapeRunning"`
	Now           string            `json:"now"`
}

type scrapeStatusInfo struct {
	OK      bool   `json:"ok"`
	At      string `json:"at"`
	Error   string `json:"error,omitempty"`
	Kind    string `json:"kind,omitempty"`
	Profile string `json:"profile,omitempty"`
	JobCount int   `json:"jobCount,omitempty"`
}

// readScrapeStatusInto loads data/scrape-status.json (missing/malformed →
// LastScrape stays nil) and probes data/scrape.lock: proper-lockfile
// refreshes the lock dir's mtime while a scrape holds it, so a lock touched
// within the last 90s means a scrape is running right now.
func readScrapeStatusInto(installDir string, now time.Time, out *statusResponse) {
	if data, err := os.ReadFile(filepath.Join(installDir, "data", "scrape-status.json")); err == nil {
		var st scrapeStatusInfo
		if json.Unmarshal(data, &st) == nil && st.At != "" {
			out.LastScrape = &st
		}
	}
	if fi, err := os.Stat(filepath.Join(installDir, "data", "scrape.lock.lock")); err == nil {
		if now.Sub(fi.ModTime()) < 90*time.Second {
			out.ScrapeRunning = true
		}
	}
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
	Available   bool            `json:"available"`
	Date        string          `json:"date"`
	Profile     string          `json:"profile"`
	GeneratedAt string          `json:"generatedAt"`
	JobCount    int             `json:"jobCount"`
	Jobs        []batchJob      `json:"jobs"`
	Funnel      json.RawMessage `json:"funnel,omitempty"` // v4.1: raw funnel object for the dashboard breakdown
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
	readScrapeStatusInto(installDir, now, &out)

	// v2.1: Telegram is optional; the page shows enabled/disabled + a setup
	// panel. "Connected" still requires an alive, polling bot.
	out.Telegram.Enabled = telegramEnabled(installDir)

	// v2.7: mirrors wrapper/main.go#isSetUp. The client reads this to decide
	// whether to render the first-run setup panel over the normal dashboard.
	out.NeedsSetup = !isSetUp(installDir)

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
		Funnel      json.RawMessage   `json:"funnel"`
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
	info.Funnel = lb.Funnel
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
