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

// isProcessAlive returns true if the given PID is running. Cross-platform.
func isProcessAlive(pid int) bool {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	// On Windows, FindProcess always succeeds (it doesn't actually probe).
	// Signal(syscall.Signal(0)) is the cross-platform "ping" — on POSIX
	// it's the standard kill -0 check; on Windows os.Process.Signal with
	// signal 0 returns nil for live processes, error for dead ones.
	return proc.Signal(nullSignal()) == nil
}
