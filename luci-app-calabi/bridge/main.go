// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	runDir    = "/var/run/calabi"
	tokenPath = "/etc/calabi/local_token"
	limit     = 48 << 10
)

type object = map[string]any

type call struct {
	Operation string `json:"operation"`
	ID        string `json:"id"`
	Data      object `json:"data"`
}

type action struct {
	method, path string
	fields       []string
}

var reads = map[string]action{
	"health":            {"GET", "/healthz", nil},
	"identity":          {"GET", "/v1/selfhosted", nil},
	"platform_identity": {"GET", "/v1/platform/identity", nil},
	"account":           {"GET", "/v1/me", nil},
	"mesh":              {"GET", "/v1/mesh", nil},
	"mesh_nodes":        {"GET", "/v1/mesh/nodes", nil},
	"routes":            {"GET", "/v1/mesh/advertise", nil},
	"mesh_services":     {"GET", "/v1/mesh/services", nil},
	"endpoints":         {"GET", "/v1/tunnels", nil},
	"endpoint":          {"GET", "/v1/tunnels/%s", nil},
	"edges":             {"GET", "/v1/edges", nil},
	"domains":           {"GET", "/v1/domains", nil},
	"org_security":      {"GET", "/v1/org/security", nil},
	"ip_policies":       {"GET", "/v1/org/ip-policies", nil},
	"oauth_policies":    {"GET", "/v1/org/oauth-policies", nil},
	"edge_affinity":     {"GET", "/v1/edge-affinity", nil},
	"endpoint_health":   {"GET", "/v1/probe/health", nil},
	"overview_snapshot": {"GET", "/tunnels", nil},
	"overview_devices":  {"GET", "/v1/mesh/nodes", nil},
	"overview_mesh":     {"GET", "/v1/mesh", nil},
	"usage_today":       {"GET", "/v1/usage/current?period=today", nil},
	"usage_month":       {"GET", "/v1/usage/current", nil},
	"usage_daily":       {"GET", "/v1/usage/daily?n=30", nil},
	"usage_mesh":        {"GET", "/v1/usage/mesh?days=30", nil},
}

var writes = map[string]action{
	"platform_setup":      {"POST", "/v1/platform/setup", []string{"api_key"}},
	"platform_replace":    {"POST", "/v1/platform/replace", []string{"api_key"}},
	"platform_clear":      {"POST", "/v1/platform/clear", nil},
	"join":                {"POST", "/v1/selfhosted/join", []string{"mesh", "replace"}},
	"trust":               {"POST", "/v1/selfhosted/trust", []string{"part", "pin"}},
	"leave":               {"POST", "/v1/selfhosted/leave", nil},
	"mesh_up":             {"POST", "/v1/mesh/up", nil},
	"mesh_down":           {"POST", "/v1/mesh/down", nil},
	"routes_save":         {"POST", "/v1/mesh/advertise", []string{"routes", "alias_hosts", "accept_routes", "route_excludes", "block_incoming", "advertise_exit_node", "exit_node"}},
	"mesh_services_save":  {"POST", "/v1/mesh/services", []string{"items"}},
	"endpoint_create":     {"POST", "/v1/tunnels", []string{"name", "type", "local_addr", "domain", "subdomain", "remote_port", "base_domain", "notify_offline"}},
	"endpoint_edit":       {"PUT", "/v1/tunnels/%s", []string{"name", "local_addr", "notify_offline"}},
	"endpoint_state":      {"POST", "/v1/tunnels/%s/status", []string{"enabled"}},
	"endpoint_takeover":   {"POST", "/v1/tunnels/%s/takeover", []string{"local_addr"}},
	"endpoint_delete":     {"DELETE", "/v1/tunnels/%s", nil},
	"endpoint_protection": {"POST", "/v1/tunnels/%s/security", nil},
	"edge_affinity_save":  {"POST", "/v1/edge-affinity", []string{"affinity"}},
	"edge_region_save":    {"POST", "/v1/edge-region", []string{"region"}},
	"probe":               {"POST", "/v1/probe/check", []string{"type", "local_addr"}},
}

