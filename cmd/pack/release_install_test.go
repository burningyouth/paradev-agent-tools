package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestReleaseInstallAndStart(t *testing.T) {
	pkg := releasePackage(t)
	home := fixtureDir(t)
	env := fixtureEnv(home)
	body := runFixture(t, home, env, filepath.Join(filepath.Dir(pkg), "Install.sh"), "manual", "--json")
	var installed map[string]any
	if err := json.Unmarshal([]byte(body), &installed); err != nil {
		t.Fatalf("invalid installer response: %v: %s", err, body)
	}
	installedPath := filepath.Join(home, ".codex", "plugins", "paradev-agent-tools")
	expectField(t, installed, "installed", installedPath)
	launch := filepath.Join(installedPath, "launch")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	session := connectTestMCP(t, ctx, launch, home, env)
	loc := callTestMCP(t, ctx, session, "skill_read", map[string]any{"skill": "agent-cleanup"}).data()
	content, ok := loc["instructions"].(string)
	if !ok || !strings.Contains(content, "receipt") {
		t.Fatalf("missing bundled cleanup instructions: %#v", loc)
	}
}

func TestReleaseMigratesLegacyHooks(t *testing.T) {
	pkg := releasePackage(t)
	home := fixtureDir(t)
	env := fixtureEnv(home)
	entry := filepath.Join(filepath.Dir(pkg), "Install.sh")
	installed := filepath.Join(home, ".codex", "plugins", "paradev-agent-tools")
	config := filepath.Join(home, ".config", "kilo", "kilo.jsonc")
	fixtureFile(t, config, "{\n  // keep\n  \"mcp\": {\"other\":{\"type\":\"remote\"}},\n}\n", 0o600)
	fixtureFile(t, filepath.Join(installed, "plugin.json"), `{"name":"paradev-agent-tools","version":"0.1.6"}`, 0o600)
	legacy := filepath.Join(installed, "runtime", "node")
	fixtureFile(t, legacy, "old runtime", 0o700)
	foreign := "'/another/runtime/node' '/another/bin/agent.js' hook stop --agent codex"
	hooks := map[string]string{"codex": filepath.Join(home, ".codex", "hooks.json"), "claude": filepath.Join(home, ".claude", "settings.json")}
	for provider, path := range hooks {
		command := `AGENT_HOOK_RUNTIME_PID="$PPID" '` + legacy + "' '" + filepath.Join(installed, "bin", "agent.js") + "' hook stop --agent " + provider
		fixtureFile(t, path, "", 0o600)
		if err := writeTestJSON(path, map[string]any{"marker": true, "hooks": map[string]any{"Stop": []any{
			map[string]any{"hooks": []any{
				map[string]any{"type": "command", "command": command, "statusMessage": "agent-cli: сохранение состояния"},
				map[string]any{"type": "command", "command": foreign},
			}},
		}}}); err != nil {
			t.Fatal(err)
		}
	}
	personal := filepath.Join(home, ".agents", "skills", "agent-cli", "references", "personal.md")
	fixtureFile(t, personal, "personal rules", 0o600)
	install := func() map[string]any {
		t.Helper()
		body := runFixture(t, home, env, entry, "kilo", "--json")
		var data map[string]any
		if err := json.Unmarshal([]byte(body), &data); err != nil {
			t.Fatal(err)
		}
		expectField(t, data, "installed", installed)
		expectField(t, data, "activated", true)
		return data
	}
	report := install()
	backups, ok := report["backups"].([]any)
	if !ok || len(backups) != 4 {
		t.Fatalf("expected a package backup and three config backups: %#v", report)
	}
	if data, err := os.ReadFile(filepath.Join(backups[0].(string), "runtime", "node")); err != nil || string(data) != "old runtime" {
		t.Fatalf("missing old runtime backup: %q %v", data, err)
	}
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Fatalf("legacy runtime still installed: %v", err)
	}
	for provider, path := range hooks {
		var updated struct {
			Marker bool
			Hooks  map[string][]struct {
				Hooks []struct{ Command string }
			}
		}
		if err := readTestJSON(path, &updated); err != nil {
			t.Fatal(err)
		}
		stop := updated.Hooks["Stop"]
		if !updated.Marker || len(stop) != 1 || len(stop[0].Hooks) != 2 {
			t.Fatalf("hook config changed unexpectedly: %+v", updated)
		}
		want := `AGENT_HOOK_RUNTIME_PID="$PPID" '` + filepath.Join(installed, "launch") + "' --agent-cli hook stop --agent " + provider
		if stop[0].Hooks[0].Command != want || stop[0].Hooks[1].Command != foreign {
			t.Fatalf("wrong migrated commands: %+v", stop)
		}
	}
	expectField(t, install(), "backups", []any{})
	if data, err := os.ReadFile(config); err != nil || !strings.Contains(string(data), "// keep") ||
		!strings.Contains(string(data), "remote") || !strings.Contains(string(data), filepath.Join(installed, "launch")) {
		t.Fatalf("Kilo config: %q %v", data, err)
	}
	if data, err := os.ReadFile(personal); err != nil || string(data) != "personal rules" {
		t.Fatalf("personal rules were modified: %q %v", data, err)
	}

	conflict := filepath.Join(filepath.Dir(config), "kilo.json")
	const content = `{"mcp":{"paradev-agent-tools":{"type":"local","command":["/other/launch"]}}}`
	fixtureFile(t, conflict, content, 0o600)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, entry, "kilo", "--json")
	cmd.Dir, cmd.Env = home, env
	if output, err := cmd.CombinedOutput(); err == nil || !strings.Contains(string(output), "имя MCP-сервера уже занято") {
		t.Fatalf("expected a conflict: %s %v", output, err)
	}
	if data, err := os.ReadFile(conflict); err != nil || string(data) != content {
		t.Fatalf("conflicting config changed: %q %v", data, err)
	}
}

