package main

import (
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

// supervisor manages the node bot child process. It spawns it, watches for
// exits, respawns on unexpected exit with a 3-strikes-per-hour throttle
// mirroring scripts/watchdog.mjs:42-44 semantics.
//
// Thread safety: the supervisor is written by runForever() and read by tray-
// menu actions (e.g., "Restart bot"). Mutex guards the child reference and
// the restart-history slice. Atomic counter for "stopped" so Quit can race-
// free signal shutdown.
type supervisor struct {
	botPath    string
	installDir string

	mu       sync.Mutex
	child    *exec.Cmd
	restarts []time.Time // sliding 1h window — same as watchdog
	stopped  atomic.Bool // set by Quit; runForever exits when seen
}

// Match scripts/watchdog.mjs:42-44 throttle policy exactly so behavior is
// consistent: 3 restart attempts per 1h sliding window, then give up
// (wrapper exits, scheduler will restart it at next trigger).
const (
	supervisorMaxRestarts   = 3
	supervisorRestartWindow = 1 * time.Hour
	supervisorRespawnDelay  = 2 * time.Second // brief pause so OS reaps the dead child
	// v2.1: how often runForever rechecks whether Telegram got enabled while
	// it's idling. Short enough that enabling Telegram from the dashboard
	// brings the bot up within a few seconds.
	supervisorIdleRecheck = 4 * time.Second
)

func newSupervisor(botPath, installDir string) *supervisor {
	return &supervisor{
		botPath:    botPath,
		installDir: installDir,
	}
}

// runForever spawns the node bot and respawns it on unexpected exit until
// either (a) the wrapper is shutting down (stopped.Load() == true), or
// (b) the restart throttle is exhausted.
func (s *supervisor) runForever() {
	idleLogged := false
	for {
		if s.stopped.Load() {
			log.Printf("supervisor: stopped flag set, exiting loop")
			return
		}

		// v2.1: Telegram is optional. When it's off there's no poller to
		// supervise — idle and recheck instead of spawning a token-less bot
		// that would exit immediately and burn the restart budget. Enabling
		// Telegram from the dashboard is picked up here within a few seconds.
		if !telegramEnabled(s.installDir) {
			if !idleLogged {
				log.Printf("supervisor: Telegram off — idling (no bot poller). Dashboard is the surface.")
				idleLogged = true
			}
			time.Sleep(supervisorIdleRecheck)
			continue
		}
		idleLogged = false

		if !s.checkRestartBudget() {
			log.Printf("supervisor: restart budget exhausted (%d restarts in last 1h). Wrapper exiting; scheduler will restart at next trigger.", supervisorMaxRestarts)
			// Exit the WRAPPER, not just the supervisor — Task Scheduler /
			// launchd / systemd will fire the trigger again at the configured
			// interval, and the watchdog will also notice the dead heartbeat.
			// This mirrors watchdog.mjs's "gave-up" path.
			os.Exit(0)
		}

		log.Printf("supervisor: spawning node %s", s.botPath)
		cmd := exec.Command(findNode(), s.botPath)
		cmd.Dir = s.installDir
		// Inherit stdio so the bot's log output flows into wrapper.log via
		// our log redirection (log.SetOutput already pointed at wrapper.log
		// in main.go). Each line is timestamped by the bot itself.
		// On Windows, we hide the child's console window so the bot doesn't
		// open a cmd-like flash when launched. See platform_*.go for
		// SysProcAttr setup.
		applyChildHideWindow(cmd)
		cmd.Stdout = log.Writer()
		cmd.Stderr = log.Writer()

		if err := cmd.Start(); err != nil {
			log.Printf("supervisor: spawn failed: %v", err)
			s.recordRestart()
			time.Sleep(supervisorRespawnDelay)
			continue
		}

		s.mu.Lock()
		s.child = cmd
		s.mu.Unlock()
		log.Printf("supervisor: spawned pid=%d", cmd.Process.Pid)

		// Wait blocks until the child exits. On normal shutdown (Quit -> Kill),
		// Wait returns an error — that's fine, we check stopped.Load() below.
		waitErr := cmd.Wait()

		s.mu.Lock()
		s.child = nil
		s.mu.Unlock()

		if s.stopped.Load() {
			log.Printf("supervisor: child exited during shutdown (err=%v) — clean", waitErr)
			return
		}

		// v2.1: if Telegram was turned off while the bot ran (dashboard
		// "Disable", which kills the child), the exit is deliberate — don't
		// count it as a crash. The loop top will idle.
		if !telegramEnabled(s.installDir) {
			log.Printf("supervisor: bot exited and Telegram is now off — idling, not a crash")
			continue
		}

		log.Printf("supervisor: child exited unexpectedly (err=%v) — will respawn after %v", waitErr, supervisorRespawnDelay)
		s.recordRestart()
		time.Sleep(supervisorRespawnDelay)
	}
}

// checkRestartBudget returns true if we have budget left to attempt another
// restart. Prunes timestamps older than the sliding window first.
func (s *supervisor) checkRestartBudget() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	cutoff := time.Now().Add(-supervisorRestartWindow)
	fresh := s.restarts[:0]
	for _, t := range s.restarts {
		if t.After(cutoff) {
			fresh = append(fresh, t)
		}
	}
	s.restarts = fresh
	return len(s.restarts) < supervisorMaxRestarts
}

