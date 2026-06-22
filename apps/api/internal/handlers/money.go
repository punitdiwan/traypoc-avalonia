package handlers

import "os"

// currencyCode returns the org's billing currency (ISO 4217 code), configurable
// via the CURRENCY env var. Defaults to INR. Amounts are always stored and sent
// as integer cents; the web app formats them with Intl.NumberFormat.
func currencyCode() string {
	if c := os.Getenv("CURRENCY"); c != "" {
		return c
	}
	return "INR"
}
