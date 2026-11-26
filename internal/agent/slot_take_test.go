package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func fixtureTakeSlot(t *testing.T) (paradev, workspace) {
	t.Helper()
	repo := fixtureRepo(t)
	remote := filepath.Join(t.TempDir(), "origin.git")
	testGit(t, repo, "clone", "--bare", repo, remote)
	testGit(t, repo, "remote", "add", "origin", remote)
	testGit(t, repo, "fetch", "origin")
	checkout := filepath.Join(canonicalPath(t.TempDir()), "slot-1")
	testGit(t, repo, "worktree", "add", "--detach", checkout, "HEAD")
	ws := workspace{ID: "slot-id", Name: "slot-1", WorktreePath: checkout, ProjectID: "project-id", ProjectName: "project"}
	return fixtureParadev(t, ws, repo, false), ws
}

func TestTakeSlotPreviewDistinguishesBlockers(t *testing.T) {
	for _, tc := range []struct {
		name, want string
		configure  func(*testing.T, *paradev, workspace)
	}{
		{"reservation", "reserved", func(t *testing.T, host *paradev, ws workspace) {
			writeFixture(t, chatSlotPath(host.env, ws.ID), `{"active":{"sessionId":"fixture"}}`)
		}},
		{"dirty", "dirty", func(t *testing.T, _ *paradev, ws workspace) {
			writeFixture(t, filepath.Join(ws.WorktreePath, "untracked.txt"), "pending edits\n")
		}},
		{"git operation", "git_operation", func(t *testing.T, _ *paradev, ws workspace) {
			path := testGit(t, ws.WorktreePath, "rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD")
			writeFixture(t, path, testGit(t, ws.WorktreePath, "rev-parse", "HEAD")+"\n")
		}},
		{"live chat", "live_session", func(t *testing.T, host *paradev, ws workspace) {
			roster := []chatSession{{SessionID: "running-chat", Harness: "codex", Status: "running", Live: true}}
			slotTestRoster(host, &roster)
		}},
		{"native process", "native_process", func(t *testing.T, host *paradev, ws workspace) {
			journal := filepath.Join(host.env.home, "rollout-fixture.jsonl")
			writeFixture(t, journal, fmt.Sprintf(`{"type":"session_meta","payload":{"id":"native","cwd":%q,"source":"cli"}}`, ws.WorktreePath)+"\n")
			base := host.env.run
			host.env.run = func(ctx context.Context, command string, args []string, opts commandOptions) (commandOutput, error) {
				switch {
				case command == "ps" && len(args) != 0 && args[0] == "-axo":
					return commandOutput{stdout: "2147483647 1 10 /fixture/codex app-server\n"}, nil
				case command == "lsof":
					return commandOutput{stdout: "n" + journal + "\n"}, nil
				}
				return base(ctx, command, args, opts)
			}
		}},
		{"locked during prepare", "locked", func(t *testing.T, host *paradev, ws workspace) {
			writeFixture(t, slotStatePath(host.env, ws.WorktreePath)+".lock", "held by fixture")
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			host, ws := fixtureTakeSlot(t)
			tc.configure(t, &host, ws)
			before := testGit(t, ws.WorktreePath, "rev-parse", "HEAD")
			preview, err := host.takeSlot(slotOptions{project: ws.ProjectName, branch: "next", dry: true, offline: true})
			if err != nil {
				t.Fatal(err)
			}
			data := preview.data.(map[string]any)
			skipped := data["skipped"].([]skippedSlot)
			if data["created"] != true || data["slot"] != "slot-2" || len(skipped) != 1 ||
				!slices.Equal(skipped[0].Reasons, []string{tc.want}) || skipped[0].ReusePreview != "" {
				t.Fatalf("unexpected preview: %#v", data)
			}
			if after := testGit(t, ws.WorktreePath, "rev-parse", "HEAD"); before != after {
				t.Fatalf("preview moved HEAD from %s to %s", before, after)
			}
		})
	}
}