func main() {
	encoder := json.NewEncoder(os.Stdout)
	if len(os.Args) == 2 && os.Args[1] == "update-tick" {
		runUpdateTick()
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "list" {
		signature := object{"operation": "", "id": "", "data": object{}}
		_ = encoder.Encode(object{"read": signature, "write": signature, "inspect": signature, "update_policy_write": object{"data": object{}}})
		return
	}
	if len(os.Args) != 3 || os.Args[1] != "call" {
		os.Exit(1)
	}
	switch os.Args[2] {
	case "read", "write", "inspect", "update_policy_write":
	default:
		os.Exit(1)
	}
	body, err := io.ReadAll(io.LimitReader(os.Stdin, limit+1))
	var req call
	if err != nil || len(body) > limit || json.Unmarshal(body, &req) != nil {
		_ = encoder.Encode(failure(400, "bad_input"))
		return
	}
	if os.Args[2] == "update_policy_write" {
		_ = encoder.Encode(setUpdatePolicy(req.Data))
		return
	}
	if os.Args[2] == "inspect" {
		_ = encoder.Encode(inspectEndpoint(req))
		return
	}
	_ = encoder.Encode(handle(req, os.Args[2] == "write"))
}

func handle(req call, write bool) object {
	actions := reads
	if write {
		actions = writes
	}
	if !write && req.Operation == "firewall" {
		return firewallStatus()
	}
	if !write && req.Operation == "logs" {
		return clientLogs()
	}
	if !write && req.Operation == "package_versions" {
		return packageVersions()
	}
	if !write && req.Operation == "update_policy" {
		return updatePolicyStatus()
	}
	if !write && req.Operation == "overview_quota" {
		return overviewQuota()
	}
	if write && req.Operation == "firewall_save" {
		return saveFirewall(req.Data)
	}
	a, ok := actions[req.Operation]
	if !ok {
		return failure(404, "unsupported_operation")
	}
	if strings.Contains(a.path, "%s") {
		id, err := strconv.ParseInt(req.ID, 10, 64)
		if err != nil || id <= 0 {
			return failure(400, "bad_input")
		}
		a.path = fmt.Sprintf(a.path, strconv.FormatInt(id, 10))
	}
	if req.Operation == "endpoint_protection" {
		return saveProtection(req, a)
	}
	data := pick(req.Data, a.fields...)
	if req.Operation == "endpoint_create" && req.Data["security"] != nil {
		cfg, ok := createProtection(req.Data["security"])
		if !ok {
			return failure(400, "bad_input")
		}
		data["config_json"] = cfg
	}
	if req.Operation == "usage_today" || req.Operation == "usage_daily" {
		if zone, ok := req.Data["tz"].(string); ok && zoneName.MatchString(zone) {
			a.path += "&tz=" + url.QueryEscape(zone)
		}
	}
	if req.Operation == "join" {
		data["mesh"] = pick(asObject(data["mesh"]), "link", "server", "key", "pin", "name")
	}
	status, raw := request(a.method, a.path, data)
	if status < 200 || status >= 300 {
		return apiFailure(status, raw)
	}
	return success(status, project(req.Operation, raw))
}

var zoneName = regexp.MustCompile(`^[A-Za-z0-9_+./-]{1,96}$`)

func overviewQuota() object {
	code, me := request("GET", "/v1/me", nil)
	if code != 200 {
		return apiFailure(code, me)
	}
	id := func(row object) int64 {
		n, _ := strconv.ParseInt(fmt.Sprint(row["id"]), 10, 64)
		return n
	}
	org, user := id(asObject(me["org"])), id(asObject(me["user"]))
	if user <= 0 {
		user = id(asObject(me["acting_user"]))
	}
	if org <= 0 || user <= 0 {
		return success(200, object{})
	}
	code, quotas := request("GET", "/v1/orgs/"+strconv.FormatInt(org, 10)+"/member-quotas", nil)
	if code != 200 {
		return apiFailure(code, quotas)
	}
	for _, row := range rows(quotas["items"], "user_id", "used", "effective", "exempt") {
		if fmt.Sprint(row["user_id"]) == strconv.FormatInt(user, 10) {
			return success(200, object{"limit": asObject(row["effective"])["max_tunnels"],
				"used": asObject(row["used"])["max_tunnels"], "exempt": row["exempt"]})
		}
	}
	return success(200, object{})
}

func request(method, path string, data object) (int, object) {
	socket := runDir + "/control.sock"
	dir, err := os.Lstat(runDir)
	if err != nil || !dir.IsDir() || dir.Mode().Perm() != 0700 {
		return 503, nil
	}
	fi, err := os.Lstat(socket)
	if err != nil || fi.Mode()&os.ModeSocket == 0 || fi.Mode().Perm() != 0600 {
		return 503, nil
	}
	transport := &http.Transport{
		DisableKeepAlives: true,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: time.Second}).DialContext(ctx, "unix", socket)
		},
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 22 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	var body io.Reader
	if method != "GET" && method != "DELETE" {
		b, err := json.Marshal(data)
		if err != nil {
			return 400, nil
		}
		body = bytes.NewReader(b)
	}
	r, err := http.NewRequest(method, "http://localhost"+path, body)
	if err != nil {
		return 400, nil
	}
	if method != "GET" {
		token, err := os.ReadFile(tokenPath)
		if err != nil {
			return 503, nil
		}
		r.Header.Set("X-Local-Token", strings.TrimSpace(string(token)))
		r.Header.Set("Content-Type", "application/json")
	}
	res, err := client.Do(r)
	if err != nil {
		return 503, nil
	}
	defer res.Body.Close()
	if res.StatusCode == 204 {
		return 204, object{}
	}
	maxResponse := 2 << 20
	if strings.HasPrefix(path, "/v1/inspect/captures?") {
		// A daemon ring may hold up to 100 captures with clipped bodies.
		maxResponse = 16 << 20
	}
	buf, err := io.ReadAll(io.LimitReader(res.Body, int64(maxResponse+1)))
	if err != nil || len(buf) > maxResponse {
		return 502, nil
	}
	var out object
	dec := json.NewDecoder(bytes.NewReader(buf))
	dec.UseNumber()
	if dec.Decode(&out) != nil || out == nil {
		if res.StatusCode >= 400 {
			return res.StatusCode, nil
		}
		return 502, nil
	}
	return res.StatusCode, out
}

