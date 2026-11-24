package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
	"time"
)

type closeOptions struct {
	Workspace     string `json:"workspace,omitempty"`
	Project       string `json:"project,omitempty"`
	Note          string `json:"note,omitempty"`
	SummaryFile   string `json:"summaryFile,omitempty"`
	Reason        string `json:"reason,omitempty"`
	Result        string `json:"result,omitempty"`
	Dry           bool   `json:"dryRun,omitempty"`
	SessionOnly   bool   `json:"session-only,omitempty"`
	Force         bool   `json:"force,omitempty"`
	AfterReply    bool   `json:"afterReply,omitempty"`
	Offline       bool   `json:"offline,omitempty"`
	SkipTidy      bool   `json:"skipTidy,omitempty"`
	Recover       bool   `json:"recoverMerged,omitempty"`
	exact         bool
	expectedOwner *slotOwner
}

func sessionStopped(s liveSession) bool { return s.chat != nil && !s.chat.Live }

func sameLive(a, b liveSession) bool {
	return a.kind == b.kind && a.agent == b.agent && a.id == b.id &&
		a.terminal == b.terminal && a.workspaceID == b.workspaceID &&
		(a.nativeID == "" || a.nativeID == b.nativeID)
}

func (p paradev) closeCommand(ref string, opts closeOptions) (result, error) {
	if opts.Result != "" {
		return closeResult(absoluteOption(p.env, opts.Result))
	}
	if opts.AfterReply && (opts.Workspace == "" || ref == "" || opts.Force) {
		return result{}, fail(exitCheck, "Для --after-reply нужны точные UUID сессии и workspace; --force несовместим")
	}
	if opts.SessionOnly && ref == "" && opts.Workspace != "" {
		return result{}, fail(exitCheck, "Для закрытия только сессии укажите её UUID")
	}
	workspaces, err := p.workspaces()
	if err != nil {
		return result{}, err
	}
	var ws workspace
	var session *liveSession
	var historical sessionRecord
	if opts.Workspace != "" {
		ws, err = describeWorkspace(workspaces, opts.Workspace)
		if err != nil {
			return result{}, err
		}
	}
	if ref != "" || ws.ID == "" {
		scope := ""
		if opts.exact || opts.AfterReply {
			scope = ws.ID
		}
		found, err := p.lookupSession(ref, scope)
		if err != nil && (codeOf(err) != exitGone || ws.ID != "") {
			return result{}, err
		}
		if err == nil {
			if ws.ID != "" && found.workspaceID != ws.ID {
				return result{}, fail(exitCheck, "Сессия принадлежит другому workspace")
			}
			session = &found
			ws, err = describeWorkspace(workspaces, found.workspaceID)
			if err != nil {
				return result{}, err
			}
		} else if ref != "" {
			reg, _, regErr := loadRegistry(p.env)
			if regErr != nil {
				return result{}, regErr
			}
			found := slices.DeleteFunc(reg.Sessions, func(s sessionRecord) bool { return !matchesSessionRecord(s, ref) })
			if len(found) != 1 {
				return result{}, err
			}
			historical = found[0]
			ws, err = describeWorkspace(workspaces, historical.string("workspace"))
			if err != nil {
				return result{}, err
			}
		} else {
			target, err := currentWorkspace(p.env, workspaces, true)
			if err != nil {
				return result{}, err
			}
			ws = *target
		}
	}
	if opts.Project != "" && ws.ProjectName != opts.Project {
		return result{}, fail(exitCheck, "Workspace принадлежит другому проекту")
	}
	if session != nil && sessionStopped(*session) {
		reg, _, err := loadRegistry(p.env)
		if err != nil {
			return result{}, err
		}
		for _, row := range reg.Sessions {
			if matchesSessionRecord(row, session.id) {
				historical = row
			}
		}
		if historical == nil {
			return result{}, fail(exitCheck, "Нет сохранённого назначения закрытой сессии — выберите пустой слот явно через --workspace")
		}
		session = nil
	}
	var targetSlot *slot
	if !opts.SessionOnly && slotPattern.MatchString(ws.Name) {
		found, err := p.findSlot(ws.ID, ws.ProjectName)
		if err != nil {
			return result{}, err
		}
		if err := p.checkCloseSlot(found, session, historical); err != nil {
			return result{}, err
		}
		targetSlot = &found
	}
	if session == nil && targetSlot == nil {
		return result{}, fail(exitGone, "Нет живой сессии или слота — укажите ID или алиас")
	}
	state := ""
	if session != nil {
		if session.id == "" {
			return result{}, fail(exitCheck, "Нет UUID сессии — автоматическое продолжение невозможно; сессия не закрыта")
		}
		info, err := p.transcript(*session, time.Time{})
		if err != nil {
			return result{}, err
		}
		state = info.state
		if state == "waiting" {
			return result{}, fail(exitWaiting, "Сессия ждёт решения — сначала ответьте на вопрос или разрешение")
		}
	}
	if opts.AfterReply && (session == nil || session.chat == nil || session.id != ref ||
		ws.ID != opts.Workspace || !containsPath(ws.WorktreePath, p.env.cwd)) {
		return result{}, fail(exitCheck, "Для --after-reply нужен точный живой чат в выбранном workspace и его cwd")
	}
	self := session != nil && p.ownSession(*session)
	receipt := opts.AfterReply || self && session.chat != nil && (targetSlot != nil || opts.SessionOnly)
	if state == "working" && !opts.Force && !receipt {
		return result{}, fail(exitCheck, "Сессия работает — дождитесь завершения или явно укажите --force. Для своего чата используйте --after-reply с точными UUID.")
	}
	if opts.Dry {
		data := map[string]any{"dryRun": true, "workspace": ws.ID, "sessionId": nil, "release": targetSlot != nil}
		var lines []string
		if session != nil {
			data["sessionId"] = session.id
			line := "Закрыть " + session.id
			if receipt {
				data["afterReply"] = true
				line += " после финального ответа"
			}
			lines = append(lines, line)
		}
		if targetSlot != nil {
			lines = append(lines, "освободить "+targetSlot.Name+" и проверить результат")
		}
		return result{data: data, text: strings.Join(lines, ". ")}, nil
	}
	opts.Workspace = ws.ID
	if receipt {
		return p.queueFinish(ws, targetSlot, *session, opts)
	}
	if self {
		note, err := p.closeNote(session, opts)
		if err != nil {
			return result{}, err
		}
		opts.Note = note
		if _, err := p.saveLiveSession(*session, "checkpoint", note, "", sessionRecord{"closeReason": choose(opts.Reason, "close")}, time.Now().UTC(), true); err != nil {
			return result{}, err
		}
		return p.queueClose(*session, opts)
	}
	return p.closeTarget(ws, targetSlot, session, historical, opts)
}

