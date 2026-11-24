package agent

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
)

type hookInput struct {
	Event         string `json:"hook_event_name"`
	SessionID     string `json:"session_id"`
	Cwd           string `json:"cwd"`
	Subagent      string `json:"agent_id"`
	OtherSubagent string `json:"agentId"`
	Source        string `json:"source"`
	Reason        string `json:"reason"`
	LastAssistant string `json:"last_assistant_message"`
}

type hookTarget struct {
	Agent      string `json:"agent"`
	NativeID   string `json:"nativeSessionId"`
	Workspace  string `json:"workspace"`
	Terminal   string `json:"terminal"`
	RuntimePID string `json:"runtimePid"`
}

type hookBinding struct {
	Target          hookTarget    `json:"target"`
	Session         sessionRecord `json:"session"`
	EventCwd        string        `json:"eventCwd"`
	Owner           *slotOwner    `json:"owner"`
	SlotBlocked     bool          `json:"slotBlocked,omitempty"`
	ProjectBranch   bool          `json:"projectBranch,omitempty"`
	SlotBlockReason string        `json:"slotBlockReason,omitempty"`
	Incarnation     string        `json:"incarnation"`
}

func hookResult(status string, fields map[string]any) result {
	if fields == nil {
		fields = map[string]any{}
	}
	fields["status"] = status
	encoded, _ := json.Marshal(fields)
	return result{data: fields, text: string(encoded)}
}

func hookIgnored(reason string) result {
	return hookResult("ignored", map[string]any{"reason": reason})
}

func hookTitle(out result, name string) result {
	base := slotPattern.FindString(name)
	if base != "" && (name == base || name == base+" · чат") {
		out.runtimeOutput = map[string]any{"hookSpecificOutput": map[string]any{
			"hookEventName":     "UserPromptSubmit",
			"additionalContext": "Если из поручения понятна тема работы, дай текущему слоту название. Выполни из текущей папки paradev-agent slot title --title \"<тема в 2–6 словах>\" или вызови MCP chat_title. Для приветствия без темы оставь имя как есть.",
		}}
	}
	return out
}

func sameRecordBinding(current, binding sessionRecord) bool {
	if current == nil || binding == nil || current.string("id") == "" {
		return false
	}
	for _, key := range []string{"id", "sessionId", "terminal", "workspace", "nativeSessionId", "lifecycleId"} {
		if current.string(key) != binding.string(key) {
			return false
		}
	}
	return true
}

func currentHookRecord(env environment, binding sessionRecord) (sessionRecord, error) {
	reg, _, err := loadRegistry(env)
	if err != nil {
		return nil, err
	}
	for _, row := range reg.Sessions {
		if sameRecordBinding(row, binding) {
			return row, nil
		}
	}
	return nil, fail(exitCheck, "Сессия уже возобновлена или переназначена — старое событие отменено")
}

func liveFromRecord(record sessionRecord) liveSession {
	return liveSession{
		kind: record.string("kind"), agent: record.string("agent"), id: record.string("sessionId"), nativeID: record.string("nativeSessionId"),
		workspaceID: record.string("workspace"), workspaceName: record.string("workspaceName"), project: record.string("project"),
		terminal: record.string("terminal"), cwd: record.string("cwd"), alias: record.string("alias"), title: record.string("title"),
	}
}