func asObject(v any) object {
	out, _ := v.(map[string]any)
	return out
}

func pick(in object, fields ...string) object {
	out := object{}
	for _, k := range fields {
		switch v := in[k].(type) {
		case nil:
		default:
			out[k] = v
		}
	}
	return out
}

func rows(in any, fields ...string) []object {
	out := []object{}
	list, _ := in.([]any)
	for _, v := range list {
		if row := asObject(v); row != nil {
			out = append(out, pick(row, fields...))
		}
	}
	return out
}

func parseObject(raw any) object {
	var out object
	if s, ok := raw.(string); ok {
		_ = json.Unmarshal([]byte(s), &out)
	}
	if out == nil {
		out = object{}
	}
	return out
}

var endpointFields = []string{"id", "name", "type", "local_addr", "domain", "subdomain", "remote_port", "status",
	"approval", "edge_node_id", "client_id", "created_by_me", "client_online", "upstream_state", "disabled_by_admin"}

func endpoint(row object) object {
	out := pick(row, endpointFields...)
	// IDs are int64. Store them as decimal strings before ubus/JavaScript.
	for _, key := range []string{"id", "client_id"} {
		if id, ok := out[key].(json.Number); ok {
			out[key] = id.String()
		}
	}
	cfg := parseObject(row["config_json"])
	sec := asObject(cfg["security"])
	out["ip"] = pick(asObject(sec["ip"]), "allow", "deny", "from_policy")
	out["basic_users"] = rows(asObject(sec["basic_auth"])["users"], "user")
	out["rate_limit"] = pick(asObject(sec["rate_limit"]), "per_minute", "per_ip_per_minute")
	headers := asObject(sec["request_headers"])
	out["header_names"] = keys(asObject(headers["set"]))
	out["remove_headers"] = headers["remove"]
	out["oauth"] = pick(asObject(sec["oauth"]), "provider", "client_id", "client_secret_set", "allow_emails", "allow_domains", "from_policy")
	out["notify_offline"] = asObject(cfg["notify"])["offline"] == true
	return out
}

