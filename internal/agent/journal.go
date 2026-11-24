package agent

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
)

type transcriptRecord struct {
	searchText string
	UUID       string `json:"uuid"`
	Timestamp  string `json:"timestamp"`
	Type       string `json:"type"`
	Subtype    string `json:"subtype,omitempty"`
	TurnStatus string `json:"turnStatus,omitempty"`
	Message    struct {
		ID      string `json:"id"`
		Content any    `json:"content"`
	} `json:"message"`
	Attachment struct {
		Type        string
		CommandMode string
		Prompt      string
	} `json:"attachment"`
	Sidechain  bool `json:"isSidechain"`
	Meta       bool `json:"isMeta"`
	APIError   bool `json:"isApiErrorMessage"`
	Background int  `json:"pendingBackgroundAgentCount"`
}

type assistantAnswer struct {
	Text      string `json:"text"`
	Timestamp string `json:"timestamp"`
	UUID      string `json:"uuid,omitempty"`
}

type rolloutLine struct {
	Type      string
	Timestamp string
	Payload   sessionRecord
}

type journalLine struct {
	number  int
	content []byte
}

var (
	claudePathChars = regexp.MustCompile(`[^A-Za-z0-9]`)
	codexTool       = regexp.MustCompile(`(?:tool|function)_call(?:_output)?$`)
	pasteMarker     = regexp.MustCompile(`</?pasted_content(?: id="[^"]*")?>`)
)

func nativeJournalPath(env environment, s liveSession) (string, error) {
	if s.agent == "codex" {
		if s.id != "" && s.journal != "" {
			return s.journal, nil
		}
		return "", fail(exitError, "У процесса Codex %d не найден единственный открытый rollout-файл (lsof); журнал не определён", s.pid)
	}
	if s.id == "" || s.cwd == "" {
		return "", fail(exitError, "У процесса %d нет ~/.claude/sessions/%d.json — журнал не найти", s.pid, s.pid)
	}
	if filepath.Base(s.id) != s.id {
		return "", fail(exitCheck, "Недопустимый ID журнала: %s", s.id)
	}
	root := filepath.Join(choose(env.get("CLAUDE_CONFIG_DIR"), filepath.Join(env.home, ".claude")), "projects")
	target := filepath.Join(root, claudePathChars.ReplaceAllString(s.cwd, "-"), s.id+".jsonl")
	if fileExists(target) {
		return target, nil
	}
	dirs, err := os.ReadDir(root)
	if errors.Is(err, fs.ErrNotExist) {
		return target, nil
	}
	if err != nil {
		return "", err
	}
	for _, dir := range dirs {
		candidate := filepath.Join(root, dir.Name(), s.id+".jsonl")
		if fileExists(candidate) {
			return candidate, nil
		}
	}
	return target, nil
}

