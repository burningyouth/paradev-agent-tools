package agent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestChatJournalPagination(t *testing.T) {
	for _, cursor := range []string{`"opaque token"`, `{"epoch":"old","seq":9007199254740993}`} {
		t.Run(cursor, func(t *testing.T) {
			for _, cycle := range []bool{false, true} {
				calls := 0
				host := paradev{ctx: context.Background(), config: configuration{Superset: "fixture"}}
				host.env.run = func(_ context.Context, _ string, args []string, _ commandOptions) (commandOutput, error) {
					calls++
					pos := slices.Index(args, "--before")
					if calls == 1 && pos >= 0 {
						t.Fatalf("unexpected initial cursor: %v", args)
					}
					want := strings.Trim(cursor, `"`)
					if calls == 2 && (pos < 0 || args[pos+1] != want) {
						t.Fatalf("cursor lost in argv: %v", args)
					}
					switch {
					case calls == 1:
						return commandOutput{stdout: `{"ok":true,"nextBefore":` + cursor + `,"envelopes":[
{"cursor":{"epoch":"e","seq":3},"event":{"type":"item","item":{"id":"answer","kind":"agent_message","text":"complete"}}},
{"cursor":{"epoch":"e","seq":4},"event":{"type":"turn","turn":{"status":"completed"}}}
]}`}, nil
					case calls == 2 && cycle:
						return commandOutput{stdout: `{"ok":true,"nextBefore":` + cursor + `,"envelopes":[]}`}, nil
					case calls == 2:
						return commandOutput{stdout: `{"ok":true,"envelopes":[
{"cursor":{"epoch":"e","seq":1},"event":{"type":"item","item":{"id":"prompt","kind":"user_message","content":[{"type":"text","text":"work"}]}}},
{"cursor":{"epoch":"e","seq":2},"event":{"type":"item","item":{"id":"answer","kind":"agent_message","text":"partial"}}}
]}`}, nil
					default:
						return commandOutput{}, fmt.Errorf("unexpected pagination request %v", args)
					}
				}
				info, err := host.readChat(liveSession{id: "chat", workspaceID: "ws"}, time.Time{})
				if cycle {
					if err == nil || !strings.Contains(err.Error(), "повтор курсора") {
						t.Fatalf("expected cursor cycle error: %v", err)
					}
					continue
				}
				if err != nil || len(info.records) != 3 || info.state != "idle" {
					t.Fatalf("wrong transcript: %#v %v", info, err)
				}
				if info.records[0].prompt() != "work" || info.records[1].UUID != "chat:chat:e:2" || info.records[1].assistantText() != "complete" {
					t.Fatalf("partial update was not merged at its original anchor: %#v", info.records)
				}
			}
		})
	}
}

func TestCodexJournalAnchorsAndMarker(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rollout.jsonl")
	writeFixture(t, path, `{"type":"session_meta","payload":{"id":"thread"}}
{"type":"event_msg","timestamp":"2026-03-01T12:00:00Z","payload":{"type":"user_message","message":"Review <pasted_content id=\"one\">the patch</pasted_content>"}}
{"type":"response_item","payload":{"type":"function_call_output","output":"[[DONE]]"}}
{"type":"response_item","payload":{"type":"message","role":"assistant","channel":"analysis","content":[{"type":"output_text","text":"[[DONE]]"}]}}
{"type":"event_msg","payload":{"type":"error","will_retry":true}}
{"type":"event_msg","payload":{"type":"agent_message","message":"Ready"}}
{"type":"response_item","payload":{"type":"message","role":"assistant","channel":"final","content":[{"type":"output_text","text":"Ready"}]}}
{"type":"event_msg","payload":{"type":"task_complete"}}
{"type":`)
	records, err := readTranscript(path)
	if err != nil {
		t.Fatal(err)
	}
	accepted := acceptedRecord(records, "Review the patch", time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC))
	if accepted == nil || accepted.UUID != "codex:thread:2" {
		t.Fatalf("wrong prompt anchor: %#v", accepted)
	}
	got := analyzeTranscript(records, 0, "DONE")
	if got.markerFound || !got.turnEnded || got.apiError != "" || got.answer == nil || got.answer.Text != "Ready" || got.answer.UUID != "codex:thread:7" {
		t.Fatalf("wrong analysis: %+v, answer: %+v", got, got.answer)
	}
	answers := 0
	for _, record := range records {
		if record.assistantText() == "Ready" {
			answers++
		}
	}
	if answers != 1 {
		t.Fatalf("duplicate assistant messages: %d", answers)
	}
}