func keys(m object) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func saveProtection(req call, a action) object {
	status, current := request("GET", strings.TrimSuffix(a.path, "/security"), nil)
	if status != 200 {
		return apiFailure(status, current)
	}
	cfg := parseObject(current["config_json"])
	sec := asObject(cfg["security"])
	if sec == nil {
		sec = object{}
	}
	changes := asObject(req.Data["changes"])
	if changes == nil {
		section, _ := req.Data["section"].(string)
		raw, present := req.Data["value"]
		if !present {
			return failure(400, "bad_input")
		}
		changes = object{section: raw}
	}
	if len(changes) == 0 || len(changes) > 5 {
		return failure(400, "bad_input")
	}
	for section, raw := range changes {
		if !mergeProtection(sec, section, raw) {
			return failure(400, "bad_input")
		}
	}
	cfg["security"] = sec
	body, err := json.Marshal(cfg)
	if err != nil {
		return failure(400, "bad_input")
	}
	status, result := request(a.method, a.path, object{"config_json": string(body)})
	if status < 200 || status >= 300 {
		return apiFailure(status, result)
	}
	return success(status, endpoint(result))
}

func createProtection(raw any) (string, bool) {
	changes := asObject(raw)
	if len(changes) == 0 {
		return "", false
	}
	security := object{}
	for key, entry := range changes {
		if (key != "ip" && key != "basic_auth") || entry == nil || !mergeProtection(security, key, entry) {
			return "", false
		}
	}
	body, err := json.Marshal(object{"security": security})
	return string(body), err == nil
}

func mergeProtection(sec object, section string, raw any) bool {
	value := asObject(raw)
	if raw != nil && value == nil {
		return false
	}
	var clean object
	switch section {
	case "ip":
		clean = pick(value, "allow", "deny", "from_policy")
	case "basic_auth":
		if value != nil {
			users, ok := passwordRows(asObject(sec["basic_auth"]), value)
			if !ok {
				return false
			}
			clean = object{"users": users}
		}
	case "rate_limit":
		clean = pick(value, "per_minute", "per_ip_per_minute")
	case "request_headers":
		clean = pick(value, "set", "remove")
		previous := asObject(asObject(sec["request_headers"])["set"])
		if submitted, changed := clean["set"]; changed {
			set := asObject(submitted)
			if set == nil {
				return false
			}
			for name, val := range set {
				if val == nil {
					val = previous[name]
					set[name] = val
				}
				if _, ok := val.(string); !ok {
					return false
				}
			}
		} else if value != nil && previous != nil {
			clean["set"] = previous
		}
	case "oauth":
		clean = pick(value, "provider", "client_id", "client_secret", "allow_emails", "allow_domains", "from_policy")
	default:
		return false
	}
	if value == nil {
		delete(sec, section)
	} else {
		sec[section] = clean
	}
	return true
}

func passwordRows(existing, submitted object) ([]object, bool) {
	prior := map[string]string{}
	for _, row := range rows(existing["users"], "user", "hash") {
		name, _ := row["user"].(string)
		hash, _ := row["hash"].(string)
		prior[name] = hash
	}
	out := rows(submitted["users"], "user", "password")
	if len(out) == 0 {
		return nil, false
	}
	for _, row := range out {
		name, _ := row["user"].(string)
		password, _ := row["password"].(string)
		if name == "" || (password == "" && prior[name] == "") {
			return nil, false
		}
		if password == "" {
			delete(row, "password")
			row["hash"] = prior[name]
		}
	}
	return out, true
}

