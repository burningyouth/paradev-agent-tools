package agent

import (
	"context"
	"encoding/json"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestSlotPrepareFromLiveChat(t *testing.T) {
	for _, tc := range []struct {
		name          string
		configure     func(*testing.T, paradev, workspace, map[string]string, map[string]any, *[]chatSession)
		want          string
		preview       bool
		reservedOwner string
		lateBlocker   string
	}{
		{name: "sole caller"},
		{name: "own reservation", reservedOwner: "chat-1"},
		{name: "preview", preview: true},
		{name: "foreign reservation", reservedOwner: "other", want: "Слот занят"},
		{name: "foreign session", want: "Слот занят", configure: func(_ *testing.T, _ paradev, _ workspace, env map[string]string, _ map[string]any, _ *[]chatSession) {
			env["CODEX_THREAD_ID"] = "other-thread"
		}},
		{name: "explicit holder IDs do not identify an unknown caller", want: "Слот занят", configure: func(_ *testing.T, _ paradev, ws workspace, env map[string]string, args map[string]any, _ *[]chatSession) {
			delete(env, "CODEX_THREAD_ID")
			delete(env, "SUPERSET_TERMINAL_ID")
			args["ownerWorkspaceId"], args["ownerSessionId"] = ws.ID, "chat-1"
		}},
		{name: "other workspace", want: "Слот занят", configure: func(_ *testing.T, _ paradev, _ workspace, env map[string]string, _ map[string]any, _ *[]chatSession) {
			env["SUPERSET_WORKSPACE_ID"] = "other"
		}},
		{name: "additional chat", want: "Слот занят", configure: func(_ *testing.T, _ paradev, _ workspace, _ map[string]string, _ map[string]any, chats *[]chatSession) {
			*chats = append(*chats, chatSession{SessionID: "another", Harness: "claude", Live: true})
		}},
		{name: "unrecognized live chat", want: "Слот занят", configure: func(_ *testing.T, _ paradev, _ workspace, _ map[string]string, _ map[string]any, chats *[]chatSession) {
			*chats = append(*chats, chatSession{SessionID: "another", Harness: "unknown", Live: true})
		}},
		{name: "chat appeared during fetch", want: "Слот занят", lateBlocker: "chat"},
		{name: "unidentified native session", want: "Слот занят", lateBlocker: "process"},
		{name: "fetched base moved", want: "detached HEAD", configure: func(t *testing.T, _ paradev, ws workspace, _ map[string]string, _ map[string]any, _ *[]chatSession) {
			main := filepath.Dir(testGit(t, ws.WorktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir"))
			testGit(t, main, "commit", "--allow-empty", "-m", "Advance base")
			origin := testGit(t, main, "remote", "get-url", "origin")
			testGit(t, origin, "fetch", "--update-head-ok", main, "refs/heads/main:refs/heads/main")
		}},
		{name: "dirty even with carry", want: "чистая рабочая копия", configure: func(t *testing.T, _ paradev, ws workspace, _ map[string]string, args map[string]any, _ *[]chatSession) {
			writeFixture(t, filepath.Join(ws.WorktreePath, "dirty"), "keep this")
			args["carry"] = true
		}},
		{name: "existing branch on same SHA", want: "только новую ветку", configure: func(t *testing.T, _ paradev, ws workspace, _ map[string]string, args map[string]any, _ *[]chatSession) {
			testGit(t, ws.WorktreePath, "branch", "existing")
			args["branch"] = "existing"
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			host, ws := fixtureTakeSlot(t)
			env := map[string]string{"SUPERSET_BIN": host.config.Superset, "SUPERSET_WORKSPACE_ID": ws.ID,
				"SUPERSET_TERMINAL_ID": "terminal-1", "CODEX_THREAD_ID": "native-1"}
			host.env.get = func(key string) string { return env[key] }
			args := map[string]any{"workspaceId": ws.ID, "cwd": ws.WorktreePath, "branch": "next", "dryRun": tc.preview}
			chats := []chatSession{{SessionID: "chat-1", TerminalID: stringPtr("terminal-1"), Harness: "codex",
				HarnessSessionID: stringPtr("native-1"), Live: true}}
			if tc.configure != nil {
				tc.configure(t, host, ws, env, args, &chats)
			}
			if tc.reservedOwner != "" {
				state := chatSlotState{Active: &chatAssignment{Ready: true, Name: ws.Name, chatTarget: chatTarget{
					Workspace: ws.ID, SessionID: tc.reservedOwner, Terminal: "terminal-1", Cwd: ws.WorktreePath,
				}}}
				if err := host.saveChatState(ws.ID, state); err != nil {
					t.Fatal(err)
				}
			}
			initial := testGit(t, ws.WorktreePath, "rev-parse", "HEAD")
			status := testGit(t, ws.WorktreePath, "status", "--porcelain")
			journal := filepath.Join(host.env.home, "rollout-extra.jsonl")
			if tc.lateBlocker == "process" {
				raw, err := json.Marshal(map[string]any{"type": "session_meta", "payload": map[string]string{
					"id": "unmapped", "cwd": ws.WorktreePath,
				}})
				if err != nil {
					t.Fatal(err)
				}
				writeFixture(t, journal, string(raw)+"\n")
			}
			run := host.env.run
			host.env.run = func(ctx context.Context, cmd string, argv []string, opts commandOptions) (commandOutput, error) {
				switch {
				case cmd == host.config.Superset && slices.Equal(argv[:min(2, len(argv))], []string{"sessions", "list"}):
					raw, err := json.Marshal(chats)
					return commandOutput{stdout: string(raw)}, err
				case cmd == "git" && argv[0] == "fetch" && tc.lateBlocker == "chat":
					chats = append(chats, chatSession{SessionID: "late", Harness: "codex", Live: true})
				case tc.lateBlocker == "process" && cmd == "ps" && argv[0] == "-axo":
					return commandOutput{stdout: "2147483647 1 10 /fixture/codex app-server\n"}, nil
				case tc.lateBlocker == "process" && cmd == "lsof":
					return commandOutput{stdout: "n" + journal + "\n"}, nil
				}
				return run(ctx, cmd, argv, opts)
			}
			ctx := context.Background()
			serverSide, clientSide := mcp.NewInMemoryTransports()
			server, err := nativeMCP(host.env).Connect(ctx, serverSide, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer server.Close()
			client, err := mcp.NewClient(&mcp.Implementation{Name: "slot-prepare-test"}, nil).Connect(ctx, clientSide, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			reply, err := client.CallTool(ctx, &mcp.CallToolParams{Name: "slot_prepare", Arguments: args})
			if err != nil {
				t.Fatal(err)
			}
			body := reply.StructuredContent.(map[string]any)
			data := body["data"].(map[string]any)
			branch := ""
			if tc.want != "" {
				if body["code"] != float64(exitCheck) || !strings.Contains(data["error"].(string), tc.want) {
					t.Fatalf("expected %q, got %v", tc.want, body)
				}
			} else {
				if body["code"] != float64(exitOK) || data["branchOnly"] != true || data["base"] != initial || data["fetched"] != true {
					t.Fatalf("unexpected prepare result: %v", body)
				}
				if !tc.preview {
					branch = "next"
				}
			}
			if got := testGit(t, ws.WorktreePath, "branch", "--show-current"); got != branch {
				t.Fatalf("branch = %q, want %q", got, branch)
			}
			if testGit(t, ws.WorktreePath, "rev-parse", "HEAD") != initial || testGit(t, ws.WorktreePath, "status", "--porcelain") != status {
				t.Fatal("prepare changed the commit or worktree")
			}
		})
	}
}
