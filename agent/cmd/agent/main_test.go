package main

import "testing"

// A build without -ldflags "-X main.version=..." must say so instead of
// passing for a release.
func TestVersionDefault(t *testing.T) {
	if version != "dev" {
		t.Errorf("version = %q, want dev", version)
	}
}
