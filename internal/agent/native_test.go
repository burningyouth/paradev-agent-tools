package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func writeFixture(t *testing.T, path, data string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
}

func testGit(t *testing.T, path string, args ...string) string {
	t.Helper()
	env := []string{"GIT_AUTHOR_NAME=Fixture", "GIT_AUTHOR_EMAIL=fixture@example.com",
		"GIT_COMMITTER_NAME=Fixture", "GIT_COMMITTER_EMAIL=fixture@example.com"}
	out, err := runCommand(context.Background(), "git", args, commandOptions{dir: path, env: env})
	if err != nil || out.status != 0 {
		t.Fatalf("git %v: %v %s", args, err, out.stderr)
	}
	return strings.TrimSpace(out.stdout)
}

func fixtureRepo(t *testing.T) string {
	t.Helper()
	root := canonicalPath(t.TempDir())
	testGit(t, root, "init", "-q", "-b", "main")
	writeFixture(t, filepath.Join(root, "owned.txt"), "initial\n")
	writeFixture(t, filepath.Join(root, "foreign.txt"), "initial\n")
	testGit(t, root, "add", "--", "owned.txt", "foreign.txt")
	testGit(t, root, "commit", "-qm", "Initial")
	return root
}

func fixtureParadev(t *testing.T, ws workspace, checkout string, chat bool) paradev {
	t.Helper()
	root := canonicalPath(t.TempDir())
	env := environment{cwd: ws.WorktreePath, home: root, agentHome: filepath.Join(root, ".agent-cli"), get: func(string) string { return "" }}
	cfg := configuration{Superset: "/fake/superset", MaxSessions: 5, SendAcceptTimeoutSec: 20}
	env.run = func(ctx context.Context, command string, args []string, opts commandOptions) (commandOutput, error) {
		key := strings.Join(args[:min(2, len(args))], " ")
		switch command {
		case cfg.Superset:
			var data any
			switch key {
			case "ws list":
				data = []workspace{ws}
			case "ws update":
				index := slices.Index(args, "--name")
				if index < 0 || index+1 == len(args) {
					return commandOutput{}, fmt.Errorf("missing workspace name: %v", args)
				}
				ws.Name, data = args[index+1], map[string]any{}
			case "projects list":
				data = []project{{ID: ws.ProjectID, Name: ws.ProjectName, Path: checkout}}
			case "snapshot --json":
				data = map[string]any{"workspaces": []workspace{}}
			case "sessions list":
				data = []any{}
				if chat {
					data = []map[string]any{{"sessionId": "chat-1", "terminalId": "terminal-1", "harness": "codex",
						"harnessSessionId": "native-1", "status": "idle", "live": true}}
				}
			case "sessions read":
				return commandOutput{stdout: `{"ok":true,"envelopes":[
					{"cursor":{"epoch":"epoch","seq":1},"ts":1750000000000,"event":{"type":"item","item":{"id":"user","kind":"user_message","content":[{"type":"text","text":"do it"}]}}},
					{"cursor":{"epoch":"epoch","seq":2},"ts":1750000001000,"event":{"type":"item","item":{"id":"answer","kind":"agent_message","text":"done [[DONE]]"}}},
					{"cursor":{"epoch":"epoch","seq":3},"ts":1750000002000,"event":{"type":"turn","turn":{"status":"completed"}}}
				]}`}, nil
			default:
				return commandOutput{}, fmt.Errorf("unexpected host command: %v", args)
			}
			json, _ := json.Marshal(data)
			return commandOutput{stdout: string(json)}, nil
		case "ps":
			return commandOutput{}, nil
		case "git":
			return runCommand(ctx, command, args, opts)
		default:
			return commandOutput{}, fmt.Errorf("unexpected command %s %v", command, args)
		}
	}
	return paradev{ctx: context.Background(), env: env, config: cfg}
}

