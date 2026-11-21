// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bufio"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gofrs/flock"
)

const (
	updateDir        = "/etc/calabi"
	updatePolicyPath = updateDir + "/openwrt-update-policy.json"
	updateStatePath  = updateDir + "/openwrt-update-state.json"
	updateFeedPath   = updateDir + "/openwrt-update-feed"
	updateKeyPath    = updateDir + "/openwrt-update.pub"
)

type updatePolicy struct {
	Mode  string `json:"mode"`
	Start int    `json:"window_start_hour"`
	End   int    `json:"window_end_hour"`
	Defer int    `json:"max_defer_days"`
}

type updateState struct {
	Status    string       `json:"status"`
	Candidate string       `json:"candidate,omitempty"`
	Since     time.Time    `json:"since"`
	Checked   time.Time    `json:"checked"`
	Policy    updatePolicy `json:"policy"`
}

func validUpdatePolicy(p updatePolicy) bool {
	return (p.Mode == "notify" || p.Mode == "security" || p.Mode == "auto") &&
		p.Start >= 0 && p.Start < 24 && p.End >= 0 && p.End < 24 && p.Defer >= 0 && p.Defer <= 90
}

func loadUpdatePolicy() updatePolicy {
	var policy updatePolicy
	if b, err := os.ReadFile(updatePolicyPath); err == nil && json.Unmarshal(b, &policy) == nil && validUpdatePolicy(policy) {
		return policy
	}
	return updatePolicy{Mode: "notify", Start: 3, End: 5, Defer: 7}
}

func loadUpdateState() updateState {
	var state updateState
	if data, err := os.ReadFile(updateStatePath); err == nil {
		_ = json.Unmarshal(data, &state)
	}
	return state
}

func saveUpdateJSON(path string, value any) error {
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".update-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, writeErr := file.Write(b)
	if err := errors.Join(writeErr, file.Close()); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}

func updateFeed() (*url.URL, bool) {
	text, err := os.ReadFile(updateFeedPath)
	if err != nil {
		return nil, false
	}
	base, err := url.Parse(strings.TrimSpace(string(text)))
	if err != nil || base.Hostname() == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" ||
		(base.Scheme != "https" && !(base.Scheme == "http" && base.Hostname() == "127.0.0.1")) {
		return nil, false
	}
	fi, err := os.Lstat(updateKeyPath)
	return base, err == nil && fi.Mode().IsRegular()
}

func updatePolicyStatus() object {
	_, ready := updateFeed()
	zone, _ := command("/bin/date", "+%Z")
	st := loadUpdateState()
	return success(200, object{"policy": loadUpdatePolicy(), "feed_ready": ready, "status": st.Status,
		"candidate": st.Candidate, "checked": st.Checked, "timezone": strings.TrimSpace(string(zone))})
}

func setUpdatePolicy(data object) object {
	b, err := json.Marshal(data)
	var p updatePolicy
	if err != nil || len(data) != 4 || data["mode"] == nil || data["window_start_hour"] == nil ||
		data["window_end_hour"] == nil || data["max_defer_days"] == nil ||
		json.Unmarshal(b, &p) != nil || !validUpdatePolicy(p) {
		return failure(400, "bad_input")
	}
	if err := saveUpdateJSON(updatePolicyPath, p); err != nil {
		return failure(500, "save")
	}
	return updatePolicyStatus()
}

func withinUpdateWindow(p updatePolicy, hour int) bool {
	if p.Start == p.End {
		return true
	}
	if hour < 0 {
		return false
	}
	if p.Start < p.End {
		return hour >= p.Start && hour < p.End
	}
	return hour >= p.Start || hour < p.End
}

func updateDecision(p updatePolicy, security bool, now, since time.Time, hour int, busy bool) string {
	if p.Mode == "notify" {
		return "available"
	}
	if security {
		return "installing"
	}
	if p.Mode == "security" {
		return "ordinary_update"
	}
	if p.Defer == 0 || (!since.IsZero() && now.Sub(since) >= time.Duration(p.Defer)*24*time.Hour) {
		return "installing"
	}
	if !withinUpdateWindow(p, hour) {
		return "waiting_window"
	}
	if busy {
		return "waiting_idle"
	}
	return "installing"
}

type feedPackage struct {
	name, version, filename, digest string
	security                        bool
}

var (
	updateVersionPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.~+_:=-]{0,127}$`)
	updateFilenamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.~+_:-]{0,190}\.ipk$`)
)

