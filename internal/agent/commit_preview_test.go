package agent

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestCommitPreviewKeepsSharedWorktreeObjectsUnchanged(t *testing.T) {
	root := filepath.Join(canonicalPath(t.TempDir()), "repo: with space")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	testGit(t, root, "init", "-q", "-b", "main")
	testGit(t, root, "commit", "--allow-empty", "-qm", "Initial")
	worktree := filepath.Join(t.TempDir(), "slot-1")
	testGit(t, root, "worktree", "add", "-qb", "task", worktree)
	testGit(t, worktree, "config", "commit.gpgSign", "true")
	testGit(t, worktree, "config", "gpg.program", filepath.Join(root, "missing-gpg"))
	writeFixture(t, filepath.Join(worktree, "first.txt"), "first change\n")
	writeFixture(t, filepath.Join(worktree, "second.txt"), "second change\n")
	writeFixture(t, filepath.Join(worktree, "foreign.txt"), "staged elsewhere\n")
	testGit(t, worktree, "add", "--", "foreign.txt")

	plan := filepath.Join(t.TempDir(), "plan.json")
	writeFixture(t, plan, `[
		{"message":"fix: first change","paths":["first.txt"]},
		{"message":"fix: second change","paths":["second.txt"]}
	]`)
	g := gitClient{ctx: context.Background(), env: environment{run: runCommand}, cwd: worktree}
	objects := func() string {
		return testGit(t, root, "cat-file", "--batch-all-objects", "--batch-check=%(objectname)")
	}
	before, head := objects(), testGit(t, worktree, "rev-parse", "HEAD")
	report, err := commitPlan(g, plan, false)
	if err != nil {
		t.Fatal(err)
	}
	steps := report.data.(commitOutcome).Steps
	if len(steps) != 2 || len(steps[1].Files) != 1 || steps[1].Files[0] != "second.txt" {
		t.Fatalf("wrong preview: %+v", steps)
	}
	if objects() != before || testGit(t, worktree, "rev-parse", "HEAD") != head ||
		testGit(t, worktree, "diff", "--cached", "--name-only") != "foreign.txt" {
		t.Fatal("preview changed shared objects, HEAD or the real index")
	}
}
