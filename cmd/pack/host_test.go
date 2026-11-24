package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

type hostState struct {
	Main, Slot, Name, LaunchPrompt, Receipt                  string
	Created, Live, Waiting, Queued, SendTimeout, Unavailable bool
	Records                                                  []map[string]any
}

func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "--fixture-host" {
		if err := fixtureHost(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	os.Exit(m.Run())
}

func fixtureHost(args []string) error {
	path := os.Getenv("TEST_HOST_STATE")
	var state hostState
	if err := readTestJSON(path, &state); err != nil {
		return err
	}
	flag := func(name string) string {
		i := slices.Index(args, name)
		if i < 0 || i+1 >= len(args) {
			return ""
		}
		return args[i+1]
	}
	command := strings.Join(args[:min(2, len(args))], " ")
	if state.Unavailable && command != "--version" {
		return fmt.Errorf("host service manifest is stale")
	}
	workspace := func(id, name, path string) map[string]any {
		return map[string]any{"id": id, "name": name, "worktreePath": path, "projectId": "project-one", "projectName": "test project"}
	}
	chat := func() map[string]any {
		status := "idle"
		if state.Waiting {
			status = "awaiting_input"
		}
		return map[string]any{"sessionId": "session-one", "terminalId": "terminal-one", "harness": "codex-acp", "harnessSessionId": "native-one", "status": status, "live": state.Live}
	}
	event := func(body map[string]any) map[string]any {
		return map[string]any{"ts": time.Now().UnixMilli(), "cursor": map[string]any{"epoch": "test", "seq": len(state.Records) + 1}, "event": body}
	}
	save := false
	var result any
	switch command {
	case "--version":
		_, err := fmt.Println("Fixture")
		return err
	case "projects list":
		result = []any{map[string]any{"id": "project-one", "name": "test project", "path": state.Main}}
	case "ws list":
		result = []any{workspace("main-id", "Main", state.Main), workspace("slot-id", state.Name, state.Slot)}
	case "ws update":
		state.Name, save, result = flag("--name"), true, map[string]any{}
	case "notifications show":
		result = map[string]any{"ok": true}
	case "snapshot --json":
		result = map[string]any{"workspaces": []any{}}
	case "sessions list":
		result = []any{}
		if state.Created && flag("--workspace") == "slot-id" {
			result = []any{chat()}
		}
	case "sessions create":
		state.Created, state.Live, state.LaunchPrompt = true, true, flag("--prompt")
		save, result = true, chat()
	case "sessions send":
		prompt := flag("--prompt")
		if state.LaunchPrompt == "" {
			state.LaunchPrompt = prompt
		}
		seq := len(state.Records)
		state.Records = append(state.Records, event(map[string]any{"type": "item", "item": map[string]any{
			"id": fmt.Sprintf("prompt-%d", seq), "kind": "user_message", "queued": state.Queued,
			"content": []any{map[string]any{"type": "text", "text": prompt}},
		}}))
		if !state.Queued {
			state.Records = append(state.Records, event(map[string]any{"type": "item", "item": map[string]any{
				"id": fmt.Sprintf("answer-%d", seq), "kind": "agent_message", "text": "Result [[DONE]]",
			}}))
			state.Records = append(state.Records, event(map[string]any{"type": "turn", "turn": map[string]any{"status": "completed"}}))
		}
		save, result = true, chat()
	case "sessions read":
		records := state.Records
		if state.Receipt != "" {
			records = append(records, event(map[string]any{"type": "item", "item": map[string]any{
				"id": "final", "kind": "agent_message", "text": "Outcome saved. " + state.Receipt,
			}}))
			records = append(records, map[string]any{"ts": time.Now().UnixMilli(),
				"cursor": map[string]any{"epoch": "test", "seq": len(records) + 1},
				"event":  map[string]any{"type": "turn", "turn": map[string]any{"status": "completed"}},
			})
		}
		if state.Waiting {
			records = append(records, event(map[string]any{"type": "item", "item": map[string]any{
				"id": "approval", "kind": "approval_request", "title": "Choose an option", "status": "pending",
				"form": map[string]any{"message": "Which one?"}, "options": []string{"A", "B"},
			}}))
		}
		result = map[string]any{"ok": true, "envelopes": records}
	case "sessions close":
		state.Live, save, result = false, true, map[string]any{"closed": true}
	default:
		return fmt.Errorf("unexpected fixture host command %v", args)
	}
	if save {
		if err := writeTestJSON(path, state); err != nil {
			return err
		}
	}
	if command == "sessions send" && state.SendTimeout {
		time.Sleep(10 * time.Second)
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}

func readTestJSON(path string, value any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, value)
}

func writeTestJSON(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".fixture-")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(temp.Name(), path)
}
