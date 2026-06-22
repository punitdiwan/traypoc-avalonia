package handlers

import "strings"

// maxNameLen caps a stored full name. Mirrored client-side (web + desktop).
const maxNameLen = 30

// normalizeName trims surrounding whitespace, collapses any internal whitespace
// run to a single space, and caps the result at maxNameLen runes. So
// "  Ram   Kumar  Prasad " becomes "Ram Kumar Prasad". Empty input stays empty.
func normalizeName(s string) string {
	name := strings.Join(strings.Fields(s), " ")
	if r := []rune(name); len(r) > maxNameLen {
		name = string(r[:maxNameLen])
	}
	return name
}