func inspectEndpoint(req call) object {
	id, err := strconv.ParseInt(req.ID, 10, 64)
	if err != nil || id <= 0 {
		return failure(400, "bad_input")
	}
	var path string
	switch req.Operation {
	case "connections":
		path = "/v1/inspect/connections"
	case "captures", "capture":
		path = "/v1/inspect/captures"
	default:
		return failure(404, "unsupported_operation")
	}
	code, snap := request("GET", "/tunnels", nil)
	if code != 200 {
		return apiFailure(code, snap)
	}
	var proxy string
	for _, tunnel := range rows(snap["tunnels"], "tunnel_id", "pending", "proxy_id") {
		if fmt.Sprint(tunnel["tunnel_id"]) == strconv.FormatInt(id, 10) && tunnel["pending"] != true {
			proxy, _ = tunnel["proxy_id"].(string)
			break
		}
	}
	if proxy == "" {
		return failure(404, "client_offline")
	}
	code, result := request("GET", path+"?proxy_id="+url.QueryEscape(proxy), nil)
	if code != 200 {
		return apiFailure(code, result)
	}
	items, _ := result["items"].([]any)
	out := []object{}
	for _, raw := range items {
		if len(out) == 25 {
			break
		}
		item := asObject(raw)
		if item["proxy_id"] != proxy {
			continue
		}
		if req.Operation == "connections" {
			out = append(out, pick(item, "id", "started_at", "ended_at", "bytes_in", "bytes_out", "duration_ms", "visitor_ip"))
			continue
		}
		if req.Operation == "capture" && fmt.Sprint(item["id"]) != fmt.Sprint(req.Data["capture_id"]) {
			continue
		}
		row := pick(item, "id", "started_at", "method", "response_status", "duration_ms")
		rawPath, _ := item["path"].(string)
		safePath, _, _ := strings.Cut(rawPath, "?")
		row["path"] = inspectText(safePath, 512)
		row["failed"] = item["error"] != nil && item["error"] != ""
		if req.Operation == "capture" {
			row["request_headers"] = inspectHeaders(asObject(item["request_headers"]))
			row["response_headers"] = inspectHeaders(asObject(item["response_headers"]))
			row["request_body"] = inspectText(item["request_body"], 4096)
			row["response_body"] = inspectText(item["response_body"], 4096)
			return success(200, row)
		}
		out = append(out, row)
	}
	if req.Operation == "capture" {
		return failure(404, "unsupported_operation")
	}
	return success(200, object{"items": out})
}

func inspectText(raw any, max int) string {
	s, _ := raw.(string)
	decoded, _ := url.QueryUnescape(s)
	if logCredentials.MatchString(s) || logCredentials.MatchString(decoded) {
		return "[redacted]"
	}
	if len(s) > max {
		return s[:max] + "…"
	}
	return s
}

func inspectHeaders(headers object) object {
	out := object{}
	for _, k := range []string{"Content-Type", "Content-Length", "Accept", "Cache-Control", "Content-Encoding", "User-Agent"} {
		for name, value := range headers {
			if strings.EqualFold(k, name) {
				out[k] = inspectText(value, 256)
				break
			}
		}
	}
	return out
}

var networkPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

var (
	clientLogLine  = regexp.MustCompile(`^(.{24}) daemon\.(debug|info|notice|warn|err|crit|alert|emerg) calabi(?:\[[0-9]+\])?: (.+)$`)
	clientLogLevel = regexp.MustCompile(`^time=(\S+) level=(DEBUG|INFO|WARN|ERROR)(?: |$)`)
	logCredentials = regexp.MustCompile(`(?i)\b(?:tk_|ck_|ak_)[a-z0-9_-]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?|calabi://join\b|-----BEGIN |\bbearer\s+\S+|\b(?:authorization|cookie|(?:(?:api|auth|join|private)[_-]?)?key|password|passwd|(?:client[_-]?)?secret|(?:[a-z]+[_-])?token)["']?\s*[:=]|https?://[^\s"]*(?:\?|@)`)
)

