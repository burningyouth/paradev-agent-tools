package agent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestSessionEndReleasesEveryOwnedSlotAndRetriesBlockedSlot(t *testing.T) {
	t.Run("standalone", func(t *testing.T) { testSessionEndSlots(t, false) })
	t.Run("managed-by-host", func(t *testing.T) { testSessionEndSlots(t, true) })
}

func testSessionEndSlots(t *testing.T, hostManaged bool) {
	t.Helper()
	repo := fixtureRepo(t)
	testGit(t, repo, "update-ref", "refs/remotes/origin/main", "HEAD")
	primary := workspace{ID: "main", Name: "project main", ProjectID: "project-id", ProjectName: "project", WorktreePath: repo}
	rows := []workspace{primary}
	for _, name := range []string{"slot-1", "slot-2", "slot-3", "slot-4"} {
		path := filepath.Join(t.TempDir(), name)
		testGit(t, repo, "worktree", "add", "--detach", path, "HEAD")
		rows = append(rows, workspace{ID: name, Name: name, ProjectID: primary.ProjectID, ProjectName: primary.ProjectName, WorktreePath: path})
	}
	host := fixtureParadev(t, primary, repo, false)
	session := liveSession{kind: "chat", agent: "codex", id: "chat-1", nativeID: "native-1", terminal: "terminal-1",
		workspaceID: primary.ID, workspaceName: primary.Name, cwd: repo, project: primary.ProjectName}
	live := true
	run := host.env.run
	host.env.run = func(ctx context.Context, command string, args []string, opts commandOptions) (commandOutput, error) {
		if command != host.config.Superset {
			return run(ctx, command, args, opts)
		}
		var payload any
		switch strings.Join(args[:min(2, len(args))], " ") {
		case "ws list":
			payload = rows
		case "ws update":
			at := slices.Index(args, "--name")
			for i := range rows {
				if rows[i].ID == args[2] {
					rows[i].Name = args[at+1]
				}
			}
			payload = struct{}{}
		case "sessions list":
			at := slices.Index(args, "--workspace")
			chats := []chatSession{}
			if args[at+1] == session.workspaceID && live {
				chats = append(chats, chatSession{SessionID: session.id, TerminalID: &session.terminal,
					HarnessSessionID: &session.nativeID, Harness: session.agent, Status: "idle", Live: true})
			}
			payload = chats
		case "notifications show":
			payload = struct{}{}
		default:
			return run(ctx, command, args, opts)
		}
		raw, err := json.Marshal(payload)
		return commandOutput{stdout: string(raw)}, err
	}
	for i := 1; i <= 3; i++ {
		if _, err := host.prepareSlot(rows[i].ID, slotOptions{branch: "task/" + rows[i].ID, offline: true,
			ownerWorkspace: session.workspaceID, ownerSession: session.id}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := host.prepareSlot(rows[4].ID, slotOptions{branch: "task/other", offline: true}); err != nil {
		t.Fatal(err)
	}
	blocker := filepath.Join(rows[1].WorktreePath, "uncommitted")
	writeFixture(t, blocker, "preserve")
	testGit(t, rows[3].WorktreePath, "switch", "-c", "task/changed")
	record, err := host.saveLiveSession(session, "observed", "summary", "", nil, time.Now(), true)
	if err != nil {
		t.Fatal(err)
	}
	live = false
	path := filepath.Join(host.env.agentHome, "end-jobs", "test.json")
	job := workerJob{Operation: "session-end", Target: workerIdentity(session), Session: record, HostManaged: hostManaged,
		Hook:  &hookTarget{Workspace: session.workspaceID, Terminal: session.terminal, NativeID: session.nativeID, Agent: session.agent},
		Close: map[string]any{"status": "pending"}, Release: map[string]any{"status": "not-applicable"}}
	out, err := host.runSessionEnd(path, &job)
	if err != nil || out.code == exitOK || job.Status != "blocked" || job.Close["status"] != "closed" {
		t.Fatalf("expected partial completion: %+v %v", job, err)
	}
	statuses := map[string]string{}
	for _, slot := range job.AdditionalSlots {
		statuses[slot.Workspace] = slot.Status
	}
	if len(statuses) != 3 || statuses["slot-1"] != "blocked" || statuses["slot-2"] != "released" || statuses["slot-3"] != "blocked" {
		t.Fatalf("release results: %+v", job.AdditionalSlots)
	}
	if rows[2].Name != "slot-2" || testGit(t, rows[2].WorktreePath, "branch", "--show-current") != "" {
		t.Fatalf("released slot was not reset: %+v", rows[2])
	}
	for i, branch := range map[int]string{1: "task/slot-1", 3: "task/changed", 4: "task/other"} {
		if got := testGit(t, rows[i].WorktreePath, "branch", "--show-current"); got != branch {
			t.Fatalf("slot %d branch = %s, want %s", i, got, branch)
		}
	}
	if data, err := os.ReadFile(blocker); err != nil || string(data) != "preserve" {
		t.Fatalf("uncommitted file changed: %q %v", data, err)
	}
	if err := os.Remove(blocker); err != nil {
		t.Fatal(err)
	}
	testGit(t, rows[3].WorktreePath, "switch", "task/slot-3")
	retry, err := host.closeCommand(session.id, closeOptions{Workspace: primary.ID, exact: true})
	if err != nil || len(retry.data.(sessionRecord)["additionalSlots"].([]slotReleaseOutcome)) != 2 {
		t.Fatalf("retry did not release the two remaining slots: %+v %v", retry, err)
	}
	for _, i := range []int{1, 3} {
		if rows[i].Name != rows[i].ID || testGit(t, rows[i].WorktreePath, "branch", "--show-current") != "" {
			t.Fatalf("retried slot was not reset: %+v", rows[i])
		}
	}
}
