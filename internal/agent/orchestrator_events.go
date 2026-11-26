package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type paradevJournalRow struct {
	Epoch   string `json:"epoch"`
	Harness string `json:"harness"`
	Seq     int64  `json:"seq"`
	Event   string `json:"event"`
}

type paradevDurableEvent struct {
	Type   string `json:"type"`
	TurnID string `json:"turnId"`
	Turn   struct {
		ID     string `json:"id"`
		Status string `json:"status"`
		Error  struct {
			Message string `json:"message"`
		} `json:"error"`
	} `json:"turn"`
	Item struct {
		ID          string          `json:"id"`
		Kind        string          `json:"kind"`
		Parent      string          `json:"parentItemId"`
		Text        string          `json:"text"`
		CompletedAt *int64          `json:"completedAtMs"`
		Status      string          `json:"status"`
		Title       string          `json:"title"`
		Reason      string          `json:"reason"`
		Form        json.RawMessage `json:"form"`
		Queued      bool            `json:"queued"`
		Discarded   bool            `json:"discarded"`
	} `json:"item"`
}

type orchestratorEvent struct {
	Session string          `json:"session"`
	Harness string          `json:"harness"`
	Cursor  string          `json:"cursor"`
	Type    string          `json:"type"`
	Turn    string          `json:"turn"`
	Item    string          `json:"item,omitempty"`
	Text    string          `json:"text,omitempty"`
	Form    json.RawMessage `json:"form,omitempty"`
}

type observedTurn struct {
	user          bool
	ended         bool
	latestMessage string
	messageText   string
	items         map[string]bool
	pending       map[string]bool
}

type journalCursor struct {
	Epoch string `json:"epoch"`
	Seq   int64  `json:"seq"`
}

func (c journalCursor) String() string { return c.Epoch + ":" + strconv.FormatInt(c.Seq, 10) }

type trackedJournal struct {
	file    string
	session string
	cursor  journalCursor
	acked   journalCursor
	turns   map[string]*observedTurn
}

const journalPageSize = 256

func (t *trackedJournal) readPage(ctx context.Context) ([]paradevJournalRow, error) {
	// Hex encode the one explicitly selected session. Never scan other sessions.
	id := "CAST(X'" + hex.EncodeToString([]byte(t.session)) + "' AS TEXT)"
	query := fmt.Sprintf(`
WITH target AS (
	SELECT session_id, epoch, harness FROM chat_sessions_local
	WHERE session_id = %s AND harness IN ('codex', 'codex-acp', 'opencode-acp', 'opencode')
), page AS (
	SELECT j.seq, j.event_json FROM target t
	JOIN chat_journal j ON j.session_id = t.session_id AND j.epoch = t.epoch
	WHERE j.seq > %d ORDER BY j.seq LIMIT %d
)
SELECT t.epoch, t.harness, COALESCE(p.seq, 0) AS seq,
	COALESCE(p.event_json, '') AS event FROM target t LEFT JOIN page p ON 1
ORDER BY p.seq;`, id, t.cursor.Seq, journalPageSize)
	cmd := exec.CommandContext(ctx, "/usr/bin/sqlite3", "-batch", "-init", "/dev/null", "-readonly", "-json", "-cmd", ".timeout 2000", t.file, query)
	raw, err := cmd.Output()
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return nil, fmt.Errorf("локальный журнал Paradev: %s", strings.TrimSpace(string(exit.Stderr)))
		}
		return nil, err
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, fail(exitGone, "В указанном локальном журнале нет сессии Codex/OpenCode %s", t.session)
	}
	var rows []paradevJournalRow
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil, err
	}
	if len(rows) == 0 || rows[0].Epoch == "" {
		return nil, fail(exitCheck, "Журнал %s не вернул поколение сессии", t.session)
	}
	return rows, nil
}

func (t *trackedJournal) apply(row paradevJournalRow) (*orchestratorEvent, error) {
	if t.cursor.Epoch == "" {
		t.cursor.Epoch = row.Epoch
	}
	if row.Epoch != t.cursor.Epoch || t.acked.Epoch != "" && row.Epoch != t.acked.Epoch {
		return nil, fail(exitCheck, "Журнал %s сменил поколение. Неподтверждённые события старого поколения могли стать недоступны.", t.session)
	}
	if row.Seq == 0 {
		return nil, nil
	}
	if row.Seq != t.cursor.Seq+1 {
		return nil, fail(exitCheck, "В журнале %s отсутствует запись после %s", t.session, t.cursor)
	}
	var e paradevDurableEvent
	if err := json.Unmarshal([]byte(row.Event), &e); err != nil {
		return nil, fmt.Errorf("повреждённая запись журнала %s #%d: %w", t.session, row.Seq, err)
	}
	t.cursor.Seq = row.Seq
	turnID := choose(e.TurnID, e.Turn.ID)
	if turnID == "" {
		return nil, nil
	}
	turn := t.turns[turnID]
	if turn == nil {
		turn = &observedTurn{items: make(map[string]bool), pending: make(map[string]bool)}
		t.turns[turnID] = turn
	}
	out := &orchestratorEvent{Session: t.session, Harness: row.Harness, Cursor: t.cursor.String(), Turn: turnID}
	if e.Type == "item" && !turn.ended {
		item := e.Item
		switch item.Kind {
		case "user_message":
			turn.user = turn.user || item.Parent == "" && !item.Queued && !item.Discarded
		case "agent_message":
			if item.Parent == "" && item.ID != "" {
				turn.latestMessage, turn.messageText = item.ID, ""
				if item.CompletedAt != nil {
					turn.messageText = item.Text
				}
			}
		case "tool_call":
			if item.Parent == "" && !turn.items[item.ID] {
				turn.latestMessage, turn.messageText = "", ""
				turn.items[item.ID] = true
			}
		case "approval_request":
			first := !turn.items[item.ID]
			turn.items[item.ID] = true
			if item.Status != "pending" {
				delete(turn.pending, item.ID)
				break
			}
			turn.pending[item.ID] = true
			if first && item.ID != "" {
				out.Type, out.Item, out.Text, out.Form = "permission_required", item.ID, choose(item.Title, item.Reason), item.Form
				if len(item.Form) > 0 && string(item.Form) != "null" {
					out.Type = "question"
				}
			}
		}
	}
	if e.Type == "turn" && !turn.ended && e.Turn.Status != "running" {
		turn.ended = true
		switch e.Turn.Status {
		case "completed":
			if turn.user && len(turn.pending) == 0 && strings.TrimSpace(turn.messageText) != "" {
				out.Type, out.Item, out.Text = "answer", turn.latestMessage, turn.messageText
			}
		case "failed", "interrupted":
			out.Type, out.Text = "error", choose(e.Turn.Error.Message, e.Turn.Status)
		}
		// Keep the terminal marker to ignore duplicate updates, but release the transcript.
		*turn = observedTurn{ended: true}
	}
	if out.Type == "" || row.Seq <= t.acked.Seq {
		return nil, nil
	}
	return out, nil
}

