package main

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestReleasePlatformZIPs(t *testing.T) {
	dir := os.Getenv("TEST_MCP_ZIPS")
	if dir == "" {
		t.Skip("set TEST_MCP_ZIPS to the generated ZIP directory")
	}
	native := runtime.GOOS + "-" + runtime.GOARCH
	for _, platform := range platforms {
		t.Run(platform, func(t *testing.T) {
			archive, err := zip.OpenReader(filepath.Join(dir, name+"-"+platform+".zip"))
			if err != nil {
				t.Fatal(err)
			}
			defer archive.Close()
			dir := fixtureDir(t)
			files := map[string]bool{}
			for _, file := range archive.File {
				rel, isBinary := strings.CutPrefix(file.Name, name+"/bin/")
				if isBinary && !strings.HasPrefix(rel, platform+"/") {
					t.Fatalf("unexpected platform in %s: %s", platform, file.Name)
				}
				files[file.Name] = true
				if platform != native {
					continue
				}
				target := filepath.Join(dir, filepath.FromSlash(file.Name))
				if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
					t.Fatal(err)
				}
				input, err := file.Open()
				if err != nil {
					t.Fatal(err)
				}
				out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_EXCL, file.Mode().Perm())
				if err != nil {
					input.Close()
					t.Fatal(err)
				}
				_, err = io.Copy(out, input)
				if err := errors.Join(err, input.Close(), out.Close()); err != nil {
					t.Fatal(err)
				}
			}
			for _, required := range []string{"Install.sh", name + "/bin/" + platform + "/paradev-agent", name + "/skills/paradev-agent-update/SKILL.md"} {
				if !files[required] {
					t.Errorf("missing %s", required)
				}
			}
			if platform == native {
				testInstalledZIP(t, dir)
			}
		})
	}
}

func testInstalledZIP(t *testing.T, source string) {
	t.Helper()
	home := fixtureDir(t)
	env := fixtureEnv(home)
	body := runFixture(t, home, env, filepath.Join(source, "Install.sh"), "manual", "--json")
	var installed struct{ Installed, Launcher string }
	if err := json.Unmarshal([]byte(body), &installed); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(home, ".local", "share", name)
	if installed.Installed != dir || installed.Launcher != filepath.Join(dir, "launch") {
		t.Fatalf("wrong installation: %+v", installed)
	}

	// The entry survives removal of the installer and serves a new MCP connection.
	if err := os.RemoveAll(source); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	session := connectTestMCP(t, ctx, installed.Launcher, home, env)
	loaded := callTestMCP(t, ctx, session, "plugin_source", map[string]any{}).data()
	version := session.InitializeResult().ServerInfo.Version
	expectField(t, loaded, "source", "zip")
	expectField(t, loaded, "version", version)
	expectField(t, loaded, "active", version)
	expectField(t, loaded, "launcher", installed.Launcher)
	skill := callTestMCP(t, ctx, session, "skill_read", map[string]any{"skill": "paradev-agent-update"}).data()
	if text, ok := skill["instructions"].(string); !ok || !strings.Contains(text, "update apply") {
		t.Fatalf("missing updater workflow: %v", skill)
	}
	runFixture(t, home, env, installed.Launcher, "--agent-cli", "install")
	cli := filepath.Join(home, ".local", "bin", "paradev-agent")
	body = runFixture(t, home, env, cli, "update", "source", "--json")
	var fromCLI map[string]any
	if err := json.Unmarshal([]byte(body), &fromCLI); err != nil {
		t.Fatal(err)
	}
	expectField(t, fromCLI, "source", "zip")
	expectField(t, fromCLI, "version", version)
}