func TestRegistryRecoversCompleteEventsAfterSnapshot(t *testing.T) {
	env := environment{agentHome: t.TempDir()}
	writeFixture(t, filepath.Join(env.agentHome, "sessions.json"), `{"historyVersion":1,"aliases":{"mine":"old"},"keep":["old"],"sessions":[{"id":"fixture","sessionId":"old","agent":"codex"}]}`)
	writeFixture(t, filepath.Join(env.agentHome, "session-log.jsonl"), `{"version":2,"type":"resumed","record":{"id":"fixture","sessionId":"new","terminal":"new-terminal","agent":"codex","resumedFrom":"old","alias":"mine"}}
{"version":3,"type":"checkpoint","record":`)
	reg, events, err := loadRegistry(env)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || reg.HistoryVersion != 2 || len(reg.Sessions) != 1 ||
		reg.Sessions[0].string("sessionId") != "new" || !slices.Contains(reg.Keep, "new") {
		t.Fatalf("history did not recover: %+v (%+v)", reg, events)
	}
}

func TestPatchJSONCPreservesOtherSettingsAndComments(t *testing.T) {
	source := "{\n  // keep this\n  \"mcp\": {\"servers\":{\"other\":{\"type\":\"remote\"}, /* keep this too */}},\n}\n"
	doc, err := parseJSONC(source)
	if err != nil {
		t.Fatal(err)
	}
	patched, err := patchJSONC(source, doc, []string{"mcp", "servers", "agent"}, map[string]any{"command": "/some/launch"})
	if err != nil {
		t.Fatal(err)
	}
	doc, err = parseJSONC(patched)
	if err != nil {
		t.Fatal(err)
	}
	for _, keys := range [][]string{{"mcp", "servers", "other", "type"}, {"mcp", "servers", "agent", "command"}} {
		if doc.get(keys...) == nil {
			t.Fatalf("missing %v in %s", keys, patched)
		}
	}
	if !strings.Contains(patched, "// keep this") || !strings.Contains(patched, "/* keep this too */") {
		t.Fatalf("comments lost:\n%s", patched)
	}
}

