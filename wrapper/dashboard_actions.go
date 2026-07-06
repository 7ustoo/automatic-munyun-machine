package main

// v2.1: state-changing dashboard endpoints. The dashboard graduated from a
// read-only status page to the primary control surface — "Scrape now" and
// the optional Telegram setup flow live here. Every handler in this file is
// wrapped by guardPost (POST-only, localhost Host, valid CSRF token).
//
// Telegram logic stays in Node: these handlers exec scripts/telegram-setup.mjs
// and relay its one-line JSON verbatim, so the wrapper never re-implements the
// Telegram API dance.

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// guardPost wraps a handler so it only runs for same-machine POSTs carrying
// the per-process CSRF token. Defenses, in order:
//   - method must be POST (GET status stays open + side-effect-free)
//   - Host must be loopback (rejects DNS-rebinding to a LAN name)
//   - X-AMM-Token must equal the token we injected into the served HTML; a
//     cross-origin page can't read that HTML, so it can't forge the header.
func (d *dashboardServer) guardPost(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSONError(w, http.StatusMethodNotAllowed, "POST only")
			return
		}
		host := r.Host
		if i := strings.LastIndex(host, ":"); i >= 0 {
			host = host[:i]
		}
		if host != "127.0.0.1" && host != "localhost" && host != "[::1]" {
			writeJSONError(w, http.StatusForbidden, "loopback only")
			return
		}
		if r.Header.Get("X-AMM-Token") != d.csrfToken {
			writeJSONError(w, http.StatusForbidden, "bad or missing token")
			return
		}
		h(w, r)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeJSONError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"ok": false, "error": msg})
}

// readBody decodes a small JSON request body into a string map. Caps the read
// so a buggy/hostile caller can't balloon memory.
func readBody(r *http.Request) map[string]string {
	out := map[string]string{}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<16))
	if err != nil || len(body) == 0 {
		return out
	}
	_ = json.Unmarshal(body, &out)
	return out
}

// handleScrape triggers a one-shot daily batch — same as the tray's
// "Run scrape now", reachable from the dashboard so the GUI is self-contained.
func (d *dashboardServer) handleScrape(w http.ResponseWriter, r *http.Request) {
	// v2.9: "watch": true → run with a visible on-screen browser window.
	b := readBody(r)
	watch := b["watch"] == "true" || b["watch"] == "1"
	actionRunScrape(d.installDir, watch)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "watching": watch})
}

// --- v2.1 control surface: job actions, settings, search terms ---
// All of these exec scripts/dashboard-api.mjs and relay its one-line JSON,
// so the job/config logic stays in Node (profile-aware config-rw, the
// Playwright job-action, applications.md format).

func (d *dashboardServer) execDashboardAPI(timeout time.Duration, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	script := filepath.Join(d.installDir, "scripts", "dashboard-api.mjs")
	cmd := exec.CommandContext(ctx, findNode(), append([]string{script}, args...)...)
	cmd.Dir = d.installDir
	applyChildHideWindow(cmd)
	out, err := cmd.Output()
	return out, err
}