func TestTakeSlotApplyRechecksAfterPreview(t *testing.T) {
	host, ws := fixtureTakeSlot(t)
	opts := slotOptions{project: ws.ProjectName, branch: "next", dry: true, offline: true, existingOnly: true}
	preview, err := host.takeSlot(opts)
	if err != nil {
		t.Fatal(err)
	}
	if data := preview.data.(map[string]any); data["created"] != false || data["workspace"] != ws.ID ||
		len(data["skipped"].([]skippedSlot)) != 0 {
		t.Fatalf("expected an available slot: %#v", data)
	}
	dirty := filepath.Join(ws.WorktreePath, "new-local-file.txt")
	base := host.env.run
	host.env.run = func(ctx context.Context, command string, args []string, opts commandOptions) (commandOutput, error) {
		if command == host.config.Superset && len(args) >= 2 && args[0] == "sessions" && args[1] == "list" {
			if _, err := os.Stat(slotStatePath(host.env, ws.WorktreePath) + ".lock"); err == nil {
				writeFixture(t, dirty, "arrived during prepare")
			}
		}
		return base(ctx, command, args, opts)
	}
	opts.dry = false
	applied, err := host.takeSlot(opts)
	if err != nil || applied.code != exitWaiting {
		t.Fatalf("expected no reusable slot: %#v %v", applied, err)
	}
	if data := applied.data.(map[string]any); data["status"] != "confirmation_required" {
		t.Fatalf("expected explicit creation confirmation: %#v", data)
	}
	if branch := testGit(t, ws.WorktreePath, "branch", "--show-current"); branch != "" {
		t.Fatalf("concurrent change allowed checkout of %s", branch)
	}
	if data, err := os.ReadFile(dirty); err != nil || string(data) != "arrived during prepare" {
		t.Fatalf("concurrent edit: %q %v", data, err)
	}
}

func slotTestRoster(host *paradev, roster *[]chatSession) {
	run := host.env.run
	host.env.run = func(ctx context.Context, command string, args []string, opts commandOptions) (commandOutput, error) {
		if command == host.config.Superset && slices.Equal(args[:min(2, len(args))], []string{"sessions", "list"}) {
			data, err := json.Marshal(*roster)
			return commandOutput{stdout: string(data)}, err
		}
		return run(ctx, command, args, opts)
	}
}

