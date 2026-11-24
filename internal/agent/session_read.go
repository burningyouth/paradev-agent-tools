package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"
)

func closeResult(path string) (result, error) {
	var data sessionRecord
	if err := readJSON(path, &data); err != nil {
		return result{}, err
	}
	if data.string("status") == "" {
		return result{}, fail(exitError, "Нет результата закрытия")
	}
	code, _ := data["code"].(float64)
	formatted, err := json.MarshalIndent(data, "", "  ")
	return result{data: data, text: string(formatted), code: exitCode(code)}, err
}

func (p paradev) lookupSession(ref, exactWorkspaceID string) (liveSession, error) {
	workspaces, err := p.workspaces()
	if err != nil {
		return liveSession{}, err
	}
	if exactWorkspaceID != "" {
		if _, err := exactWorkspace(workspaces, exactWorkspaceID); err != nil {
			return liveSession{}, err
		}
		all, _, err := p.listSessions(workspaces, true, exactWorkspaceID)
		if err != nil {
			return liveSession{}, err
		}
		matches := slices.DeleteFunc(all, func(s liveSession) bool {
			return s.workspaceID != exactWorkspaceID || s.id != ref || s.terminal == ""
		})
		if len(matches) != 1 {
			return liveSession{}, fail(exitGone, "Сессия %s не найдена однозначно в workspace %s. Проверьте актуальный ID.", ref, exactWorkspaceID)
		}
		return matches[0], nil
	}
	if ref == "" {
		all, _, err := p.listSessions(workspaces, false, "")
		if err != nil {
			return liveSession{}, err
		}
		matches := currentSessions(p.env, all, nil)
		if len(matches) == 0 && p.env.get("CODEX_THREAD_ID") == "" {
			ws, err := currentWorkspace(p.env, workspaces, true)
			if err != nil {
				return liveSession{}, fail(codeOf(err), "%v — укажите ID или алиас: agent last <ID|алиас>", err)
			}
			matches = currentSessions(p.env, all, ws)
		}
		const hint = "укажите ID или алиас: agent last <ID|алиас>. Список — paradev-agent ls"
		switch len(matches) {
		case 0:
			return liveSession{}, fail(exitGone, "В текущем контексте нет живой сессии — %s", hint)
		case 1:
			return matches[0], nil
		default:
			return liveSession{}, fail(exitError, "В текущем контексте несколько сессий — %s", hint)
		}
	}

	reg, _, err := loadRegistry(p.env)
	if err != nil {
		return liveSession{}, err
	}
	alias := reg.Aliases[ref]
	target := choose(alias, ref)
	var record sessionRecord
	for index := len(reg.Sessions) - 1; index >= 0; index-- {
		row := reg.Sessions[index]
		if matchesSessionRecord(row, target) || alias == "" && row.string("alias") == ref {
			record = row
			break
		}
	}
	terminal := choose(record.string("sessionId"), target)
	all, _, err := p.listSessions(workspaces, true, record.string("workspace"))
	if err != nil {
		return liveSession{}, err
	}
	all = slices.DeleteFunc(all, func(s liveSession) bool { return s.terminal == "" })
	for _, s := range all {
		if s.terminal == terminal || s.id == terminal || s.nativeID == terminal {
			s.alias = choose(s.alias, record.string("alias"))
			return s, nil
		}
	}
	if len(terminal) >= 6 {
		matches := slices.DeleteFunc(all, func(s liveSession) bool {
			return !strings.HasPrefix(s.terminal, terminal) && !strings.HasPrefix(s.id, terminal) && !strings.HasPrefix(s.nativeID, terminal)
		})
		switch len(matches) {
		case 0:
		case 1:
			return matches[0], nil
		default:
			return liveSession{}, fail(exitError, "Префикс %s подходит нескольким терминалам — уточните", terminal)
		}
	}
	hint := ""
	if alias != "" {
		hint = fmt.Sprintf(" (алиас %s → %s)", ref, alias)
	}
	return liveSession{}, fail(exitGone, "Живая Codex/Claude-сессия в терминале %s не найдена%s. Список — paradev-agent ls", terminal, hint)
}

func sessionLast(p paradev, ref, workspaceID string) (result, error) {
	s, err := p.lookupSession(ref, workspaceID)
	if err != nil {
		return result{}, err
	}
	info, err := p.transcript(s, time.Time{})
	if err != nil {
		return result{}, err
	}
	answer := lastAnswer(info.records)
	note := ""
	if answer != nil {
		text := []rune(answer.Text)
		note = string(text[:min(4000, len(text))])
	}
	event := "observed"
	if s.chat != nil && !s.chat.Live {
		event = "checkpoint"
	}
	if err := p.recordLiveSession(s, event, note, "", time.Now().UTC()); err != nil {
		return result{}, err
	}
	wait := p.waiting(s, info)
	if wait == nil && answer == nil {
		return result{}, fail(exitError, "В журнале сессии ещё нет ответа ассистента")
	}
	payload := map[string]any{"terminal": s.terminal, "sessionId": nonempty(s.id), "waiting": wait}
	var text []string
	if answer != nil {
		payload["text"], payload["timestamp"], payload["uuid"] = answer.Text, answer.Timestamp, answer.UUID
		text = append(text, answer.Text)
	}
	if wait != nil {
		text = append(text, fmt.Sprintf("— на экране (%s):\n%s", waitingLabel[wait.Kind], wait.Text))
	}
	return result{data: payload, text: strings.Join(text, "\n\n")}, nil
}