func parseUpdateFeed(index io.Reader) ([]feedPackage, error) {
	var result []feedPackage
	fields := map[string]string{}
	add := func() error {
		name := fields["Package"]
		if name != "calabi" && name != "luci-app-calabi" {
			return nil
		}
		arch := fields["Architecture"]
		if arch != "x86_64" && arch != "all" {
			return nil
		}
		ver, file, digest := fields["Version"], fields["Filename"], fields["SHA256sum"]
		hash, err := hex.DecodeString(digest)
		if !updateVersionPattern.MatchString(ver) || !updateFilenamePattern.MatchString(file) ||
			!strings.HasPrefix(file, name+"_") || err != nil || len(hash) != sha256.Size {
			return errors.New("invalid Calabi package index entry")
		}
		result = append(result, feedPackage{name, ver, file, strings.ToLower(digest), fields["Security-Update"] == "yes"})
		return nil
	}
	scanner := bufio.NewScanner(index)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if err := add(); err != nil {
				return nil, err
			}
			clear(fields)
			continue
		}
		k, v, ok := strings.Cut(line, ":")
		if ok && k != "" && k[0] != ' ' && k[0] != '\t' {
			fields[k] = strings.TrimSpace(v)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if err := add(); err != nil {
		return nil, err
	}
	return result, nil
}

var updateHTTP = &http.Client{
	Timeout: 45 * time.Second,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 || req.URL.Scheme != via[0].URL.Scheme || req.URL.Host != via[0].URL.Host {
			return errors.New("unexpected feed redirect")
		}
		return nil
	},
}

func downloadUpdateFile(base *url.URL, name, path string, limit int64, digest string) error {
	source := *base
	source.Path = strings.TrimRight(source.Path, "/") + "/" + name
	source.RawPath = ""
	response, err := updateHTTP.Get(source.String())
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return errors.New("feed file unavailable")
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	sum := sha256.New()
	n, copyErr := io.Copy(io.MultiWriter(file, sum), io.LimitReader(response.Body, limit+1))
	if err := errors.Join(copyErr, file.Close()); err != nil {
		return err
	}
	if n > limit || (digest != "" && hex.EncodeToString(sum.Sum(nil)) != digest) {
		return errors.New("feed file integrity check failed")
	}
	return nil
}

func signedUpdateFeed(base *url.URL, dir string) ([]feedPackage, error) {
	gzPath, sig := filepath.Join(dir, "Packages.gz"), filepath.Join(dir, "Packages.sig")
	if err := downloadUpdateFile(base, "Packages.gz", gzPath, 2<<20, ""); err != nil {
		return nil, err
	}
	if err := downloadUpdateFile(base, "Packages.sig", sig, 4096, ""); err != nil {
		return nil, err
	}
	compressed, err := os.Open(gzPath)
	if err != nil {
		return nil, err
	}
	defer compressed.Close()
	gz, err := gzip.NewReader(compressed)
	if err != nil {
		return nil, err
	}
	defer gz.Close()
	data, err := io.ReadAll(io.LimitReader(gz, (4<<20)+1))
	if err != nil || len(data) > 4<<20 {
		return nil, errors.New("feed index too large or invalid")
	}
	index := filepath.Join(dir, "Packages")
	if err := os.WriteFile(index, data, 0600); err != nil {
		return nil, err
	}
	if _, err := command("/usr/bin/usign", "-V", "-p", updateKeyPath, "-m", index, "-x", sig); err != nil {
		return nil, err
	}
	return parseUpdateFeed(strings.NewReader(string(data)))
}

func installedUpdatePackages() (map[string]string, error) {
	out, err := command("/bin/opkg", "list-installed")
	if err != nil {
		return nil, err
	}
	packages := map[string]string{}
	for _, line := range strings.Split(string(out), "\n") {
		name, version, ok := strings.Cut(strings.TrimSpace(line), " - ")
		if ok && (name == "calabi" || name == "luci-app-calabi") && updateVersionPattern.MatchString(version) {
			packages[name] = version
		}
	}
	return packages, nil
}

func newerUpdateVersion(candidate, current string) bool {
	_, err := command("/bin/opkg", "compare-versions", candidate, ">", current)
	return err == nil
}

func updateTraffic() (map[string]int64, bool) {
	cs, client := request("GET", "/tunnels", nil)
	ms, mesh := request("GET", "/v1/mesh", nil)
	if cs != 200 || ms != 200 {
		return nil, false
	}
	byteCount := func(v any) int64 {
		n, _ := strconv.ParseInt(fmt.Sprint(v), 10, 64)
		return n
	}
	counts := map[string]int64{}
	for _, row := range rows(client["tunnels"], "proxy_id", "bytes_in", "bytes_out") {
		counts["t:"+fmt.Sprint(row["proxy_id"])] = byteCount(row["bytes_in"]) + byteCount(row["bytes_out"])
	}
	for _, row := range rows(mesh["peers"], "public_key", "rx_bytes", "tx_bytes") {
		counts["m:"+fmt.Sprint(row["public_key"])] = byteCount(row["rx_bytes"]) + byteCount(row["tx_bytes"])
	}
	return counts, true
}

func updaterBusy() bool {
	before, ok := updateTraffic()
	if !ok {
		return true
	}
	time.Sleep(2 * time.Second)
	after, ok := updateTraffic()
	if !ok {
		return true
	}
	for id, n := range after {
		if n > before[id] {
			return true
		}
	}
	return false
}