func TestTakeSlotWithIdleChatFencesOldAdmission(t *testing.T) {
	host, ws := fixtureTakeSlot(t)
	old := chatTarget{Workspace: ws.ID, SessionID: "old-chat", Terminal: "old-pane", Cwd: ws.WorktreePath}
	next := chatTarget{Workspace: ws.ID, SessionID: "new-chat", Terminal: "new-pane", Cwd: ws.WorktreePath}
	roster := []chatSession{{SessionID: old.SessionID, TerminalID: &old.Terminal, Harness: "codex", Status: "idle", Live: true}}
	slotTestRoster(&host, &roster)
	initial := testGit(t, ws.WorktreePath, "rev-parse", "HEAD")
	testGit(t, ws.WorktreePath, "switch", "-c", "old-merged")
	run := host.env.run
	raced := false
	host.env.run = func(ctx context.Context, command string, args []string, opts commandOptions) (commandOutput, error) {
		if command == "git" && args[0] == "switch" && !raced {
			raced = true
			admission, err := host.chatLifecycle("admit", old)
			if err != nil || admission.data.(map[string]any)["status"] != "blocked" ||
				!strings.Contains(admission.data.(map[string]any)["question"].(string), "Блокировка") {
				t.Fatalf("old chat won the checkout race: %v, %v", admission.data, err)
			}
		}
		return run(ctx, command, args, opts)
	}
	taken, err := host.takeSlot(slotOptions{project: ws.ProjectName, branch: "next", existingOnly: true, offline: true})
	if err != nil || taken.code != exitOK || !raced || taken.data.(map[string]any)["workspace"] != ws.ID {
		t.Fatalf("idle chat prevented reuse: %+v %v", taken, err)
	}
	if branch := testGit(t, ws.WorktreePath, "branch", "--show-current"); branch != "next" {
		t.Fatalf("got branch %q", branch)
	}
	if before := testGit(t, ws.WorktreePath, "rev-parse", "refs/heads/old-merged"); before != initial {
		t.Fatalf("old branch changed from %s to %s", initial, before)
	}
	for _, action := range []string{"reserve", "admit"} {
		output, err := host.chatLifecycle(action, old)
		if err != nil || output.data.(map[string]any)["status"] != "blocked" {
			t.Fatalf("old chat %s: %v %v", action, output.data, err)
		}
	}
	oldHook := hookTarget{Workspace: ws.ID, Terminal: old.Terminal, Agent: "codex", NativeID: "old-native", RuntimePID: "1234"}
	if _, err := host.promptSlot(hookInput{Cwd: ws.WorktreePath}, oldHook); err == nil || !strings.Contains(err.Error(), "назначен заново") {
		t.Fatalf("fallback hook did not fence the old chat: %v", err)
	}

	prepared, err := host.findSlot(ws.ID, ws.ProjectName)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := host.checkPreparedSlot(prepared, launchOptions{branch: "next"}); err != nil {
		t.Fatalf("prepared slot rejected a new launch: %v", err)
	}
	owner, err := host.ownership(prepared)
	if err != nil || owner.Generation == "" {
		t.Fatalf("missing generation: %+v, %v", owner, err)
	}
	roster = append(roster, chatSession{SessionID: next.SessionID, TerminalID: &next.Terminal, Harness: "codex", Status: "starting", Live: true})
	session := liveSession{kind: "chat", agent: "codex", id: next.SessionID, terminal: next.Terminal, workspaceID: ws.ID,
		workspaceName: prepared.Name, project: ws.ProjectName, cwd: ws.WorktreePath}
	startup := sessionRecord{"workspace": ws.ID, "path": owner.Path, "slotName": owner.Name, "branch": owner.Branch, "generation": owner.Generation}
	if _, err := host.saveLiveSession(session, "created", "", "", sessionRecord{"startup": startup}, time.Now(), true); err != nil {
		t.Fatal(err)
	}
	if output, err := host.chatLifecycle("admit", next); err != nil || output.data.(map[string]any)["status"] != "ready" {
		t.Fatalf("new chat was not admitted to its branch: %v %v", output.data, err)
	}
	newHook := hookTarget{Workspace: ws.ID, Terminal: next.Terminal, Agent: "codex", NativeID: "new-native", RuntimePID: "1235"}
	if admitted, err := host.promptSlot(hookInput{Cwd: ws.WorktreePath}, newHook); err != nil || admitted == nil {
		t.Fatalf("fallback hook did not admit the new chat: %v %v", admitted, err)
	}
	if err := host.advanceSlot(prepared); err != nil {
		t.Fatal(err)
	}
	if output, err := host.chatLifecycle("admit", next); err != nil || output.data.(map[string]any)["status"] != "blocked" {
		t.Fatalf("previous generation admitted on the same branch and label: %v %v", output.data, err)
	}
	environment := map[string]string{"SUPERSET_WORKSPACE_ID": ws.ID, "SUPERSET_TERMINAL_ID": next.Terminal}
	host.env.get = func(key string) string { return environment[key] }
	output, err := host.sessionHook("user-prompt-submit", "codex", hookInput{
		Event: "UserPromptSubmit", Cwd: ws.WorktreePath, SessionID: "new-native",
	})
	if err != nil || output.runtimeOutput["decision"] != "block" {
		t.Fatalf("managed Codex hook admitted the previous generation: %v %v", output.runtimeOutput, err)
	}
}