func TestCommitKeepsUnselectedHunk(t *testing.T) {
	root := fixtureRepo(t)
	path := filepath.Join(root, "owned.txt")
	base := "first\n" + strings.Repeat("context\n", 15) + "last\n"
	writeFixture(t, path, base)
	testGit(t, root, "add", "owned.txt")
	testGit(t, root, "commit", "-qm", "Base for hunks")
	pending := strings.ReplaceAll(strings.ReplaceAll(base, "first", "head edit"), "last", "tail edit")
	writeFixture(t, path, pending)
	t.Setenv("GIT_AUTHOR_NAME", "Fixture")
	t.Setenv("GIT_AUTHOR_EMAIL", "fixture@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "Fixture")
	t.Setenv("GIT_COMMITTER_EMAIL", "fixture@example.com")
	plan := filepath.Join(t.TempDir(), "plan.json")
	writeFixture(t, plan, `[{"message":"feat: first hunk","hunks":[{"path":"owned.txt","include":[1]}]}]`)
	git := gitClient{ctx: context.Background(), env: environment{run: runCommand}, cwd: root}
	if _, err := commitPlan(git, plan, true); err != nil {
		t.Fatal(err)
	}
	got := testGit(t, root, "show", "HEAD:owned.txt")
	if want := strings.TrimSpace(strings.Replace(base, "first", "head edit", 1)); got != want {
		t.Fatalf("wrong committed content:\n%s", got)
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != pending {
		t.Fatalf("wrong working file: %q %v", data, err)
	}
}

func TestCurrentWorkspaceUsesDeepestCanonicalPath(t *testing.T) {
	root := canonicalPath(t.TempDir())
	deeper := filepath.Join(root, "slot")
	writeFixture(t, filepath.Join(deeper, "subdir", "file"), "")
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(deeper, link); err != nil {
		t.Fatal(err)
	}
	rows := []workspace{{ID: "root", WorktreePath: root}, {ID: "deep", WorktreePath: deeper}}
	env := environment{cwd: filepath.Join(link, "subdir"), get: func(string) string { return "" }}
	current, err := currentWorkspace(env, rows, false)
	if err != nil || current == nil || current.ID != "deep" {
		t.Fatalf("workspace: %+v %v", current, err)
	}
	rows = append(rows, workspace{ID: "duplicate", WorktreePath: link})
	if _, err := currentWorkspace(env, rows, false); err == nil {
		t.Fatal("duplicate canonical worktree must be ambiguous")
	}
}

func TestPromptScreensDistinguishPermissionAndQuestion(t *testing.T) {
	for _, tc := range []struct {
		screen, kind string
		labels       []string
	}{
		{"Previous output\n────────\nWhich one?\n❯ 1. Use A\n  2. Use B\nEnter to select", "question", []string{"Use A", "Use B"}},
		{"Claude needs your permission\n❯ 1. Yes, allow\n  2. No", "permission", []string{"Yes, allow", "No"}},
	} {
		got := parsePromptScreen(tc.screen)
		if got == nil || got.Kind != tc.kind || strings.Contains(got.Text, "Previous output") {
			t.Fatalf("wrong prompt: %+v", got)
		}
		var labels []string
		for _, option := range got.Options.([]map[string]any) {
			labels = append(labels, option["label"].(string))
		}
		if !reflect.DeepEqual(labels, tc.labels) {
			t.Fatalf("options: %v, want %v", labels, tc.labels)
		}
	}
}

func TestDoctorContinuesAfterInvalidConfigAndTimeout(t *testing.T) {
	home := canonicalPath(t.TempDir())
	env := environment{home: home, agentHome: home, get: func(name string) string {
		if name == "SUPERSET_BIN" {
			return "/fixture/superset"
		}
		return ""
	}}
	config := filepath.Join(home, "config.json")
	writeFixture(t, config, "{broken")
	var calls []string
	env.run = func(_ context.Context, command string, _ []string, options commandOptions) (commandOutput, error) {
		calls = append(calls, command)
		if options.timeout != 5*time.Second {
			t.Fatalf("missing timeout for %s", command)
		}
		if command == "lsof" {
			return commandOutput{status: 124}, nil
		}
		return commandOutput{}, nil
	}
	report := doctor(context.Background(), env)
	data := report.data.(doctorData)
	if report.code != exitCheck || data.OK || len(calls) != 4 {
		t.Fatalf("wrong doctor outcome: %+v, calls: %v", data, calls)
	}
	status := map[string]string{}
	for _, check := range data.Checks {
		status[check.Name] = check.Status
	}
	if status["config"] != "missing" || status["lsof"] != "missing" || status["router-codex"] != "warning" {
		t.Fatalf("wrong statuses: %v", status)
	}
	if bytes, err := os.ReadFile(config); err != nil || string(bytes) != "{broken" {
		t.Fatalf("doctor changed config: %q %v", bytes, err)
	}
}

func TestSkillRouterConflictPreflightAndBackup(t *testing.T) {
	home := canonicalPath(t.TempDir())
	env := environment{home: home, agentHome: filepath.Join(home, ".agent-cli"), get: func(string) string { return "" }}
	codex := filepath.Join(home, ".agents", "skills", "agent-cli", "SKILL.md")
	claude := filepath.Join(home, ".claude", "skills", "agent-cli", "SKILL.md")
	personal := filepath.Join(filepath.Dir(claude), "references", "personal.md")
	writeFixture(t, claude, "custom router\n")
	writeFixture(t, personal, "personal\n")
	opts := options{flags: map[string]string{"agent": "all", "dry-run": "true"}}
	preview, err := installRouter(env, opts)
	if err != nil {
		t.Fatal(err)
	}
	items := preview.data.(map[string]any)["items"].([]routerItem)
	if len(items) != 2 || items[0].Action != "create" || items[1].Action != "replace" || fileExists(codex) {
		t.Fatalf("wrong read-only preview: %+v", items)
	}
	delete(opts.flags, "dry-run")
	if _, err := installRouter(env, opts); codeOf(err) != exitCheck || fileExists(codex) {
		t.Fatalf("expected preflight conflict, got %v", err)
	}
	opts.flags["force"] = "true"
	apply, err := installRouter(env, opts)
	if err != nil {
		t.Fatal(err)
	}
	items = apply.data.(map[string]any)["items"].([]routerItem)
	if items[1].Backup == nil {
		t.Fatal("replacement has no backup")
	}
	for path, want := range map[string]string{*items[1].Backup: "custom router\n", personal: "personal\n"} {
		if got, err := os.ReadFile(path); err != nil || string(got) != want {
			t.Fatalf("%s changed: %q %v", path, got, err)
		}
	}
	delete(opts.flags, "force")
	again, err := installRouter(env, opts)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range again.data.(map[string]any)["items"].([]routerItem) {
		if item.Action != "unchanged" || item.Backup != nil {
			t.Fatalf("install was not idempotent: %+v", item)
		}
	}
}

func TestResumeSelectorsKeepProjectsAndOpenSessionsSeparate(t *testing.T) {
	env := environment{agentHome: t.TempDir()}
	writeFixture(t, filepath.Join(env.agentHome, "sessions.json"), `{"sessions":[
{"id":"one","sessionId":"open","project":"P","task":"X","status":"open","lastSeenAt":"2026-02-04"},
{"id":"two","sessionId":"closed","project":"P","task":"X","status":"closed","closedAt":"2026-02-03"},
{"id":"three","sessionId":"other","project":"Q","task":"X","status":"closed","closedAt":"2026-02-05"}
]}`)
	for _, test := range []struct {
		name, ref, want string
		opts            resumeOptions
		code            exitCode
	}{
		{name: "ambiguous task", opts: resumeOptions{launchOptions: launchOptions{task: "X"}}, code: exitCheck},
		{name: "last closed", opts: resumeOptions{lastClosed: true, launchOptions: launchOptions{project: "P"}}, want: "closed"},
		{name: "all open", opts: resumeOptions{allOpen: true}, want: "open"},
		{name: "exact id", ref: "other", opts: resumeOptions{exact: true}, want: "other"},
		{name: "conflicting selectors", ref: "other", opts: resumeOptions{allOpen: true}, code: exitError},
	} {
		t.Run(test.name, func(t *testing.T) {
			rows, err := resumeSelection(env, test.ref, test.opts)
			if test.code != exitOK && (err == nil || codeOf(err) != test.code) ||
				test.code == exitOK && (err != nil || len(rows) != 1 || rows[0].string("sessionId") != test.want) {
				t.Fatalf("selection: %+v %v", rows, err)
			}
		})
	}
}

func TestSlotLockRejectsConcurrentOperationAndAllowsRetry(t *testing.T) {
	host := paradev{env: environment{agentHome: t.TempDir()}}
	slot := canonicalPath(t.TempDir())
	hold, entered := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	go func() {
		_, err := host.withSlotLock("one", slot, func() (result, error) {
			close(entered)
			<-hold
			return result{}, nil
		})
		done <- err
	}()
	select {
	case <-entered:
	case err := <-done:
		t.Fatalf("fixture failed to acquire lock: %v", err)
	}
	ran := false
	action := func() (result, error) { ran = true; return result{}, nil }
	_, err := host.withSlotLock("different-id", slot, action)
	close(hold)
	if wait := <-done; wait != nil {
		t.Fatal(wait)
	}
	if codeOf(err) != exitCheck || ran {
		t.Fatalf("concurrent action ran: %t, error: %v", ran, err)
	}
	if _, err := host.withSlotLock("one", slot, action); err != nil || !ran {
		t.Fatalf("cannot retry after release: %v", err)
	}
}

func TestCleanupProtectsCurrentKeptWaitingAndQuestionSessions(t *testing.T) {
	env := environment{agentHome: t.TempDir(), get: func(key string) string {
		if key == "SUPERSET_TERMINAL_ID" {
			return "current"
		}
		return ""
	}}
	writeFixture(t, filepath.Join(env.agentHome, "sessions.json"), `{"keep":["kept"]}`)
	host := paradev{ctx: context.Background(), env: env}
	rules, err := loadGCRules(host, gcOptions{idle: "30m"})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, state, terminal, text, skip string
		eligible                          bool
	}{
		{name: "current", state: "idle", terminal: "current", skip: "текущая сессия"},
		{name: "kept", state: "idle", skip: "keep"},
		{name: "waiting", state: "waiting", skip: "ждёт"},
		{name: "working", state: "working", skip: "работает"},
		{name: "question", state: "idle", text: "[[DONE]]\nProceed?", skip: "вопрос"},
		{name: "done", state: "idle", text: "Complete [[DONE]]", eligible: true},
		{name: "long idle", state: "idle", text: "Ready", eligible: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "rollout.jsonl")
			writeFixture(t, path, fmt.Sprintf(`{"type":"assistant","message":{"content":%q}}`, tc.text)+"\n")
			older := time.Now().Add(-time.Hour)
			if err := os.Chtimes(path, older, older); err != nil {
				t.Fatal(err)
			}
			session := liveSession{id: tc.name, terminal: tc.terminal, agent: "codex", kind: "cli", state: tc.state, journal: path}
			reason, skipped := host.gcJudge(session, rules)
			if tc.eligible != (reason != "") || !strings.Contains(skipped, tc.skip) {
				t.Fatalf("cleanup decision: reason=%q skip=%q", reason, skipped)
			}
		})
	}
}

