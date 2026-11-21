package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestReadCannotDispatchWritesOrChoosePath(t *testing.T) {
	r := handle(call{Operation: "platform_clear"}, false)
	if r["code"] != "unsupported_operation" {
		t.Fatal("read dispatch accepted a credential mutation")
	}
	r = handle(call{Operation: "endpoint_delete", ID: "7/../../local-token"}, true)
	if r["code"] != "bad_input" {
		t.Fatal("non-decimal ID reached the daemon")
	}
}

func TestEndpointProjectionOmitsSecrets(t *testing.T) {
	d := endpoint(object{
		"id":          json.Number("9007199254740993"),
		"config_json": `{"security":{"basic_auth":{"users":[{"user":"tester","hash":"hash-fixture"}]},"oauth":{"provider":"github","client_secret":"oauth-fixture"},"request_headers":{"set":{"Authorization":"header-fixture"}}}}`,
	})
	out, err := json.Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	result := string(out)
	for _, secret := range []string{"hash-fixture", "oauth-fixture", "header-fixture", "config_json"} {
		if strings.Contains(result, secret) {
			t.Fatalf("endpoint response included unexpected field or value %q", secret)
		}
	}
	if !strings.Contains(result, `"9007199254740993"`) || !strings.Contains(result, "tester") {
		t.Fatal("projection lost the endpoint ID or account name")
	}
}

func TestEndpointHealthAndSnapshotKeepJoinKeys(t *testing.T) {
	snap := project("overview_snapshot", object{
		"server_ip": "192.0.2.1",
		"tunnels": []any{object{
			"tunnel_id": json.Number("9007199254740993"), "proxy_id": "local-proxy", "pending": false,
			"bytes_in": json.Number("1024"), "bytes_out": json.Number("0"),
		}},
	})
	row := snap["tunnels"].([]object)[0]
	if row["tunnel_id"] != "9007199254740993" || row["proxy_id"] != "local-proxy" {
		t.Fatalf("snapshot lost join keys: %+v", row)
	}
	if snap["server_ip"] != "192.0.2.1" || row["bytes_in"] != json.Number("1024") || row["bytes_out"] != json.Number("0") {
		t.Fatalf("snapshot lost endpoint address or traffic counters: %+v", snap)
	}
	edges := project("edges", object{"items": []any{object{"public_addr": "[2001:db8::1]:7443"}}})
	if edges["items"].([]object)[0]["public_addr"] != "[2001:db8::1]:7443" {
		t.Fatalf("edge directory lost the public address: %+v", edges)
	}
	health := project("endpoint_health", object{"enabled": true, "items": []any{object{
		"proxy_id": "local-proxy", "healthy": true, "latency_ms": 3,
	}}})
	if health["items"].([]object)[0]["proxy_id"] != row["proxy_id"] {
		t.Fatalf("health lost proxy ID: %+v", health)
	}
}

func TestCreateProtectionAllowsWizardFieldsOnly(t *testing.T) {
	cfg, ok := createProtection(object{
		"ip":         object{"from_policy": "office", "ignored": "fixture"},
		"basic_auth": object{"users": []any{object{"user": "qa", "password": "fixture", "hash": "untrusted"}}},
	})
	if !ok || strings.Contains(cfg, "ignored") || strings.Contains(cfg, "untrusted") ||
		!strings.Contains(cfg, `"from_policy":"office"`) || !strings.Contains(cfg, `"password":"fixture"`) {
		t.Fatalf("unexpected create security payload: %s", cfg)
	}
	if _, ok := createProtection(object{"oauth": object{}}); ok {
		t.Fatal("create accepted a section outside the wizard")
	}
}

func TestAccessControlMergesAndInspectRedacts(t *testing.T) {
	sec := object{
		"basic_auth":      object{"users": []any{object{"user": "demo", "hash": "stored"}}},
		"request_headers": object{"set": object{"X-Key": "original"}},
		"ip":              object{"allow": []string{"10.0.0.0/8"}},
	}
	if !mergeProtection(sec, "basic_auth", object{"users": []any{object{"user": "demo", "password": ""}}}) ||
		!mergeProtection(sec, "request_headers", object{"remove": []string{"X-Tracing"}}) ||
		!mergeProtection(sec, "ip", nil) {
		t.Fatal("valid access control update rejected")
	}
	if sec["ip"] != nil || asObject(asObject(sec["request_headers"])["set"])["X-Key"] != "original" ||
		asObject(sec["basic_auth"])["users"].([]object)[0]["hash"] != "stored" {
		t.Fatalf("merged access control lost stored fields: %+v", sec)
	}
	if !mergeProtection(sec, "request_headers", object{"set": object{"X-Key": nil, "X-New": "added"}}) {
		t.Fatal("valid header edits rejected")
	}
	set := asObject(asObject(sec["request_headers"])["set"])
	if set["X-Key"] != "original" || set["X-New"] != "added" {
		t.Fatalf("header edits did not preserve the stored value: %+v", set)
	}
	headers := inspectHeaders(object{"Authorization": "secret", "Cookie": "secret", "content-type": "application/json"})
	if len(headers) != 1 || headers["Content-Type"] != "application/json" ||
		inspectText(`{"password":"secret"}`, 4096) != "[redacted]" {
		t.Fatalf("unsafe capture projection: %+v", headers)
	}
}

func TestClientLogProjection(t *testing.T) {
	input := strings.Join([]string{
		"Wed Nov 18 16:22:37 2026 daemon.err calabi[987]: time=2026-11-18T08:22:37-08:00 level=INFO msg=\"daemon starting\"",
		"Wed Nov 18 16:22:38 2026 daemon.err calabi-backup[1]: unrelated-entry",
		"Wed Nov 18 16:22:39 2026 daemon.err calabi[987]: time=2026-11-18T16:22:39Z level=WARN msg=\"failed token=fixture-sensitive\"",
		"Wed Nov 18 16:22:40 2026 daemon.info calabi: could not prepare private state directory",
		"Wed Nov 18 16:22:41 2026 daemon.err calabi[987]: url=https://example.com/verify%3Fcode%3Dfixture-sensitive",
	}, "\n")
	got := projectClientLogs(input)
	if len(got) != 4 || got[0]["level"] != "info" || got[0]["time"] != "2026-11-18T16:22:37Z" ||
		got[1]["level"] != "warn" || got[1]["message"] != "[redacted]" ||
		got[2]["time"] != "2026-11-18T16:22:40Z" || got[2]["message"] != "could not prepare private state directory" ||
		got[3]["level"] != "error" || got[3]["message"] != "[redacted]" {
		t.Fatalf("unexpected filtered logs: %v", got)
	}
}
