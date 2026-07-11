package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// notifyOS shows a native desktop notification. Best-effort and dependency-free
// — it shells out to the platform's own notifier, so a missing tool or an
// unavailable API just means no toast, never a crash. v4.6.
func notifyOS(title, message string) {
	switch runtime.GOOS {
	case "windows":
		// Absolute path per the project convention (some installs drop
		// System32 from PATH); fall back to bare name if it's missing.
		pwsh := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
		if _, err := os.Stat(pwsh); err != nil {
			pwsh = "powershell.exe"
		}
		_ = exec.Command(pwsh, "-NoProfile", "-NonInteractive", "-Command", winToastScript(title, message)).Run()
	case "darwin":
		script := "display notification " + strconv.Quote(message) + " with title " + strconv.Quote(title)
		_ = exec.Command("osascript", "-e", script).Run()
	default: // linux, *bsd
		_ = exec.Command("notify-send", title, message).Run()
	}
}

// winToastScript builds a PowerShell command that raises a Windows 10/11 toast
// via the WinRT ToastNotificationManager. Text is XML-escaped, and the XML is
// embedded in a single-quoted PowerShell literal (single quotes doubled). If
// the WinRT APIs aren't present the script throws and Run() returns an error
// we ignore.
func winToastScript(title, message string) string {
	xml := "<toast><visual><binding template=\"ToastText02\">" +
		"<text id=\"1\">" + xmlEscape(title) + "</text>" +
		"<text id=\"2\">" + xmlEscape(message) + "</text>" +
		"</binding></visual></toast>"
	xmlLit := strings.ReplaceAll(xml, "'", "''")
	return "[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]>$null;" +
		"[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom,ContentType=WindowsRuntime]>$null;" +
		"$d=New-Object Windows.Data.Xml.Dom.XmlDocument;" +
		"$d.LoadXml('" + xmlLit + "');" +
		"$t=[Windows.UI.Notifications.ToastNotification]::new($d);" +
		"[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Automatic Munyun Machine').Show($t)"
}

func xmlEscape(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	s = strings.ReplaceAll(s, "\"", "&quot;")
	return s
}