func (p paradev) sessionHook(action, agent string, input hookInput) (result, error) {
	if !slices.ContainsFunc(hookEvents, func(event hookEvent) bool { return event.action == action && event.event == input.Event }) {
		return result{}, fail(exitError, "Неизвестное событие hook или несовпадение команды и JSON")
	}
	if agent != "codex" && agent != "claude" {
		return result{}, fail(exitError, "--agent: выберите codex или claude")
	}
	if active := p.env.get("SUPERSET_AGENT_ID"); input.Subagent != "" || input.OtherSubagent != "" || active != "" && active != agent {
		return hookIgnored("subagent-or-foreign-harness"), nil
	}
	if action == "session-end" && slices.Contains([]string{"clear", "compact"}, input.Reason) {
		return hookIgnored("context-reset"), nil
	}
	if action == "session-start" && slices.Contains([]string{"clear", "compact", "fork"}, input.Source) {
		return hookIgnored("context-reset-or-fork"), nil
	}
	target := hookTarget{Agent: agent, NativeID: input.SessionID, Workspace: p.env.get("SUPERSET_WORKSPACE_ID"),
		Terminal: p.env.get("SUPERSET_TERMINAL_ID"), RuntimePID: p.env.get("AGENT_HOOK_RUNTIME_PID")}
	if target.Workspace != "" && target.Terminal != "" && (action == "user-prompt-submit" || action == "session-end") {
		state, err := p.chatState(target.Workspace)
		if err != nil {
			return result{}, err
		}
		if state.Active != nil && state.Active.Terminal == target.Terminal {
			out := hookIgnored("managed-by-paradev-host")
			if action == "user-prompt-submit" && state.Active.Ready && state.Active.ProjectOwner != nil {
				out = hookTitle(out, state.Active.Name)
			}
			return out, nil
		}
		for _, terminal := range state.Parked {
			if terminal == target.Terminal {
				return hookIgnored("managed-by-paradev-host"), nil
			}
		}
	}
	raw, _ := json.Marshal(target)
	path := filepath.Join(p.env.agentHome, "hook-sessions", fmt.Sprintf("%x.json", sha256.Sum256(raw)))
	if action == "user-prompt-submit" {
		if agent != "codex" || target.Workspace == "" {
			return hookIgnored("outside-paradev-chat"), nil
		}
		return p.promptHook(input, target, path), nil
	}
	pid, _ := strconv.Atoi(target.RuntimePID)
	if target.NativeID == "" || target.Workspace == "" || target.Terminal == "" || pid <= 1 {
		return hookIgnored("missing-exact-identity"), nil
	}
	var binding *hookBinding
	if err := readJSON(path, &binding); err != nil {
		return result{}, err
	}
	if action == "session-end" {
		if binding == nil {
			return hookIgnored("no-session-start-checkpoint"), nil
		}
		if input.Cwd == "" || canonicalPath(input.Cwd) != binding.EventCwd {
			return result{}, fail(exitCheck, "cwd события не совпадает с сохранённой сессией")
		}
		return p.queueSessionEnd(*binding, input.Reason)
	}
	workspaces, err := p.workspaces()
	if err != nil {
		return result{}, err
	}
	ws, err := exactWorkspace(workspaces, target.Workspace)
	if err != nil || input.Cwd == "" || !containsPath(ws.WorktreePath, input.Cwd) {
		return result{}, fail(exitCheck, "Workspace или cwd события не совпадает с окружением")
	}
	sessions, _, err := p.listSessions(workspaces, false, ws.ID)
	if err != nil {
		return result{}, err
	}
	matches := slices.DeleteFunc(sessions, func(s liveSession) bool {
		return s.workspaceID != ws.ID || s.agent != agent || s.terminal != target.Terminal ||
			s.kind == "chat" && s.nativeID != "" && s.nativeID != target.NativeID ||
			s.kind != "chat" && (s.id != target.NativeID || s.pid != pid)
	})
	if len(matches) != 1 {
		return hookIgnored("no-exact-root-session"), nil
	}
	session := matches[0]
	session.cwd = ws.WorktreePath
	if session.kind == "chat" {
		session.nativeID = target.NativeID
	}
	var owner *slotOwner
	var selected slot
	if slotPattern.MatchString(ws.Name) {
		selected, err = p.findSlot(ws.ID, ws.ProjectName)
		if err != nil {
			return result{}, err
		}
		if selected.checkout == "" || canonicalPath(selected.WorktreePath) == canonicalPath(selected.checkout) {
			return result{}, fail(exitCheck, "Основная копия не является слотом")
		}
		current, err := p.ownership(selected)
		if err != nil {
			return result{}, err
		}
		owner = &current
		if action == "stop" && binding != nil && binding.Owner != nil &&
			(binding.Owner.Generation != owner.Generation || binding.Owner.Branch != owner.Branch) {
			valid, err := p.validProjectBranch(selected, binding.Owner, *owner, binding.ProjectBranch)
			if err != nil {
				return result{}, err
			}
			if !valid {
				return result{}, fail(exitCheck, "Назначение слота изменилось; checkpoint старой сессии не переназначается")
			}
		}
	}
	note := input.LastAssistant
	if note == "" {
		if content, err := p.transcript(session, time.Now().Add(4*time.Second)); err == nil {
			if answer := lastAnswer(content.records); answer != nil {
				note = answer.Text
			}
		}
	}
	patch := sessionRecord{}
	var expected sessionRecord
	event := "checkpoint"
	newBinding := action == "session-start" || binding == nil
	if action == "session-start" {
		event = "observed"
		patch["lifecycleId"] = uuid()
	} else if binding != nil {
		expected = binding.Session
	}
	record, err := p.saveSessionWithBinding(session, event, truncateRunes(note, 4000), "", patch, time.Now().UTC(), true, expected)
	if err != nil {
		return result{}, err
	}
	if newBinding {
		binding = &hookBinding{Incarnation: uuid()}
	}
	binding.Target, binding.Session, binding.EventCwd, binding.Owner = target, record, canonicalPath(input.Cwd), owner
	if newBinding && owner != nil && agent == "codex" && session.kind == "chat" {
		chat := chatTarget{Workspace: ws.ID, Cwd: ws.WorktreePath, SessionID: session.id, Terminal: session.terminal}
		available, err := p.recordedChatAssignment(selected, *owner, chat, session.nativeID, false)
		if err != nil {
			return result{}, err
		}
		binding.SlotBlocked = !available
	}
	if err := atomicJSON(path, binding); err != nil {
		return result{}, err
	}
	return hookResult("checkpoint", map[string]any{"recordId": record.string("id")}), nil
}

