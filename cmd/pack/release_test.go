package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func releasePackage(t *testing.T) string {
	t.Helper()
	path := os.Getenv("TEST_MCP_PACKAGE")
	if path == "" {
		t.Skip("set TEST_MCP_PACKAGE to the extracted paradev-agent-tools directory")
	}
	path, err := filepath.Abs(path)
	if err != nil {
		t.Fatal(err)
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	return path
}

func runFixture(t *testing.T, cwd string, env []string, command string, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Dir, cmd.Env = cwd, env
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	data, err := cmd.Output()
	if err != nil {
		t.Fatalf("%s %v: %v\n%s\n%s", command, args, err, data, &stderr)
	}
	return strings.TrimSpace(string(data))
}

func fixtureFile(t *testing.T, path, text string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), mode); err != nil {
		t.Fatal(err)
	}
}

func fixtureDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func fixtureEnv(home string) []string {
	return []string{"HOME=" + home, "PATH=" + filepath.Join(home, "bin") + ":/usr/bin:/bin:/usr/sbin:/sbin",
		"GIT_CONFIG_NOSYSTEM=1", "GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.invalid",
		"GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.invalid"}
}

func connectTestMCP(t *testing.T, ctx context.Context, launcher, cwd string, env []string) *mcp.ClientSession {
	t.Helper()
	cmd := exec.CommandContext(ctx, launcher)
	cmd.Dir, cmd.Env, cmd.Stderr = cwd, env, os.Stderr
	client := mcp.NewClient(&mcp.Implementation{Name: "release-test", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.CommandTransport{Command: cmd}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close() })
	if got := session.InitializeResult().ServerInfo.Name; got != "multi-agent-mcp" {
		t.Fatalf("MCP server name: %q", got)
	}
	return session
}

type toolReply map[string]any

func (r toolReply) data() map[string]any {
	value, _ := r["data"].(map[string]any)
	return value
}

func expectField(t *testing.T, value map[string]any, key string, want any) {
	t.Helper()
	if !reflect.DeepEqual(value[key], want) {
		t.Fatalf("%s: got %#v, want %#v (in %#v)", key, value[key], want, value)
	}
}

func callTestMCP(t *testing.T, ctx context.Context, session *mcp.ClientSession, name string, args map[string]any) toolReply {
	t.Helper()
	if args == nil {
		args = map[string]any{}
	}
	res, err := session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	body, ok := res.StructuredContent.(map[string]any)
	if !ok || len(res.Content) == 0 {
		t.Fatalf("%s: missing result: %#v", name, res)
	}
	text, ok := res.Content[0].(*mcp.TextContent)
	var decoded map[string]any
	if !ok || json.Unmarshal([]byte(text.Text), &decoded) != nil || !reflect.DeepEqual(decoded, body) {
		t.Fatalf("%s: text and structured results disagree: %#v", name, res)
	}
	return body
}

type releaseHost struct {
	dir, home, main, slot, origin string
	env                           []string
	git                           func(string, ...string) string
	readState                     func() hostState
	save                          func(hostState)
}

