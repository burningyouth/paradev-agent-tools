package agent

import (
	"bytes"
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

type sessionRecord map[string]any

func (r sessionRecord) string(key string) string {
	value, _ := r[key].(string)
	return value
}

func (r sessionRecord) strings(key string) []string {
	values, _ := r[key].([]any)
	result := make([]string, 0, len(values))
	for _, value := range values {
		if str, ok := value.(string); ok {
			result = append(result, str)
		}
	}
	return result
}

type historyEvent struct {
	Version int64         `json:"version"`
	Type    string        `json:"type"`
	At      string        `json:"at"`
	Record  sessionRecord `json:"record"`
}

type registry struct {
	Sessions       []sessionRecord   `json:"sessions"`
	Aliases        map[string]string `json:"aliases"`
	Keep           []string          `json:"keep"`
	HistoryVersion int64             `json:"historyVersion"`
	extra          map[string]json.RawMessage
}

func (r *registry) UnmarshalJSON(data []byte) error {
	type base registry
	if err := json.Unmarshal(data, (*base)(r)); err != nil {
		return err
	}
	if err := json.Unmarshal(data, &r.extra); err != nil {
		return err
	}
	for _, key := range []string{"sessions", "aliases", "keep", "historyVersion"} {
		delete(r.extra, key)
	}
	return nil
}

func (r registry) MarshalJSON() ([]byte, error) {
	type base registry
	if len(r.extra) == 0 {
		return json.Marshal(base(r))
	}
	known, err := json.Marshal(base(r))
	if err != nil {
		return nil, err
	}
	fields := make(map[string]json.RawMessage)
	if err := json.Unmarshal(known, &fields); err != nil {
		return nil, err
	}
	for key, value := range r.extra {
		fields[key] = value
	}
	return json.Marshal(fields)
}

func loadRegistry(env environment) (registry, []historyEvent, error) {
	var reg registry
	if err := readJSON(filepath.Join(env.agentHome, "sessions.json"), &reg); err != nil {
		return reg, nil, err
	}
	if reg.Sessions == nil {
		reg.Sessions = []sessionRecord{}
	}
	if reg.Aliases == nil {
		reg.Aliases = map[string]string{}
	}
	if reg.Keep == nil {
		reg.Keep = []string{}
	}
	events, err := loadHistoryEvents(filepath.Join(env.agentHome, "session-log.jsonl"))
	if err != nil {
		return reg, nil, err
	}
	for _, event := range events {
		if event.Version > reg.HistoryVersion {
			reg.replay(event)
		}
	}
	return reg, events, nil
}

func loadHistoryEvents(path string) ([]historyEvent, error) {
	events := []historyEvent{}
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return events, nil
	}
	if err != nil {
		return nil, err
	}
	// Only complete newline-delimited records were committed by the writer.
	prefix := bytes.LastIndexByte(data, '\n') + 1
	for line := range bytes.SplitSeq(data[:prefix], []byte{'\n'}) {
		if len(line) == 0 {
			continue
		}
		var event historyEvent
		if err := json.Unmarshal(line, &event); err != nil ||
			event.Version < 1 || event.Version > 1<<53-1 || event.Type == "" || event.Record.string("id") == "" {
			return nil, fail(exitCheck, "Повреждён журнал %s", path)
		}
		events = append(events, event)
	}
	return events, nil
}

func (r *registry) replay(event historyEvent) {
	record := event.Record
	sessionID := record.string("sessionId")
	terminal := record.string("terminal")
	agent := record.string("agent")
	previousIDs := record.strings("sessionIds")
	r.Sessions = slices.DeleteFunc(r.Sessions, func(old sessionRecord) bool {
		if old.string("id") == record.string("id") {
			return true
		}
		if choose(old.string("agent"), "claude") != agent {
			return false
		}
		if id := old.string("sessionId"); id != "" {
			return id == sessionID || slices.Contains(previousIDs, id)
		}
		return old.string("terminal") != "" && old.string("terminal") == terminal
	})
	if event.Type != "forgotten" {
		r.Sessions = append(r.Sessions, record)
	}
	if from := record.string("resumedFrom"); from != "" && sessionID != "" &&
		slices.Contains(r.Keep, from) && !slices.Contains(r.Keep, sessionID) {
		r.Keep = append(r.Keep, sessionID)
	}
	alias := record.string("alias")
	if alias != "" {
		switch event.Type {
		case "created", "resumed", "observed", "alias-changed":
			if terminal != "" {
				r.Aliases[alias] = terminal
			}
		case "closed", "forgotten":
			if r.Aliases[alias] == terminal {
				delete(r.Aliases, alias)
			}
		}
	}
	r.HistoryVersion = event.Version
}

func sessionLog(env environment, project, task string) (result, error) {
	reg, all, err := loadRegistry(env)
	if err != nil {
		return result{}, err
	}
	sessions := slices.DeleteFunc(reg.Sessions, func(record sessionRecord) bool {
		return (project != "" && record.string("project") != project) ||
			(task != "" && record.string("task") != task)
	})
	slices.SortStableFunc(sessions, func(a, b sessionRecord) int {
		return cmp.Compare(choose(b.string("updatedAt"), b.string("closedAt")), choose(a.string("updatedAt"), a.string("closedAt")))
	})
	ids := make(map[string]bool, len(sessions))
	lines := make([]string, 0, len(sessions))
	for _, record := range sessions {
		if id := record.string("id"); id != "" {
			ids[id] = true
		}
		lines = append(lines, formatSessionHistory(record))
	}
	events := make([]historyEvent, 0)
	for _, event := range all {
		if ids[event.Record.string("id")] {
			events = append(events, event)
		}
	}
	return result{
		data: map[string]any{"sessions": sessions, "events": events},
		text: choose(strings.Join(lines, "\n"), "История сессий пуста"),
	}, nil
}

func formatSessionHistory(record sessionRecord) string {
	state := "unknown"
	if record.string("closedAt") != "" {
		state = "closed"
	}
	fallback := func(field string) string { return choose(record.string(field), "—") }
	line := fmt.Sprintf("%s  %s/%s  %s  %s/%s  %s  %s\n  workspace %s · %s · ветка %s · %s",
		fallback("alias"), choose(record.string("agent"), "claude"), choose(record.string("kind"), "cli"),
		choose(record.string("sessionId"), "(нет UUID)"), fallback("project"), fallback("task"),
		choose(record.string("status"), state), choose(record.string("updatedAt"), fallback("closedAt")),
		fallback("workspace"), fallback("workspaceName"), fallback("branch"), fallback("cwd"))
	for _, entry := range [][2]string{{"nativeSessionId", "native UUID "}, {"closeReason", "причина: "}, {"note", ""}} {
		if value := record.string(entry[0]); value != "" {
			line += "\n  " + entry[1] + value
		}
	}
	return line
}
