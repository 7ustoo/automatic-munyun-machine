//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"unsafe"
)

var shellExecuteW = syscall.NewLazyDLL("shell32.dll").NewProc("ShellExecuteW")

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

func openTarget(target string) error {
	operation, err := syscall.UTF16PtrFromString("open")
	if err != nil {
		return err
	}
	targetPtr, err := syscall.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	const swShowNormal = 1
	result, _, callErr := shellExecuteW.Call(
		0,
		uintptr(unsafe.Pointer(operation)),
		uintptr(unsafe.Pointer(targetPtr)),
		0,
		0,
		swShowNormal,
	)
	if result <= 32 {
		return fmt.Errorf("ShellExecuteW failed (%d): %v", result, callErr)
	}
	return nil
}

// terminateProcess sends a graceful termination signal to the child. On
// Windows there's no true SIGTERM equivalent — os.Process.Signal doesn't
// support arbitrary signals on Windows — so we fall through to Kill().
// The bot's process.on('exit') still fires for cleanup. Acceptable.
func terminateProcess(p *os.Process) error {
	return p.Kill()
}

// isProcessAlive: real Win32 liveness probe. os.Process.Signal(0) — the
// POSIX kill-0 idiom — always errors on Windows for processes we didn't
// spawn, which made the single-instance lock treat every live instance as
// dead (v2.4 fix). OpenProcess with query-limited rights + GetExitCodeProcess
// is the canonical check: a live process reports STILL_ACTIVE (259).
func isProcessAlive(pid int) bool {
	const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
	const STILL_ACTIVE = 259
	h, err := syscall.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		// No handle → no such process (or a permissions wall we'd never hit
		// for our own user's AMM.exe).
		return false
	}
	defer syscall.CloseHandle(h)
	var code uint32
	if err := syscall.GetExitCodeProcess(h, &code); err != nil {
		return false
	}
	return code == STILL_ACTIVE
}

// killProcessTree force-kills a process AND its children. Used by the v2.4
// takeover path: when a stale/unresponsive AMM instance holds the lock, we
// must also take down its supervised node bot child — otherwise the orphaned
// poller keeps fighting the new instance's bot over the Telegram token (409s).
// taskkill /T walks the child tree for us.
func killProcessTree(pid int) {
	sys32 := os.Getenv("SystemRoot")
	if sys32 == "" {
		sys32 = `C:\Windows`
	}
	cmd := exec.Command(sys32+`\System32\taskkill.exe`, "/PID", strconv.Itoa(pid), "/T", "/F")
	applyChildHideWindow(cmd)
	_ = cmd.Run()
}
