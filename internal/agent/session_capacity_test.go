package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

func TestCountActivityPrioritizesActiveWorkAndCountsTerminals(t *testing.T) {
	sessions := []liveSession{
		{kind: "cli", terminal: "shared", state: "unknown"},
		{kind: "chat", terminal: "shared", state: "idle"},
		{kind: "cli", terminal: "shared", state: "working"},
		{kind: "chat", terminal: "shared", state: "waiting"},
		{kind: "chat", terminal: "waiting", state: "idle"},
		{kind: "chat", terminal: "waiting", state: "waiting"},
		{kind: "chat", terminal: "idle", state: "idle"},
		{kind: "cli", terminal: "unknown", state: "unknown"},
		{kind: "cli", terminal: "independent", state: "working"},
		{kind: "cli", state: "working"},
	}
	want := sessionActivity{Working: 2, Waiting: 1, Idle: 1, Unknown: 1}
	if got := countActivity(sessions); got != want {
		t.Fatalf("activity = %+v, want %+v", got, want)
	}
	for status, want := range map[string]string{
		"starting": "working", "running": "working", "awaiting_input": "waiting",
		"idle": "idle", "not_loaded": "idle", "offline": "idle", "dead": "idle",
		"": "unknown", "new-provider-state": "unknown",
	} {
		if got := chatActivity(status); got != want {
			t.Errorf("chatActivity(%q) = %q, want %q", status, got, want)
		}
	}
}

func TestSessionCapacityForListCreateAndResume(t *testing.T) {
	repo := fixtureRepo(t)
	ws := workspace{ID: "work", Name: "project main", WorktreePath: repo, ProjectID: "project-id", ProjectName: "project"}
	host := fixtureParadev(t, ws, repo, false)
	// Linux resolves terminal IDs from /proc rather than ps. The fixture
	// process only sleeps, while the simulated ps listing presents it as Codex.
	pid := 10111
	if runtime.GOOS == "linux" {
		child := exec.Command("sleep", "30")
		child.Env = append(os.Environ(), "SUPERSET_TERMINAL_ID=shared", "SUPERSET_WORKSPACE_ID=work")
		if err := child.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_ = child.Process.Kill()
			_ = child.Wait()
		})
		pid = child.Process.Pid
	}

	full, cliWorking, sameNative := false, false, false
	sharedStatus := "idle"
	launches := 0
	journal := filepath.Join(host.env.home, "rollout-capacity.jsonl")
	writeFixture(t, journal, fmt.Sprintf(`{"type":"session_meta","payload":{"id":"native-shared","cwd":%q}}`+"\n"+`{"type":"event_msg","payload":{"type":"turn_started"}}`+"\n", repo))
	run := host.env.run
	host.env.run = func(ctx context.Context, command string, args []string, opts commandOptions) (commandOutput, error) {
		switch {
		case command == "ps" && args[0] == "-axo":
			return commandOutput{stdout: fmt.Sprintf("%d 1 1024 /fake/codex resume\n", pid)}, nil
		case command == "ps" && args[0] == "-E":
			return commandOutput{stdout: "/fake/codex resume SUPERSET_TERMINAL_ID=shared SUPERSET_WORKSPACE_ID=work\n"}, nil
		case command == "ps" && args[0] == "-p" && args[1] == strconv.Itoa(pid):
			return commandOutput{stdout: "/fake/codex resume\n"}, nil
		case command == "lsof":
			if sameNative {
				return commandOutput{stdout: "n" + journal + "\n"}, nil
			}
			return commandOutput{}, nil
		case command == host.config.Superset && args[0] == "snapshot" && cliWorking:
			return commandOutput{stdout: `{"workspaces":[{"id":"work","terminals":[{"id":"shared","agent":{"state":"working"}}]}]}`}, nil
		case command == host.config.Superset && strings.Join(args[:2], " ") == "sessions list":
			statuses := []string{sharedStatus, "starting", "running", "running", "awaiting_input", "idle", "something-new"}
			if full {
				statuses = append(statuses, "running")
			}
			rows := make([]chatSession, 0, len(statuses)+1)
			for i, status := range statuses {
				terminal := fmt.Sprintf("pane-%d", i)
				harness := "codex"
				switch i {
				case 1:
					harness = "opencode-acp"
				case 5:
					harness = "future-acp"
				}
				var native *string
				if i == 0 {
					terminal = "shared"
					if sameNative {
						native = new("native-shared")
					}
				}
				rows = append(rows, chatSession{SessionID: "chat-" + terminal, TerminalID: new(terminal), Harness: harness,
					HarnessSessionID: native, Status: status, Live: true})
			}
			rows = append(rows, chatSession{SessionID: "closed", Harness: "opencode-acp", Status: "idle"})
			data, err := json.Marshal(rows)
			return commandOutput{stdout: string(data)}, err
		case command == host.config.Superset && strings.Join(args[:2], " ") == "sessions create":
			launches++
			return commandOutput{stdout: `{"sessionId":"new-chat","terminalId":"new-pane"}`}, nil
		default:
			return run(ctx, command, args, opts)
		}
	}
	checkList := func(want sessionActivity, rows int) {
		t.Helper()
		list, err := listSessionsResult(host)
		if err != nil {
			t.Fatal(err)
		}
		data := list.data.(map[string]any)
		sessions := data["sessions"].([]map[string]any)
		if data["count"] != want.Working || data["limit"] != 5 || data["activity"] != want || len(sessions) != rows {
			t.Fatalf("list activity = %+v, want %+v and %d rows", data["activity"], want, rows)
		}
		for id, wantAgent := range map[string]string{"chat-pane-1": "opencode-acp", "chat-pane-5": "future-acp"} {
			var gotAgent any
			for _, session := range sessions {
				if session["sessionId"] == id {
					gotAgent = session["agent"]
					break
				}
			}
			if gotAgent != wantAgent {
				t.Errorf("session %s agent = %v, want %s", id, gotAgent, wantAgent)
			}
		}
	}
	checkList(sessionActivity{Working: 3, Waiting: 1, Idle: 2, Unknown: 1}, 8)
	cliWorking = true
	checkList(sessionActivity{Working: 4, Waiting: 1, Idle: 1, Unknown: 1}, 8)
	// A known-native duplicate is collapsed, but its active state must survive.
	sameNative = true
	checkList(sessionActivity{Working: 4, Waiting: 1, Idle: 1, Unknown: 1}, 7)
	sharedStatus = "awaiting_input"
	checkList(sessionActivity{Working: 3, Waiting: 2, Idle: 1, Unknown: 1}, 7)
	sharedStatus, sameNative = "idle", false
	create := launchOptions{workspace: ws.ID, prompt: "fixture", agent: "codex"}
	saved := sessionRecord{"sessionId": "saved-chat", "kind": "chat", "agent": "codex", "workspace": ws.ID}
	if _, err := host.createSession(create); err != nil || launches != 1 {
		t.Fatalf("create must allow the last free terminal: %v, launches %d", err, launches)
	}
	if plan, err := host.resumeSession(saved, resumeOptions{dry: true}); err != nil || plan["status"] != "planned" {
		t.Fatalf("resume must allow the last free terminal: %v, plan %v", err, plan)
	}

	full = true
	checkList(sessionActivity{Working: 5, Waiting: 1, Idle: 1, Unknown: 1}, 9)
	if _, err := host.createSession(create); err == nil || codeOf(err) != exitLimit || launches != 1 {
		t.Fatalf("create must reject five independent terminals: %v, launches %d", err, launches)
	}
	if _, err := host.resumeSession(saved, resumeOptions{dry: true}); err == nil || codeOf(err) != exitLimit {
		t.Fatalf("resume must reject five independent terminals: %v", err)
	}
	if _, err := host.resumeTransport(saved, ws, "codex", "", true, resumeOptions{}); err == nil || codeOf(err) != exitLimit {
		t.Fatalf("resume must recheck capacity immediately before launch: %v", err)
	}
}