func (t *trackedJournal) scanPage(ctx context.Context, emit func(orchestratorEvent) error) (bool, error) {
	rows, err := t.readPage(ctx)
	if err != nil {
		return false, err
	}
	for _, row := range rows {
		event, err := t.apply(row)
		if err != nil {
			return false, err
		}
		if event != nil {
			if err := emit(*event); err != nil {
				return false, err
			}
		}
	}
	if len(rows) < journalPageSize && t.cursor.Seq < t.acked.Seq {
		return false, fail(exitCheck, "Журнал %s отстаёт от подтверждённого курсора %s", t.session, t.acked)
	}
	return len(rows) == journalPageSize, nil
}

func (t *trackedJournal) checkpointPath(env environment) string {
	key := sha256.Sum256([]byte(t.file + "\x00" + t.session))
	return filepath.Join(env.agentHome, "events", fmt.Sprintf("%x.json", key))
}

func (t *trackedJournal) checkpoint(env environment, update func(path string) error) error {
	path := t.checkpointPath(env)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return err
	}
	if err := readJSON(path, &t.acked); err != nil {
		return err
	}
	return update(path)
}

func (t *trackedJournal) bind(ctx context.Context, env environment) error {
	return t.checkpoint(env, func(path string) error {
		if t.acked.Epoch != "" {
			return nil
		}
		rows, err := t.readPage(ctx)
		if err != nil {
			return err
		}
		t.acked = journalCursor{Epoch: rows[0].Epoch}
		return atomicJSON(path, t.acked)
	})
}

func (t *trackedJournal) acknowledge(ctx context.Context, env environment, cursor string) error {
	return t.checkpoint(env, func(path string) error {
		if t.acked.Epoch != "" && t.acked.Seq > 0 && cursor == t.acked.String() {
			return nil
		}
		stop := errors.New("first event")
		var next string
		for more := true; more; {
			var err error
			more, err = t.scanPage(ctx, func(event orchestratorEvent) error {
				next = event.Cursor
				return stop
			})
			if errors.Is(err, stop) {
				break
			}
			if err != nil {
				return err
			}
		}
		if next == "" || cursor != next {
			return fail(exitCheck, "Курсор не соответствует следующему неподтверждённому событию сессии %s", t.session)
		}
		return atomicJSON(path, t.cursor)
	})
}

func localEvents(ctx context.Context, env environment, opts options, stdout io.Writer) error {
	args := opts.positionals[1:]
	if len(args) < 2 || !filepath.IsAbs(opts.flags["journal"]) {
		return fail(exitError, "Справка: paradev-agent events --help. Укажите абсолютный путь --journal")
	}
	file := canonicalPath(opts.flags["journal"])
	info, err := os.Stat(file)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fail(exitError, "--journal должен указывать на файл chat.db")
	}
	newTrack := func(id string) *trackedJournal {
		return &trackedJournal{file: file, session: id, turns: make(map[string]*observedTurn)}
	}
	switch args[0] {
	case "ack":
		if len(args) != 3 {
			return fail(exitError, "Нужно: events ack SESSION CURSOR --journal PATH")
		}
		return newTrack(args[1]).acknowledge(ctx, env, args[2])
	case "watch":
		var tracks []*trackedJournal
		for _, id := range args[1:] {
			if slices.ContainsFunc(tracks, func(t *trackedJournal) bool { return t.session == id }) {
				continue
			}
			track := newTrack(id)
			if err := track.bind(ctx, env); err != nil {
				return err
			}
			tracks = append(tracks, track)
		}
		return watchTrackedJournals(ctx, opts.flags["timeout"], tracks, stdout)
	default:
		return fail(exitError, "Справка: paradev-agent events --help")
	}
}

func watchTrackedJournals(ctx context.Context, timeout string, tracks []*trackedJournal, stdout io.Writer) error {
	if timeout != "" {
		seconds, err := strconv.ParseUint(timeout, 10, 31)
		if err != nil || seconds == 0 {
			return fail(exitError, "--timeout: укажите положительное число секунд")
		}
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(seconds)*time.Second)
		defer cancel()
	}
	encoder := json.NewEncoder(stdout)
	encoder.SetEscapeHTML(false)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		backlog := false
		for _, track := range tracks {
			more, err := track.scanPage(ctx, func(event orchestratorEvent) error { return encoder.Encode(event) })
			if err != nil {
				if ctx.Err() != nil {
					return nil
				}
				return err
			}
			backlog = backlog || more
		}
		if backlog {
			continue
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}