func (p paradev) validProjectBranch(s slot, old *slotOwner, current slotOwner, allowed bool) (bool, error) {
	if !allowed || old == nil {
		return false, nil
	}
	g := gitClient{ctx: p.ctx, env: p.env, cwd: s.WorktreePath}
	cfg, err := loadSlotConfig(s)
	if err != nil {
		return false, err
	}
	main, err := mainBranch(g, cfg)
	if err != nil {
		return false, err
	}
	active := &chatAssignment{Branch: old.Branch, Name: old.Name, ProjectOwner: old}
	return p.matchesChatCheckout(s, active, current, main), nil
}

func (p paradev) promptHook(input hookInput, target hookTarget, path string) result {
	ctx, cancel := context.WithTimeout(p.ctx, 110*time.Second)
	defer cancel()
	check := p
	check.ctx = ctx
	var binding *hookBinding
	err := readJSON(path, &binding)
	var admitted *slot
	if err == nil {
		admitted, err = check.promptSlot(input, target)
	}
	if err == nil && admitted != nil && binding != nil {
		var owner slotOwner
		owner, err = check.ownership(*admitted)
		if err == nil {
			binding.Owner = &owner
			binding.ProjectBranch = binding.ProjectBranch || owner.Branch == ""
			binding.SlotBlocked, binding.SlotBlockReason = false, ""
			err = atomicJSON(path, binding)
		}
	}
	if err == nil {
		if admitted != nil {
			return hookTitle(hookResult("admitted", nil), admitted.Name)
		}
		return hookResult("ignored", nil)
	}
	reason := "Не удалось проверить или подготовить слот."
	var failure *agentError
	if errors.As(err, &failure) {
		reason = strings.SplitN(err.Error(), "\n", 2)[0]
	}
	question := reason
	if !strings.HasSuffix(reason, "?") {
		question += " Как продолжить работу со слотом?"
	}
	if binding != nil {
		binding.SlotBlocked, binding.SlotBlockReason = true, question
		_ = atomicJSON(path, binding)
	}
	p.notifyHook(target.Workspace, "Проверка рабочего слота", question, 2*time.Second)
	out := hookResult("blocked", map[string]any{"reason": reason})
	out.runtimeOutput = map[string]any{"decision": "block", "reason": question}
	return out
}