func (p paradev) ownSession(s liveSession) bool {
	terminal, thread := p.env.get("SUPERSET_TERMINAL_ID"), p.env.get("CODEX_THREAD_ID")
	return terminal != "" && terminal == s.terminal || thread != "" && s.agent == "codex" && (thread == s.id || thread == s.nativeID)
}

func (p paradev) closeNote(s *liveSession, opts closeOptions) (string, error) {
	if opts.SummaryFile != "" {
		content, err := os.ReadFile(absoluteOption(p.env, opts.SummaryFile))
		return strings.TrimSpace(string(content)), err
	}
	if opts.Note != "" {
		return opts.Note, nil
	}
	if s != nil {
		if info, err := p.transcript(*s, time.Time{}); err == nil {
			if answer := lastAnswer(info.records); answer != nil {
				return truncateRunes(answer.Text, 4000), nil
			}
			return "Последний ответ отсутствует", nil
		}
		reg, _, err := loadRegistry(p.env)
		if err != nil {
			return "", err
		}
		for i := len(reg.Sessions) - 1; i >= 0; i-- {
			if row := reg.Sessions[i]; matchesSessionRecord(row, s.id) && row.string("note") != "" {
				return row.string("note"), nil
			}
		}
	}
	return "Состояние сохранено перед закрытием", nil
}

func truncateRunes(text string, maxLen int) string {
	data := []rune(text)
	return string(data[:min(len(data), maxLen)])
}

func (p paradev) checkCloseSlot(s slot, own *liveSession, historical sessionRecord) error {
	if !s.exists || s.checkout == "" || canonicalPath(s.WorktreePath) == canonicalPath(s.checkout) {
		return fail(exitCheck, "Нужен существующий отдельный слот с известной основной копией")
	}
	for _, live := range s.sessions {
		if own == nil || !sameLive(*own, live) {
			return fail(exitCheck, "В слоте другая активная сессия — слот не освобождён")
		}
	}
	if other, err := p.foreignNative(s, own); err != nil || other {
		if err != nil {
			return err
		}
		return fail(exitCheck, "В слоте другой native-процесс — слот не освобождён")
	}
	g := gitClient{ctx: p.ctx, env: p.env, cwd: s.WorktreePath}
	info, err := g.describe()
	if err != nil {
		return err
	}
	if info == nil || len(info.Changes) > 0 {
		return fail(exitCheck, "Слот грязный — закоммитьте или сохраните правки по процессу проекта; сессия оставлена открытой")
	}
	if busy, err := checkoutOperation(g); err != nil || busy {
		if err != nil {
			return err
		}
		return fail(exitCheck, "В слоте незавершённая операция Git")
	}
	if historical != nil {
		return checkHistoricalSlot(g, s, info, historical)
	}
	return nil
}

