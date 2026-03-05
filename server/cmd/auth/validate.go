package main

import (
	"net/mail"
	"regexp"
	"strings"
)

var usernameRe = regexp.MustCompile(`^[a-zA-Z0-9_]{3,20}$`)
var hexColorRe = regexp.MustCompile(`^[0-9a-fA-F]{6}$`)

func validateEmail(email string) bool {
	if len(email) > 254 {
		return false
	}
	_, err := mail.ParseAddress(email)
	return err == nil
}

func validateUsername(username string) bool {
	return usernameRe.MatchString(username)
}

func validateHexColor(color string) bool {
	return hexColorRe.MatchString(color)
}

func validateMediaURL(url string) bool {
	return strings.HasPrefix(url, "/media/")
}

// isEmail distinguishes emails from usernames. Reliable because
// validateUsername enforces ^[a-zA-Z0-9_]{3,20}$ — usernames never contain "@".
func isEmail(identifier string) bool {
	return strings.Contains(identifier, "@")
}
