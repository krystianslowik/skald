package server

import (
	"crypto/subtle"
	"net/http"
)

// requireToken checks X-Agent-Token against the expected value using
// constant-time comparison. /healthz is allowed through unauthenticated so
// health probes don't need the secret.
func requireToken(expected string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			next.ServeHTTP(w, r)
			return
		}
		got := r.Header.Get("X-Agent-Token")
		if subtle.ConstantTimeCompare([]byte(got), []byte(expected)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