func TestNativeManagedChatChecksExactAssignmentAndParks(t *testing.T) {
	repo := fixtureRepo(t)
	remote := filepath.Join(t.TempDir(), "origin.git")
	testGit(t, repo, "clone", "--bare", repo, remote)
	testGit(t, repo, "remote", "add", "origin", remote)
	testGit(t, repo, "fetch", "origin")
	checkout := filepath.Join(t.TempDir(), "slot")
	testGit(t, repo, "worktree", "add", "--detach", checkout, "HEAD")
	ws := workspace{ID: "slot-id", Name: "slot-2", WorktreePath: checkout, ProjectID: "project-id", ProjectName: "project"}
	host := fixtureParadev(t, ws, repo, true)
	target := chatTarget{Workspace: ws.ID, SessionID: "chat-1", Terminal: "terminal-1", Cwd: checkout}
	call := func(action string, who chatTarget, expected string) {
		t.Helper()
		out, err := host.chatLifecycle(action, who)
		if err != nil || out.data.(map[string]any)["status"] != expected {
			t.Fatalf("%s: got %+v, %v, want %s", action, out.data, err, expected)
		}
	}
	call("reserve", target, "reserved")
	other := target
	other.SessionID = "another-chat"
	call("admit", other, "blocked")
	call("admit", target, "ready")
	if title, err := host.titleChat(ws.ID, target.SessionID, "Проверка слота"); err != nil || title.text != "slot-2 — Проверка слота" {
		t.Fatalf("title: %+v %v", title, err)
	}
	testGit(t, checkout, "switch", "-c", "task-branch")
	if out, err := host.requestTaskCompletion(ws.ID, target.SessionID, true); err != nil || out.data.(map[string]any)["status"] != "planned" {
		t.Fatalf("plan completion: %+v %v", out, err)
	}
	call("completion-pending", target, "unchanged")
	if out, err := host.requestTaskCompletion(ws.ID, target.SessionID, false); err != nil || out.data.(map[string]any)["status"] != "queued" {
		t.Fatalf("request completion: %+v %v", out, err)
	}
	writeFixture(t, filepath.Join(checkout, "dirty"), "keep this")
	call("completion-pending", target, "blocked")
	if err := os.Remove(filepath.Join(checkout, "dirty")); err != nil {
		t.Fatal(err)
	}
	call("park", target, "unchanged")
	if _, err := host.requestTaskCompletion(ws.ID, target.SessionID, false); err != nil {
		t.Fatal(err)
	}
	call("completion-pending", target, "pending")
	call("park", target, "parked")
	call("park", target, "unchanged")
	if branch := testGit(t, checkout, "branch", "--show-current"); branch != "" {
		t.Fatalf("released slot is on %s", branch)
	}
	if testGit(t, checkout, "rev-parse", "task-branch") == "" {
		t.Fatal("the task branch was lost")
	}
}

func TestNativeHookRejectsOldLifecycleBinding(t *testing.T) {
	repo := fixtureRepo(t)
	ws := workspace{ID: "workspace", Name: "Main", WorktreePath: repo, ProjectID: "project", ProjectName: "test"}
	host := fixtureParadev(t, ws, repo, true)
	env := map[string]string{"SUPERSET_WORKSPACE_ID": ws.ID, "SUPERSET_TERMINAL_ID": "terminal-1", "AGENT_HOOK_RUNTIME_PID": "2001"}
	host.env.get = func(key string) string { return env[key] }
	input := hookInput{Event: "SessionStart", SessionID: "native-1", Cwd: repo}
	if out, err := host.sessionHook("session-start", "codex", input); err != nil || out.data.(map[string]any)["status"] != "checkpoint" {
		t.Fatalf("start checkpoint: %+v %v", out, err)
	}
	input.Event, input.LastAssistant = "Stop", "Saved note"
	if out, err := host.sessionHook("stop", "codex", input); err != nil || out.data.(map[string]any)["status"] != "checkpoint" {
		t.Fatalf("stop checkpoint: %+v %v", out, err)
	}
	env["AGENT_HOOK_RUNTIME_PID"] = "2002"
	input.Event = "SessionStart"
	if _, err := host.sessionHook("session-start", "codex", input); err != nil {
		t.Fatal(err)
	}
	env["AGENT_HOOK_RUNTIME_PID"] = "2001"
	input.Event = "SessionEnd"
	if _, err := host.sessionHook("session-end", "codex", input); codeOf(err) != exitCheck {
		t.Fatalf("old SessionEnd should fail closed: %v", err)
	}
}

