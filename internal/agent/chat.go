package agent

import (
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"
)

type waitPrompt struct {
	Kind    string `json:"kind"`
	Text    string `json:"text"`
	Options any    `json:"options"`
	Form    any    `json:"form,omitempty"`
}

type transcript struct {
	records []transcriptRecord
	state   string
	waiting *waitPrompt
}

type chatCursor struct {
	Epoch string      `json:"epoch"`
	Seq   json.Number `json:"seq"`
}

type chatEnvelope struct {
	Cursor *chatCursor `json:"cursor"`
	TS     int64       `json:"ts"`
	Event  *struct {
		Type    string
		Item    sessionRecord
		Turn    sessionRecord
		Session sessionRecord
	} `json:"event"`
}

type chatPage struct {
	OK         bool            `json:"ok"`
	Envelopes  []chatEnvelope  `json:"envelopes"`
	NextBefore json.RawMessage `json:"nextBefore"`
}

func chatArguments(s liveSession) []string {
	return []string{"--local", "--workspace", s.workspaceID, "--session", s.id}
}

func (p paradev) readChat(s liveSession, deadline time.Time) (transcript, error) {
	var batches [][]chatEnvelope
	seen := map[string]bool{}
	before := ""
	for {
		api := p
		if !deadline.IsZero() {
			remaining := time.Until(deadline)
			if remaining <= 0 {
				return transcript{}, fail(exitError, "Истёк срок чтения chat-журнала")
			}
			api.timeout = remaining
		}
		args := append([]string{"sessions", "read"}, chatArguments(s)...)
		args = append(args, "--limit", "500")
		if before != "" {
			args = append(args, "--before", before)
		}
		var page chatPage
		if err := api.call(&page, args...); err != nil {
			return transcript{}, err
		}
		if !page.OK || page.Envelopes == nil {
			return transcript{}, fail(exitError, "superset sessions read: некорректный ответ журнала")
		}
		batches = append(batches, page.Envelopes)
		if len(page.NextBefore) == 0 || string(page.NextBefore) == "null" {
			break
		}
		if json.Unmarshal(page.NextBefore, &before) != nil {
			before = string(page.NextBefore)
		}
		if before == "" {
			break
		}
		if seen[before] {
			return transcript{}, fail(exitError, "superset sessions read: повтор курсора пагинации")
		}
		seen[before] = true
	}
	slices.Reverse(batches)
	return normalizeChat(batches, s.id)
}

type chatItem struct {
	row  transcriptRecord
	item sessionRecord
}

func normalizeChat(pages [][]chatEnvelope, id string) (transcript, error) {
	result := transcript{records: []transcriptRecord{}, state: "unknown"}
	var records []chatItem
	index := map[string]int{}
	for _, page := range pages {
		for _, envelope := range page {
			event := envelope.Event
			if event == nil || envelope.Cursor == nil {
				return transcript{}, fail(exitError, "superset sessions read: ожидалось событие с курсором")
			}
			row := transcriptRecord{
				UUID:      fmt.Sprintf("chat:%s:%s:%s", id, envelope.Cursor.Epoch, envelope.Cursor.Seq),
				Timestamp: time.UnixMilli(envelope.TS).UTC().Format("2006-01-02T15:04:05.000Z"),
			}
			switch event.Type {
			case "item":
				key := event.Item.string("id")
				if known, ok := index[key]; ok {
					records[known].item = event.Item
					continue
				}
				index[key] = len(records)
				records = append(records, chatItem{row, event.Item})
			case "turn":
				switch event.Turn.string("status") {
				case "running":
					result.state, row.Type, row.Subtype = "working", "system", "turn_started"
				case "completed", "interrupted", "failed":
					result.state = "idle"
					if event.Turn.string("status") == "failed" {
						content, _ := event.Turn["error"].(map[string]any)
						message := choose(sessionRecord(content).string("message"), event.Turn.string("error"))
						failure := row
						failure.Type, failure.APIError = "assistant", true
						failure.Message.Content = choose(message, "Chat turn failed")
						records = append(records, chatItem{row: failure})
					}
					row.Type, row.Subtype, row.TurnStatus = "system", "turn_duration", event.Turn.string("status")
				}
				if row.Type != "" {
					records = append(records, chatItem{row: row})
				}
			case "session":
				switch event.Session.string("status") {
				case "idle", "not_loaded", "offline", "dead":
					result.state = "idle"
				case "starting", "running":
					result.state = "working"
				case "awaiting_input":
					result.state = "waiting"
				}
				if event.Session["awaitingBackground"] == true {
					result.state = "working"
				}
			}
		}
	}
	for _, entry := range records {
		row, item := entry.row, entry.item
		if item == nil {
			result.records = append(result.records, row)
			continue
		}
		if item.string("parentItemId") != "" || item["discarded"] == true || item.string("from") == "parent" {
			continue
		}
		switch item.string("kind") {
		case "user_message":
			row.Type, row.Message.Content = "user", item["content"]
			if item["queued"] == true {
				row.Type, row.Attachment.Type, row.Attachment.CommandMode = "attachment", "queued_command", "prompt"
				row.Attachment.Prompt = contentText(item["content"], "text")
			}
		case "agent_message":
			row.Type, row.Message.ID, row.Message.Content = "assistant", item.string("id"), item.string("text")
		case "notice":
			if item.string("noticeKind") != "error" {
				continue
			}
			row.Type, row.APIError = "assistant", true
			row.Message.Content = choose(item.string("message"), choose(item.string("text"), "Chat error"))
		case "approval_request":
			if item.string("status") == "pending" {
				result.state, result.waiting = "waiting", chatWaiting(item)
			}
			continue
		default:
			continue
		}
		result.records = append(result.records, row)
	}
	return result, nil
}

func chatWaiting(item sessionRecord) *waitPrompt {
	wait := &waitPrompt{Kind: "permission", Options: item["options"], Form: item["form"]}
	form, _ := item["form"].(map[string]any)
	if form != nil {
		wait.Kind = "question"
	}
	if wait.Options == nil {
		wait.Options = []any{}
	}
	lines := []string{item.string("title"), sessionRecord(form).string("message"), contentText(item["detail"], "text")}
	wait.Text = strings.Join(slices.DeleteFunc(lines, func(s string) bool { return s == "" }), "\n")
	return wait
}

func (p paradev) transcript(s liveSession, deadline time.Time) (transcript, error) {
	if s.chat != nil {
		info, err := p.readChat(s, deadline)
		if s.state == "working" || s.state == "waiting" {
			info.state = s.state
		}
		return info, err
	}
	path, err := nativeJournalPath(p.env, s)
	if err != nil {
		return transcript{}, err
	}
	records, err := readTranscript(path)
	return transcript{records: records, state: s.state}, err
}

func (p paradev) waiting(s liveSession, info transcript) *waitPrompt {
	if info.state != "waiting" {
		return nil
	}
	if s.chat != nil {
		if info.waiting != nil {
			return info.waiting
		}
		return &waitPrompt{Kind: "permission", Text: "Chat ждёт ответа или разрешения", Options: []any{}}
	}
	var reply struct{ Text string }
	args := []string{"terminals", "read", "--local", "--workspace", s.workspaceID, "--terminal", s.terminal, "--max-lines", strconv.Itoa(60)}
	if err := p.call(&reply, args...); err != nil {
		return nil
	}
	return parsePromptScreen(reply.Text)
}