func newReleaseHost(t *testing.T) releaseHost {
	t.Helper()
	dir := fixtureDir(t)
	home, main, slot := filepath.Join(dir, "home"), filepath.Join(dir, "main checkout"), filepath.Join(dir, "slot checkout")
	statePath, origin := filepath.Join(dir, "host.json"), filepath.Join(dir, "origin.git")
	host := filepath.Join(home, "bin", "superset")
	fixtureFile(t, host, "#!/bin/sh\nexec \"$TEST_HOST_BINARY\" --fixture-host \"$@\"\n", 0o700)
	fixtureFile(t, filepath.Join(home, "bin", "ps"), "#!/bin/sh\nexit 0\n", 0o700)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	env := append(fixtureEnv(home), "SUPERSET_BIN="+host, "TEST_HOST_BINARY="+exe, "TEST_HOST_STATE="+statePath,
		"SUPERSET_WORKSPACE_ID=unrelated-inherited-id")
	tracked := filepath.Join(main, "tracked.txt")
	fixtureFile(t, tracked, "first\n", 0o600)
	git := func(cwd string, args ...string) string {
		t.Helper()
		return runFixture(t, cwd, env, "git", args...)
	}
	git(main, "init", "-q", "-b", "main")
	git(main, "add", "tracked.txt")
	git(main, "commit", "-qm", "test base")
	git(main, "clone", "--bare", main, origin)
	git(main, "remote", "add", "origin", origin)
	git(main, "fetch", "origin")
	git(main, "worktree", "add", "--detach", slot, "HEAD")

	readState := func() hostState {
		t.Helper()
		var state hostState
		if err := readTestJSON(statePath, &state); err != nil {
			t.Fatal(err)
		}
		return state
	}
	save := func(state hostState) {
		t.Helper()
		if err := writeTestJSON(statePath, state); err != nil {
			t.Fatal(err)
		}
	}
	save(hostState{Main: main, Slot: slot, Name: "slot-1", Records: []map[string]any{}})
	return releaseHost{dir: dir, home: home, main: main, slot: slot, origin: origin, env: env, git: git, readState: readState, save: save}
}

