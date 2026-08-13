package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

var scheduledHelperScripts = map[string]string{
	"daily":        "daily-batch.mjs",
	"watchdog":     "watchdog.mjs",
	"batch-missed": "batch-missed-watcher.mjs",
}

func scheduledHelperPath(installDir, task string) (string, error) {
	name, ok := scheduledHelperScripts[task]
	if !ok {
		return "", fmt.Errorf("unknown scheduled task %q", task)
	}
	return filepath.Join(installDir, "scripts", name), nil
}

// runScheduledHelper is the console-free bridge between Windows Task
// Scheduler and the existing JavaScript business logic. AMM.exe is linked as
// a Windows GUI application, and its Node child inherits CREATE_NO_WINDOW.
func runScheduledHelper(installDir, task string) int {
	script, err := scheduledHelperPath(installDir, task)
	if err != nil {
		return 2
	}
	if _, err := os.Stat(script); err != nil {
		return 3
	}
	cmd := exec.Command(findNode(), script)
	cmd.Dir = installDir
	applyChildHideWindow(cmd)
	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return exitErr.ExitCode()
		}
		return 1
	}
	return 0
}
