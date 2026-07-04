package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Fixed reference time for deterministic age calculations.
// 2026-05-18T20:30:00Z — picked to be after the data shapes captured in the
// live install (heartbeat ts 20:18:47Z), so a heartbeat from "now" lives in
// the alive band by design.
var testNow = time.Date(2026, 5, 18, 20, 30, 0, 0, time.UTC)

func writeFile(t *testing.T, dir, name, content string) {
	t.Helper()
	full := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestBuildStatus_EmptyInstall(t *testing.T) {
	// No heartbeat, no config, no last-batch — every section returns its
	// zero/unknown value, nothing panics.
	dir := t.TempDir()
	s := buildStatusAt(dir, testNow)
	if s.Bot.State != "unknown" {
		t.Errorf("Bot.State = %q; want unknown", s.Bot.State)
	}
	if s.Telegram.Connected {
		t.Error("Telegram.Connected = true; want false")
	}
	if s.Profile.Active != "" {
		t.Errorf("Profile.Active = %q; want empty", s.Profile.Active)
	}
	if s.LastBatch.Available {
		t.Error("LastBatch.Available = true; want false")
	}
	if s.LastBatch.Jobs == nil {
		t.Error("LastBatch.Jobs is nil; want empty slice (JSON marshals nil as null, [] as [])")
	}
	// v2.7: empty install means missing config.json, which means needsSetup=true.
	if !s.NeedsSetup {
		t.Error("NeedsSetup = false; want true when config.json is missing")
	}
}

func TestBuildStatus_NeedsSetupFalseWithConfig(t *testing.T) {
	// v2.7: once config.json exists, needsSetup flips to false. Tray-poll uses
	// the same signal to exit the "needs setup" mode.
	dir := t.TempDir()
	writeFile(t, dir, "config.json", `{"active_profile":"default","profiles":{"default":{"user":{"name":"J"}}}}`)
	s := buildStatusAt(dir, testNow)
	if s.NeedsSetup {
		t.Error("NeedsSetup = true; want false when config.json exists")
	}
}

func TestBuildStatus_AliveHeartbeat(t *testing.T) {
	dir := t.TempDir()
	// 2 minutes old — inside heartbeatFreshThreshold (5 min).
	hbTs := testNow.Add(-2 * time.Minute).Format(time.RFC3339Nano)
	startedTs := testNow.Add(-6 * 24 * time.Hour).Format(time.RFC3339Nano)
	hb := map[string]any{
		"ts":                  hbTs,
		"pid":                 49396,
		"version":             "1.3.0",
		"startedAt":           startedTs,
		"lastPollOk":          true,
		"consecutiveFailures": 0,
	}
	b, _ := json.Marshal(hb)
	writeFile(t, dir, "data/heartbeat.json", string(b))

	s := buildStatusAt(dir, testNow)
	if s.Bot.State != "alive" {
		t.Errorf("Bot.State = %q; want alive", s.Bot.State)
	}
	if s.Bot.Pid != 49396 {
		t.Errorf("Bot.Pid = %d; want 49396", s.Bot.Pid)
	}
	if s.Bot.LastHeartbeatAgeSec < 110 || s.Bot.LastHeartbeatAgeSec > 130 {
		t.Errorf("Bot.LastHeartbeatAgeSec = %d; want ~120", s.Bot.LastHeartbeatAgeSec)
	}
	if !s.Telegram.Connected {
		t.Error("Telegram.Connected = false; want true (alive + lastPollOk)")
	}
	if s.Bot.UptimeSec < 6*86400-60 || s.Bot.UptimeSec > 6*86400+60 {
		t.Errorf("Bot.UptimeSec = %d; want ~%d", s.Bot.UptimeSec, 6*86400)
	}
}

func TestBuildStatus_StaleHeartbeat(t *testing.T) {
	dir := t.TempDir()
	// 7 minutes old — between fresh (5m) and stale-cutoff (10m) thresholds.
	hbTs := testNow.Add(-7 * time.Minute).Format(time.RFC3339Nano)
	hb := map[string]any{
		"ts": hbTs, "pid": 1234, "version": "1.3.0",
		"startedAt": testNow.Add(-1 * time.Hour).Format(time.RFC3339Nano),
		"lastPollOk": true, "consecutiveFailures": 0,
	}
	b, _ := json.Marshal(hb)
	writeFile(t, dir, "data/heartbeat.json", string(b))

	s := buildStatusAt(dir, testNow)
	if s.Bot.State != "stale" {
		t.Errorf("Bot.State = %q; want stale", s.Bot.State)
	}
	// Connected = lastPollOk AND alive — stale should NOT report connected.
	if s.Telegram.Connected {
		t.Error("Telegram.Connected = true on stale heartbeat; want false")
	}
}

func TestBuildStatus_DeadHeartbeat(t *testing.T) {
	dir := t.TempDir()
	// 30 minutes old — past the 10m stale cutoff.
	hbTs := testNow.Add(-30 * time.Minute).Format(time.RFC3339Nano)
	hb := map[string]any{
		"ts": hbTs, "pid": 1234, "version": "1.3.0",
		"startedAt": testNow.Add(-1 * time.Hour).Format(time.RFC3339Nano),
		"lastPollOk": false, "consecutiveFailures": 5,
	}
	b, _ := json.Marshal(hb)
	writeFile(t, dir, "data/heartbeat.json", string(b))

	s := buildStatusAt(dir, testNow)
	if s.Bot.State != "dead" {
		t.Errorf("Bot.State = %q; want dead", s.Bot.State)
	}
	if s.Telegram.ConsecutiveFailures != 5 {
		t.Errorf("Telegram.ConsecutiveFailures = %d; want 5", s.Telegram.ConsecutiveFailures)
	}
}

func TestBuildStatus_MalformedHeartbeat(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "data/heartbeat.json", "{not valid json")
	s := buildStatusAt(dir, testNow)
	if s.Bot.State != "unknown" {
		t.Errorf("Bot.State = %q on malformed JSON; want unknown", s.Bot.State)
	}
}

