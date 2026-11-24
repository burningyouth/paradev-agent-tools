package agent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"
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
			main := testGit(t, ws.WorktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir")
			*host = fixtureParadev(t, ws, filepath.Dir(main), true)
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
