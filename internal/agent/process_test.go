package agent

import (
	"context"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestAgentProcessesKeepsNativeAgentsAndOnlyListsServersOnRequest(t *testing.T) {
	env := environment{run: func(_ context.Context, command string, args []string, _ commandOptions) (commandOutput, error) {
		if command != "ps" || !slices.Equal(args, []string{"-axo", "pid=,ppid=,rss=,command="}) {
			return commandOutput{}, fmt.Errorf("unexpected process query: %s %v", command, args)
		}
		return commandOutput{stdout: `101 1 10 /usr/bin/node /fixture/codex/bin/codex.js
102 101 20 /fixture/bin/codex
103 102 30 /bin/sh -c claude
104 103 40 /fixture/bin/claude
105 1 50 /fixture/bin/codex app-server
106 1 60 /fixture/bin/codex mcp-server
107 1 70 /usr/bin/node /fixture/codex.js
108 1 80 /usr/bin/node /fixture/unrelated.js
`}, nil
	}}
	get := func(includeServers bool) []agentProcess {
		t.Helper()
		got, err := agentProcesses(context.Background(), env, includeServers)
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	want := []agentProcess{
		{pid: 102, parent: 101, rssKB: 20, agent: "codex"},
		{pid: 104, parent: 103, rssKB: 40, agent: "claude", nested: true},
		{pid: 107, parent: 1, rssKB: 70, agent: "codex", launcher: true},
	}
	if got := get(false); !slices.Equal(got, want) {
		t.Fatalf("interactive agent processes: %+v", got)
	}
	all := get(true)
	var pids []int
	for _, process := range all {
		pids = append(pids, process.pid)
	}
	if !slices.Equal(pids, []int{101, 102, 104, 105, 106, 107}) {
		t.Fatalf("all agent processes: %v", pids)
	}
}

func TestCodexDiscoveryRequiresOneRootRolloutForExactPID(t *testing.T) {
	temp := t.TempDir()
	path := func(name, payload string) string {
		t.Helper()
		file := filepath.Join(temp, "rollout-"+name+".jsonl")
		writeFixture(t, file, `{"type":"session_meta","payload":`+payload+"}\n")
		return file
	}
	one := path("one", `{"id":"first","cwd":"/project","source":"cli"}`)
	two := path("two", `{"id":"second","cwd":"/project","source":"cli"}`)
	sub := path("sub", `{"id":"subagent","cwd":"/project","source":{"subagent":{"thread_spawn":{}}}}`)
	for _, tc := range []struct {
		name, pid, id, journal string
		files                  []string
	}{
		{"first PID", "101", "first", one, []string{one, one, sub}},
		{"second PID in same cwd", "102", "second", two, []string{two}},
		{"ambiguous", "103", "", "", []string{one, two}},
		{"subagent only", "104", "", "", []string{sub}},
		{"missing", "105", "", "", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := environment{run: func(_ context.Context, command string, args []string, _ commandOptions) (commandOutput, error) {
				if command != "lsof" || !slices.Equal(args, []string{"-a", "-p", tc.pid, "-Fn"}) {
					return commandOutput{}, fmt.Errorf("unexpected open files query: %s %v", command, args)
				}
				var stdout strings.Builder
				for _, name := range tc.files {
					fmt.Fprintln(&stdout, "n"+name)
				}
				return commandOutput{stdout: stdout.String()}, nil
			}}
			var pid int
			if _, err := fmt.Sscan(tc.pid, &pid); err != nil {
				t.Fatal(err)
			}
			got, err := nativeSession(context.Background(), env, agentProcess{pid: pid, agent: "codex"})
			if err != nil || got.SessionID != tc.id || got.Journal != tc.journal {
				t.Fatalf("discovery: %+v %v", got, err)
			}
		})
	}
}

func TestCommandTimeoutReturnsStatus124(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := runCommand(ctx, "/bin/sleep", []string{"4"}, commandOptions{timeout: 30 * time.Millisecond})
	if err != nil || out.status != 124 || out.stdout != "" || out.stderr == "" {
		t.Fatalf("wrong command timeout: %+v %v", out, err)
	}
}
