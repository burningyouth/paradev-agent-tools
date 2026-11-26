package agent

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

type chatTarget struct {
	Workspace string `json:"workspace"`
	SessionID string `json:"sessionId"`
	Terminal  string `json:"terminal"`
	Cwd       string `json:"cwd"`
}

type chatAssignment struct {
	chatTarget
	Ready        bool       `json:"ready"`
	Branch       string     `json:"branch"`
	Name         string     `json:"name"`
	ProjectOwner *slotOwner `json:"projectOwner,omitempty"`
	Completion   *slotOwner `json:"completion,omitempty"`
}

type chatSlotState struct {
	Active     *chatAssignment   `json:"active"`
	Parked     map[string]string `json:"parked"`
	Superseded map[string]string `json:"superseded,omitempty"`
}

var chatIdentity = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

func (p paradev) chatState(workspace string) (chatSlotState, error) {
	state := chatSlotState{Parked: map[string]string{}}
	err := readJSON(chatSlotPath(p.env, workspace), &state)
	if state.Parked == nil {
		state.Parked = map[string]string{}
	}
	return state, err
}

func (p paradev) saveChatState(workspace string, state chatSlotState) error {
	return atomicJSON(chatSlotPath(p.env, workspace), state)
}

func (t chatTarget) matchesSession(s liveSession) bool {
	return t.SessionID == s.id && t.Terminal == s.terminal
}

func (t chatTarget) matchesRow(s chatSession) bool {
	return t.SessionID == s.SessionID && t.Terminal == choose(nonemptyString(s.TerminalID), s.SessionID)
}

func nonemptyString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func isChatName(name, base string) bool {
	return base != "" && (name == base+" · чат" || strings.HasPrefix(name, base+" — "))
}

func chatReply(status string, extra map[string]any) result {
	if extra == nil {
		extra = map[string]any{}
	}
	extra["status"] = status
	label, _ := extra["question"].(string)
	return result{data: extra, text: choose(label, status)}
}

func chatBlocked(question string) result {
	return chatReply("blocked", map[string]any{"question": question})
}

func (p paradev) chatAvailable(s slot, t chatTarget, rows []chatSession) (bool, error) {
	for _, session := range s.sessions {
		if session.kind != "chat" || !t.matchesSession(session) && session.state != "idle" {
			return false, nil
		}
	}
	for _, row := range rows {
		if row.Live && !t.matchesRow(row) && !reusableIdleChat(row) {
			return false, nil
		}
	}
	occupied, err := p.nativeInSlot(s)
	return err == nil && !occupied, err
}

func requireCleanSlot(g gitClient) error {
	info, err := g.describe()
	if err != nil {
		return err
	}
	busy, err := checkoutOperation(g)
	if err != nil {
		return err
	}
	if info == nil || len(info.Changes) != 0 || busy {
		return fail(exitCheck, "Слот содержит изменения или незавершённую операцию Git")
	}
	return nil
}

func (p paradev) advanceSlot(s slot) error {
	return atomicJSON(slotStatePath(p.env, s.WorktreePath)+".json", map[string]string{"generation": uuid()})
}

func (p paradev) matchesChatCheckout(s slot, active *chatAssignment, current slotOwner, main string) bool {
	if active.ProjectOwner != nil && current.Generation != active.ProjectOwner.Generation {
		return false
	}
	if current.Branch == active.Branch && current.Name == active.Name {
		return true
	}
	if active.ProjectOwner == nil {
		return false
	}
	owner := *active.ProjectOwner
	base := slotPattern.FindString(owner.Name)
	marked := current.Name != owner.Name && (owner.Name == base || isChatName(owner.Name, base)) && isChatName(current.Name, base)
	newBranch := owner.Branch == "" && current.Branch != "" && current.Branch != main
	if !marked && !newBranch || !newBranch && current.Branch != owner.Branch {
		return false
	}
	if marked {
		current.Name = owner.Name
	}
	if newBranch {
		current.Head = owner.Head
	}
	current.Branch = owner.Branch
	return current == owner
}

