//go:build windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

// applyChildHideWindow sets SysProcAttr so the spawned node child doesn't
// flash a console window. Critical for the "looks like a real app" UX —
// without this, every node spawn pops a black console.
//
// CREATE_NO_WINDOW = 0x08000000  (Win32 process creation flag)
func applyChildHideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000,
	}
}

// terminateProcess sends a graceful termination signal to the child. On
// Windows there's no true SIGTERM equivalent — os.Process.Signal doesn't
// support arbitrary signals on Windows — so we fall through to Kill().
// The bot's process.on('exit') still fires for cleanup. Acceptable.
func terminateProcess(p *os.Process) error {
	return p.Kill()
}

// nullSignal returns the no-op signal used for liveness probes. On Windows
// os.Process.Signal(syscall.Signal(0)) returns nil for live processes and
// error for dead ones — the standard kill-0 idiom.
func nullSignal() os.Signal {
	return syscall.Signal(0)
}
