package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func eventTestSQL(t *testing.T, db, query string) {
	t.Helper()
	if output, err := exec.Command("/usr/bin/sqlite3", db, query).CombinedOutput(); err != nil {
		t.Fatalf("fixture sqlite: %s (%v)", output, err)
	}
}

func eventTestInsert(t *testing.T, db, session string, start int, raw ...string) {
	t.Helper()
	var query strings.Builder
	query.WriteString("BEGIN;")
	for index, row := range raw {
		fmt.Fprintf(&query, "INSERT INTO chat_journal VALUES ('%s','epoch',%d,'%s');", session, start+index, row)
	}
	query.WriteString("COMMIT;")
	eventTestSQL(t, db, query.String())
}

func eventFromCLI(t *testing.T, db string, wantCode int, args ...string) []orchestratorEvent {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	cmd := append(append([]string{"events"}, args...), "--journal", db)
	var stdout, stderr bytes.Buffer
	if code := Main(ctx, cmd, &stdout, &stderr); code != wantCode {
		t.Fatalf("%v returned %d: %s", args, code, stderr.String())
	}
	var events []orchestratorEvent
	decoder := json.NewDecoder(&stdout)
	for decoder.More() {
		var event orchestratorEvent
		if err := decoder.Decode(&event); err != nil {
			t.Fatal(err)
		}
		events = append(events, event)
	}
	return events
}