func readTranscript(path string) ([]transcriptRecord, error) {
	records := []transcriptRecord{}
	file, err := os.Open(path)
	if errors.Is(err, fs.ErrNotExist) {
		return records, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	reader := bufio.NewReader(file)
	var lines []journalLine
	var codexID string
	for index := 1; ; index++ {
		line, err := reader.ReadBytes('\n')
		if json.Valid(line) {
			lines = append(lines, journalLine{index, line})
			if codexID == "" {
				var event rolloutLine
				if json.Unmarshal(line, &event) == nil && event.Type == "session_meta" {
					codexID = event.Payload.string("id")
				}
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
	}
	if codexID != "" {
		return normalizeCodex(lines, codexID), nil
	}
	for _, entry := range lines {
		var record transcriptRecord
		if json.Unmarshal(entry.content, &record) == nil {
			record.searchText = string(entry.content)
			records = append(records, record)
		}
	}
	return records, nil
}

func normalizeCodex(lines []journalLine, id string) []transcriptRecord {
	out := []transcriptRecord{}
	wasEvent := false
	for _, line := range lines {
		var event rolloutLine
		if json.Unmarshal(line.content, &event) != nil {
			continue
		}
		payload := event.Payload
		kind := payload.string("type")
		var row transcriptRecord
		row.UUID, row.Timestamp = fmt.Sprintf("codex:%s:%d", id, line.number), event.Timestamp
		row.Message.ID = row.UUID
		isEvent := false
		switch {
		case event.Type == "response_item" && kind == "message":
			row.Type = payload.string("role")
			if row.Type != "user" && row.Type != "assistant" || row.Type == "assistant" && payload.string("channel") == "analysis" {
				continue
			}
			row.Message.Content = contentText(payload["content"], "input_text", "output_text", "text")
			if row.Type == "assistant" && wasEvent && out[len(out)-1].Message.Content == row.Message.Content {
				out = out[:len(out)-1]
			}
		case event.Type == "event_msg":
			switch kind {
			case "user_message":
				row.Type, row.Message.Content = "user", payload.string("message")
			case "agent_message":
				row.Type, row.Message.Content, isEvent = "assistant", payload.string("message"), true
			case "task_complete", "turn_complete", "turn_aborted":
				row.Type, row.Subtype = "system", "turn_duration"
			case "task_started", "turn_started":
				row.Type, row.Subtype = "system", "turn_started"
			case "error":
				if payload["will_retry"] == true {
					continue
				}
				nested, _ := payload["error"].(map[string]any)
				row.Type, row.APIError = "assistant", true
				row.Message.Content = choose(payload.string("message"), choose(sessionRecord(nested).string("message"), "ошибка API"))
			default:
				continue
			}
		case event.Type == "response_item" && codexTool.MatchString(kind):
			row.Type = "assistant"
		default:
			continue
		}
		out = append(out, row)
		wasEvent = isEvent
	}
	return out
}

func contentText(content any, types ...string) string {
	if text, ok := content.(string); ok {
		return text
	}
	blocks, _ := content.([]any)
	var text []string
	for _, entry := range blocks {
		block, _ := entry.(map[string]any)
		data := sessionRecord(block)
		if slices.Contains(types, data.string("type")) {
			text = append(text, data.string("text"))
		}
	}
	return strings.Join(text, "\n")
}

func (r transcriptRecord) prompt() string {
	if r.Meta || r.Sidechain {
		return ""
	}
	if r.Type == "attachment" && r.Attachment.Type == "queued_command" && r.Attachment.CommandMode == "prompt" {
		return r.Attachment.Prompt
	}
	if r.Type != "user" {
		return ""
	}
	if blocks, ok := r.Message.Content.([]any); ok {
		for _, entry := range blocks {
			block, _ := entry.(map[string]any)
			if block["type"] == "tool_result" {
				return ""
			}
		}
	}
	text := contentText(r.Message.Content, "text")
	if strings.HasPrefix(text, "[Request interrupted") {
		return ""
	}
	return text
}

func (r transcriptRecord) assistantText() string {
	if r.Type == "assistant" && !r.Sidechain && !r.APIError {
		return strings.TrimSpace(contentText(r.Message.Content, "text"))
	}
	return ""
}

func lastAnswer(records []transcriptRecord) *assistantAnswer {
	for index := len(records) - 1; index >= 0; index-- {
		last := records[index]
		if last.assistantText() == "" {
			continue
		}
		var blocks []string
		for _, row := range records[:index+1] {
			if row.Message.ID == last.Message.ID {
				if text := row.assistantText(); text != "" {
					blocks = append(blocks, text)
				}
			}
		}
		return &assistantAnswer{Text: strings.Join(blocks, "\n\n"), UUID: last.UUID, Timestamp: last.Timestamp}
	}
	return nil
}

type transcriptAnalysis struct {
	markerFound, turnEnded bool
	markerAt               string
	apiError               string
	answer                 *assistantAnswer
}

func analyzeTranscript(records []transcriptRecord, start int, marker string) transcriptAnalysis {
	tail := records[start+1:]
	info := transcriptAnalysis{answer: lastAnswer(tail)}
	lastActivity, lastEnd := -1, -1
	for index, row := range tail {
		if marker != "" && !info.markerFound && strings.Contains(row.assistantText(), "[["+marker+"]]") {
			info.markerFound, info.markerAt = true, row.Timestamp
		}
		if !row.Sidechain && (row.Type == "user" || row.Type == "assistant" || row.Subtype == "turn_started" || row.Attachment.Type == "queued_command") {
			lastActivity = index
		}
		if row.Type == "system" && row.Subtype == "turn_duration" {
			lastEnd = index
		}
		if row.Type == "assistant" && !row.Sidechain {
			info.apiError = ""
			if row.APIError {
				info.apiError = choose(contentText(row.Message.Content, "text"), "ошибка API")
			}
		}
	}
	info.turnEnded = lastEnd > lastActivity && tail[lastEnd].Background == 0
	return info
}

func acceptedRecord(records []transcriptRecord, text string, since time.Time) *transcriptRecord {
	normalize := func(text string) string {
		return strings.Join(strings.Fields(pasteMarker.ReplaceAllString(text, " ")), " ")
	}
	probe := []rune(normalize(text))
	prefix := string(probe[:min(200, len(probe))])
	for _, row := range records {
		stamp, _ := time.Parse(time.RFC3339Nano, row.Timestamp)
		if !stamp.IsZero() && stamp.Before(since.Add(-2*time.Second)) {
			continue
		}
		if prompt := row.prompt(); prompt != "" && strings.HasPrefix(normalize(prompt), prefix) {
			return &row
		}
	}
	return nil
}
