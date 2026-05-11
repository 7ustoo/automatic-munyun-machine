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

// nullSignal returns the no-op signal used for liveness probes. POSIX
// kill(pid, 0) returns 0 for live processes, ESRCH for dead.
func nullSignal() os.Signal {
	return syscall.Signal(0)
}