func TestSlotPreparePreservesDirtyWorkAndRespectsOfflineBase(t *testing.T) {
	main := fixtureRepo(t)
	remote := filepath.Join(t.TempDir(), "origin.git")
	testGit(t, main, "clone", "--bare", main, remote)
	testGit(t, main, "remote", "add", "origin", remote)
	testGit(t, main, "fetch", "origin")
	worktree := filepath.Join(t.TempDir(), "slot")
	testGit(t, main, "worktree", "add", "--detach", worktree, "HEAD")
	w := workspace{ID: "slot-id", Name: "slot-1", WorktreePath: worktree, ProjectID: "project", ProjectName: "project"}
	host := fixtureParadev(t, w, main, false)
	slot := slot{workspace: w, checkout: main, exists: true}
	file := filepath.Join(worktree, "owned.txt")
	writeFixture(t, file, "pending work\n")
	before := testGit(t, worktree, "rev-parse", "HEAD")
	opts := slotOptions{branch: "task", task: "TASK", offline: true}
	beforeApply := func() error { return nil }
	if _, err := host.prepareCheckout(slot, opts, beforeApply); err == nil {
		t.Fatal("dirty worktree was prepared without carry")
	}
	if testGit(t, worktree, "rev-parse", "HEAD") != before || testGit(t, worktree, "branch", "--show-current") != "" {
		t.Fatal("failed prepare moved HEAD")
	}
	if got, err := os.ReadFile(file); err != nil || string(got) != "pending work\n" {
		t.Fatalf("failed prepare changed edits: %q %v", got, err)
	}
	testGit(t, main, "remote", "set-url", "origin", remote+"-missing")
	opts.offline = false
	if _, err := host.prepareCheckout(slot, opts, beforeApply); err == nil || !strings.Contains(err.Error(), "--offline") {
		t.Fatalf("expected fetch failure: %v", err)
	}
	opts.offline, opts.carry = true, true
	if _, err := host.prepareCheckout(slot, opts, beforeApply); err != nil {
		t.Fatal(err)
	}
	if branch := testGit(t, worktree, "branch", "--show-current"); branch != "task" {
		t.Fatalf("branch: %q", branch)
	}
	if got, err := os.ReadFile(file); err != nil || string(got) != "pending work\n" {
		t.Fatalf("carry lost edits: %q %v", got, err)
	}
}