func TestReleaseMCPChatAndSlot(t *testing.T) {
	pkg := releasePackage(t)
	w := newReleaseHost(t)
	home, main, slot, tracked := w.home, w.main, w.slot, filepath.Join(w.main, "tracked.txt")
	git, readState, save := w.git, w.readState, w.save
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	session := connectTestMCP(t, ctx, filepath.Join(pkg, "launch"), pkg, w.env)
	call := func(name string, args map[string]any) toolReply {
		t.Helper()
		return callTestMCP(t, ctx, session, name, args)
	}

	tools, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, tool := range tools.Tools {
		schema, ok := tool.InputSchema.(map[string]any)
		if seen[tool.Name] || !ok || schema["type"] != "object" || schema["additionalProperties"] != false {
			t.Fatalf("unexpected tool: %#v", tool)
		}
		seen[tool.Name] = true
	}
	if len(seen) != 34 {
		t.Fatalf("tool count: %d", len(seen))
	}
	expectField(t, call("executor_install", map[string]any{"agent": "codex"}).data(), "status", "planned")
	if _, err := os.Stat(filepath.Join(home, ".codex")); !os.IsNotExist(err) {
		t.Fatalf("preview changed the fixture home: %v", err)
	}
	expectField(t, call("executor_install", map[string]any{"agent": "codex", "dryRun": false}).data(), "status", "installed")
	expectField(t, call("status", map[string]any{"cwd": main}).data()["workspace"].(map[string]any), "id", "main-id")
	expectField(t, call("status", map[string]any{"cwd": main, "workspaceId": "slot-id"}), "code", float64(9))

	head := git(main, "rev-parse", "HEAD")
	fixtureFile(t, tracked, "changed\n", 0o600)
	expectField(t, call("commit_plan", map[string]any{"cwd": main, "plan": []any{
		map[string]any{"message": "test", "paths": []string{"tracked.txt"}},
	}}), "code", float64(0))
	if git(main, "rev-parse", "HEAD") != head || git(main, "diff", "--cached", "--name-only") != "" {
		t.Fatal("commit preview changed HEAD or the index")
	}
	fixtureFile(t, tracked, "first\n", 0o600)

	taken := call("slot_take", map[string]any{"cwd": main, "branch": "task-branch", "task": "TASK", "offline": true}).data()
	expectField(t, taken, "workspace", "slot-id")
	prepared := taken["prepare"].(map[string]any)
	create := map[string]any{"cwd": taken["path"], "workspaceId": taken["workspace"],
		"branch": "wrong-branch", "task": prepared["task"], "prompt": "Read project instructions"}
	expectField(t, call("session_create", create), "code", float64(9))
	create["branch"] = prepared["branch"]
	expectField(t, call("session_create", create), "status", "created")
	if !strings.Contains(readState().LaunchPrompt, "Если контекст неясен") ||
		!strings.Contains(readState().LaunchPrompt, "launch' --agent-cli status --json") {
		t.Fatalf("prompt did not use the packaged launcher: %q", readState().LaunchPrompt)
	}
	expectField(t, call("session_create", create), "code", float64(9))
	expectField(t, call("session_last", map[string]any{"workspaceId": "main-id", "sessionId": "session-one"}), "code", float64(6))

	target := func(fields map[string]any) map[string]any {
		fields["workspaceId"], fields["sessionId"] = "slot-id", "session-one"
		return fields
	}
	sent := call("session_send", target(map[string]any{"text": "--help is literal text"}))
	expectField(t, sent, "status", "accepted")
	reply := call("session_wait", target(map[string]any{"after": sent.data()["anchor"], "marker": "DONE", "timeout": 1}))
	expectField(t, reply.data(), "reason", "marker")
	expectField(t, reply.data()["answer"].(map[string]any), "text", "Result [[DONE]]")

	state := readState()
	state.Queued, state.SendTimeout = true, true
	save(state)
	uncertain := call("session_send", target(map[string]any{"text": "Could already be delivered", "timeout": 1}))
	expectField(t, uncertain, "status", "delivery-unknown")
	journal := call("session_journal", target(map[string]any{"after": sent.data()["anchor"]}))
	var delivered []map[string]any
	for _, value := range journal.data()["entries"].([]any) {
		entry := value.(map[string]any)
		if entry["text"] == "Could already be delivered" {
			delivered = append(delivered, entry)
		}
	}
	if len(delivered) != 1 {
		t.Fatalf("expected one delivered prompt, got %#v", journal)
	}
	expectField(t, delivered[0], "queued", true)
	wait := target(map[string]any{"after": delivered[0]["anchor"], "marker": "DONE", "timeout": 1})
	expectField(t, call("session_wait", wait).data(), "reason", "timeout")

	state = readState()
	state.Waiting = true
	save(state)
	expectField(t, call("session_wait", wait).data(), "reason", "waiting")
	expectField(t, call("session_close", target(map[string]any{"cwd": main})), "code", float64(3))
	state = readState()
	state.Waiting, state.Queued, state.SendTimeout = false, false, false
	save(state)
	followUp := call("session_send", target(map[string]any{"text": "Finish the task"}))
	expectField(t, call("session_wait", target(map[string]any{"after": followUp.data()["anchor"], "marker": "DONE"})).data(), "reason", "marker")

	expectField(t, call("session_close", target(map[string]any{"cwd": main, "dryRun": true})).data(), "dryRun", true)
	if !readState().Live {
		t.Fatal("preview closed the fixture chat")
	}
	git(main, "remote", "set-url", "origin", filepath.Join(w.dir, "missing.git"))
	partial := call("session_close", target(map[string]any{"cwd": main})).data()
	expectField(t, partial, "status", "partial")
	expectField(t, partial["close"].(map[string]any), "status", "closed")
	expectField(t, partial["release"].(map[string]any), "status", "unverified")
	git(main, "remote", "set-url", "origin", w.origin)
	completed := call("session_close", map[string]any{"cwd": main, "workspaceId": "slot-id"}).data()
	expectField(t, completed, "status", "completed")
	expectField(t, completed["close"].(map[string]any), "status", "already-closed")
	expectField(t, completed["release"].(map[string]any), "status", "released")
	if readState().Name != "slot-1" || git(slot, "branch", "--show-current") != "" {
		t.Fatal("slot was not parked")
	}
	history := call("session_history", nil).data()
	sessions, ok := history["sessions"].([]any)
	if !ok || len(sessions) == 0 {
		t.Fatalf("missing session history: %#v", history)
	}
	expectField(t, sessions[0].(map[string]any), "status", "closed")
}