func clientLogs() object {
	// Read retained procd output even when the Calabi process has stopped.
	// No browser inputs are passed to logread. Match the exact source again
	// while parsing its output so other services never reach the browser.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/sbin/logread", "-l", "1000", "-e", "^calabi")
	// logread's ctime prefix has no offset. Render it in UTC in this process
	// so historical entries remain unambiguous across router timezone changes.
	cmd.Env = append(os.Environ(), "TZ=UTC0")
	out, err := cmd.Output()
	if err != nil {
		return failure(503, "logs_unavailable")
	}
	return success(200, object{"lines": projectClientLogs(string(out))})
}

func projectClientLogs(out string) []object {
	lines := []object{}
	byteBudget := 32 << 10
	for len(out) > 0 && len(lines) < 200 {
		end := strings.LastIndexByte(strings.TrimSuffix(out, "\n"), '\n') + 1
		match := clientLogLine.FindStringSubmatch(strings.TrimSuffix(out[end:], "\n"))
		out = out[:end]
		if match == nil {
			continue
		}
		timestamp, err := time.Parse(time.ANSIC, match[1])
		if err != nil {
			continue
		}
		level := match[2]
		switch level {
		case "notice":
			level = "info"
		case "err", "crit", "alert", "emerg":
			level = "error"
		}
		message := match[3]
		if structured := clientLogLevel.FindStringSubmatch(message); structured != nil {
			if loggedAt, err := time.Parse(time.RFC3339Nano, structured[1]); err == nil {
				timestamp = loggedAt
			}
			level = strings.ToLower(structured[2])
			message = message[len(structured[0]):]
		}
		sensitive := logCredentials.MatchString(message)
		if decoded, err := url.QueryUnescape(message); err == nil && decoded != message {
			sensitive = sensitive || logCredentials.MatchString(decoded)
		}
		if sensitive {
			message = "[redacted]"
		}
		byteBudget -= len(message)
		if byteBudget < 0 {
			break
		}
		lines = append(lines, object{"time": timestamp.UTC().Format(time.RFC3339), "level": level, "message": message})
	}
	// The UI reads oldest to newest and can follow the bottom of the pane.
	for left, right := 0, len(lines)-1; left < right; left, right = left+1, right-1 {
		lines[left], lines[right] = lines[right], lines[left]
	}
	return lines
}

func command(path string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, path, args...).Output()
}

func packageVersions() object {
	installed, err := command("/bin/opkg", "list-installed")
	if err != nil {
		return failure(503, "package_versions_unavailable")
	}
	upgradable, err := command("/bin/opkg", "list-upgradable")
	if err != nil {
		return failure(503, "package_versions_unavailable")
	}
	packages := object{"calabi": object{}, "luci-app-calabi": object{}}
	for _, list := range []struct {
		out []byte
		key string
		n   int
	}{
		{installed, "installed", 2},
		{upgradable, "available", 3},
	} {
		for _, line := range strings.Split(string(list.out), "\n") {
			fields := strings.Split(strings.TrimSpace(line), " - ")
			if len(fields) == list.n {
				if pkg := asObject(packages[fields[0]]); pkg != nil {
					pkg[list.key] = fields[list.n-1]
				}
			}
		}
	}
	return success(200, packages)
}

func firewallStatus() object {
	current, _ := command("/sbin/uci", "-q", "get", "calabi.firewall.network")
	out, err := command("/bin/ubus", "call", "network.interface", "dump")
	var netifd object
	if err != nil || json.Unmarshal(out, &netifd) != nil {
		return failure(503, "network_unavailable")
	}
	_, nftErr := command("/usr/sbin/nft", "list", "set", "inet", "fw4", "calabi_published_v4")
	return success(200, object{"selected": strings.Fields(string(current)), "networks": rows(netifd["interface"], "interface", "up", "l3_device"),
		"fw4_available": nftErr == nil})
}