func TestSlotDependencyStepsUseLockAndRequiredWorkspaceSamples(t *testing.T) {
	main, checkout := t.TempDir(), fixtureRepo(t)
	lock := filepath.Join(checkout, "package-lock.json")
	writeFixture(t, lock, `{"packages":{
"":{},
"node_modules/optional":{"optional":true},
"node_modules/required":{},
"node_modules/second":{},
"libs/x/node_modules/peer":{"peer":true},
"libs/x/node_modules/required":{}
}}`)
	testGit(t, checkout, "add", "package-lock.json")
	writeFixture(t, filepath.Join(checkout, ".husky", "pre-commit"), "")
	slot := slot{workspace: workspace{WorktreePath: checkout}, checkout: main}
	g := gitClient{ctx: context.Background(), env: environment{run: runCommand}, cwd: checkout}
	steps, err := defaultSlotSteps(g, slot)
	if err != nil {
		t.Fatal(err)
	}
	if len(steps) != 3 || !slices.Equal(steps[0].IfSame, []string{"package-lock.json"}) ||
		steps[0].Ready["node_modules"] != "node_modules/required" ||
		steps[0].Ready["libs/x/node_modules"] != "libs/x/node_modules/required" {
		t.Fatalf("wrong clone plan: %+v", steps)
	}
	if steps[1].Run != "npm ci" || steps[1].EnvFromMain["npm_config_userconfig"] != ".npmrc" ||
		len(steps[1].IfMissing) != 2 || steps[2].Run != "npx husky" || !steps[2].IfNoHooks {
		t.Fatalf("wrong install plan: %+v", steps)
	}
}