func (p paradev) recordedChatAssignment(s slot, owner slotOwner, target chatTarget, native string, allowUnknown bool) (bool, error) {
	registry, _, err := loadRegistry(p.env)
	if err != nil {
		return false, err
	}
	for _, record := range registry.Sessions {
		known := record.string("nativeSessionId")
		if record.string("status") != "open" || record.string("kind") != "chat" || record.string("agent") != "codex" ||
			record.string("workspace") != s.ID || record.string("sessionId") != target.SessionID ||
			record.string("terminal") != target.Terminal || known != "" && known != native && !(allowUnknown && native == "") {
			continue
		}
		for _, key := range []string{"startup", "slotAdmission"} {
			value, _ := record[key].(map[string]any)
			job := sessionRecord(value)
			projectBranch, _ := job["projectBranch"].(bool)
			if job.string("workspace") == s.ID && job.string("path") == owner.Path && job.string("generation") == owner.Generation &&
				(job.string("slotName") == s.Name || projectBranch && isChatName(s.Name, slotPattern.FindString(job.string("slotName")))) &&
				(job.string("branch") == owner.Branch || projectBranch && job.string("branch") == "") {
				return true, nil
			}
		}
	}
	return false, nil
}

func (p paradev) chatLifecycle(action string, target chatTarget) (result, error) {
	if !chatIdentity.MatchString(target.Workspace) || !chatIdentity.MatchString(target.SessionID) ||
		!chatIdentity.MatchString(target.Terminal) || target.Cwd == "" {
		return result{}, fail(exitError, "Нужны точные workspace, session, terminal и cwd")
	}
	switch action {
	case "reserve", "admit", "completion-pending", "park", "close":
	default:
		return result{}, fail(exitError, "Неизвестное событие жизненного цикла чата")
	}
	if action == "completion-pending" {
		state, err := p.chatState(target.Workspace)
		if err != nil {
			return result{}, err
		}
		if state.Active == nil || !sameChatTarget(state.Active.chatTarget, target) || state.Active.Completion == nil {
			return chatReply("unchanged", nil), nil
		}
	}
	rows, err := p.workspaces()
	if err != nil {
		return result{}, err
	}
	var ws workspace
	for _, row := range rows {
		if row.ID == target.Workspace {
			ws = row
			break
		}
	}
	if ws.ID == "" || ws.WorktreePath == "" || canonicalPath(ws.WorktreePath) != canonicalPath(target.Cwd) {
		return chatBlocked("Путь чата и workspace не совпали. Где продолжить задачу?"), nil
	}
	if slotPattern.FindString(ws.Name) == "" {
		return chatReply("unmanaged", nil), nil
	}
	s, err := p.findSlot(target.Workspace, "")
	if err != nil {
		return result{}, err
	}
	if !s.exists || s.checkout == "" || canonicalPath(s.WorktreePath) == canonicalPath(s.checkout) {
		return chatBlocked("Рабочий слот не подтверждён. Где продолжить задачу?"), nil
	}
	// closeCommand already holds the lock when it asks the host to close a chat.
	if action == "close" {
		registry, _, err := loadRegistry(p.env)
		if err != nil {
			return result{}, err
		}
		for _, row := range registry.Sessions {
			if row.string("workspace") == s.ID && row.string("status") == "closing" &&
				row.string("sessionId") == target.SessionID && row.string("terminal") == target.Terminal {
				return chatReply("unchanged", nil), nil
			}
		}
	}
	output, err := p.withSlotLock(s.ID, s.WorktreePath, func() (result, error) {
		fresh, err := p.findSlot(s.ID, s.ProjectName)
		if err != nil {
			return result{}, err
		}
		if canonicalPath(fresh.WorktreePath) != canonicalPath(target.Cwd) {
			return result{}, fail(exitCheck, "Путь слота изменился")
		}
		return p.chatLifecycleLocked(action, fresh, target)
	})
	if data, ok := output.data.(map[string]any); err == nil && ok &&
		(data["status"] == "parked" || data["status"] == "released" || data["closed"] == true) {
		owner := workerTarget{Kind: "chat", Workspace: target.Workspace, SessionID: target.SessionID, Terminal: target.Terminal}
		extra, releaseErr := p.releaseSessionSlots(owner)
		if len(extra) > 0 {
			data["additionalSlots"] = extra
		}
		if releaseErr != nil {
			message := releaseErr.Error()
			data["releaseError"] = message
			_, _ = p.env.run(p.ctx, p.config.Superset, []string{"notifications", "show", "Часть слотов не освобождена",
				"--body", message, "--workspace", target.Workspace, "--json"}, commandOptions{timeout: 2 * time.Second})
		}
	}
	var failure *agentError
	if errors.As(err, &failure) {
		question := strings.SplitN(err.Error(), "\n", 2)[0] + ". Как продолжить работу со слотом?"
		if action == "close" {
			_, _ = p.env.run(p.ctx, p.config.Superset, []string{"notifications", "show", "Слот не освобождён", "--body", question,
				"--workspace", target.Workspace, "--json"}, commandOptions{timeout: 2 * time.Second})
		}
		return chatBlocked(question), nil
	}
	return output, err
}