func TestNativeStatusAndChatJournal(t *testing.T) {
	worktree := fixtureRepo(t)
	writeFixture(t, filepath.Join(worktree, "untracked test.txt"), "new")
	ws := workspace{ID: "slot-id", Name: "slot-2 · TASK", WorktreePath: worktree, ProjectID: "project-id", ProjectName: "project"}
	host := fixtureParadev(t, ws, worktree, true)
	status, err := statusResult(host, ws.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	data := status.data.(map[string]any)
	if data["selection"] != "selected" || data["slot"] != "slot-2" {
		t.Fatalf("wrong workspace or selection: %#v", data)
	}
	git := data["git"].(*gitStatus)
	if got := git.Changes; !reflect.DeepEqual(got, []gitChange{{"??", "untracked test.txt"}}) {
		t.Fatalf("unexpected changes: %v", got)
	}

	journal, err := sessionJournal(host, "chat-1", ws.ID, "chat:chat-1:epoch:1", 1)
	if err != nil {
		t.Fatal(err)
	}
	entries := journal.data.(map[string]any)["entries"].([]map[string]any)
	if len(entries) != 1 || entries[0]["anchor"] != "chat:chat-1:epoch:2" || entries[0]["text"] != "done [[DONE]]" {
		t.Fatalf("unexpected journal: %#v", entries)
	}
	wait, err := sessionWait(host, waitOptions{ref: "chat-1", workspace: ws.ID, after: "chat:chat-1:epoch:1", marker: "DONE",
		timeout: time.Second, interval: time.Millisecond})
	if err != nil || wait.code != 0 || wait.data.(map[string]any)["reason"] != "marker" {
		t.Fatalf("unexpected wait response: %#v %v", wait, err)
	}
	last, err := sessionLast(host, "chat-1", ws.ID)
	if err != nil || last.text != "done [[DONE]]" {
		t.Fatalf("unexpected last response: %#v %v", last, err)
	}
	log, err := sessionLog(host.env, "project", "TASK")
	if err != nil {
		t.Fatal(err)
	}
	sessions := log.data.(map[string]any)["sessions"].([]sessionRecord)
	if len(sessions) != 1 || sessions[0].string("note") != last.text {
		t.Fatalf("wrong durable record: %#v", sessions)
	}
}

func TestNativeCommitOnTemporaryIndex(t *testing.T) {
	root := fixtureRepo(t)
	writeFixture(t, filepath.Join(root, "owned.txt"), "owned changes\n")
	writeFixture(t, filepath.Join(root, "foreign.txt"), "colleague changes\n")
	testGit(t, root, "add", "--", "foreign.txt")
	plan := filepath.Join(t.TempDir(), "plan.json")
	writeFixture(t, plan, `[{"message":"feat: native commit","paths":["owned.txt"]}]`)
	t.Setenv("GIT_AUTHOR_NAME", "Fixture")
	t.Setenv("GIT_AUTHOR_EMAIL", "fixture@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "Fixture")
	t.Setenv("GIT_COMMITTER_EMAIL", "fixture@example.com")
	env := environment{run: runCommand}
	git := gitClient{ctx: context.Background(), env: env, cwd: root}
	before := testGit(t, root, "rev-parse", "HEAD")
	if _, err := commitPlan(git, plan, false); err != nil {
		t.Fatal(err)
	}
	if head := testGit(t, root, "rev-parse", "HEAD"); head != before {
		t.Fatalf("dry run moved HEAD to %s", head)
	}
	if _, err := commitPlan(git, plan, true); err != nil {
		t.Fatal(err)
	}
	if files := testGit(t, root, "show", "--format=", "--name-only", "HEAD"); files != "owned.txt" {
		t.Fatalf("submitted files: %s", files)
	}
	if staged := testGit(t, root, "diff", "--cached", "--name-only"); staged != "foreign.txt" {
		t.Fatalf("staged files: %s", staged)
	}
}

func TestNativeMCPStatusAndInlinePlan(t *testing.T) {
	root := fixtureRepo(t)
	host := fixtureParadev(t, workspace{ID: "ws", Name: "workspace", ProjectName: "repo", WorktreePath: root}, root, false)
	t.Setenv("GIT_AUTHOR_NAME", "Fixture")
	t.Setenv("GIT_AUTHOR_EMAIL", "fixture@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "Fixture")
	t.Setenv("GIT_COMMITTER_EMAIL", "fixture@example.com")
	// Keep tests independent of the developer's configured host.
	host.env.get = func(name string) string {
		if name == "SUPERSET_BIN" {
			return host.config.Superset
		}
		return ""
	}
	writeFixture(t, filepath.Join(root, "owned.txt"), "pending\n")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	serverSide, clientSide := mcp.NewInMemoryTransports()
	server := nativeMCP(host.env)
	serverSession, err := server.Connect(ctx, serverSide, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer serverSession.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "parity", Version: "1"}, nil)
	clientSession, err := client.Connect(ctx, clientSide, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer clientSession.Close()
	tools, err := clientSession.ListTools(ctx, nil)
	if err != nil || !slices.ContainsFunc(tools.Tools, func(tool *mcp.Tool) bool { return tool.Name == "slot_prepare" }) {
		t.Fatalf("tool inventory: %#v %v", tools, err)
	}
	for name, args := range map[string]map[string]any{
		"status": {"cwd": root, "workspaceId": "ws"},
		"commit_plan": {"cwd": root, "plan": []any{
			map[string]any{"message": "feat: inline", "paths": []string{"owned.txt"}},
		}},
	} {
		response, err := clientSession.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
		if err != nil || response.IsError {
			if response != nil && len(response.Content) > 0 {
				if text, ok := response.Content[0].(*mcp.TextContent); ok {
					t.Log(text.Text)
				}
			}
			t.Fatalf("%s: %#v %v", name, response, err)
		}
		body, ok := response.StructuredContent.(map[string]any)
		if !ok || body["code"] != float64(0) {
			t.Fatalf("%s unexpected result: %#v", name, response.StructuredContent)
		}
	}
}

func TestNativeLocalFilesKeepsConflictingVersions(t *testing.T) {
	main, worktree := t.TempDir(), t.TempDir()
	s := slot{workspace: workspace{Name: "slot-1", WorktreePath: worktree}, checkout: main}
	env := environment{agentHome: t.TempDir()}
	file := "rules.md"
	writeFixture(t, filepath.Join(main, file), "# Same\nstart\n")
	writeFixture(t, filepath.Join(worktree, file), "# Same\nstart\n")
	if _, err := syncLocalFiles(env, s, []string{file}, []string{"back"}, true); err != nil {
		t.Fatal(err)
	}
	mainText, slotText := "# Same\nmain edit\n", "# Same\nslot edit\n"
	writeFixture(t, filepath.Join(main, file), mainText)
	writeFixture(t, filepath.Join(worktree, file), slotText+"\n# New\ncopy it\n")
	preview, err := syncLocalFiles(env, s, []string{file}, []string{"back", "forward"}, false)
	if err != nil || len(preview.Conflicts) == 0 {
		t.Fatalf("expected a preview conflict: %#v %v", preview, err)
	}
	if current, _ := os.ReadFile(filepath.Join(main, file)); string(current) != mainText {
		t.Fatalf("preview wrote %q", current)
	}
	applied, err := syncLocalFiles(env, s, []string{file}, []string{"back"}, true)
	if err != nil || applied.Backup == nil || len(applied.Conflicts) != 1 {
		t.Fatalf("expected conflict and backup: %#v %v", applied, err)
	}
	if current, _ := os.ReadFile(filepath.Join(main, file)); !strings.Contains(string(current), "main edit") ||
		!strings.Contains(string(current), "# New") || strings.Contains(string(current), "slot edit") {
		t.Fatalf("dest conflict was overwritten: %q", current)
	}
	if backup, _ := os.ReadFile(*applied.Backup + "/main/" + file); string(backup) != mainText {
		t.Fatalf("wrong backup: %q", backup)
	}
}