func TestReleaseClientArchive(t *testing.T) {
	pkg := releasePackage(t)
	clients := os.Getenv("TEST_MCP_CLIENTS")
	if clients == "" {
		t.Skip("set TEST_MCP_CLIENTS to the extracted client distribution")
	}
	for _, name := range []string{"Install.sh", "Install.command"} {
		path := filepath.Join(filepath.Dir(pkg), name)
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
			t.Fatalf("missing executable installer %s: %v", path, err)
		}
	}
	for _, name := range []string{"runtime", "src", "bin/agent.js"} {
		if _, err := os.Lstat(filepath.Join(pkg, name)); !os.IsNotExist(err) {
			t.Fatalf("unexpected legacy path %s: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(clients, ".agents", "plugins", "marketplace.json")); err != nil {
		t.Fatal(err)
	}
	var plugin, manifest releaseManifest
	if err := readTestJSON(filepath.Join(pkg, "plugin.json"), &plugin); err != nil {
		t.Fatal(err)
	}
	if err := readTestJSON(filepath.Join(clients, "package.json"), &manifest); err != nil {
		t.Fatal(err)
	}
	var npm struct {
		Type    string
		Exports map[string]string
	}
	if err := readTestJSON(filepath.Join(clients, "package.json"), &npm); err != nil {
		t.Fatal(err)
	}
	if manifest.Version != plugin.Version || manifest.Name != "paradev-agent-tools-opencode" || npm.Type != "module" || npm.Exports["."] != "./opencode.js" {
		t.Fatalf("wrong OpenCode manifest: %+v %+v", manifest, npm)
	}
	if _, err := os.Stat(filepath.Join(clients, "opencode.js")); err != nil {
		t.Fatal(err)
	}
	releaseTree := os.DirFS(pkg)
	clientsTree := os.DirFS(filepath.Join(clients, "plugins", name))
	if !reflect.DeepEqual(readReleaseTree(t, releaseTree), readReleaseTree(t, clientsTree)) {
		t.Fatal("the installer and client archives contain different plugin files")
	}
}

func readReleaseTree(t *testing.T, tree fs.FS) map[string][32]byte {
	t.Helper()
	files := map[string][32]byte{}
	err := fs.WalkDir(tree, ".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		file, err := tree.Open(path)
		if err != nil {
			return err
		}
		defer file.Close()
		hash := sha256.New()
		if _, err := io.Copy(hash, file); err != nil {
			return err
		}
		files[path] = [32]byte(hash.Sum(nil))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func TestReleaseCodexRelayForwardsSameTurnWarning(t *testing.T) {
	pkg := releasePackage(t)
	home := fixtureDir(t)
	fake := filepath.Join(home, "codex-fixture")
	fixtureFile(t, fake, `#!/bin/sh
if [ "$1" = --version ]; then printf '%s\n' 'codex-cli 0.170.0'; exit 0; fi
cat
cat <<'EVENTS'
{"method":"hook/completed","params":{"threadId":"native","turnId":"turn","run":{"eventName":"userPromptSubmit","source":"user","statusMessage":"External hook","status":"blocked","entries":[{"kind":"feedback","text":"ignored"}]}}}
{"method":"hook/completed","params":{"threadId":"native","turnId":"turn","run":{"eventName":"userPromptSubmit","source":"user","statusMessage":"agent-cli: проверка рабочего слота","status":"blocked","entries":[{"kind":"feedback","text":"Где продолжить?"}]}}}
{"method":"turn/completed","params":{"turn":{"id":"turn"}}}
EVENTS
`, 0o700)
	relay := filepath.Join(pkg, "bin", runtime.GOOS+"-"+runtime.GOARCH, "codex")
	env := append(fixtureEnv(home), "AGENT_REAL_CODEX="+fake, "SUPERSET_WORKSPACE_ID=workspace", "SUPERSET_TERMINAL_ID=terminal")
	if version := runFixture(t, home, env, relay, "--version"); version != "codex-cli 0.170.0" {
		t.Fatalf("passthrough version: %q", version)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, relay, "app-server", "--stdio")
	cmd.Dir, cmd.Env = home, env
	cmd.Stdin = strings.NewReader("{\"id\":1,\"method\":\"turn/start\"}\n")
	output, err := cmd.Output()
	if err != nil {
		t.Fatalf("relay failed: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	want := []string{"turn/start", "hook/completed", "hook/completed", "warning", "turn/completed"}
	if len(lines) != len(want) {
		t.Fatalf("unexpected relay output: %s", output)
	}
	for i, line := range lines {
		var data map[string]any
		if err := json.Unmarshal([]byte(line), &data); err != nil {
			t.Fatal(err)
		}
		expectField(t, data, "method", want[i])
		if want[i] == "warning" {
			params, _ := data["params"].(map[string]any)
			expectField(t, params, "threadId", "native")
			expectField(t, params, "turnId", "turn")
			expectField(t, params, "message", "Где продолжить?")
		}
	}
}

func TestReleaseSlotTakeExplainsAndReusesAssignedSlot(t *testing.T) {
	pkg := releasePackage(t)
	w := newReleaseHost(t)
	w.git(w.slot, "switch", "-c", "release-branch")
	w.git(w.slot, "commit", "--allow-empty", "-qm", "Release bump")
	head := w.git(w.slot, "rev-parse", "HEAD")
	tree := w.git(w.main, "rev-parse", "HEAD^{tree}")
	distribution := w.git(w.main, "commit-tree", tree, "-m", "Publish release\n\nSource: "+head)
	w.git(w.main, "update-ref", "refs/remotes/origin/distribution", distribution)
	state := w.readState()
	state.Name = "slot-1 · release-task"
	w.save(state)

	launcher := filepath.Join(pkg, "launch")
	args := []string{"slot", "take", "--project", "test project", "--branch", "new-task", "--offline", "--dry-run"}
	cli := fixtureCLIJSON(t, w.main, w.env, launcher, nil, append(args, "--json")...)
	expectField(t, cli, "created", true)
	expectField(t, cli, "slot", "slot-2")
	skipped, ok := cli["skipped"].([]any)
	if !ok || len(skipped) != 1 {
		t.Fatalf("expected one skipped slot: %#v", cli)
	}
	row, _ := skipped[0].(map[string]any)
	expectField(t, row, "workspaceId", "slot-id")
	expectField(t, row, "name", "slot-1 · release-task")
	expectField(t, row, "branch", "release-branch")
	expectField(t, row, "head", head)
	expectField(t, row, "reasons", []any{"assigned", "unmerged"})
	expectField(t, row, "baseRefs", []any{"main", "origin/main"})
	preview, _ := row["reusePreview"].(string)
	if !strings.Contains(preview, "'slot-id' --dry-run --json") {
		t.Fatalf("invalid reuse preview: %q", preview)
	}
	text := runFixture(t, w.main, w.env, launcher, append([]string{"--agent-cli"}, args...)...)
	for _, hint := range []string{"назначен", "не влит", preview} {
		if !strings.Contains(text, hint) {
			t.Fatalf("missing %q in CLI preview: %s", hint, text)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	session := connectTestMCP(t, ctx, launcher, pkg, w.env)
	mcpArgs := map[string]any{"cwd": w.main, "branch": "new-task", "offline": true, "dryRun": true}
	mcpPreview := callTestMCP(t, ctx, session, "slot_take", mcpArgs).data()
	expectField(t, mcpPreview, "skipped", skipped)
	closePreview := callTestMCP(t, ctx, session, "session_close", map[string]any{
		"cwd": w.main, "workspaceId": "slot-id", "dryRun": true,
	}).data()
	expectField(t, closePreview, "release", true)
	if w.readState().Name != state.Name || w.git(w.slot, "rev-parse", "HEAD") != head {
		t.Fatal("preview changed the assigned release slot")
	}
	closed := fixtureCLIJSON(t, w.main, w.env, launcher, nil, "close", "--workspace", "slot-id", "--offline", "--json")
	release, _ := closed["release"].(map[string]any)
	expectField(t, release, "status", "released")
	if w.readState().Name != "slot-1" || w.git(w.slot, "branch", "--show-current") != "" ||
		w.git(w.slot, "status", "--porcelain") != "" || w.git(w.main, "rev-parse", "refs/heads/release-branch") != head {
		t.Fatal("release did not preserve the old branch and park the worktree")
	}
	reused := callTestMCP(t, ctx, session, "slot_take", mcpArgs).data()
	expectField(t, reused, "created", false)
	expectField(t, reused, "workspace", "slot-id")
	expectField(t, reused, "skipped", []any{})
}
