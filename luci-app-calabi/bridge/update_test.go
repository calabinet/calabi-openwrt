package main

import (
	"strings"
	"testing"
	"time"
)

func TestOpenWrtUpdatePolicy(t *testing.T) {
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	p := updatePolicy{Mode: "auto", Start: 23, End: 5, Defer: 7}
	for _, example := range []struct {
		mode       string
		security   bool
		hour, days int
		busy       bool
		want       string
	}{
		{"notify", true, 3, 9, false, "available"},
		{"security", false, 3, 9, false, "ordinary_update"},
		{"security", true, 14, 0, true, "installing"},
		{"auto", false, 5, 0, false, "waiting_window"},
		{"auto", false, 23, 0, true, "waiting_idle"},
		{"auto", false, 4, 0, false, "installing"},
		{"auto", false, 12, 7, true, "installing"},
	} {
		p.Mode = example.mode
		if got := updateDecision(p, example.security, now, now.Add(-time.Duration(example.days)*24*time.Hour),
			example.hour, example.busy); got != example.want {
			t.Errorf("%+v produced %q", example, got)
		}
	}
}

func TestOpenWrtUpdateFeedParser(t *testing.T) {
	entry := "Package: calabi\nVersion: 2.9.0-1\nArchitecture: x86_64\nFilename: calabi_2.9.0-1_x86_64.ipk\n" +
		"SHA256sum: " + strings.Repeat("f", 64) + "\nSecurity-Update: yes"
	packages, err := parseUpdateFeed(strings.NewReader("Package: unrelated\nVersion: 999\n\n" + entry))
	if err != nil || len(packages) != 1 || !packages[0].security || packages[0].version != "2.9.0-1" {
		t.Fatalf("packages = %+v, err = %v", packages, err)
	}
	if _, err := parseUpdateFeed(strings.NewReader(strings.Replace(entry, "calabi_2.", "../calabi_2.", 1))); err == nil {
		t.Fatal("accepted a non-basename package")
	}
}
