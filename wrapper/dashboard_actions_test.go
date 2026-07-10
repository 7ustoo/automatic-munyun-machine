package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// guardPost is the security boundary for every state-changing dashboard
// endpoint (v2.1). These tests pin its behavior: POST-only, loopback-only,
// and the per-process CSRF token must match.

func newGuarded(t *testing.T) (*dashboardServer, http.HandlerFunc) {
	t.Helper()
	d := &dashboardServer{csrfToken: "secret-token-abc"}
	reached := false
	h := d.guardPost(func(w http.ResponseWriter, r *http.Request) {
		reached = true
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	// Return a wrapper that lets the caller inspect whether the inner handler ran.
	return d, func(w http.ResponseWriter, r *http.Request) {
		reached = false
		h(w, r)
		if reached {
			w.Header().Set("X-Reached", "1")
		}
	}
}

func TestGuardPost_RejectsGet(t *testing.T) {
	_, h := newGuarded(t)
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/api/scrape", nil)
	req.Host = "127.0.0.1:5000"
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET → %d; want 405", rec.Code)
	}
}

func TestGuardPost_RejectsMissingToken(t *testing.T) {
	_, h := newGuarded(t)
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/api/scrape", nil)
	req.Host = "127.0.0.1:5000"
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("POST without token → %d; want 403", rec.Code)
	}
}

func TestGuardPost_RejectsWrongToken(t *testing.T) {
	_, h := newGuarded(t)
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/api/scrape", nil)
	req.Host = "127.0.0.1:5000"
	req.Header.Set("X-AMM-Token", "WRONG")
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("POST wrong token → %d; want 403", rec.Code)
	}
}

func TestGuardPost_RejectsNonLoopbackHost(t *testing.T) {
	// A DNS-rebinding attempt: correct token won't help if Host isn't loopback.
	_, h := newGuarded(t)
	req := httptest.NewRequest(http.MethodPost, "http://evil.example/api/scrape", nil)
	req.Host = "evil.example"
	req.Header.Set("X-AMM-Token", "secret-token-abc")
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("POST non-loopback host → %d; want 403", rec.Code)
	}
}

func TestGuardPost_AcceptsGoodPost(t *testing.T) {
	_, h := newGuarded(t)
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/api/scrape", nil)
	req.Host = "127.0.0.1:5000"
	req.Header.Set("X-AMM-Token", "secret-token-abc")
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("good POST → %d; want 200", rec.Code)
	}
	if rec.Header().Get("X-Reached") != "1" {
		t.Errorf("inner handler did not run on a valid POST")
	}
}

func TestGuardPost_AcceptsLocalhostName(t *testing.T) {
	_, h := newGuarded(t)
	req := httptest.NewRequest(http.MethodPost, "http://localhost/api/scrape", nil)
	req.Host = "localhost:5000"
	req.Header.Set("X-AMM-Token", "secret-token-abc")
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("localhost host → %d; want 200", rec.Code)
	}
}

func TestEmailOAuthCallbackRejectsNonLoopbackHost(t *testing.T) {
	d := &dashboardServer{}
	req := httptest.NewRequest(http.MethodGet, "http://evil.example/oauth/google/callback?error=access_denied", nil)
	req.Host = "evil.example"
	rec := httptest.NewRecorder()
	d.handleEmailOAuthCallback(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("non-loopback OAuth callback → %d; want 403", rec.Code)
	}
}

func TestEmailOAuthCallbackRendersCancellationWithoutHelper(t *testing.T) {
	d := &dashboardServer{}
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/oauth/google/callback?error=access_denied", nil)
	req.Host = "127.0.0.1:5000"
	rec := httptest.NewRecorder()
	d.handleEmailOAuthCallback(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "access_denied") {
		t.Errorf("cancelled OAuth callback = %d %q; want explanatory 200", rec.Code, rec.Body.String())
	}
}

// handleIndex must substitute the CSRF placeholder so the page can read it.
func TestHandleIndex_InjectsToken(t *testing.T) {
	d := &dashboardServer{csrfToken: "INJECTED-TOKEN-123"}
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/", nil)
	rec := httptest.NewRecorder()
	d.handleIndex(rec, req)
	body := rec.Body.String()
	if strings.Contains(body, "__AMM_TOKEN__") {
		t.Errorf("placeholder __AMM_TOKEN__ was not replaced")
	}
	if !strings.Contains(body, "INJECTED-TOKEN-123") {
		t.Errorf("CSRF token not present in served HTML")
	}
}

// /api/status must report telegram.enabled from .env token+chat (v2.4 parity).
func TestBuildStatus_TelegramEnabledFlag(t *testing.T) {
	dir := t.TempDir()
	if buildStatus(dir).Telegram.Enabled {
		t.Errorf("empty dir → telegram.enabled true; want false")
	}
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("TELEGRAM_BOT_TOKEN=123:abc\nTELEGRAM_CHAT_ID=42\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !buildStatus(dir).Telegram.Enabled {
		t.Errorf("token present → telegram.enabled false; want true")
	}
}
