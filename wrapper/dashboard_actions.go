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
	actionRunScrape(d.installDir)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
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
