package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestReleaseCloseWaitsForFinalReply(t *testing.T) {
	pkg := releasePackage(t)
	w := newReleaseHost(t)
	w.git(w.slot, "switch", "-c", "task-branch")
	w.git(w.slot, "config", "user.name", "Test")
	w.git(w.slot, "config", "user.email", "test@example.invalid")
	state := w.readState()
	state.Name, state.Created, state.Live = "slot-1 · TASK", true, true
	w.save(state)
	env := append(w.env, "SUPERSET_WORKSPACE_ID=slot-id", "SUPERSET_TERMINAL_ID=terminal-one", "CODEX_THREAD_ID=native-one")
	launch := filepath.Join(pkg, "launch")
	runJSON := func(args ...string) map[string]any { return fixtureCLIJSON(t, w.slot, env, launch, nil, args...) }
	outcome := filepath.Join(w.dir, "outcome.md")
	fixtureFile(t, outcome, "Results ready for review.\n", 0o600)
	queued := runJSON("close", "--summary-file", outcome, "--json")
	expectField(t, queued, "status", "queued")
	job, jobOK := queued["resultFile"].(string)
	receipt, receiptOK := queued["receipt"].(string)
	if !jobOK || !receiptOK || !w.readState().Live {
		t.Fatalf("expected queued worker and live chat: %#v", queued)
	}
	t.Cleanup(func() {
		// Bound the detached worker's wait even if an earlier assertion failed.
		state := w.readState()
		if state.Live && state.Receipt == "" {
			state.Live = false
			w.save(state)
		}
	})
	state = w.readState()
	state.Receipt = receipt
	w.save(state)

	result := waitReleaseWorker(t, job)
	expectField(t, result, "status", "completed")
	expectField(t, result["close"].(map[string]any), "status", "closed")
	expectField(t, result["release"].(map[string]any), "status", "released")
	notification, _ := result["notification"].(map[string]any)
	expectField(t, notification, "status", "accepted")
	if state := w.readState(); state.Live || state.Name != "slot-1" || w.git(w.slot, "branch", "--show-current") != "" {
		t.Fatalf("worker did not close the chat and park the slot: %#v", state)
	}
	before, err := os.ReadFile(job)
	if err != nil {
		t.Fatal(err)
	}
	runFixture(t, w.slot, env, launch, "--agent-cli", "__session-worker", job)
	after, err := os.ReadFile(job)
	if err != nil || !bytes.Equal(after, before) {
		t.Fatalf("replayed worker changed its persisted result: %v", err)
	}
}

func fixtureCLIJSON(t *testing.T, dir string, env []string, launch string, input []byte, args ...string) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, launch, append([]string{"--agent-cli"}, args...)...)
	cmd.Dir, cmd.Env, cmd.Stdin = dir, env, bytes.NewReader(input)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	body, err := cmd.Output()
	if err != nil {
		t.Fatalf("%v: %v\n%s\n%s", args, err, body, &stderr)
	}
	var data map[string]any
	if err := json.Unmarshal(body, &data); err != nil {
		t.Fatalf("invalid CLI response: %v: %s", err, body)
	}
	return data
}

func waitReleaseWorker(t *testing.T, job string) map[string]any {
	t.Helper()
	for deadline := time.Now().Add(15 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		var result map[string]any
		if err := readTestJSON(job, &result); err != nil {
			t.Fatal(err)
		}
		if result["notification"] != nil || result["status"] == "error" {
			return result
		}
	}
	t.Fatalf("worker did not finish: %s", job)
	return nil
}

func TestReleaseSessionEndWaitsForTransportExit(t *testing.T) {
	pkg := releasePackage(t)
	w := newReleaseHost(t)
	state := w.readState()
	state.Created, state.Live = true, true
	w.save(state)
	t.Cleanup(func() {
		state := w.readState()
		if state.Live {
			state.Live = false
			w.save(state)
		}
	})
	env := append(w.env, "SUPERSET_WORKSPACE_ID=slot-id", "SUPERSET_TERMINAL_ID=terminal-one",
		"CODEX_THREAD_ID=native-one", "AGENT_HOOK_RUNTIME_PID=123")
	launch := filepath.Join(pkg, "launch")
	hook := func(action, event string, extra map[string]any) map[string]any {
		t.Helper()
		input := map[string]any{"hook_event_name": event, "session_id": "native-one", "cwd": w.slot}
		for key, value := range extra {
			input[key] = value
		}
		body, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		return fixtureCLIJSON(t, w.slot, env, launch, body, "hook", action, "--agent", "codex", "--json")
	}
	expectField(t, hook("session-start", "SessionStart", nil), "status", "checkpoint")
	expectField(t, hook("user-prompt-submit", "UserPromptSubmit", map[string]any{"prompt": "Start work"}), "status", "admitted")
	w.git(w.slot, "switch", "-c", "task-branch")
	note := "Paused for native exit test"
	expectField(t, hook("stop", "Stop", map[string]any{"last_assistant_message": note}), "status", "checkpoint")
	queued := hook("session-end", "SessionEnd", map[string]any{"reason": "other"})
	expectField(t, queued, "status", "queued")
	job := queued["resultFile"].(string)
	duplicate := hook("session-end", "SessionEnd", map[string]any{"reason": "other"})
	expectField(t, duplicate, "resultFile", job)
	if !w.readState().Live || w.git(w.slot, "branch", "--show-current") != "task-branch" {
		t.Fatal("SessionEnd touched the running fixture chat or branch")
	}
	state = w.readState()
	state.Live = false
	w.save(state)
	finished := waitReleaseWorker(t, job)
	expectField(t, finished, "status", "completed")
	expectField(t, finished["release"].(map[string]any), "status", "released")
	if branch := w.git(w.slot, "branch", "--show-current"); branch != "" {
		t.Fatalf("slot was not detached: %s", branch)
	}
	var registry struct {
		Sessions []struct{ Note string }
	}
	if err := readTestJSON(filepath.Join(w.home, ".agent-cli", "sessions.json"), &registry); err != nil || len(registry.Sessions) != 1 || registry.Sessions[0].Note != note {
		t.Fatalf("missing recovery note: %+v %v", registry, err)
	}
}
