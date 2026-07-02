package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
)

// acquireSingleInstanceLock writes our PID to data/wrapper.lock and refuses
// to start if a previous instance is still alive. Prevents the double-tray-
// icon scenario when the scheduler restarts AMM.exe while a healthy wrapper
// is still running (per plan risk #4).
//
// Returns a release func that removes the lock on shutdown.
func acquireSingleInstanceLock(installDir string) (release func(), err error) {
	lockPath := filepath.Join(installDir, "data", "wrapper.lock")
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		return nil, fmt.Errorf("mkdir: %w", err)
	}

	// Check for existing lock
	if data, err := os.ReadFile(lockPath); err == nil {
		if pid, perr := strconv.Atoi(string(data)); perr == nil && pid > 0 {
			if isProcessAlive(pid) && pid != os.Getpid() {
				return nil, fmt.Errorf("another wrapper instance is running (pid=%d)", pid)
			}
		}
		// stale lock — overwrite below
	}

	// Write our PID
	if err := os.WriteFile(lockPath, []byte(strconv.Itoa(os.Getpid())), 0o644); err != nil {
		return nil, fmt.Errorf("write lock: %w", err)
	}

	return func() {
		// Only remove the lock if it still contains OUR pid — defensive against
		// a second instance overwriting it (shouldn't happen but cheap to check).
		if data, err := os.ReadFile(lockPath); err == nil {
			if string(data) == strconv.Itoa(os.Getpid()) {
				_ = os.Remove(lockPath)
			}
		}
	}, nil
}

// readLockPID returns the PID recorded in data/wrapper.lock, or 0 when the
// lock is absent/unreadable. Used by the v2.4 takeover path to identify the
// stale instance to kill.
func readLockPID(installDir string) int {
	data, err := os.ReadFile(filepath.Join(installDir, "data", "wrapper.lock"))
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(string(data))
	if err != nil || pid <= 0 {
		return 0
	}
	return pid
}

// isProcessAlive lives in platform_windows.go / platform_unix.go.
//
// v2.4: it used to live here as proc.Signal(syscall.Signal(0)) "cross-
// platform". That idiom is a lie on Windows — os.Process.Signal to a
// process we didn't spawn ALWAYS errors there, so every live instance
// looked dead, every lock looked stale, and a double-click quietly booted
// a full second instance (two trays, two dashboards) instead of handing
// off. Caught by the v2.4 live launch test; Windows now probes with
// OpenProcess + GetExitCodeProcess.