func TestReleaseGitClientInstallUsesDistribution(t *testing.T) {
	pkg := releasePackage(t)
	home := fixtureDir(t)
	env := fixtureEnv(home)
	log := filepath.Join(home, "commands")
	env = append(env, "TEST_LOG="+log)
	for client, app := range map[string]string{
		"codex":    "ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
		"opencode": "OpenCode.app/Contents/Resources/opencode-cli",
	} {
		script := strings.ReplaceAll(`#!/bin/sh
if [ "$1" = --version ]; then printf '%s\n' 2.3.1; exit 0; fi
printf '%s %s\n' "FIXTURE_CLIENT" "$*" >> "$TEST_LOG"
if [ "$TEST_OLD_MARKETPLACE" = yes ]; then
  printf '%s\n' '{"marketplaceName":"paradev-agent-tools","alreadyAdded":true}'
elif [ "$2" = marketplace ]; then
  printf '%s\n' '{"marketplaceName":"burningyouth"}'
fi
`, "FIXTURE_CLIENT", client)
		fixtureFile(t, filepath.Join(home, "bin", client), script, 0o700)
		fixtureFile(t, filepath.Join(home, "Applications", app), script, 0o700)
	}
	launch := filepath.Join(pkg, "launch")
	for _, client := range []string{"codex", "opencode-auto"} {
		report := runFixture(t, home, env, launch, "--install", client, "--json")
		var data map[string]any
		if err := json.Unmarshal([]byte(report), &data); err != nil {
			t.Fatal(err)
		}
		expectField(t, data, "activated", true)
	}
	want := []string{
		"codex plugin marketplace add burningyouth/paradev-agent-tools --ref distribution --json",
		"codex plugin add paradev-agent-tools@burningyouth --json",
		"opencode plugin add git+https://github.com/burningyouth/paradev-agent-tools.git#distribution",
	}
	output, err := os.ReadFile(log)
	if err != nil || !reflect.DeepEqual(strings.Split(strings.TrimSpace(string(output)), "\n"), want) {
		t.Fatalf("wrong Git client commands: %q %v", output, err)
	}
	if _, err := os.Stat(filepath.Join(home, ".agents", "plugins", "marketplace.json")); !os.IsNotExist(err) {
		t.Fatalf("Git install wrote a local catalog: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, launch, "--install", "codex", "--json")
	cmd.Dir, cmd.Env = home, append(env, "TEST_OLD_MARKETPLACE=yes")
	refused, err := cmd.CombinedOutput()
	if err == nil || !strings.Contains(string(refused), "codex plugin marketplace remove paradev-agent-tools") {
		t.Fatalf("legacy marketplace was not reported: %s %v", refused, err)
	}
	output, err = os.ReadFile(log)
	if err != nil || strings.Count(string(output), "codex plugin add ") != 1 {
		t.Fatalf("recognized marketplace conflict was ignored: %q %v", output, err)
	}
}

func TestReleaseLinkedInstallUsesCheckoutUpdates(t *testing.T) {
	pkg := releasePackage(t)
	dir := fixtureDir(t)
	home := filepath.Join(dir, "home")
	env := fixtureEnv(home)
	if err := os.Mkdir(home, 0o700); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(dir, "distribution", "plugins", name)
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.CopyFS(source, os.DirFS(pkg)); err != nil {
		t.Fatal(err)
	}
	repo := filepath.Dir(filepath.Dir(source))
	runFixture(t, repo, env, "git", "init", "-q", "-b", "distribution")
	runFixture(t, repo, env, "git", "add", ".")
	runFixture(t, repo, env, "git", "commit", "-qm", "Packaged release")
	runFixture(t, dir, env, filepath.Join(source, "launch"), "--install", "manual", "--link", "--json")
	installed := filepath.Join(home, ".codex", "plugins", "paradev-agent-tools")
	if target, err := os.Readlink(installed); err != nil || target != source {
		t.Fatalf("installed package does not link to checkout: %q %v", target, err)
	}

	const marker = "Updated release from the linked checkout."
	skill := filepath.Join(source, "skills", "paradev-agent-tools", "SKILL.md")
	f, err := os.OpenFile(skill, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, writeErr := f.WriteString("\n" + marker + "\n")
	closeErr := f.Close()
	if writeErr != nil || closeErr != nil {
		t.Fatalf("write fixture update: %v %v", writeErr, closeErr)
	}
	content, err := os.ReadFile(filepath.Join(installed, "skills", "paradev-agent-tools", "SKILL.md"))
	if err != nil || !strings.Contains(string(content), marker) {
		t.Fatalf("updated skill is missing from the linked installation: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	connectTestMCP(t, ctx, filepath.Join(installed, "launch"), dir, env)
}

func TestReleaseOpenCodeParadevWorkspace(t *testing.T) {
	pkg := releasePackage(t)
	root := fixtureDir(t)
	home := filepath.Join(root, "home")
	profile := filepath.Join(home, ".paradev", "hooks", "opencode")
	project := filepath.Join(root, "project")
	sibling := filepath.Join(root, "sibling")
	env := fixtureEnv(home)
	if err := os.MkdirAll(project, 0o700); err != nil {
		t.Fatal(err)
	}
	runFixture(t, project, env, "git", "init", "-q")
	runFixture(t, project, env, "git", "commit", "--allow-empty", "-qm", "Fixture")
	globalConfig := filepath.Join(home, ".config", "opencode", "opencode.jsonc")
	profileConfig := filepath.Join(profile, "opencode.json")
	target := filepath.Join(project, ".opencode", "opencode.jsonc")
	const unrelated = "{\n  // keep\n  \"mcp\": {\"servers\": {\"other\": {\"type\": \"remote\", \"url\": \"https://example.invalid/mcp\"}}},\n}\n"
	const empty = "{}\n"
	const native = `{"plugins":["git+https://github.com/burningyouth/paradev-agent-tools.git#distribution"]}`
	fixtureFile(t, globalConfig, native, 0o600)
	fixtureFile(t, profileConfig, empty, 0o600)
	fixtureFile(t, target, unrelated, 0o600)
	entry := filepath.Join(pkg, "launch")
	install := func(workspace string) map[string]any {
		t.Helper()
		body := runFixture(t, root, env, entry, "--install", "opencode-paradev", "--workspace", workspace, "--json")
		var report map[string]any
		if err := json.Unmarshal([]byte(body), &report); err != nil {
			t.Fatal(err)
		}
		return report
	}
	read := func(path string) string {
		t.Helper()
		value, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		return string(value)
	}
	assertAbsent := func(path string) {
		t.Helper()
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("unexpected file %s (%v)", path, err)
		}
	}
	report := install(project)
	expectField(t, report, "workspace", project)
	expectField(t, report, "profile", profile)
	expectField(t, report, "config", target)
	expectField(t, report, "status", "configured")
	updated := read(target)
	if !strings.Contains(updated, "// keep") || !strings.Contains(updated, "example.invalid") ||
		strings.Count(updated, `"paradev-agent-tools":`) != 1 {
		t.Fatalf("project settings were lost or duplicated: %s", updated)
	}
	expectField(t, install(project), "status", "already-configured")
	if read(target) != updated || read(globalConfig) != native || read(profileConfig) != empty {
		t.Fatal("repeat install or client/profile settings changed")
	}
	assertAbsent(filepath.Join(home, ".codex"))
	runFixture(t, project, env, "git", "worktree", "add", "--detach", sibling)
	siblingTarget := filepath.Join(sibling, ".opencode", "opencode.jsonc")
	assertAbsent(siblingTarget)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	session := connectTestMCP(t, ctx, report["launcher"].(string), project, env)
	tools, err := session.ListTools(ctx, nil)
	if err != nil || len(tools.Tools) == 0 {
		t.Fatalf("tools/list failed: %v", err)
	}

	// A sibling inherits a shared profile, but not an untracked project file.
	fixtureFile(t, profileConfig, native, 0o600)
	inherited := install(sibling)
	expectField(t, inherited, "status", "already-configured")
	expectField(t, inherited, "config", profileConfig)
	assertAbsent(siblingTarget)
	legacyProfile, err := json.Marshal(map[string]any{"mcp": map[string]any{
		"legacy-alias": map[string]any{"type": "local", "command": []string{entry}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	fixtureFile(t, profileConfig, string(legacyProfile), 0o600)
	expectField(t, install(sibling), "status", "already-configured")
	assertAbsent(siblingTarget)
	fixtureFile(t, profileConfig, empty, 0o600)
	expectField(t, install(sibling), "status", "configured")
	if read(target) != updated {
		t.Fatal("installing the sibling changed the original workspace")
	}

	const conflict = `{"mcp":{"servers":{"paradev-agent-tools":{"type":"remote","url":"https://example.invalid/other"}}}}`
	fixtureFile(t, siblingTarget, conflict, 0o600)
	cmd := exec.CommandContext(ctx, entry, "--install", "opencode-paradev", "--workspace", sibling, "--json")
	cmd.Dir, cmd.Env = root, env
	if output, err := cmd.CombinedOutput(); err == nil || !strings.Contains(string(output), "уже занято") {
		t.Fatalf("conflict was not reported: %s (%v)", output, err)
	}
	if read(siblingTarget) != conflict || read(profileConfig) != empty {
		t.Fatal("conflicting settings were changed")
	}
}