func sameChatTarget(a, b chatTarget) bool {
	return a.Workspace == b.Workspace && a.SessionID == b.SessionID && a.Terminal == b.Terminal &&
		canonicalPath(a.Cwd) == canonicalPath(b.Cwd)
}

func (p paradev) chatLifecycleLocked(action string, s slot, target chatTarget) (result, error) {
	state, err := p.chatState(s.ID)
	if err != nil {
		return result{}, err
	}
	active := state.Active
	own := active != nil && sameChatTarget(active.chatTarget, target)
	g := gitClient{ctx: p.ctx, env: p.env, cwd: s.WorktreePath}
	owner, err := p.ownership(s)
	if err != nil {
		return result{}, err
	}
	if action == "completion-pending" {
		if !own || active.Completion == nil {
			return chatReply("unchanged", nil), nil
		}
		if owner == *active.Completion {
			err = requireCleanSlot(g)
			if err == nil {
				return chatReply("pending", nil), nil
			}
		} else {
			err = fail(exitCheck, "Принадлежность слота изменилась")
		}
		active.Completion = nil
		if saveErr := p.saveChatState(s.ID, state); saveErr != nil {
			return result{}, saveErr
		}
		return chatBlocked(strings.SplitN(err.Error(), "\n", 2)[0] + ". Завершение задачи нужно подтвердить заново."), nil
	}
	if action == "park" || action == "close" {
		if !own || action == "park" && active.Completion == nil {
			if action == "close" && (state.Parked[target.SessionID] == target.Terminal || state.Superseded[target.SessionID] == target.Terminal) {
				delete(state.Parked, target.SessionID)
				delete(state.Superseded, target.SessionID)
				return chatReply("unchanged", nil), p.saveChatState(s.ID, state)
			}
			return chatReply("unchanged", nil), nil
		}
		output, err := p.parkChat(s, g, owner, target, state, action)
		if err != nil && action == "park" {
			active.Completion = nil
			err = errors.Join(err, p.saveChatState(s.ID, state))
		}
		return output, err
	}
	if owner.Branch != "" && state.Superseded[target.SessionID] == target.Terminal {
		return chatBlocked("Рабочий слот назначен заново. Этот чат нельзя продолжить в новой ветке."), nil
	}
	if active != nil && !own {
		return chatBlocked("Слот уже зарезервирован другим чатом. Где продолжить задачу?"), nil
	}
	rows, err := p.chatList(s.ID)
	if err != nil {
		return result{}, err
	}
	available, err := p.chatAvailable(s, target, rows)
	if err != nil {
		return result{}, err
	}
	if !available && (active == nil || action == "admit") {
		return chatBlocked("В слоте уже работает другая сессия. Где продолжить задачу?"), nil
	}
	cfg, err := loadSlotConfig(s)
	if err != nil {
		return result{}, err
	}
	main, err := mainBranch(g, cfg)
	if err != nil {
		return result{}, err
	}
	base := slotPattern.FindString(s.Name)
	if active == nil {
		if err := requireCleanSlot(g); err != nil {
			return result{}, err
		}
		merged, err := mergedInto(g, cfg, main)
		if err != nil {
			return result{}, err
		}
		free := owner.Branch == "" && (s.Name == base || isChatName(s.Name, base)) && merged
		reusable := owner.Branch != "" && owner.Branch != main && merged && cfg.Slot.Release == "" &&
			(s.Name == base || strings.HasPrefix(s.Name, base+" · "))
		prepared := false
		for _, row := range rows {
			if owner.Branch != "" && owner.Branch != main && target.matchesRow(row) && strings.HasPrefix(row.Harness, "codex") {
				prepared, err = p.recordedChatAssignment(s, owner, target, nonemptyString(row.HarnessSessionID), false)
				if err != nil {
					return result{}, err
				}
				break
			}
		}
		if !free && !prepared && !reusable {
			return chatBlocked("Слот уже назначен задаче или занят веткой. Где продолжить работу?"), nil
		}
		active = &chatAssignment{chatTarget: target, Name: s.Name, Branch: owner.Branch, Ready: prepared, ProjectOwner: &owner}
		state.Active = active
		if err := p.saveChatState(s.ID, state); err != nil {
			return result{}, err
		}
	}
	if action == "reserve" {
		return chatReply("reserved", nil), nil
	}
	if !p.matchesChatCheckout(s, active, owner, main) {
		return chatBlocked("Назначение рабочего слота изменилось. Где продолжить работу?"), nil
	}
	if !active.Ready {
		if err := requireCleanSlot(g); err != nil {
			return result{}, err
		}
		if owner.Branch != "" {
			return chatBlocked("Слот занят веткой прежней задачи. В каком слоте продолжить работу?"), nil
		}
		merged, err := mergedInto(g, cfg, main)
		if err != nil {
			return result{}, err
		}
		if !merged {
			return chatBlocked("В слоте есть невлитая история Git. В каком слоте продолжить работу?"), nil
		}
		if err := p.advanceSlot(s); err != nil {
			return result{}, err
		}
		current, err := p.ownership(s)
		if err != nil {
			return result{}, err
		}
		active.Ready, active.ProjectOwner = true, &current
		delete(state.Parked, target.SessionID)
		delete(state.Superseded, target.SessionID)
		if err := p.saveChatState(s.ID, state); err != nil {
			return result{}, err
		}
	}
	if active.ProjectOwner != nil && s.Name == base {
		_ = p.renameSlot(s.ID, base+" · чат", 2*time.Second)
	}
	return chatReply("ready", nil), nil
}