func installUpdates(base *url.URL, dir string, selected []feedPackage, policy updatePolicy) error {
	allowed := map[string]bool{}
	args := []string{"install"}
	for _, pkg := range selected {
		target := filepath.Join(dir, pkg.filename)
		if err := downloadUpdateFile(base, pkg.filename, target, 64<<20, pkg.digest); err != nil {
			return err
		}
		allowed[pkg.name] = true
		args = append(args, target)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	preview, err := exec.CommandContext(ctx, "/bin/opkg", append([]string{"--noaction"}, args...)...).CombinedOutput()
	if err != nil {
		return err
	}
	for _, line := range strings.Split(string(preview), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && (fields[0] == "Installing" || fields[0] == "Upgrading" || fields[0] == "Removing" || fields[0] == "Downgrading") {
			if !allowed[fields[1]] || fields[0] == "Removing" || fields[0] == "Downgrading" {
				return errors.New("unexpected opkg changes")
			}
		}
	}
	current, err := installedUpdatePackages()
	if err != nil {
		return err
	}
	for _, pkg := range selected {
		if current[pkg.name] == "" || !newerUpdateVersion(pkg.version, current[pkg.name]) {
			return errors.New("installed packages changed during update")
		}
	}
	if loadUpdatePolicy() != policy {
		return errors.New("update policy changed during download")
	}
	// The native package manager owns the installation lock. Let it finish
	// its transaction instead of killing it partway through a package upgrade.
	if err := exec.Command("/bin/opkg", args...).Run(); err != nil {
		return err
	}
	current, err = installedUpdatePackages()
	if err != nil {
		return err
	}
	for _, pkg := range selected {
		if current[pkg.name] != pkg.version {
			return errors.New("updated version not installed")
		}
	}
	return nil
}

func securityUpdates(packages []feedPackage) []feedPackage {
	var result []feedPackage
	for _, p := range packages {
		if p.security {
			result = append(result, p)
		}
	}
	return result
}

func runUpdateTick() {
	base, ready := updateFeed()
	if !ready {
		return
	}
	lock := flock.New(updateDir + "/openwrt-update.lock")
	locked, err := lock.TryLock()
	if err != nil || !locked {
		return
	}
	defer lock.Close()
	now := time.Now()
	state := loadUpdateState()
	policy := loadUpdatePolicy()
	sinceCheck := now.Sub(state.Checked)
	if policy == state.Policy && sinceCheck >= 0 && sinceCheck < 6*time.Hour &&
		(state.Status == "up_to_date" || state.Status == "available" || state.Status == "ordinary_update" || state.Status == "installed") {
		return
	}
	state.Checked = now.UTC()
	state.Policy = policy
	state.Status = "check_failed"
	defer func() { _ = saveUpdateJSON(updateStatePath, state) }()
	dir, err := os.MkdirTemp("/tmp", "calabi-package-update-")
	if err != nil {
		return
	}
	defer os.RemoveAll(dir)
	feed, err := signedUpdateFeed(base, dir)
	if err != nil {
		return
	}
	installed, err := installedUpdatePackages()
	if err != nil {
		return
	}
	var selected []feedPackage
	sawOrdinary := false
	for _, name := range []string{"calabi", "luci-app-calabi"} {
		if installed[name] == "" {
			continue
		}
		var best feedPackage
		for _, pkg := range feed {
			if pkg.name != name || !newerUpdateVersion(pkg.version, installed[name]) {
				continue
			}
			if policy.Mode == "security" && !pkg.security {
				sawOrdinary = true
				continue
			}
			if best.version == "" || newerUpdateVersion(pkg.version, best.version) {
				best = pkg
			}
		}
		if best.version != "" {
			selected = append(selected, best)
		}
	}
	if len(selected) == 0 {
		state.Status = "up_to_date"
		if sawOrdinary {
			state.Status = "ordinary_update"
		}
		state.Candidate, state.Since = "", time.Time{}
		return
	}
	var versions []string
	for _, pkg := range selected {
		versions = append(versions, pkg.name+" "+pkg.version)
	}
	tag := strings.Join(versions, ", ")
	if tag != state.Candidate || state.Since.IsZero() || state.Since.After(now) {
		state.Candidate, state.Since = tag, now.UTC()
	}
	when, err := command("/bin/date", "+%H")
	hour := -1
	if err == nil {
		hour, _ = strconv.Atoi(strings.TrimSpace(string(when)))
	}
	critical := securityUpdates(selected)
	security := len(critical) != 0
	if policy.Mode != "notify" && security {
		selected = critical
	}
	state.Status = updateDecision(policy, security, now, state.Since, hour, false)
	if state.Status != "installing" {
		return
	}
	if !security && policy.Defer > 0 && now.Sub(state.Since) < time.Duration(policy.Defer)*24*time.Hour && updaterBusy() {
		state.Status = "waiting_idle"
		return
	}
	_ = saveUpdateJSON(updateStatePath, state)
	if err := installUpdates(base, dir, selected, policy); err != nil {
		state.Status = "install_failed"
		return
	}
	state.Status = "installed"
}