func (p paradev) promptSlot(input hookInput, target hookTarget) (*slot, error) {
	workspaces, err := p.workspaces()
	if err != nil {
		return nil, err
	}
	ws, err := exactWorkspace(workspaces, target.Workspace)
	if err != nil || input.Cwd == "" || !containsPath(ws.WorktreePath, input.Cwd) {
		return nil, fail(exitCheck, "Не удалось подтвердить workspace чата. Где продолжить задачу?")
	}
	if !slotPattern.MatchString(ws.Name) {
		return nil, nil
	}
	pid, _ := strconv.Atoi(target.RuntimePID)
	if target.Terminal == "" || target.NativeID == "" || pid <= 1 {
		return nil, fail(exitCheck, "Не удалось подтвердить идентификаторы этого чата. Какой слот использовать для задачи?")
	}
	initial, err := p.findSlot(ws.ID, ws.ProjectName)
	if err != nil {
		return nil, err
	}
	if !initial.exists || initial.checkout == "" || canonicalPath(initial.WorktreePath) == canonicalPath(initial.checkout) ||
		!containsPath(initial.WorktreePath, p.env.cwd) {
		return nil, fail(exitCheck, "Путь чата не совпал с отдельным рабочим слотом. Какой слот использовать для задачи?")
	}
	for _, running := range initial.sessions {
		if running.kind == "cli" && running.agent == target.Agent && running.id == target.NativeID &&
			running.terminal == target.Terminal && running.pid == pid {
			return nil, nil
		}
	}
	owner, err := p.ownership(initial)
	if err != nil {
		return nil, err
	}
	runtime, err := p.confirmedPromptChat(initial, target, pid)
	if err != nil {
		return nil, err
	}
	g := gitClient{ctx: p.ctx, env: p.env, cwd: initial.WorktreePath}
	root, err := g.git("rev-parse", "--show-toplevel")
	if err != nil || canonicalPath(strings.TrimSpace(root)) != canonicalPath(initial.WorktreePath) {
		return nil, fail(exitCheck, "Путь слота не является корнем Git worktree")
	}
	cfg, err := loadSlotConfig(initial)
	if err != nil {
		return nil, err
	}
	main, err := mainBranch(g, cfg)
	if err != nil {
		return nil, err
	}
	base := slotPattern.FindString(initial.Name)
	owned, err := p.recordedChatAssignment(initial, owner, runtime, target.NativeID, false)
	if err != nil {
		return nil, err
	}
	owned = owned && owner.Branch != main
	if owned && initial.Name != base {
		return &initial, nil
	}
	var admitted *slot
	_, err = p.withSlotLock(initial.ID, initial.WorktreePath, func() (result, error) {
		current, err := p.ownedSlot(owner)
		if err != nil {
			return result{}, err
		}
		if _, err := p.confirmedPromptChat(current, target, pid); err != nil {
			return result{}, err
		}
		owned, err := p.recordedChatAssignment(current, owner, runtime, target.NativeID, false)
		if err != nil {
			return result{}, err
		}
		if !owned || owner.Branch == main {
			if current.Name != base && (!isChatName(current.Name, base) || owner.Branch != "") {
				return result{}, fail(exitCheck, "Слот %s уже назначен задаче. В каком слоте продолжить работу?", current.Name)
			}
			if err := requireCleanSlot(g); err != nil {
				return result{}, err
			}
			merged, err := mergedInto(g, cfg, main)
			if err != nil {
				return result{}, err
			}
			if owner.Branch != "" || !merged {
				return result{}, fail(exitCheck, "В слоте %s есть другая ветка или невлитая история. В каком слоте продолжить работу?", current.Name)
			}
			if err := p.advanceSlot(current); err != nil {
				return result{}, err
			}
			owner, err = p.ownership(current)
			if err != nil {
				return result{}, err
			}
			session := liveSession{kind: "chat", agent: "codex", id: runtime.SessionID, nativeID: target.NativeID,
				terminal: target.Terminal, workspaceID: current.ID, workspaceName: current.Name, project: current.ProjectName, cwd: current.WorktreePath}
			patch := sessionRecord{"status": "open", "slotAdmission": sessionRecord{"workspace": current.ID, "path": owner.Path,
				"slotName": current.Name, "branch": owner.Branch, "generation": owner.Generation, "projectBranch": true}}
			if _, err := p.saveLiveSession(session, "checkpoint", "", "", patch, time.Now().UTC(), true); err != nil {
				return result{}, err
			}
		}
		if current.Name == base && p.renameSlot(current.ID, base+" · чат", 2*time.Second) == nil {
			current.Name = base + " · чат"
		}
		admitted = &current
		return result{}, nil
	})
	return admitted, err
}