func (p paradev) parkChat(s slot, g gitClient, owner slotOwner, target chatTarget, state chatSlotState, action string) (result, error) {
	rows, err := p.chatList(s.ID)
	if err != nil {
		return result{}, err
	}
	available, err := p.chatAvailable(s, target, rows)
	if err != nil {
		return result{}, err
	}
	if !available {
		return result{}, fail(exitCheck, "В слоте остаётся активный процесс или другая сессия")
	}
	if action == "park" && owner != *state.Active.Completion {
		return result{}, fail(exitCheck, "Принадлежность слота изменилась")
	}
	if err := requireCleanSlot(g); err != nil {
		return result{}, err
	}
	cfg, err := loadSlotConfig(s)
	if err != nil {
		return result{}, err
	}
	main, err := mainBranch(g, cfg)
	if err != nil {
		return result{}, err
	}
	if !p.matchesChatCheckout(s, state.Active, owner, main) {
		return result{}, fail(exitCheck, "Назначение слота изменилось")
	}
	base := slotPattern.FindString(s.Name)
	releasable := state.Active.Ready || action == "close" && owner.Branch == "" && isChatName(s.Name, base)
	if !releasable && action == "close" && state.Active.Branch != "" && state.Active.Branch != main && cfg.Slot.Release == "" {
		releasable, err = mergedInto(g, cfg, main)
		if err != nil {
			return result{}, err
		}
	}
	active := state.Active
	state.Active = nil
	state.Parked[target.SessionID] = target.Terminal
	if err := p.saveChatState(s.ID, state); err != nil {
		delete(state.Parked, target.SessionID)
		return result{}, err
	}
	if releasable && (owner.Branch != "" || s.Name != base) {
		err = p.advanceSlot(s)
		if err == nil {
			var fresh slot
			fresh, err = p.findSlot(s.ID, s.ProjectName)
			if err == nil {
				_, err = p.completeLocked(fresh, releaseOptions{cached: action == "close"})
			}
		}
		if err != nil {
			state.Active = active
			delete(state.Parked, target.SessionID)
			return result{}, errors.Join(err, p.saveChatState(s.ID, state))
		}
	}
	if !releasable && owner.Branch != "" {
		return chatReply("unchanged", map[string]any{"closed": true}), nil
	}
	if action == "park" {
		return chatReply("parked", map[string]any{"message": "Задача закрыта, слот освобождён. Отправьте новое поручение, чтобы занять слот снова."}), nil
	}
	return chatReply("released", nil), nil
}