func saveFirewall(data object) object {
	vals, ok := data["networks"].([]any)
	if !ok || len(vals) > 32 {
		return failure(400, "bad_input")
	}
	names := make([]string, 0, len(vals))
	for _, v := range vals {
		name, ok := v.(string)
		if !ok || !networkPattern.MatchString(name) || name == "loopback" {
			return failure(400, "bad_input")
		}
		names = append(names, name)
	}
	sort.Strings(names)
	tmp, err := os.MkdirTemp(runDir, "uci-")
	if err != nil {
		return failure(503, "save")
	}
	defer os.RemoveAll(tmp)
	stage := filepath.Join(tmp, "stage")
	if os.Mkdir(stage, 0700) != nil {
		return failure(503, "save")
	}
	if _, err = command("/sbin/uci", "-q", "-t", stage, "get", "calabi.firewall"); err != nil {
		return failure(503, "save")
	}
	_, _ = command("/sbin/uci", "-q", "-t", stage, "delete", "calabi.firewall.network")
	for _, name := range names {
		if _, err = command("/sbin/uci", "-q", "-t", stage, "add_list", "calabi.firewall.network="+name); err != nil {
			return failure(503, "save")
		}
	}
	if _, err = command("/sbin/uci", "-q", "-t", stage, "commit", "calabi"); err != nil {
		return failure(503, "save")
	}
	return firewallStatus()
}