func TestLocalEventsReplayAndAcknowledgement(t *testing.T) {
	t.Setenv("AGENT_CLI_HOME", t.TempDir())
	db := filepath.Join(t.TempDir(), "chat.db")
	eventTestSQL(t, db, `
		CREATE TABLE chat_sessions_local(session_id TEXT PRIMARY KEY, epoch TEXT, harness TEXT);
		CREATE TABLE chat_journal(session_id TEXT, epoch TEXT, seq INTEGER, event_json TEXT, PRIMARY KEY(session_id,epoch,seq));
		INSERT INTO chat_sessions_local VALUES ('codex','epoch','codex-acp'),('open','epoch','opencode-acp'),('private','epoch','opencode-acp');
	`)
	for _, id := range []string{"codex", "open", "private"} {
		eventTestInsert(t, db, id, 1,
			`{"type":"turn","turn":{"id":"t1","status":"running"}}`,
			`{"type":"item","turnId":"t1","item":{"id":"user","kind":"user_message"}}`,
			`{"type":"item","turnId":"t1","item":{"id":"draft","kind":"agent_message","text":"unfinished"}}`,
			`{"type":"session","session":{"status":"idle"}}`)
	}
	if got := eventFromCLI(t, db, 0, "watch", "codex", "open"); len(got) != 0 {
		t.Fatalf("idle or partial message emitted a result: %+v", got)
	}
	for _, id := range []string{"codex", "open", "private"} {
		eventTestInsert(t, db, id, 5,
			`{"type":"item","turnId":"t1","item":{"id":"form","kind":"approval_request","title":"Choose a value","status":"pending","form":{"message":"Pick A or B"}}}`,
			`{"type":"item","turnId":"t1","item":{"id":"form","kind":"approval_request","status":"pending"}}`,
			`{"type":"item","turnId":"t1","item":{"id":"form","kind":"approval_request","status":"answered"}}`,
			`{"type":"item","turnId":"t1","item":{"id":"reply","kind":"agent_message","text":"first answer","completedAtMs":8}}`,
			`{"type":"item","turnId":"t1","item":{"id":"child","parentItemId":"child-turn","kind":"agent_message","text":"child output","completedAtMs":9}}`,
			`{"type":"turn","turn":{"id":"t1","status":"completed"}}`,
			`{"type":"turn","turn":{"id":"t1","status":"completed"}}`,
			`{"type":"turn","turn":{"id":"t2","status":"running"}}`,
			`{"type":"item","turnId":"t2","item":{"id":"user","kind":"user_message"}}`,
			`{"type":"item","turnId":"t2","item":{"id":"approval","kind":"approval_request","title":"Allow","status":"pending"}}`,
			`{"type":"item","turnId":"t2","item":{"id":"approval","kind":"approval_request","status":"answered"}}`,
			`{"type":"item","turnId":"t2","item":{"id":"progress","kind":"agent_message","text":"checking","completedAtMs":15}}`,
			`{"type":"item","turnId":"t2","item":{"id":"tool","kind":"tool_call","status":"running"}}`,
			`{"type":"item","turnId":"t2","item":{"id":"tool","kind":"tool_call","status":"completed"}}`,
			`{"type":"item","turnId":"t2","item":{"id":"reply","kind":"agent_message","text":"second answer","completedAtMs":19}}`,
			`{"type":"turn","turn":{"id":"t2","status":"completed"}}`,
			`{"type":"turn","turn":{"id":"t3","status":"failed","error":{"message":"test failure"}}}`)
	}
	received := eventFromCLI(t, db, 0, "watch", "codex", "open", "codex")
	if len(received) != 10 {
		t.Fatalf("want five events from each of two sessions, got %+v", received)
	}
	for i, event := range received {
		wantType := []string{"question", "answer", "permission_required", "answer", "error"}[i%5]
		wantSession := []string{"codex", "open"}[i/5]
		if event.Type != wantType || event.Session != wantSession {
			t.Fatalf("event %d = %+v", i, event)
		}
	}
	if received[1].Text != "first answer" || received[3].Text != "second answer" || received[4].Text != "test failure" {
		t.Fatalf("wrong reply text: %+v", received[:5])
	}
	// A disconnect after receipt and before ack replays with identical cursors.
	replayed := eventFromCLI(t, db, 0, "watch", "codex", "open")
	for i, event := range received {
		if i >= len(replayed) || event.Cursor != replayed[i].Cursor || event.Session != replayed[i].Session {
			t.Fatalf("unstable replay: %+v", replayed)
		}
	}
	eventFromCLI(t, db, int(exitCheck), "ack", "codex", received[1].Cursor)
	for i := 0; i < 5; i++ {
		eventFromCLI(t, db, 0, "ack", "codex", received[i].Cursor)
	}
	eventFromCLI(t, db, 0, "ack", "codex", received[4].Cursor)
	if got := eventFromCLI(t, db, 0, "watch", "codex"); len(got) != 0 {
		t.Fatalf("confirmed events replayed: %+v", got)
	}
	eventTestSQL(t, db, "UPDATE chat_sessions_local SET epoch='changed' WHERE session_id='open'")
	eventFromCLI(t, db, int(exitCheck), "watch", "open")
}

func TestLocalEventsRejectsProgressOnly(t *testing.T) {
	t.Setenv("AGENT_CLI_HOME", t.TempDir())
	db := filepath.Join(t.TempDir(), "chat.db")
	eventTestSQL(t, db, `
		CREATE TABLE chat_sessions_local(session_id TEXT PRIMARY KEY, epoch TEXT, harness TEXT);
		CREATE TABLE chat_journal(session_id TEXT, epoch TEXT, seq INTEGER, event_json TEXT, PRIMARY KEY(session_id,epoch,seq));
		INSERT INTO chat_sessions_local VALUES ('codex','epoch','codex-acp');
	`)
	eventTestInsert(t, db, "codex", 1,
		`{"type":"item","turnId":"t","item":{"id":"u","kind":"user_message"}}`,
		`{"type":"item","turnId":"t","item":{"id":"a","kind":"agent_message","text":"Let me check","completedAtMs":2}}`,
		`{"type":"item","turnId":"t","item":{"id":"x","kind":"tool_call","status":"running"}}`,
		`{"type":"turn","turn":{"id":"t","status":"completed"}}`)
	if got := eventFromCLI(t, db, 0, "watch", "codex"); len(got) != 0 {
		t.Fatalf("a progress message followed by a tool call is not a final answer: %+v", got)
	}
}
