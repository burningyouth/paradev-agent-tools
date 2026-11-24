package agent

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"slices"
	"strings"
)

type planHunk struct {
	Path    string          `json:"path"`
	Include json.RawMessage `json:"include"`
}

type planEntry struct {
	message string
	paths   []string
	hunks   []planHunk
	close   string
}

var taskPattern = regexp.MustCompile(`^[A-Za-z0-9_./-]+$`)

func readPlan(path string) ([]planEntry, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fail(exitError, "План %s не читается как JSON: %v", path, err)
	}
	if !json.Valid(data) {
		return nil, fail(exitError, "План %s не читается как JSON", path)
	}
	var entries []json.RawMessage
	if json.Unmarshal(data, &entries) != nil {
		var obj struct{ Commits []json.RawMessage }
		_ = json.Unmarshal(data, &obj)
		entries = obj.Commits
	}
	if len(entries) == 0 {
		return nil, fail(exitError, `План — непустой массив коммитов или { "commits": [...] }`)
	}
	plan := make([]planEntry, 0, len(entries))
	for index, raw := range entries {
		entry, err := parsePlanEntry(raw, index+1)
		if err != nil {
			return nil, err
		}
		plan = append(plan, entry)
	}
	return plan, nil
}

func parsePlanEntry(raw json.RawMessage, number int) (planEntry, error) {
	var fields map[string]json.RawMessage
	bad := func(message string) (planEntry, error) {
		return planEntry{}, fail(exitCheck, "Коммит %d: %s", number, message)
	}
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return bad("ожидается объект")
	}
	var unknown []string
	for field := range fields {
		if !slices.Contains([]string{"message", "paths", "hunks", "closeChange"}, field) {
			unknown = append(unknown, field)
		}
	}
	if len(unknown) != 0 {
		slices.Sort(unknown)
		return bad("неизвестные поля " + strings.Join(unknown, ", "))
	}
	entry := planEntry{paths: []string{}, hunks: []planHunk{}}
	if value, ok := fields["paths"]; ok {
		if err := json.Unmarshal(value, &entry.paths); err != nil || entry.paths == nil || slices.Contains(entry.paths, "") {
			return bad("paths — массив непустых строк")
		}
	}
	if value, ok := fields["hunks"]; ok && string(value) != "null" {
		var hunks []map[string]json.RawMessage
		if err := json.Unmarshal(value, &hunks); err != nil {
			return bad("hunks — массив")
		}
		for _, h := range hunks {
			path := h["path"]
			var name string
			if len(path) == 0 || path[0] != '"' || json.Unmarshal(path, &name) != nil || len(h["include"]) == 0 {
				return bad("каждый элемент hunks — { path, include }")
			}
			if slices.Contains(entry.paths, name) {
				return bad(fmt.Sprintf("%s есть и в paths, и в hunks", name))
			}
			entry.hunks = append(entry.hunks, planHunk{Path: name, Include: h["include"]})
		}
	}
	if message := fields["message"]; len(message) > 0 {
		_ = json.Unmarshal(message, &entry.message)
		entry.message = strings.TrimSpace(entry.message)
	}
	hasContent := len(entry.paths)+len(entry.hunks) > 0
	if hasContent && entry.message == "" {
		return bad("нужно message")
	}
	if value, ok := fields["closeChange"]; ok {
		if err := json.Unmarshal(value, &entry.close); err != nil || !taskPattern.MatchString(entry.close) {
			return bad("closeChange — имя задачи: латиница, цифры, . / _ -")
		}
	}
	if !hasContent && entry.close == "" {
		return bad("нет ни paths, ни hunks, ни closeChange")
	}
	return entry, nil
}