func project(op string, d object) object {
	switch op {
	case "health":
		return pick(d, "version", "connected", "state", "server_addr")
	case "identity":
		return object{"mode": d["mode"], "can_join": d["can_join"], "can_leave": d["can_leave"], "reason": d["reason"],
			"mesh": pick(asObject(d["mesh"]), "server", "state", "trust", "cert_presented", "cert_pinned"),
			"edge": pick(asObject(d["edge"]), "server", "state", "connected")}
	case "platform_identity":
		return pick(d, "configured", "managed", "org_id", "change")
	case "account":
		return object{"org": pick(asObject(d["org"]), "id", "name"), "scopes": d["scopes"],
			"plan":     pick(asObject(d["plan"]), "code", "max_tunnels"),
			"features": pick(parseObject(asObject(d["plan"])["features_json"]), "ip_policy", "basic_auth", "rate_limit", "header_rewrite", "oauth", "tcp", "udp")}
	case "overview_snapshot":
		out := pick(d, "client_version", "server_addr", "server_ip", "base_domain", "session_id", "client_id", "fingerprint", "device_id",
			"edge_node_id", "preferred_region", "connected", "lifecycle", "started_at", "http_port", "https_port")
		tunnels := rows(d["tunnels"], "tunnel_id", "pending", "proxy_id", "bytes_in", "bytes_out")
		for _, tunnel := range tunnels {
			if id, ok := tunnel["tunnel_id"].(json.Number); ok {
				tunnel["tunnel_id"] = id.String()
			}
		}
		out["tunnels"] = tunnels
		return out
	case "overview_devices":
		items, _ := d["items"].([]any)
		return object{"count": len(items)}
	case "overview_mesh":
		out := pick(d, "enabled", "up", "paused", "overlay", "name", "relay", "derp_home", "relay_rtt_micros")
		out["peers"] = rows(d["peers"], "public_key", "rx_bytes", "tx_bytes")
		return out
	case "usage_today", "usage_month":
		return pick(d, "scope", "bytes_total", "platform_bytes_total", "self_hosted_bytes_total",
			"platform_relay_bytes_total", "self_hosted_relay_bytes_total", "limit_mb", "percent_of_limit")
	case "usage_daily":
		return object{"buckets": rows(d["buckets"], "ts", "bytes_total", "self_hosted_bytes_total",
			"relay_bytes_out", "self_hosted_relay_bytes_out")}
	case "usage_mesh":
		return object{"today": pick(asObject(d["today"]), "relay"), "month": pick(asObject(d["month"]), "relay"),
			"daily": rows(d["daily"], "date", "relay")}
	case "mesh":
		out := pick(d, "enabled", "up", "paused", "overlay", "name", "netmap_seen", "published_routes", "unaliased_routes", "org_id", "enrollment_error")
		out["aliases"] = rows(d["subnet_aliases"], "real", "alias")
		out["peers"] = rows(d["peers"], "name", "overlay", "os", "path", "allowed_ips", "rx_bytes", "tx_bytes",
			"rtt_micros", "relay_rtt_micros")
		return out
	case "mesh_nodes":
		nodes := rows(d["items"], "overlay", "online", "owner_email")
		for _, node := range nodes {
			email, _ := node["owner_email"].(string)
			alias, _, _ := strings.Cut(email, "@")
			delete(node, "owner_email")
			if alias != "" {
				node["owner"] = alias
			}
		}
		return object{"items": nodes}
	case "routes", "routes_save":
		return pick(d, "routes", "alias_hosts", "accept_routes", "route_excludes", "block_incoming", "advertise_exit_node", "exit_node", "alias_supported", "forwarding_supported")
	case "mesh_services", "mesh_services_save":
		return object{"items": rows(d["items"], "name", "proto", "port", "target", "note", "approved", "health_checked", "target_ok", "mesh_ok")}
	case "edges":
		return object{"items": rows(d["items"], "edge_node_id", "region", "name", "base_domain", "public_addr", "healthy", "owned", "tls_passthrough"),
			"owned_total": d["owned_total"]}
	case "domains":
		return object{"items": rows(d["items"], "name", "domain", "status", "in_use", "cert_id", "cert_name")}
	case "org_security":
		return pick(d, "require_protection", "require_bare_port_protection", "default_ip_policy")
	case "ip_policies", "oauth_policies":
		return object{"items": rows(d["items"], "name", "provider", "allow", "deny")}
	case "edge_affinity", "edge_affinity_save":
		return pick(d, "affinity", "prefer_platform")
	case "endpoints":
		items := []object{}
		list, _ := d["items"].([]any)
		for _, item := range list {
			items = append(items, endpoint(asObject(item)))
		}
		out := pick(d, "total", "team_total", "my_total", "my_device_id")
		if id, ok := out["my_device_id"].(json.Number); ok {
			out["my_device_id"] = id.String()
		}
		out["items"] = items
		return out
	case "endpoint", "endpoint_state", "endpoint_edit", "endpoint_create", "endpoint_takeover":
		return endpoint(d)
	case "probe":
		return pick(d, "healthy", "latency_ms", "reason")
	case "endpoint_health":
		return object{"enabled": d["enabled"], "items": rows(d["items"], "proxy_id", "healthy", "checked_at", "reason", "latency_ms")}
	default:
		return pick(d, "switching")
	}
}

func success(status int, data object) object {
	return object{"ok": true, "status": status, "data": data}
}

func failure(status int, code string) object {
	return object{"ok": false, "status": status, "code": code}
}

var pinPattern = regexp.MustCompile(`^sha256:[[:xdigit:]]{64}$`)

func apiFailure(status int, raw object) object {
	code, _ := raw["code"].(string)
	switch code {
	case "bad_input", "endpoint_not_local", "bad_link", "joined", "untrusted", "pin_mismatch", "no_tls", "key_refused", "disabled", "full", "unreachable",
		"configured", "switching", "key_unverified", "client_offline", "platform_config", "identity_unmanaged", "save", "network_forced":
	default:
		code = "request_failed"
	}
	out := failure(status, code)
	if pin, ok := raw["pin"].(string); ok && pinPattern.MatchString(pin) {
		out["pin"] = pin
	}
	return out
}