func (d *dashboardServer) relayDashboardAPI(w http.ResponseWriter, timeout time.Duration, args ...string) []byte {
	out, err := d.execDashboardAPI(timeout, args...)
	if err != nil && len(out) == 0 {
		log.Printf("dashboard: dashboard-api %v failed: %v", args[:1], err)
		writeJSONError(w, http.StatusOK, "Could not run the helper. Is Node installed?")
		return nil
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	trimmed := append([]byte(strings.TrimSpace(string(out))), '\n')
	_, _ = w.Write(trimmed)
	return out
}

// handleJobAction: Save / Mark-applied on a batch job by index. The Playwright
// hiring.cafe action can take up to ~90s, so the exec budget is generous.
func (d *dashboardServer) handleJobAction(w http.ResponseWriter, r *http.Request) {
	b := readBody(r)
	action := b["action"]
	if action != "save" && action != "applied" {
		writeJSONError(w, http.StatusOK, "action must be save or applied")
		return
	}
	d.relayDashboardAPI(w, 100*time.Second, "job-action", action, b["idx"])
}

func (d *dashboardServer) handleSettingsSet(w http.ResponseWriter, r *http.Request) {
	b := readBody(r)
	d.relayDashboardAPI(w, 15*time.Second, "settings-set", b["path"], b["value"])
}

func (d *dashboardServer) handleJobsAdd(w http.ResponseWriter, r *http.Request) {
	b := readBody(r)
	d.relayDashboardAPI(w, 15*time.Second, "jobs-add", b["term"])
}

func (d *dashboardServer) handleJobsRemove(w http.ResponseWriter, r *http.Request) {
	b := readBody(r)
	d.relayDashboardAPI(w, 15*time.Second, "jobs-remove", b["term"])
}

func (d *dashboardServer) handleJobsMode(w http.ResponseWriter, r *http.Request) {
	b := readBody(r)
	d.relayDashboardAPI(w, 15*time.Second, "jobs-mode", b["mode"])
}

// v2.8: clear the entire search-term list in one shot.
func (d *dashboardServer) handleJobsClear(w http.ResponseWriter, r *http.Request) {
	d.relayDashboardAPI(w, 15*time.Second, "jobs-clear")
}

// v2.8: re-suggest search terms from the already-parsed CV in the requested
// flavor (titles|keywords). Read-only; powers the "Search style" toggle.
func (d *dashboardServer) handleSuggest(w http.ResponseWriter, r *http.Request) {
	b := readBody(r)
	d.relayDashboardAPI(w, 15*time.Second, "suggest-current", b["mode"])
}

// execTelegramSetup runs scripts/telegram-setup.mjs <args...> and returns its
// single line of stdout (already JSON). timeout bounds the detect poll.
func (d *dashboardServer) execTelegramSetup(timeout time.Duration, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	script := filepath.Join(d.installDir, "scripts", "telegram-setup.mjs")
	cmd := exec.CommandContext(ctx, findNode(), append([]string{script}, args...)...)
	cmd.Dir = d.installDir
	applyChildHideWindow(cmd)
	out, err := cmd.Output()
	return out, err
}

// relayTelegram execs the helper and pipes its JSON straight back to the page.
func (d *dashboardServer) relayTelegram(w http.ResponseWriter, timeout time.Duration, args ...string) []byte {
	out, err := d.execTelegramSetup(timeout, args...)
	if err != nil && len(out) == 0 {
		log.Printf("dashboard: telegram-setup %v failed: %v", args[:1], err)
		writeJSONError(w, http.StatusOK, "Could not run the Telegram helper. Is Node installed?")
		return nil
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	trimmed := append([]byte(strings.TrimSpace(string(out))), '\n')
	_, _ = w.Write(trimmed)
	return out
}

func (d *dashboardServer) handleTelegramValidate(w http.ResponseWriter, r *http.Request) {
	b := readBody(r)
	d.relayTelegram(w, 20*time.Second, "validate", b["token"])
}

func (d *dashboardServer) handleTelegramDetect(w http.ResponseWriter, r *http.Request) {
	b := readBody(r)
	// Detect polls getUpdates for ~25s; give the exec headroom past that.
	d.relayTelegram(w, 35*time.Second, "detect", b["token"])
}

// handleTelegramSave persists token+chat to .env. On success the supervisor's
// idle loop notices Telegram is now enabled and starts the bot poller within
// a few seconds — no wrapper restart needed.
func (d *dashboardServer) handleTelegramSave(w http.ResponseWriter, r *http.Request) {
	b := readBody(r)
	out := d.relayTelegram(w, 20*time.Second, "save", b["token"], b["chatId"])
	if out != nil && jsonOK(out) {
		log.Printf("dashboard: Telegram enabled from dashboard — supervisor will start the bot poller")
	}
}

// handleTelegramDisable clears the token from .env, then kills the running bot
// poller so it stops immediately (the supervisor sees Telegram off and idles
// rather than respawning).
func (d *dashboardServer) handleTelegramDisable(w http.ResponseWriter, r *http.Request) {
	out := d.relayTelegram(w, 15*time.Second, "disable")
	if out != nil && jsonOK(out) {
		if d.sup != nil {
			d.sup.KillChild()
		}
		log.Printf("dashboard: Telegram disabled from dashboard — bot poller stopped")
	}
}

// --- v2.5: resume rescan ---

// handleResumeUpload accepts a multipart resume file, saves it under
// data/uploads/, and re-parses it into the active profile's CV via
// dashboard-api resume-parse — which also returns fresh search-term
// suggestions. Guarded (POST + token). 8 MB cap covers any real resume.
func (d *dashboardServer) handleResumeUpload(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		writeJSONError(w, http.StatusOK, "upload too large or malformed")
		return
	}
	file, header, err := r.FormFile("resume")
	if err != nil {
		writeJSONError(w, http.StatusOK, "no resume file in the upload")
		return
	}
	defer file.Close()

	ext := strings.ToLower(filepath.Ext(header.Filename))
	switch ext {
	case ".pdf", ".docx", ".md", ".txt", ".markdown":
	default:
		writeJSONError(w, http.StatusOK, "unsupported file type "+ext+" — use PDF, DOCX, MD, or TXT")
		return
	}

	uploadDir := filepath.Join(d.installDir, "data", "uploads")
	_ = os.MkdirAll(uploadDir, 0o755)
	dest := filepath.Join(uploadDir, "resume-upload"+ext)
	dst, err := os.Create(dest)
	if err != nil {
		writeJSONError(w, http.StatusOK, "could not save the upload")
		return
	}
	// Cap the copy too (defense in depth against a lying Content-Length).
	if _, err := io.Copy(dst, io.LimitReader(file, 8<<20)); err != nil {
		dst.Close()
		writeJSONError(w, http.StatusOK, "could not save the upload")
		return
	}
	dst.Close()

	// Parsing a PDF/DOCX + suggesting terms is quick but give it headroom.
	d.relayDashboardAPI(w, 45*time.Second, "resume-parse", dest)
}

// handleResumeApply replaces the search-term list with the terms the user
// picked from the rescan suggestions. Body: { terms: "[\"iam\",\"m365\"]" }.
func (d *dashboardServer) handleResumeApply(w http.ResponseWriter, r *http.Request) {
	b := readBody(r)
	d.relayDashboardAPI(w, 15*time.Second, "resume-apply", b["terms"])
}

// --- v2.5: self-update ---

func (d *dashboardServer) execSelfUpdate(timeout time.Duration, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	script := filepath.Join(d.installDir, "scripts", "self-update.mjs")
	cmd := exec.CommandContext(ctx, findNode(), append([]string{script}, args...)...)
	cmd.Dir = d.installDir
	applyChildHideWindow(cmd)
	out, err := cmd.Output()
	return out, err
}

func (d *dashboardServer) relaySelfUpdate(w http.ResponseWriter, timeout time.Duration, args ...string) {
	out, err := d.execSelfUpdate(timeout, args...)
	if err != nil && len(out) == 0 {
		log.Printf("dashboard: self-update %v failed: %v", args, err)
		writeJSONError(w, http.StatusOK, "Could not run the updater. Is Node installed?")
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(append([]byte(strings.TrimSpace(string(out))), '\n'))
}

// handleUpdateCheck (GET) reports current vs latest release + whether a
// one-click auto-install is possible on this platform. Read-only, so it's
// not guarded; the network call is bounded + cached by update-checker.
func (d *dashboardServer) handleUpdateCheck(w http.ResponseWriter, r *http.Request) {
	d.relaySelfUpdate(w, 15*time.Second, "info")
}

// handleUpdateApply (guarded POST) downloads the latest installer and spawns
// the detached silent-install-then-relaunch. Returns immediately with
// {ok,started}; the running AMM is killed + replaced by the installer moments
// later, and the updater relaunches it.
//
// v3.0.2: on a started update, also close the app window this wrapper spawned
// (delayed so the page paints its "installing" message first). The window is
// a separate Chrome process the installer's taskkill never reaches — without
// this it lingered as a dead window next to the relaunched one. The page has
// its own window.close() fallback for windows this process didn't spawn.
func (d *dashboardServer) handleUpdateApply(w http.ResponseWriter, r *http.Request) {
	log.Printf("dashboard: user triggered auto-update")
	out, err := d.execSelfUpdate(210*time.Second, "apply")
	if err != nil && len(out) == 0 {
		log.Printf("dashboard: self-update [apply] failed: %v", err)
		writeJSONError(w, http.StatusOK, "Could not run the updater. Is Node installed?")
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(append([]byte(strings.TrimSpace(string(out))), '\n'))

	var res struct {
		Ok      bool `json:"ok"`
		Started bool `json:"started"`
	}
	if json.Unmarshal(out, &res) == nil && res.Ok && res.Started {
		go func() {
			time.Sleep(4 * time.Second)
			closeAppWindows()
		}()
	}
}

// --- v2.6: profile CRUD ---
// The Node helper owns all profile-store logic (slug validation, atomic config
// writes, data-dir moves). These handlers just relay bodies + responses so the
// wrapper never re-implements profile state — same rule as Telegram setup.

// handleProfileList (GET) returns { active, profiles:[{slug,active,userName,hasCV}] }
// for the dashboard's profiles panel. Read-only, so no CSRF/POST guard.
func (d *dashboardServer) handleProfileList(w http.ResponseWriter, r *http.Request) {
	d.relayDashboardAPI(w, 10*time.Second, "profile-list")
}

func (d *dashboardServer) handleProfileAdd(w http.ResponseWriter, r *http.Request) {
	b := readBody(r)
	d.relayDashboardAPI(w, 15*time.Second, "profile-add", b["slug"])
}

func (d *dashboardServer) handleProfileRename(w http.ResponseWriter, r *http.Request) {
	b := readBody(r)
	d.relayDashboardAPI(w, 15*time.Second, "profile-rename", b["oldSlug"], b["newSlug"])
}

func (d *dashboardServer) handleProfileDelete(w http.ResponseWriter, r *http.Request) {
	b := readBody(r)
	d.relayDashboardAPI(w, 15*time.Second, "profile-delete", b["slug"])
}

// handleProfileSwitch changes the active profile. Every subsequent read
// (settings, batch, resume, terms) now routes through the new one, so the
// page needs to reload to pick up the switched context — the client JS
// does that on a successful response.
func (d *dashboardServer) handleProfileSwitch(w http.ResponseWriter, r *http.Request) {
	b := readBody(r)
	d.relayDashboardAPI(w, 15*time.Second, "profile-switch", b["slug"])
}

// --- v2.7: first-run setup ---
// Same "wrapper never re-implements Node" rule as v2.1's Telegram flow and
// v2.6's profile CRUD: every handler here relays scripts/dashboard-api.mjs
// output verbatim. The dashboard's setup panel drives the whole flow.

// handleSetupGeocode (GET ?q=): open-meteo lookup. Read-only.
func (d *dashboardServer) handleSetupGeocode(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	d.relayDashboardAPI(w, 10*time.Second, "setup-geocode", q)
}

// handleSetupHcafeLoginStart (POST): spawns login-once.mjs (visible Chromium
// window). Returns immediately with the child PID. Guarded because it starts
// a subprocess with a visible window — a cross-origin page shouldn't be able
// to open Chromium on the user's screen.
func (d *dashboardServer) handleSetupHcafeLoginStart(w http.ResponseWriter, r *http.Request) {
	d.relayDashboardAPI(w, 10*time.Second, "setup-hcafe-login-start")
}

// handleSetupHcafeLoginStatus (GET): reports {running, authed}. When the
// child has exited, the helper runs a job-action.mjs auth verification — up
// to ~90s of Playwright startup + navigation, so the exec budget accounts
// for the worst case.
func (d *dashboardServer) handleSetupHcafeLoginStatus(w http.ResponseWriter, r *http.Request) {
	d.relayDashboardAPI(w, 100*time.Second, "setup-hcafe-login-status")
}

// handleSetupInit (POST): body is the initial-config JSON blob. Read the raw
// body and pass it as a single argv element rather than JSON-encoding a nested
// object into readBody's map[string]string.
func (d *dashboardServer) handleSetupInit(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<16))
	if err != nil {
		writeJSONError(w, http.StatusOK, "could not read setup payload")
		return
	}
	d.relayDashboardAPI(w, 10*time.Second, "setup-init", string(body))
}

// handleSetupFinalize (POST): registers scheduler tasks. Long budget because
// schtasks / launchctl / systemctl operations can take several seconds when
// the system is busy.
func (d *dashboardServer) handleSetupFinalize(w http.ResponseWriter, r *http.Request) {
	d.relayDashboardAPI(w, 45*time.Second, "setup-finalize")
}

// jsonOK reports whether a helper line parsed to {"ok":true,...}.
func jsonOK(line []byte) bool {
	var v struct {
		OK bool `json:"ok"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(line))), &v); err != nil {
		return false
	}
	return v.OK
}