// recordRestart appends "now" to the restart history.
func (s *supervisor) recordRestart() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.restarts = append(s.restarts, time.Now())
}

// Quit signals shutdown + kills the child. Safe to call from any goroutine.
// Called from tray "Quit" menu handler.
func (s *supervisor) Quit() {
	if !s.stopped.CompareAndSwap(false, true) {
		return // already quitting
	}
	s.mu.Lock()
	child := s.child
	s.mu.Unlock()
	if child == nil || child.Process == nil {
		return
	}
	log.Printf("supervisor: Quit() — killing child pid=%d", child.Process.Pid)
	// Try graceful SIGTERM first (the bot's signal handlers will close gracefully).
	if err := terminateProcess(child.Process); err != nil {
		log.Printf("supervisor: terminate failed (%v) — falling back to Kill", err)
		_ = child.Process.Kill()
	}
}

// Restart kills the current child and lets runForever spawn a fresh one.
// Used by the tray "Restart bot" menu item.
func (s *supervisor) Restart() {
	s.mu.Lock()
	child := s.child
	s.mu.Unlock()
	if child == nil || child.Process == nil {
		log.Printf("supervisor: Restart() — no child to kill (will spawn fresh)")
		return
	}
	log.Printf("supervisor: Restart() — killing child pid=%d for respawn", child.Process.Pid)
	_ = child.Process.Kill() // Kill (not Terminate) so the bot doesn't hang on cleanup
}

// KillChild kills the running bot poller (if any) without setting the
// terminal stopped flag. v2.1: called when Telegram is disabled from the
// dashboard. runForever's post-Wait check sees Telegram is now off and idles
// instead of respawning. No-op when no child is running.
func (s *supervisor) KillChild() {
	s.mu.Lock()
	child := s.child
	s.mu.Unlock()
	if child == nil || child.Process == nil {
		return
	}
	log.Printf("supervisor: KillChild() — stopping bot poller pid=%d (Telegram disabled)", child.Process.Pid)
	_ = child.Process.Kill()
}

// ChildPID returns the current node child's PID, or 0 if none. Used by tray
// "Status" to surface the bot's PID.
func (s *supervisor) ChildPID() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.child == nil || s.child.Process == nil {
		return 0
	}
	return s.child.Process.Pid
}

// findNode locates the node executable. Re-runs `where node` / `which node`
// at spawn-time rather than at process-start so a newly-installed Node is
// picked up without a wrapper restart.
//
// Falls back to "node" on PATH (which exec.LookPath checks) — if that fails
// at exec.Start() time we'll log the error and the supervisor's restart loop
// will give up cleanly after 3 attempts.
func findNode() string {
	// Prefer the Node runtime bundled inside the install (v4.1.1). The .exe
	// installer never provisioned system Node, so on a fresh Windows machine
	// every helper exec failed with "Could not run the helper. Is Node
	// installed?" — this bundled copy is the fix.
	if p := bundledNode(); p != "" {
		return p
	}
	// Try Windows-typical install location next (winget puts it here).
	for _, candidate := range nodeCandidates() {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	// PATH lookup as last resort
	if p, err := exec.LookPath("node"); err == nil {
		return p
	}
	return "node" // hope for the best; exec.Start will surface ENOENT
}

// bundledNode returns the path to the Node runtime shipped inside the install
// (installer/amm.iss stages it at <installDir>/runtime/), or "" if absent —
// e.g. dev builds and the mac/linux packages, which provision Node elsewhere.
// AMM.exe lives at <installDir>/wrapper/dist/AMM.exe, so the runtime dir is two
// levels up from the executable. Resolving off the executable (not the CWD)
// keeps it correct no matter which scheduler or shortcut spawned the wrapper.
func bundledNode() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	// v8.1: inside a macOS .app the runtime ships at
	// Contents/Resources/node/bin/node, not <install>/runtime/. Mac users are
	// no more likely to have Node installed than Windows users were, so the
	// bundle carries its own copy and this is what makes the app work on a
	// machine with no developer tooling at all.
	if p, ok := macBundledNode(exe); ok {
		return p
	}
	name := "node"
	if runtime.GOOS == "windows" {
		name = "node.exe"
	}
	p := filepath.Join(filepath.Dir(exe), "..", "..", "runtime", name)
	if _, err := os.Stat(p); err == nil {
		return p
	}
	return ""
}

// nodeCandidates returns platform-specific likely paths to the node binary.
func nodeCandidates() []string {
	if appdata := os.Getenv("LOCALAPPDATA"); appdata != "" {
		// winget Node install path
		matches, _ := filepath.Glob(filepath.Join(appdata, "Microsoft", "WinGet", "Packages", "OpenJS.NodeJS*", "node-*", "node.exe"))
		if len(matches) > 0 {
			return matches
		}
	}
	return []string{
		`C:\Program Files\nodejs\node.exe`,
		`C:\Program Files (x86)\nodejs\node.exe`,
		"/usr/local/bin/node",
		"/opt/homebrew/bin/node",
		"/usr/bin/node",
	}
}

// unused, but kept to silence go vet's "io imported and not used" complaint
// if any of the platform stubs change.
var _ = io.Discard
