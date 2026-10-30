package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// v2.1: the dashboard's job list comes from readFullBatch (all jobs + their
// matched keywords). Pin the parse + the "Why" data path.

func writeBatch(t *testing.T, dir string, jobsJSON string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "config.json"),
		[]byte(`{"active_profile":"default","profiles":{"default":{}}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	pd := filepath.Join(dir, "data", "profiles", "default")
	if err := os.MkdirAll(pd, 0o755); err != nil {
		t.Fatal(err)
	}
	body := `{"date":"2026-06-14","profile":"default","jobs":` + jobsJSON + `}`
	if err := os.WriteFile(filepath.Join(pd, "last-batch.json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestReadFullBatch_AllJobsAndMatched(t *testing.T) {
	dir := t.TempDir()
	writeBatch(t, dir, `[
		{"idx":1,"title":"Senior IAM Engineer","company":"Okta","matchPct":86,"cardPct":72,"jdPct":86,"coveragePct":81,"rolePct":92,"requirementCount":14,"matchConfidence":100,"score":31,"matched":["IAM Engineer","Okta","SAML"],"missing":["CISSP"],"directUrl":"https://x/1","viewjobUrl":"https://hiring.cafe/viewjob/a"},
		{"idx":2,"title":"Cloud Security Engineer","company":"Datadog","matchPct":88,"matched":["Cloud Security"],"viewjobUrl":"https://hiring.cafe/viewjob/b"}
	]`)
	b := readFullBatch(dir)
	if !b.Available || b.JobCount != 2 || len(b.Jobs) != 2 {
		t.Fatalf("want 2 available jobs, got available=%v count=%d len=%d", b.Available, b.JobCount, len(b.Jobs))
	}
	if b.Jobs[0].Title != "Senior IAM Engineer" || b.Jobs[0].MatchPct != 86 {
		t.Errorf("job 0 wrong: %+v", b.Jobs[0])
	}
	if len(b.Jobs[0].Matched) != 3 || b.Jobs[0].Matched[0] != "IAM Engineer" {
		t.Errorf("matched keywords not parsed: %+v", b.Jobs[0].Matched)
	}
	if b.Jobs[0].CoveragePct == nil || *b.Jobs[0].CoveragePct != 81 || b.Jobs[0].RolePct == nil || *b.Jobs[0].RolePct != 92 {
		t.Errorf("requirement explanation not parsed: %+v", b.Jobs[0])
	}
	if len(b.Jobs[0].Missing) != 1 || b.Jobs[0].Missing[0] != "CISSP" {
		t.Errorf("missing requirements not parsed: %+v", b.Jobs[0].Missing)
	}
}

func TestKeywordBatch_ExposesModeAndAllListings(t *testing.T) {
	dir := t.TempDir()
	writeBatch(t, dir, `[]`)
	jobs := make([]string, 1000)
	for i := range jobs {
		jobs[i] = fmt.Sprintf(`{"idx":%d,"title":"Cloud job","viewjobUrl":"https://hiring.cafe/job/%d"}`, i+1, i+1)
	}
	body := `{"date":"2026-10-30","mode":"keyword","keyword":"cloud","funnel":{"targetJobsPerBatch":1000,"searchIncomplete":false},"jobs":[` + strings.Join(jobs, ",") + `]}`
	p := filepath.Join(dir, "data", "profiles", "default", "last-batch.json")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	full := readFullBatch(dir)
	if full.Mode != "keyword" || full.Keyword != "cloud" || len(full.Jobs) != 1000 {
		t.Fatalf("keyword batch missing data: mode=%q keyword=%q jobs=%d", full.Mode, full.Keyword, len(full.Jobs))
	}
	out := statusResponse{}
	readLastBatchInto(dir, "default", &out)
	if out.LastBatch.Mode != "keyword" || out.LastBatch.JobCount != 1000 {
		t.Fatalf("status missing keyword batch: %+v", out.LastBatch)
	}
	if !strings.Contains(string(out.LastBatch.Funnel), `"targetJobsPerBatch":1000`) {
		t.Fatalf("status must include collection outcome for completion notifications: %s", out.LastBatch.Funnel)
	}
}

func TestReadFullBatch_NoBatch(t *testing.T) {
	dir := t.TempDir()
	b := readFullBatch(dir)
	if b.Available || len(b.Jobs) != 0 {
		t.Errorf("empty dir should yield no batch, got %+v", b)
	}
}

func TestParseBatchJobs_LimitAndNilMatched(t *testing.T) {
	raw := []json.RawMessage{
		json.RawMessage(`{"idx":1,"title":"A","matchPct":90}`),
		json.RawMessage(`{"idx":2,"title":"B","matchPct":80}`),
		json.RawMessage(`{"idx":3,"title":"C","matchPct":70}`),
	}
	if got := parseBatchJobs(raw, 2); len(got) != 2 {
		t.Errorf("limit 2 → %d jobs", len(got))
	}
	all := parseBatchJobs(raw, 0)
	if len(all) != 3 {
		t.Fatalf("limit 0 → %d jobs; want 3", len(all))
	}
	// Missing "matched" must serialize as [] not null (so the page's Why code is safe).
	if all[0].Matched == nil {
		t.Errorf("nil matched should be normalized to empty slice")
	}
}

func TestOpenBatchJobs_PrefersDirectURLAndSkipsUnsafeLinks(t *testing.T) {
	jobs := []batchJob{
		{DirectURL: "https://jobs.example.com/apply/1", ViewURL: "https://hiring.cafe/viewjob/1"},
		{ViewURL: "https://hiring.cafe/viewjob/2"},
		{DirectURL: "javascript:alert(1)", ViewURL: "https://hiring.cafe/viewjob/3"},
		{DirectURL: "javascript:alert(1)"},
		{},
	}
	var got []string
	opened, skipped, failed := openBatchJobs(jobs, func(raw string) error {
		got = append(got, raw)
		return nil
	})
	if opened != 3 || skipped != 2 || failed != 0 {
		t.Fatalf("openBatchJobs counts = opened %d, skipped %d, failed %d", opened, skipped, failed)
	}
	want := []string{"https://jobs.example.com/apply/1", "https://hiring.cafe/viewjob/2", "https://hiring.cafe/viewjob/3"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Fatalf("opened URLs = %v; want %v", got, want)
	}
}

func TestOpenBatchJobs_ContinuesAfterOpenFailure(t *testing.T) {
	jobs := []batchJob{
		{DirectURL: "https://jobs.example.com/apply/1"},
		{DirectURL: "https://jobs.example.com/apply/2"},
	}
	calls := 0
	opened, skipped, failed := openBatchJobs(jobs, func(string) error {
		calls++
		if calls == 1 {
			return errors.New("browser unavailable")
		}
		return nil
	})
	if calls != 2 || opened != 1 || skipped != 0 || failed != 1 {
		t.Fatalf("got calls %d, opened %d, skipped %d, failed %d", calls, opened, skipped, failed)
	}
}

func TestParseOpenJobsLimit(t *testing.T) {
	tests := []struct {
		raw  string
		want int
		bad  bool
	}{
		{"", 200, false},
		{"1", 1, false},
		{"50", 50, false},
		{"200", 200, false},
		{"0", 0, true},
		{"201", 0, true},
		{"lots", 0, true},
	}
	for _, tc := range tests {
		got, err := parseOpenJobsLimit(tc.raw)
		if (err != nil) != tc.bad || got != tc.want {
			t.Errorf("parseOpenJobsLimit(%q) = %d, %v; want %d, bad=%v", tc.raw, got, err, tc.want, tc.bad)
		}
	}
}