func checkHistoricalSlot(g gitClient, s slot, info *gitStatus, saved sessionRecord) error {
	if project := saved.string("project"); project != "" && project != s.ProjectName {
		return fail(exitCheck, "Сохранённое назначение сессии не совпадает со слотом — чужую задачу не освобождаю")
	}
	if path := saved.string("cwd"); path != "" && canonicalPath(path) != canonicalPath(s.WorktreePath) ||
		info.Branch != nil && *info.Branch != saved.string("branch") {
		return fail(exitCheck, "Сохранённое назначение сессии не совпадает со слотом — чужую задачу не освобождаю")
	}
	if path := saved.string("gitCommonDir"); path != "" {
		dir, err := g.git("rev-parse", "--path-format=absolute", "--git-common-dir")
		if err != nil {
			return err
		}
		if canonicalPath(strings.TrimSpace(dir)) != path {
			return fail(exitCheck, "Сохранённое назначение сессии не совпадает со слотом — чужую задачу не освобождаю")
		}
	}
	if task := saved.string("task"); task != "" {
		base := slotPattern.FindString(s.Name)
		if s.Name != base && s.Name != base+" · "+task {
			return fail(exitCheck, "Сохранённое назначение сессии не совпадает со слотом — чужую задачу не освобождаю")
		}
	}
	return nil
}

func (p paradev) foreignNative(s slot, own *liveSession) (bool, error) {
	rows, err := agentProcesses(p.ctx, p.env, true)
	if err != nil {
		return false, err
	}
	for _, row := range rows {
		terminal, ws, err := processIDs(p.ctx, p.env, row.pid)
		if err != nil {
			return false, err
		}
		metadata, err := nativeSession(p.ctx, p.env, row)
		if err != nil {
			return false, err
		}
		same := own != nil && (terminal != "" && terminal == own.terminal ||
			metadata.SessionID != "" && metadata.SessionID == choose(own.nativeID, own.id))
		if (same || ws == s.ID || containsPath(s.WorktreePath, metadata.Cwd)) &&
			(own == nil || (!same && (terminal != "" || metadata.SessionID != ""))) {
			return true, nil
		}
	}
	return false, nil
}

func (p paradev) closeTransport(s liveSession, opts closeOptions) (sessionRecord, error) {
	fresh, err := p.lookupSession(s.id, s.workspaceID)
	if err != nil {
		return nil, err
	}
	if !sameLive(s, fresh) {
		return nil, fail(exitCheck, "Сессия изменилась перед закрытием")
	}
	info, err := p.transcript(fresh, time.Time{})
	if err != nil {
		return nil, err
	}
	if info.state == "waiting" {
		return nil, fail(exitWaiting, "Сессия ждёт ответа или разрешения — закрытие отменено")
	}
	if info.state == "working" && !opts.Force {
		return nil, fail(exitError, "Сессия работает — закрытие прервёт её. Дождитесь (paradev-agent wait) или добавьте --force")
	}
	note, err := p.closeNote(&fresh, opts)
	if err != nil {
		return nil, err
	}
	patch := sessionRecord{"closeReason": choose(opts.Reason, "close"), "sessionOnly": opts.SessionOnly}
	if _, err := p.saveLiveSession(fresh, "close-requested", note, "", patch, time.Now().UTC(), true); err != nil {
		return nil, err
	}
	var closeErr error
	if fresh.chat != nil {
		var response any
		closeErr = p.call(&response, append([]string{"sessions", "close"}, chatArguments(fresh)...)...)
		if closeErr == nil {
			closeErr = p.waitForChatExit(fresh, 90*time.Second)
		}
		if closeErr == nil {
			closeErr = p.clearChatReservation(fresh)
		}
	} else {
		_, closeErr = p.closeTerminal(fresh.workspaceID, fresh.terminal)
		if closeErr == nil {
			closeErr = p.waitForProcessExit(fresh.pid, 10*time.Second)
		}
	}
	if closeErr != nil {
		_, err := p.saveLiveSession(fresh, "close-failed", note, "", sessionRecord{"error": closeErr.Error()}, time.Now().UTC(), false)
		return nil, errors.Join(closeErr, err)
	}
	return p.saveLiveSession(fresh, "closed", note, "", nil, time.Now().UTC(), false)
}