func (p paradev) confirmedPromptChat(s slot, target hookTarget, pid int) (chatTarget, error) {
	rows, err := p.chatList(s.ID)
	if err != nil {
		return chatTarget{}, err
	}
	var own *chatSession
	live := 0
	for i := range rows {
		row := &rows[i]
		if row.Live {
			live++
			if strings.HasPrefix(row.Harness, "codex") && row.SessionID != "" && nonemptyString(row.TerminalID) == target.Terminal &&
				(row.HarnessSessionID == nil || *row.HarnessSessionID == target.NativeID) {
				own = row
			}
		}
	}
	if own == nil || live != 1 {
		return chatTarget{}, fail(exitCheck, "Не удалось однозначно подтвердить этот чат по workspace и terminal ID")
	}
	chat := chatTarget{Workspace: s.ID, Cwd: s.WorktreePath, SessionID: own.SessionID, Terminal: target.Terminal}
	for _, session := range s.sessions {
		if session.kind != "chat" || !chat.matchesSession(session) {
			return chatTarget{}, fail(exitCheck, "Слот %s занят другой сессией", s.Name)
		}
	}
	if reservationActive(s) {
		var owner struct{ SessionID string }
		if err := json.Unmarshal(s.reservation, &owner); err != nil || owner.SessionID != own.SessionID {
			return chatTarget{}, fail(exitCheck, "Слот %s зарезервирован другим чатом", s.Name)
		}
	}
	processes, err := agentProcesses(p.ctx, p.env, true)
	if err != nil {
		return chatTarget{}, err
	}
	for _, proc := range processes {
		terminal, ws, err := processIDs(p.ctx, p.env, proc.pid)
		if err != nil {
			return chatTarget{}, err
		}
		meta, err := nativeSession(p.ctx, p.env, proc)
		if err != nil {
			return chatTarget{}, err
		}
		if (ws == s.ID || meta.Cwd != "" && containsPath(s.WorktreePath, meta.Cwd)) &&
			(proc.pid != pid || proc.agent != target.Agent || terminal != target.Terminal || ws != s.ID) {
			return chatTarget{}, fail(exitCheck, "Слот %s занят другим или неидентифицированным процессом", s.Name)
		}
	}
	return chat, nil
}

func (p paradev) notifyHook(ws, title, body string, timeout time.Duration) map[string]any {
	out, err := p.env.run(p.ctx, p.config.Superset, []string{"notifications", "show", title, "--body", body, "--workspace", ws, "--json"},
		commandOptions{timeout: timeout, env: []string{"SUPERSET_TERMINAL_ID="}})
	if err != nil {
		return map[string]any{"status": "error", "error": err.Error()}
	}
	if out.status != 0 {
		return map[string]any{"status": "error"}
	}
	return map[string]any{"status": "accepted"}
}
