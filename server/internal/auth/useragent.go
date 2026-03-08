package auth

import "strings"

// DeviceNameFromUA extracts a human-readable device name from a User-Agent string.
// Returns something like "Chrome on macOS" or "Firefox on Windows".
func DeviceNameFromUA(ua string) string {
	browser := parseBrowser(ua)
	os := parseOS(ua)
	if browser == "" && os == "" {
		return ""
	}
	if browser == "" {
		return os
	}
	if os == "" {
		return browser
	}
	return browser + " on " + os
}

func parseBrowser(ua string) string {
	// Order matters — check more specific strings first.
	switch {
	case strings.Contains(ua, "Electron"):
		return "Desktop App"
	case strings.Contains(ua, "Edg/") || strings.Contains(ua, "Edg "):
		return "Edge"
	case strings.Contains(ua, "OPR/") || strings.Contains(ua, "Opera"):
		return "Opera"
	case strings.Contains(ua, "Brave"):
		return "Brave"
	case strings.Contains(ua, "Vivaldi"):
		return "Vivaldi"
	case strings.Contains(ua, "Firefox"):
		return "Firefox"
	case strings.Contains(ua, "Chrome") && !strings.Contains(ua, "Chromium"):
		return "Chrome"
	case strings.Contains(ua, "Chromium"):
		return "Chromium"
	case strings.Contains(ua, "Safari") && !strings.Contains(ua, "Chrome"):
		return "Safari"
	default:
		return ""
	}
}

// PlatformFromUA returns a platform string ("web", "electron") based on the User-Agent.
// Mobile platforms (android, ios) are detected by their native apps, not UA.
func PlatformFromUA(ua string) string {
	if strings.Contains(ua, "Electron") {
		return "electron"
	}
	return "web"
}

func parseOS(ua string) string {
	switch {
	case strings.Contains(ua, "iPhone") || strings.Contains(ua, "iPad"):
		return "iOS"
	case strings.Contains(ua, "Android"):
		return "Android"
	case strings.Contains(ua, "Mac OS X") || strings.Contains(ua, "Macintosh"):
		return "macOS"
	case strings.Contains(ua, "Windows"):
		return "Windows"
	case strings.Contains(ua, "CrOS"):
		return "ChromeOS"
	case strings.Contains(ua, "Linux"):
		return "Linux"
	default:
		return ""
	}
}