func (p paradev) waitForChatExit(s liveSession, wait time.Duration) error {
	return p.waitForClose(wait, "Chat не завершился — закрытие не подтверждено", func() (bool, error) {
		rows, err := p.chatList(s.workspaceID)
		return !slices.ContainsFunc(rows, func(chat chatSession) bool { return chat.Live && chat.SessionID == s.id }), err
	})
}

func (p paradev) waitForProcessExit(pid int, wait time.Duration) error {
	return p.waitForClose(wait, "Процесс сессии не завершился — закрытие не подтверждено", func() (bool, error) {
		rows, err := agentProcesses(p.ctx, p.env, false)
		return !slices.ContainsFunc(rows, func(proc agentProcess) bool { return proc.pid == pid }), err
	})
}

func (p paradev) waitForClose(wait time.Duration, message string, exited func() (bool, error)) error {
	deadline := time.Now().Add(wait)
	for {
		finished, err := exited()
		if err != nil || finished {
			return err
		}
		if !time.Now().Before(deadline) {
			return fail(exitTimeout, "%s", message)
		}
		if err := pause(p.ctx, min(time.Until(deadline), 500*time.Millisecond)); err != nil {
			return err
		}
	}
}

type chatReservation struct {
	Active sessionRecord     `json:"active"`
	Parked map[string]string `json:"parked"`
}

func (p paradev) clearChatReservation(s liveSession) error {
	path := chatSlotPath(p.env, s.workspaceID)
	var state chatReservation
	if err := readJSON(path, &state); err != nil {
		return err
	}
	if state.Active.string("sessionId") != s.id || state.Active.string("terminal") != s.terminal {
		return nil
	}
	state.Active = nil
	if state.Parked == nil {
		state.Parked = map[string]string{}
	}
	state.Parked[s.id] = s.terminal
	return atomicJSON(path, state)
}

func (p paradev) closeTarget(ws workspace, requested *slot, session *liveSession, historical sessionRecord, opts closeOptions) (result, error) {
	run := func() (result, error) {
		closeState := map[string]any{"status": "already-closed"}
		release := map[string]any{"status": "not-applicable"}
		tidied := []map[string]any{}
		var owner slotOwner
		if requested != nil {
			actual, err := p.findSlot(requested.ID, requested.ProjectName)
			if err != nil {
				return result{}, err
			}
			if canonicalPath(requested.WorktreePath) != canonicalPath(actual.WorktreePath) || actual.Name != requested.Name {
				return result{}, fail(exitCheck, "Назначение слота изменилось до закрытия")
			}
			if err := p.checkCloseSlot(actual, session, historical); err != nil {
				return result{}, err
			}
			owner, err = p.ownership(actual)
			if err != nil {
				return result{}, err
			}
			if opts.expectedOwner != nil && owner != *opts.expectedOwner {
				return result{}, fail(exitCheck, "Принадлежность слота изменилась — старая операция отменена")
			}
			if opts.expectedOwner != nil && historical != nil {
				if _, err := currentHookRecord(p.env, historical); err != nil {
					return result{}, err
				}
			}
			if opts.Recover {
				git := gitClient{ctx: p.ctx, env: p.env, cwd: actual.WorktreePath}
				cfg, err := loadSlotConfig(actual)
				if err != nil {
					return result{}, err
				}
				main, err := mainBranch(git, cfg)
				if err != nil {
					return result{}, err
				}
				merged, err := mergedInto(git, cfg, main)
				if err != nil {
					return result{}, err
				}
				if owner.Branch == "" || owner.Branch == main || cfg.Slot.Release != "" || !merged || reservationActive(actual) {
					return result{}, fail(exitCheck, "Невозможно подтвердить, что прежнюю задачу можно освободить")
				}
			}
			release["status"] = "pending"
		}
		var closed []sessionRecord
		if session != nil {
			record, err := p.closeTransport(*session, opts)
			if err != nil {
				return result{}, err
			}
			closed = append(closed, record)
			closeState["status"] = "closed"
		} else if requested != nil {
			var err error
			closed, err = p.closeSlotHistory(*requested, owner, historical, opts)
			if err != nil {
				return result{}, err
			}
		}
		partial := func(err error) (result, error) {
			status := release["status"]
			if status == "pending" {
				status = "unverified"
			}
			var id any
			if session != nil {
				id = nonempty(session.id)
			}
			return result{}, &agentError{code: codeOf(err), message: err.Error(), details: map[string]any{
				"status": "partial", "workspace": ws.ID, "sessionId": id, "close": closeState,
				"release": map[string]any{"status": status},
			}}
		}
		if session != nil && session.chat == nil && !opts.SessionOnly && !opts.SkipTidy {
			var err error
			tidied, err = p.tidyWorkspace(ws.ID)
			if err != nil {
				return partial(err)
			}
		}
		var files *syncResult
		text := "Сессия закрыта"
		if requested != nil {
			var fresh slot
			err := p.waitForClose(90*time.Second, "Сессия/native-процессы не завершились — слот не освобождён", func() (bool, error) {
				var err error
				fresh, err = p.ownedSlot(owner)
				if err != nil {
					return false, err
				}
				native, err := p.nativeInSlot(fresh)
				return !native && len(fresh.sessions) == 0, err
			})
			if err != nil {
				return partial(err)
			}
			if err := atomicJSON(slotStatePath(p.env, fresh.WorktreePath)+".json", map[string]string{"generation": uuid()}); err != nil {
				return partial(err)
			}
			release, err = p.completeLocked(fresh, releaseOptions{offline: opts.Offline, cached: opts.expectedOwner != nil})
			if err != nil {
				release = map[string]any{"status": "unverified"}
				return partial(err)
			}
			release["status"] = "released"
			report := release["result"].(releaseReport)
			files = report.LocalFiles
			text = fmt.Sprintf("Сессия закрыта, слот %s освобождён и проверен", report.Slot)
			for _, record := range closed {
				if _, err := p.saveSessionWithBinding(liveFromRecord(record), "released", "", "", sessionRecord{"release": release}, time.Now().UTC(), false, record); err != nil {
					return partial(err)
				}
			}
		}
		data := sessionRecord{}
		if len(closed) > 0 {
			for key, value := range closed[0] {
				data[key] = value
			}
		}
		data["status"], data["workspace"], data["tidied"], data["close"], data["release"] = "completed", ws.ID, tidied, closeState, release
		if requested != nil {
			data["localFiles"] = files
		}
		return result{data: data, text: strings.Join(append([]string{text}, formatSync(files, "  ")...), "\n")}, nil
	}
	if requested != nil || opts.SessionOnly {
		return p.withSlotLock(ws.ID, ws.WorktreePath, run)
	}
	return run()
}