func TestCapacityDefaultsAndPersonalOverride(t *testing.T) {
	home := t.TempDir()
	t.Setenv("AGENT_CLI_HOME", home)
	path := filepath.Join(home, "config.json")
	writeFixture(t, path, `{"sendAcceptTimeoutSec":30,"extra":{"keep":true}}`)
	for _, test := range []struct {
		args []string
		want int
		code int
	}{
		{[]string{"get"}, 10, 0},
		{[]string{"set"}, 10, 1},
		{[]string{"set", "5"}, 5, 0},
		{[]string{"get"}, 5, 0},
		{[]string{"set", "0"}, 5, 1},
		{[]string{"set", "1.5"}, 5, 1},
		{[]string{"set", "--", "-3"}, 5, 1},
		{[]string{"set", "x"}, 5, 1},
		{[]string{"reset"}, 10, 0},
		{[]string{"get"}, 10, 0},
	} {
		env, err := getEnvironment()
		if err != nil {
			t.Fatal(err)
		}
		args := append([]string{"config", test.args[0], "maxSessions"}, test.args[1:]...)
		var stdout, stderr strings.Builder
		if code := Main(context.Background(), args, &stdout, &stderr); code != test.code {
			t.Fatalf("%v: exit %d, stdout %q, stderr %q", args, code, &stdout, &stderr)
		}
		host, err := mcpHost(context.Background(), env)
		if err != nil || host.config.MaxSessions != test.want || host.config.SendAcceptTimeoutSec != 30 {
			t.Fatalf("%v: config = %+v, %v", args, host.config, err)
		}
		if test.code == 0 && strings.TrimSpace(stdout.String()) != strconv.Itoa(test.want) {
			t.Fatalf("%v: stdout %q", args, &stdout)
		}
	}
	var fields map[string]json.RawMessage
	if err := readJSON(path, &fields); err != nil || len(fields) != 2 || !strings.Contains(string(fields["extra"]), "true") {
		t.Fatalf("other fields were not preserved or reset did not remove the override: %v %v", fields, err)
	}
}