func TestIdleChatDoesNotOverrideCheckoutOrAssignmentProtection(t *testing.T) {
	for _, tc := range []struct {
		name, reason string
		setup        func(*testing.T, paradev, workspace)
	}{
		{"dirty", "dirty", func(t *testing.T, _ paradev, ws workspace) {
			writeFixture(t, filepath.Join(ws.WorktreePath, "unsaved"), "preserve these edits")
		}},
		{"unmerged", "unmerged", func(t *testing.T, _ paradev, ws workspace) {
			testGit(t, ws.WorktreePath, "switch", "-c", "unfinished")
			testGit(t, ws.WorktreePath, "commit", "--allow-empty", "-m", "Work not merged")
		}},
		{"reserved", "reserved", func(t *testing.T, p paradev, ws workspace) {
			writeFixture(t, chatSlotPath(p.env, ws.ID), `{"active":{"sessionId":"idle"}}`)
		}},
		{"holder", "reserved", func(t *testing.T, p paradev, ws workspace) {
			writeFixture(t, slotStatePath(p.env, ws.WorktreePath)+".json", `{"generation":"one","holder":{"sessionId":"owner","workspace":"other"}}`)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			host, ws := fixtureTakeSlot(t)
			roster := []chatSession{{SessionID: "idle", Harness: "codex", Status: "idle", Live: true}}
			slotTestRoster(&host, &roster)
			tc.setup(t, host, ws)
			before := testGit(t, ws.WorktreePath, "status", "--porcelain", "--branch")
			head := testGit(t, ws.WorktreePath, "rev-parse", "HEAD")
			preview, err := host.takeSlot(slotOptions{project: ws.ProjectName, branch: "next", dry: true, offline: true})
			if err != nil {
				t.Fatal(err)
			}
			reasons := preview.data.(map[string]any)["skipped"].([]skippedSlot)
			if len(reasons) != 1 || !slices.Equal(reasons[0].Reasons, []string{tc.reason}) {
				t.Fatalf("preview did not preserve %s: %v", tc.reason, reasons)
			}
			got, err := host.takeSlot(slotOptions{project: ws.ProjectName, branch: "next", existingOnly: true, offline: true})
			if err != nil || got.code != exitWaiting {
				t.Fatalf("slot bypassed %s: %+v %v", tc.reason, got, err)
			}
			if tc.name == "dirty" {
				content, err := os.ReadFile(filepath.Join(ws.WorktreePath, "unsaved"))
				if err != nil || string(content) != "preserve these edits" {
					t.Fatalf("dirty content was lost: %q %v", content, err)
				}
			}
			if testGit(t, ws.WorktreePath, "status", "--porcelain", "--branch") != before ||
				testGit(t, ws.WorktreePath, "rev-parse", "HEAD") != head {
				t.Fatal("blocked assignment changed worktree or HEAD")
			}
		})
	}
}

func TestTaskSlotRequiresSeparateMatchingWorktree(t *testing.T) {
	host, regular := fixtureTakeSlot(t)
	projects, err := host.projects()
	if err != nil {
		t.Fatal(err)
	}
	repo := projects[0].Path
	arbitrary := regular
	arbitrary.ID, arbitrary.Name, arbitrary.Type = "adopted", "slot-2", "worktree"
	arbitrary.CreatedByUser = json.RawMessage("null")
	arbitrary.WorktreePath = filepath.Join(t.TempDir(), "slot-2")
	testGit(t, repo, "worktree", "add", "--detach", arbitrary.WorktreePath, "HEAD")
	misplaced := regular
	misplaced.ID, misplaced.Name, misplaced.Type = "misplaced", "slot-3", "worktree"
	misplaced.CreatedByUser = json.RawMessage(`"user"`)
	misplaced.WorktreePath = filepath.Join(t.TempDir(), "manual-copy")
	testGit(t, repo, "worktree", "add", "--detach", misplaced.WorktreePath, "HEAD")
	main := workspace{ID: "main", Name: "slot-4", Type: "local", WorktreePath: repo,
		ProjectID: regular.ProjectID, ProjectName: regular.ProjectName}
	testGit(t, repo, "switch", "-c", "task-in-main-workspace")
	base := host.env.run
	host.env.run = func(ctx context.Context, command string, args []string, opts commandOptions) (commandOutput, error) {
		if command == host.config.Superset && slices.Equal(args[:min(2, len(args))], []string{"ws", "list"}) {
			raw, err := json.Marshal([]workspace{arbitrary, misplaced, main, regular})
			return commandOutput{stdout: string(raw)}, err
		}
		return base(ctx, command, args, opts)
	}
	for _, row := range []workspace{arbitrary, misplaced, main, regular} {
		scoped := host
		scoped.env.cwd = row.WorktreePath
		status, err := statusResult(scoped, row.ID, true)
		if err != nil {
			t.Fatal(err)
		}
		var want any
		if row.ID == regular.ID {
			want = "slot-1"
		}
		if got := status.data.(map[string]any)["slot"]; got != want {
			t.Fatalf("status of %s: slot %v, want %v", row.ID, got, want)
		}
		if row.ID != regular.ID {
			if _, err := host.prepareSlot(row.ID, slotOptions{branch: "next", dry: true, offline: true}); codeOf(err) != exitCheck {
				t.Fatalf("slot prepare accepted %s: %v", row.ID, err)
			}
		}
	}
	preview, err := host.takeSlot(slotOptions{project: regular.ProjectName, branch: "next", dry: true, offline: true})
	if err != nil || preview.data.(map[string]any)["workspace"] != regular.ID {
		t.Fatalf("slot take selected a nonstandard copy: %+v, %v", preview.data, err)
	}
}