func (p paradev) closeSlotHistory(s slot, owner slotOwner, previous sessionRecord, opts closeOptions) ([]sessionRecord, error) {
	var matches []sessionRecord
	if previous != nil {
		matches = []sessionRecord{previous}
	} else if owner.Branch != "" {
		registry, _, err := loadRegistry(p.env)
		if err != nil {
			return nil, err
		}
		for _, record := range registry.Sessions {
			if record.string("workspace") == s.ID && record.string("status") == "open" && record.string("branch") == owner.Branch &&
				(record.string("project") == "" || record.string("project") == s.ProjectName) &&
				record.string("cwd") != "" && canonicalPath(record.string("cwd")) == owner.Path {
				matches = append(matches, record)
			}
		}
	}
	if len(matches) == 0 {
		return nil, nil
	}
	git := gitClient{ctx: p.ctx, env: p.env, cwd: owner.Path}
	info := &gitStatus{Branch: stringPtr(owner.Branch)}
	for _, record := range matches {
		if err := checkHistoricalSlot(git, s, info, record); err != nil {
			return nil, err
		}
	}
	closed := make([]sessionRecord, 0, len(matches))
	for _, record := range matches {
		saved, err := p.saveSessionWithBinding(liveFromRecord(record), "closed", opts.Note, "",
			sessionRecord{"closeReason": choose(opts.Reason, choose(record.string("closeReason"), "close"))}, time.Now().UTC(), false, record)
		if err != nil {
			return nil, err
		}
		closed = append(closed, saved)
	}
	return closed, nil
}

func parseJobResult(raw any) (map[string]any, error) {
	data, err := json.Marshal(raw)
	if err != nil {
		return nil, err
	}
	var value map[string]any
	err = json.Unmarshal(data, &value)
	return value, err
}

func closeCLIOptions(opts options) closeOptions {
	return closeOptions{Workspace: opts.flags["workspace"], Project: opts.flags["project"], Note: opts.flags["note"],
		SummaryFile: opts.flags["summary-file"], Reason: opts.flags["reason"], Result: opts.flags["result"],
		Dry: opts.flags["dry-run"] == "true", SessionOnly: opts.flags["session-only"] == "true",
		Force: opts.flags["force"] == "true", AfterReply: opts.flags["after-reply"] == "true", Offline: opts.flags["offline"] == "true"}
}
