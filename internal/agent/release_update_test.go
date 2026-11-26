package agent

import (
	"archive/zip"
	"bytes"
	"cmp"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type releaseTransport func(*http.Request) (*http.Response, error)

func (f releaseTransport) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func TestReleaseVersionAndPlatform(t *testing.T) {
	for _, row := range []struct {
		a, b string
		want int
	}{
		{"0.2.9", "0.2.11", -1}, {"2.0.0", "1.99.99", 1}, {"1.0.0", "1.0.0", 0},
	} {
		if got := compareReleaseVersions(row.a, row.b); cmp.Compare(got, 0) != row.want {
			t.Errorf("compare(%s, %s) = %d", row.a, row.b, got)
		}
	}
	for _, invalid := range []string{"v1.2.3", "1.0.0-rc.1", "1.02.3", "1.2.3/.."} {
		if releaseVersion.MatchString(invalid) {
			t.Fatalf("accepted version %s", invalid)
		}
	}
	for _, osName := range []string{"darwin", "linux", "windows"} {
		for _, arch := range []string{"amd64", "arm64", "386"} {
			got, err := releasePlatform(osName, arch)
			supported := osName != "windows" && arch != "386"
			if supported && (err != nil || got != osName+"-"+arch) || !supported && err == nil {
				t.Errorf("platform %s/%s: %q, %v", osName, arch, got, err)
			}
		}
	}
}

func releaseFixtureFiles(t *testing.T, version string) map[string]string {
	t.Helper()
	platform, err := releasePlatform(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		t.Fatal(err)
	}
	return map[string]string{
		"plugin.json":                         fmt.Sprintf(`{"name":%q,"version":%q}`, productName, version),
		"launch":                              "#!/bin/sh\n",
		"bin/" + platform + "/paradev-agent":  version + " CLI",
		"bin/" + platform + "/codex":          version + " relay",
		"mcp.json":                            "{}",
		"skills/" + productName + "/SKILL.md": version + " MCP skill",
		"skills/" + updateSkill + "/SKILL.md": version + " updater skill",
	}
}

func fixtureReleaseMode(name string) os.FileMode {
	if name == "launch" || strings.HasPrefix(name, "bin/") {
		return 0o755
	}
	return 0o644
}

func syntheticZIP(t *testing.T, version string, extra *zip.FileHeader) []byte {
	t.Helper()
	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	for path, content := range releaseFixtureFiles(t, version) {
		header := &zip.FileHeader{Name: productName + "/" + path}
		header.SetMode(fixtureReleaseMode(path))
		w, err := z.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(w, content); err != nil {
			t.Fatal(err)
		}
	}
	if extra != nil {
		if _, err := z.CreateHeader(extra); err != nil {
			t.Fatal(err)
		}
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func releaseFixture(t *testing.T) (string, string) {
	t.Helper()
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(home, "incoming")
	for rel, content := range releaseFixtureFiles(t, "0.2.5") {
		name := filepath.Join(source, rel)
		if err := os.MkdirAll(filepath.Dir(name), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(name, []byte(content), fixtureReleaseMode(rel)); err != nil {
			t.Fatal(err)
		}
	}
	return managedRoot(environment{home: home}), source
}

func releaseFakeHTTP(t *testing.T, data []byte) (githubRelease, githubAsset, *http.Client, *int) {
	t.Helper()
	platform, _ := releasePlatform(runtime.GOOS, runtime.GOARCH)
	name := productName + "-" + platform + ".zip"
	asset := githubAsset{Name: name, State: "uploaded", URL: releaseWeb + "v0.2.6/" + name, Size: int64(len(data)), Digest: fmt.Sprintf("sha256:%x", sha256.Sum256(data))}
	release := githubRelease{Tag: "v0.2.6", Assets: []githubAsset{asset}}
	downloads := 0
	client := releaseHTTP()
	client.Transport = releaseTransport(func(req *http.Request) (*http.Response, error) {
		body := data
		switch req.URL.String() {
		case releaseAPI + "latest":
			body, _ = json.Marshal(release)
		case asset.URL:
			downloads++
		default:
			t.Fatalf("unexpected HTTP request: %s", req.URL)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(body))}, nil
	})
	return release, asset, client, &downloads
}

func TestManagedReleaseUpgradeAndRollback(t *testing.T) {
	ctx := context.Background()
	root, source := releaseFixture(t)
	if err := prepareReleaseInstall(root, source); err != nil {
		t.Fatal(err)
	}
	state, err := currentRelease(root)
	if err != nil || state.Version != "0.2.5" || state.Previous != "" {
		t.Fatalf("initial state = %+v, %v", state, err)
	}
	launch := filepath.Join(root, "launch")
	runtimePath := filepath.Join(root, "current", "package")
	activeSkill := filepath.Join(runtimePath, "skills", updateSkill, "SKILL.md")
	personal := filepath.Join(root, "personal-limit")
	if err := os.WriteFile(personal, []byte("7"), 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := os.Lstat(launch)
	if err != nil {
		t.Fatal(err)
	}
	archive := syntheticZIP(t, "0.2.6", nil)
	_, asset, client, downloads := releaseFakeHTTP(t, archive)
	info, err := previewRelease(ctx, client, releaseSource{Source: "zip", Version: state.Version})
	if err != nil || info.Latest != "0.2.6" || info.Status != "update-available" || info.Asset != asset.Name || info.Digest != asset.Digest || *downloads != 0 {
		t.Fatalf("unexpected check: %+v, download count %d, %v", info, *downloads, err)
	}
	wrongDigest := "sha256:" + strings.Repeat("1", 64)
	if err := updateRelease(ctx, client, root, state, "0.2.6", wrongDigest); err == nil || *downloads != 0 {
		t.Fatalf("changed approval was not refused before download: %v", err)
	}
	if err := withReleaseLock(root, func() error {
		if err := withReleaseLock(root, func() error { return nil }); err == nil {
			t.Fatal("concurrent update took the lock")
		}
		return updateRelease(ctx, client, root, state, "0.2.6", asset.Digest)
	}); err != nil {
		t.Fatal(err)
	}
	check := func(version, previous string) releaseState {
		t.Helper()
		got, err := currentRelease(root)
		if err != nil || got.Version != version || got.Previous != previous {
			t.Fatalf("state = %+v, %v; expected %s -> %s", got, version, previous, err)
		}
		data, err := os.ReadFile(activeSkill)
		if err != nil || string(data) != version+" updater skill" {
			t.Fatalf("active skill = %q, %v", data, err)
		}
		info, err := os.Stat(launch)
		if err != nil || !os.SameFile(before, info) {
			t.Fatalf("launcher changed: %v", err)
		}
		data, err = os.ReadFile(personal)
		if err != nil || string(data) != "7" {
			t.Fatalf("personal data changed: %q, %v", data, err)
		}
		return got
	}
	state = check("0.2.6", "0.2.5")
	if _, err := os.Stat(filepath.Join(root, "releases", "0.2.5", "launch")); err != nil {
		t.Fatal(err)
	}
	info, err = previewRelease(ctx, client, releaseSource{Source: "zip", Version: state.Version})
	if err != nil || info.Status != "current" {
		t.Fatalf("current check = %+v, %v", info, err)
	}
	if err := rollbackRelease(root, state, "0.2.5"); err != nil {
		t.Fatal(err)
	}
	state = check("0.2.5", "0.2.6")
	if err := updateRelease(ctx, client, root, state, "0.2.6", asset.Digest); err != nil {
		t.Fatal(err)
	}
	check("0.2.6", "0.2.5")
}

func TestManagedReleaseRefusesForeignPathsAndBadAssets(t *testing.T) {
	ctx := context.Background()
	root, source := releaseFixture(t)
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	foreign := filepath.Join(root, "foreign")
	if err := os.WriteFile(foreign, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := prepareReleaseInstall(root, source); err == nil {
		t.Fatal("replaced foreign installation")
	}
	if data, err := os.ReadFile(foreign); err != nil || string(data) != "keep" {
		t.Fatalf("foreign file changed: %q, %v", data, err)
	}
	release, asset, client, _ := releaseFakeHTTP(t, syntheticZIP(t, "0.2.6", nil))
	platform, _ := releasePlatform(runtime.GOOS, runtime.GOARCH)
	for _, uri := range []string{"https://example.invalid/a.zip", strings.Replace(asset.URL, pluginRepo, "other/repo", 1)} {
		release.Assets[0].URL = uri
		if _, err := release.platformAsset(platform); err == nil {
			t.Fatalf("accepted unexpected asset URL %s", uri)
		}
	}
	release.Assets[0] = asset
	asset.Digest = "sha256:" + strings.Repeat("0", 64)
	if err := downloadRelease(ctx, client, asset, filepath.Join(root, "bad.zip")); err == nil {
		t.Fatal("accepted incorrect digest")
	}
	for _, name := range []string{productName + "/../../outside", productName + "/unexpected-link"} {
		header := &zip.FileHeader{Name: name}
		if strings.HasSuffix(name, "-link") {
			header.SetMode(os.ModeSymlink | 0o777)
		}
		archive := filepath.Join(t.TempDir(), "archive.zip")
		if err := os.WriteFile(archive, syntheticZIP(t, "0.2.6", header), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := unpackRelease(archive, filepath.Join(t.TempDir(), "dest")); err == nil {
			t.Fatalf("accepted unsafe ZIP entry %s", name)
		}
	}
	other, _ := url.Parse("https://example.invalid/file.zip")
	expected, _ := url.Parse(asset.URL)
	if err := releaseHTTP().CheckRedirect(&http.Request{URL: other}, []*http.Request{{URL: expected}}); err == nil {
		t.Fatal("accepted unexpected redirect")
	}
}

func TestManagedReleaseFreshMCP(t *testing.T) {
	zipDir, oldBinary := os.Getenv("TEST_MCP_ZIPS"), os.Getenv("TEST_PREVIOUS_MCP_BINARY")
	if zipDir == "" || oldBinary == "" {
		t.Skip("set TEST_MCP_ZIPS and TEST_PREVIOUS_MCP_BINARY to run both packaged MCP versions")
	}
	platform, _ := releasePlatform(runtime.GOOS, runtime.GOARCH)
	archivePath := filepath.Join(zipDir, productName+"-"+platform+".zip")
	archive, err := os.ReadFile(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	root, source := releaseFixture(t)
	if err := os.RemoveAll(source); err != nil {
		t.Fatal(err)
	}
	if err := unpackRelease(archivePath, source); err != nil {
		t.Fatal(err)
	}
	old, err := os.ReadFile(oldBinary)
	if err != nil {
		t.Fatal(err)
	}
	const from, to = "0.2.5", "0.2.6"
	for name, bytes := range map[string][]byte{
		"plugin.json":                        []byte(fmt.Sprintf(`{"name":%q,"version":%q}`, productName, from)),
		"bin/" + platform + "/paradev-agent": old,
	} {
		if err := os.WriteFile(filepath.Join(source, name), bytes, fixtureReleaseMode(name)); err != nil {
			t.Fatal(err)
		}
	}
	if err := prepareReleaseInstall(root, source); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	home := filepath.Dir(source)
	launch := filepath.Join(root, "launch")
	connect := func(version string) *mcp.ClientSession {
		t.Helper()
		cmd := exec.CommandContext(ctx, launch)
		cmd.Dir, cmd.Env = home, []string{"HOME=" + home, "PATH=/usr/bin:/bin"}
		client := mcp.NewClient(&mcp.Implementation{Name: "update-integration", Version: "1"}, nil)
		out, err := client.Connect(ctx, &mcp.CommandTransport{Command: cmd}, nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = out.Close() })
		if got := out.InitializeResult().ServerInfo.Version; got != version {
			t.Fatalf("MCP handshake used %s, expected %s", got, version)
		}
		return out
	}
	check := func(session *mcp.ClientSession, loaded, active string) {
		t.Helper()
		reply, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "plugin_source"})
		if err != nil || reply.IsError {
			t.Fatalf("plugin_source: %+v, %v", reply, err)
		}
		raw := reply.Content[0].(*mcp.TextContent).Text
		var result struct{ Data releaseSource }
		if err := json.Unmarshal([]byte(raw), &result); err != nil {
			t.Fatal(err)
		}
		if data := result.Data; data.Source != "zip" || data.Version != loaded || data.Active != active || data.Launcher != launch {
			t.Fatalf("unexpected loaded source: %+v", data)
		}
	}
	live := connect(from)
	check(live, from, from)
	_, asset, client, _ := releaseFakeHTTP(t, archive)
	if err := updateRelease(ctx, client, root, releaseState{Version: from}, to, asset.Digest); err != nil {
		t.Fatal(err)
	}
	check(live, from, to)
	check(connect(to), to, to)
	cmd := exec.CommandContext(ctx, launch, "--agent-cli", "update", "rollback", to, from)
	cmd.Dir, cmd.Env = home, []string{"HOME=" + home, "PATH=/usr/bin:/bin"}
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("rollback through CLI: %v, %s", err, out)
	}
	check(connect(from), from, from)
}

func TestOpenCodeCatalogSourceRequiresMatchingLockfile(t *testing.T) {
	cache := t.TempDir()
	const npmName = productName + "-opencode"
	pkg := filepath.Join(cache, "node_modules", npmName, "plugins", productName)
	lockPath := filepath.Join(cache, "package-lock.json")
	lock := func(spec, repo string) {
		t.Helper()
		data := fmt.Sprintf(`{"packages":{"":{"dependencies":{%q:%q}},"node_modules/%s":{"version":"0.2.6","resolved":%q}}}`,
			npmName, spec, npmName, repo+"#"+strings.Repeat("a", 40))
		if err := os.WriteFile(lockPath, []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	const repo = "git+ssh://git@github.com/" + pluginRepo + ".git"
	if knownOpenCodePackage(pkg, "0.2.6") {
		t.Fatal("classified a package without catalog metadata")
	}
	lock("github:"+pluginRepo+"#"+pluginBranch, repo)
	if !knownOpenCodePackage(pkg, "0.2.6") || knownOpenCodePackage(pkg, "0.2.5") {
		t.Fatal("did not identify the exact loaded version")
	}
	lock("file:/tmp/local", repo)
	if knownOpenCodePackage(pkg, "0.2.6") {
		t.Fatal("classified a local package as the public catalog")
	}
	lock("github:"+pluginRepo+"#"+pluginBranch, repo+"-fork")
	if knownOpenCodePackage(pkg, "0.2.6") {
		t.Fatal("classified a foreign repository as the public catalog")
	}
}