func TestBuildStatus_ProfileEnumeration(t *testing.T) {
	dir := t.TempDir()
	cfg := `{
		"active_profile": "manager",
		"profiles": {
			"default": {},
			"manager": {},
			"contractor": {}
		}
	}`
	writeFile(t, dir, "config.json", cfg)
	s := buildStatusAt(dir, testNow)
	if s.Profile.Active != "manager" {
		t.Errorf("Profile.Active = %q; want manager", s.Profile.Active)
	}
	if len(s.Profile.All) != 3 {
		t.Errorf("Profile.All len = %d; want 3", len(s.Profile.All))
	}
	// Sort enforced — must be deterministic.
	expected := []string{"contractor", "default", "manager"}
	for i, want := range expected {
		if s.Profile.All[i] != want {
			t.Errorf("Profile.All[%d] = %q; want %q (full = %v)", i, s.Profile.All[i], want, s.Profile.All)
		}
	}
}

func TestBuildStatus_LastBatchHappyPath(t *testing.T) {
	dir := t.TempDir()
	cfg := `{"active_profile":"default","profiles":{"default":{}}}`
	writeFile(t, dir, "config.json", cfg)

	// 12 jobs — more than dashboardJobLimit (10) so we exercise the cap.
	jobs := make([]map[string]any, 12)
	for i := range jobs {
		jobs[i] = map[string]any{
			"idx":        i + 1,
			"id":         "job-id-X",
			"title":      "Some Engineer",
			"company":    "Acme",
			"yoe":        nil,
			"q":          "IAM",
			"score":      42.5,
			"matchPct":   80 - i*5,
			"matched":    []string{"iam"},
			"directUrl":  "https://example.com/" + string(rune('a'+i)),
			"viewjobUrl": "https://hiring.cafe/" + string(rune('a'+i)),
		}
	}
	lb := map[string]any{
		"date":        "2026-05-18",
		"profile":     "default",
		"generatedAt": testNow.Format(time.RFC3339),
		"funnel":      nil,
		"jobs":        jobs,
	}
	b, _ := json.Marshal(lb)
	writeFile(t, dir, "data/profiles/default/last-batch.json", string(b))

	s := buildStatusAt(dir, testNow)
	if !s.LastBatch.Available {
		t.Fatal("LastBatch.Available = false; want true")
	}
	if s.LastBatch.JobCount != 12 {
		t.Errorf("LastBatch.JobCount = %d; want 12", s.LastBatch.JobCount)
	}
	if len(s.LastBatch.Jobs) != dashboardJobLimit {
		t.Errorf("len(LastBatch.Jobs) = %d; want %d (cap)", len(s.LastBatch.Jobs), dashboardJobLimit)
	}
	if s.LastBatch.Jobs[0].MatchPct != 80 {
		t.Errorf("Jobs[0].MatchPct = %d; want 80", s.LastBatch.Jobs[0].MatchPct)
	}
	if s.LastBatch.Date != "2026-05-18" {
		t.Errorf("LastBatch.Date = %q; want 2026-05-18", s.LastBatch.Date)
	}
}

func TestBuildStatus_LastBatchSkippedWhenNoActiveProfile(t *testing.T) {
	// last-batch.json exists at default/ but config.json is missing so
	// active profile is empty — we shouldn't read the batch at all.
	dir := t.TempDir()
	writeFile(t, dir, "data/profiles/default/last-batch.json",
		`{"date":"2026-05-18","profile":"default","jobs":[]}`)
	s := buildStatusAt(dir, testNow)
	if s.LastBatch.Available {
		t.Error("LastBatch.Available = true with no active profile; want false")
	}
}

func TestBuildStatus_LastBatchMalformed(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "config.json",
		`{"active_profile":"default","profiles":{"default":{}}}`)
	writeFile(t, dir, "data/profiles/default/last-batch.json", "not-json")
	s := buildStatusAt(dir, testNow)
	if s.LastBatch.Available {
		t.Error("LastBatch.Available = true on malformed JSON; want false")
	}
}

func TestBuildStatus_NowFieldIsRFC3339UTC(t *testing.T) {
	dir := t.TempDir()
	s := buildStatusAt(dir, testNow)
	if _, err := time.Parse(time.RFC3339, s.Now); err != nil {
		t.Errorf("Now = %q is not valid RFC3339: %v", s.Now, err)
	}
}
