//go:build !windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

// applyChildHideWindow is a no-op on POSIX — there's no console window
// to hide. Bot stdout/stderr is already redirected via cmd.Stdout/Stderr
// in supervisor.go.
func applyChildHideWindow(cmd *exec.Cmd) {
	// Put the child in its own process group so SIGTERM to the wrapper
	// doesn't fan out to the child via the same controlling terminal —
	// we send it explicitly via terminateProcess() instead.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// terminateProcess sends SIGTERM so the node bot's signal handlers fire
// gracefully (close Playwright contexts, flush logs). Fall back to Kill
// if Signal returns an error.
func terminateProcess(p *os.Process) error {
	return p.Signal(syscall.SIGTERM)
}

// isProcessAlive: POSIX kill(pid, 0) — returns 0 for live processes, ESRCH
// for dead. (On Windows this idiom silently fails for foreign processes;
// see platform_windows.go for the Win32 probe.)
func isProcessAlive(pid int) bool {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return proc.Signal(syscall.Signal(0)) == nil
}

// killProcessTree force-kills a process and (best-effort) its children.
// The supervised bot child runs in its own process group (Setpgid in
// applyChildHideWindow), so killing the wrapper PID alone would orphan it —
// send SIGKILL to the wrapper's group AND the pid itself.
func killProcessTree(pid int) {
	_ = syscall.Kill(-pid, syscall.SIGKILL) // group, if pid is a group leader
	_ = syscall.Kill(pid, syscall.SIGKILL)
}