func sessionJournal(p paradev, ref, workspaceID, after string, limit int) (result, error) {
	s, err := p.lookupSession(ref, workspaceID)
	if err != nil {
		return result{}, err
	}
	info, err := p.transcript(s, time.Time{})
	if err != nil {
		return result{}, err
	}
	start := -1
	if after != "" {
		start = slices.IndexFunc(info.records, func(r transcriptRecord) bool { return r.UUID == after })
		if start == -1 {
			return result{}, fail(exitError, "Якорь не найден. Проверьте актуальный sessionId и журнал.")
		}
	}
	entries := []map[string]any{}
	for _, row := range info.records[start+1:] {
		role, text := "user", row.prompt()
		if text == "" {
			role, text = "assistant", row.assistantText()
		}
		if text != "" {
			entries = append(entries, map[string]any{
				"anchor": row.UUID, "timestamp": row.Timestamp, "role": role, "text": text, "queued": row.Type == "attachment",
			})
		}
	}
	if limit < 1 {
		limit = 20
	}
	if limit > 200 {
		return result{}, fail(exitError, "limit должен быть от 1 до 200")
	}
	data := map[string]any{"workspace": s.workspaceID, "sessionId": s.id, "state": info.state,
		"waiting": info.waiting, "entries": entries[max(0, len(entries)-limit):]}
	return result{data: data}, nil
}

type waitOptions struct {
	ref, workspace, after, marker string
	timeout, interval             time.Duration
}

func sessionWait(p paradev, opts waitOptions) (result, error) {
	if opts.ref == "" {
		return result{}, fail(exitError, "Укажите терминал или алиас сессии")
	}
	deadline := time.Now().Add(opts.timeout)
	for {
		s, err := p.lookupSession(opts.ref, opts.workspace)
		if err != nil {
			return result{}, err
		}
		info, err := p.transcript(s, time.Time{})
		if err != nil {
			return result{}, err
		}
		start := -1
		if opts.after != "" {
			start = slices.IndexFunc(info.records, func(row transcriptRecord) bool { return row.UUID == opts.after })
			if start < 0 {
				return result{}, fail(exitError, "Якорь %s не найден в журнале сессии %s (после /clear журнал новый)", opts.after, s.id)
			}
		} else {
			for i := len(info.records) - 1; i >= 0; i-- {
				if info.records[i].prompt() != "" {
					start = i
					break
				}
			}
		}
		analysis := analyzeTranscript(info.records, start, opts.marker)
		reason, code := waitVerdict(analysis, info.state, opts.marker, !time.Now().Before(deadline))
		if reason != "" {
			return waitResult(p, s, info, analysis, reason, code, opts.marker), nil
		}
		if err := pause(p.ctx, min(time.Until(deadline), opts.interval)); err != nil {
			return result{}, err
		}
	}
}

func waitVerdict(info transcriptAnalysis, state, marker string, timedOut bool) (string, exitCode) {
	switch {
	case info.markerFound:
		return "marker", exitOK
	case info.apiError != "":
		return "api-error", exitAPIError
	case state == "waiting":
		return "waiting", exitWaiting
	case info.turnEnded && state == "idle":
		if marker != "" {
			return "idle-no-marker", exitIdle
		}
		return "idle", exitOK
	case timedOut:
		return "timeout", exitTimeout
	default:
		return "", exitOK
	}
}

func waitResult(p paradev, s liveSession, info transcript, analysis transcriptAnalysis, reason string, code exitCode, marker string) result {
	labels := map[string]string{
		"marker": "маркер найден", "idle": "ход закончен", "idle-no-marker": "ход закончен без маркера",
		"waiting": "ждёт разрешения или ответа", "api-error": "ошибка API", "timeout": "таймаут",
	}
	var answer any
	text := "(ответа после якоря нет)"
	if analysis.answer != nil {
		answer, text = analysis.answer, analysis.answer.Text
	}
	if reason == "api-error" {
		answer, text = map[string]any{"text": analysis.apiError, "timestamp": nil}, analysis.apiError
	}
	label := labels[reason]
	var wait *waitPrompt
	if reason == "waiting" {
		wait = p.waiting(s, info)
		if wait != nil {
			text += fmt.Sprintf("\n\n— на экране (%s):\n%s", waitingLabel[wait.Kind], wait.Text)
			label += ": " + waitingLabel[wait.Kind]
		}
	}
	return result{code: code, text: text + "\n\n— " + label, data: map[string]any{
		"reason": reason, "code": code, "marker": nonempty(marker), "terminal": s.terminal, "sessionId": nonempty(s.id),
		"answer": answer, "waiting": wait,
	}}
}

func pause(ctx context.Context, wait time.Duration) error {
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func secondsOption(key, raw string, fallback int) (time.Duration, error) {
	if raw == "" {
		return time.Duration(fallback) * time.Second, nil
	}
	seconds, err := strconv.ParseFloat(raw, 64)
	if err != nil || !(seconds > 0 && seconds <= float64((time.Duration(1<<63-1))/time.Second)) {
		return 0, fail(exitError, "--%s: укажите положительное число секунд", key)
	}
	return time.Duration(seconds * float64(time.Second)), nil
}