func (p paradev) requestTaskCompletion(workspaceID, sessionID string, dry bool) (result, error) {
	if !chatIdentity.MatchString(workspaceID) || !chatIdentity.MatchString(sessionID) {
		return result{}, fail(exitError, "Укажите точные ID чата и workspace")
	}
	s, err := p.findSlot(workspaceID, "")
	if err != nil {
		return result{}, err
	}
	if s.ID != workspaceID || canonicalPath(s.WorktreePath) != canonicalPath(p.env.cwd) {
		return result{}, fail(exitCheck, "cwd должен совпадать с рабочим слотом")
	}
	return p.withSlotLock(s.ID, s.WorktreePath, func() (result, error) {
		state, err := p.chatState(s.ID)
		if err != nil {
			return result{}, err
		}
		active := state.Active
		if active == nil || !active.Ready || active.SessionID != sessionID || active.Workspace != workspaceID ||
			canonicalPath(active.Cwd) != canonicalPath(s.WorktreePath) {
			return result{}, fail(exitCheck, "У чата нет активного назначения слота")
		}
		s, err := p.findSlot(workspaceID, s.ProjectName)
		if err != nil {
			return result{}, err
		}
		rows, err := p.chatList(s.ID)
		if err != nil {
			return result{}, err
		}
		confirmed := false
		for _, row := range rows {
			confirmed = confirmed || row.Live && active.matchesRow(row)
		}
		if !confirmed {
			return result{}, fail(exitCheck, "Работающий чат с таким назначением не найден")
		}
		g := gitClient{ctx: p.ctx, env: p.env, cwd: s.WorktreePath}
		if err := requireCleanSlot(g); err != nil {
			return result{}, err
		}
		owner, err := p.ownership(s)
		if err != nil {
			return result{}, err
		}
		cfg, err := loadSlotConfig(s)
		if err != nil {
			return result{}, err
		}
		main, err := mainBranch(g, cfg)
		if err != nil {
			return result{}, err
		}
		if owner.Branch == "" || !p.matchesChatCheckout(s, active, owner, main) {
			return result{}, fail(exitCheck, "Назначение задачи изменилось")
		}
		status := "planned"
		if !dry {
			active.Completion = &owner
			if err := p.saveChatState(s.ID, state); err != nil {
				return result{}, err
			}
			status = "queued"
		}
		return chatReply(status, map[string]any{"workspace": workspaceID, "sessionId": sessionID}), nil
	})
}

func (p paradev) titleChat(workspaceID, sessionID, title string) (result, error) {
	title = strings.TrimSpace(title)
	if title == "" || utf8.RuneCountInString(title) > 80 || strings.ContainsFunc(title, func(r rune) bool { return unicode.Is(unicode.C, r) }) {
		return result{}, fail(exitError, "Введите короткое название в одну строку, до 80 символов")
	}
	workspaces, err := p.workspaces()
	if err != nil {
		return result{}, err
	}
	var initial *workspace
	if workspaceID == "" {
		initial, err = currentWorkspace(p.env, workspaces, true)
	} else {
		initial, err = exactWorkspace(workspaces, workspaceID)
	}
	if err != nil {
		return result{}, err
	}
	if initial.slotName() == "" || !containsPath(initial.WorktreePath, p.env.cwd) {
		return result{}, fail(exitCheck, "Нужна рабочая папка отдельного слота")
	}
	return p.withSlotLock(initial.ID, initial.WorktreePath, func() (result, error) {
		s, err := p.findSlot(initial.ID, initial.ProjectName)
		if err != nil {
			return result{}, err
		}
		base := slotPattern.FindString(s.Name)
		if base == "" || canonicalPath(s.WorktreePath) != canonicalPath(initial.WorktreePath) ||
			(s.Name != base && !isChatName(s.Name, base)) {
			return result{}, fail(exitCheck, "Этот слот уже назначен задаче или его назначение изменилось")
		}
		var session *liveSession
		for i := range s.sessions {
			row := &s.sessions[i]
			if row.kind == "chat" && ((sessionID != "" && row.id == sessionID) || sessionID == "" &&
				p.env.get("SUPERSET_WORKSPACE_ID") == s.ID && row.terminal == p.env.get("SUPERSET_TERMINAL_ID")) {
				session = row
			}
		}
		failure := fail(exitCheck, "Не подтверждён единственный работающий чат этого слота")
		if session == nil || len(s.sessions) != 1 {
			return result{}, failure
		}
		target := chatTarget{Workspace: s.ID, SessionID: session.id, Terminal: session.terminal, Cwd: s.WorktreePath}
		if len(s.chats) != 1 || !target.matchesRow(s.chats[0]) {
			return result{}, failure
		}
		state, err := p.chatState(s.ID)
		if err != nil {
			return result{}, err
		}
		managed := state.Active != nil && state.Active.Ready && state.Active.ProjectOwner != nil && sameChatTarget(state.Active.chatTarget, target)
		if managed && state.Active.Completion != nil || !managed && state.Active != nil ||
			state.Superseded[target.SessionID] == target.Terminal {
			return result{}, failure
		}
		if !managed {
			assigned, err := p.slotHasAssignment(s)
			if err != nil {
				return result{}, err
			}
			if assigned {
				return result{}, failure
			}
		}
		name := fmt.Sprintf("%s — %s", base, title)
		if s.Name != name {
			if err := p.renameSlot(s.ID, name, p.timeout); err != nil {
				return result{}, err
			}
		}
		if managed && state.Active.Name != name {
			state.Active.Name = name
			if err := p.saveChatState(s.ID, state); err != nil {
				return result{}, err
			}
		}
		return result{data: map[string]string{"workspace": s.ID, "sessionId": session.id, "name": name}, text: name}, nil
	})
}