func TestCommitValidationAndHookFailurePreserveHeadAndIndex(t *testing.T) {
	for _, tc := range []struct {
		name, plan, message string
		setup               func(*testing.T, string)
	}{
		{"unknown field", `[{"message":"feat: edit","paths":["owned.txt"],"extra":true}]`, "неизвестные поля", nil},
		{"forbidden file", `[{"message":"feat: edit","paths":["owned.txt"]}]`, "owned.txt", func(t *testing.T, root string) {
			writeFixture(t, filepath.Join(root, ".agent-cli.json"), `{"commit":{"forbiddenPaths":["owned.txt"]}}`)
		}},
		{"already staged", `[{"message":"feat: edit","paths":["owned.txt"]}]`, "owned.txt", func(t *testing.T, root string) {
			testGit(t, root, "add", "owned.txt")
		}},
		{"hook fails", `[{"message":"feat: edit","paths":["owned.txt"]}]`, "fixture hook refused", func(t *testing.T, root string) {
			path := filepath.Join(root, ".git", "hooks", "pre-commit")
			writeFixture(t, path, "#!/bin/sh\nprintf '%s\\n' 'fixture hook refused' >&2\nexit 1\n")
			if err := os.Chmod(path, 0o700); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := fixtureRepo(t)
			writeFixture(t, filepath.Join(root, "owned.txt"), "pending\n")
			writeFixture(t, filepath.Join(root, "foreign.txt"), "already staged\n")
			testGit(t, root, "add", "foreign.txt")
			testGit(t, root, "config", "user.name", "Fixture")
			testGit(t, root, "config", "user.email", "fixture@example.com")
			testGit(t, root, "config", "core.hooksPath", filepath.Join(root, ".git", "hooks"))
			if tc.setup != nil {
				tc.setup(t, root)
			}
			head, index := testGit(t, root, "rev-parse", "HEAD"), testGit(t, root, "write-tree")
			plan := filepath.Join(t.TempDir(), "plan.json")
			writeFixture(t, plan, tc.plan)
			git := gitClient{ctx: context.Background(), env: environment{run: runCommand}, cwd: root}
			if _, err := commitPlan(git, plan, true); err == nil || !strings.Contains(err.Error(), tc.message) {
				t.Fatalf("expected failure containing %q, got %v", tc.message, err)
			}
			if testGit(t, root, "rev-parse", "HEAD") != head || testGit(t, root, "write-tree") != index {
				t.Fatal("failed commit changed HEAD or the staging area")
			}
		})
	}
}
