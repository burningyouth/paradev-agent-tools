package agent

import (
	"regexp"
	"slices"
	"strconv"
	"strings"
)

var (
	screenRule       = regexp.MustCompile(`^\s*[─━═\-_]{8,}\s*$`)
	screenOption     = regexp.MustCompile(`^\s*([❯›>]\s*)?(\d+)[.)]\s+(\S.*?)\s*$`)
	screenPermission = regexp.MustCompile(`(?i)Do you want to|Would you like to|Yes, and don't ask again|Yes, allow|Claude needs your permission|allow .* to (?:run|use|access)`)
	screenQuestion   = regexp.MustCompile(`(?i)Enter to select|Type something|Chat about this|Review your answers|Submit answers`)
)

var waitingLabel = map[string]string{
	"question": "вопрос с вариантами", "permission": "запрос разрешения", "unknown": "ждёт ответа",
}

func parsePromptScreen(screen string) *waitPrompt {
	lines := strings.Split(screen, "\n")
	for i := range lines {
		lines[i] = trimEnd(lines[i])
	}
	for len(lines) > 0 && (strings.TrimSpace(lines[len(lines)-1]) == "" || screenRule.MatchString(lines[len(lines)-1])) {
		lines = lines[:len(lines)-1]
	}
	anchor := slices.IndexFunc(lines, screenOption.MatchString)
	if anchor < 0 {
		anchor = len(lines)
	}
	start := max(0, anchor-15)
	for i := anchor - 1; i >= start; i-- {
		if screenRule.MatchString(lines[i]) {
			start = i + 1
			break
		}
	}
	lines = slices.DeleteFunc(lines[start:], screenRule.MatchString)
	text := strings.TrimSpace(strings.Join(lines, "\n"))
	if text == "" {
		return nil
	}
	options := []map[string]any{}
	for _, line := range lines {
		if m := screenOption.FindStringSubmatch(line); m != nil {
			n, _ := strconv.Atoi(m[2])
			options = append(options, map[string]any{"n": n, "label": m[3], "selected": m[1] != ""})
		}
	}
	kind := "unknown"
	switch {
	case screenPermission.MatchString(text):
		kind = "permission"
	case screenQuestion.MatchString(text) || len(options) != 0:
		kind = "question"
	}
	return &waitPrompt{Kind: kind, Text: text, Options: options}
}
