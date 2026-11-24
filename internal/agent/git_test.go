package agent

import (
	"context"
	"fmt"
	"slices"
	"testing"
)

func TestWorktreePathsWithAndWithoutNULSupport(t *testing.T) {
	for _, tc := range []struct {
		name    string
		status  int
		output  string
		want    []string
		wantErr bool
	}{
		{"NUL-delimited paths", 0, "worktree /checkout\x00bare\x00\x00worktree /with\nnewline/slot-1\x00detached\x00", []string{"/checkout", "/with\nnewline/slot-1"}, false},
		{"older Git", 129, "worktree /checkout with spaces\nHEAD abc\nbranch refs/heads/main\n\nworktree /gone/slot-2\nHEAD def\ndetached\nprunable missing\n\n", []string{"/checkout with spaces", "/gone/slot-2"}, false},
		{"ambiguous path", 129, "worktree /with\nnewline/slot-1\nHEAD abc\ndetached\n", nil, true},
		{"unrelated Git error", 128, "", nil, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			g := gitClient{ctx: context.Background(), env: environment{run: func(_ context.Context, command string, args []string, _ commandOptions) (commandOutput, error) {
				calls++
				switch {
				case command != "git":
				case slices.Equal(args, []string{"worktree", "list", "--porcelain", "-z"}):
					output := ""
					if tc.status == 0 {
						output = tc.output
					}
					return commandOutput{status: tc.status, stdout: output}, nil
				case tc.status == 129 && slices.Equal(args, []string{"worktree", "list", "--porcelain"}):
					return commandOutput{stdout: tc.output}, nil
				}
				return commandOutput{}, fmt.Errorf("unexpected command %s %v", command, args)
			}}}
			got, err := g.worktreePaths()
			wantCalls := 1
			if tc.status == 129 {
				wantCalls = 2
			}
			if (err != nil) != tc.wantErr || !slices.Equal(got, tc.want) || calls != wantCalls {
				t.Fatalf("worktrees: %v, calls: %d, error: %v", got, calls, err)
			}
		})
	}
}
