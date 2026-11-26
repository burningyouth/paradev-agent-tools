package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

type launchOptions struct {
	workspace, project, branch, task, from    string
	agent, prompt, alias, model, mode, effort string
	cli, allowCreate, exactWorkspace          bool
}

type chatTransport struct {
	SessionID  string `json:"sessionId"`
	TerminalID string `json:"terminalId"`
}

func describeWorkspace(workspaces []workspace, ref string) (workspace, error) {
	for _, ws := range workspaces {
		if ws.ID == ref {
			return ws, nil
		}
	}
	var matches []workspace
	for _, ws := range workspaces {
		if ws.Name == ref || len(ref) >= 6 && strings.HasPrefix(ws.ID, ref) || slotPattern.FindString(ws.Name) == ref {
			matches = append(matches, ws)
		}
	}
	if len(matches) != 1 {
		return workspace{}, fail(exitError, "Workspace %s не найден однозначно", ref)
	}
	return matches[0], nil
}

func (p paradev) withLaunchLock(call func() (result, error)) (result, error) {
	return p.withSlotLock("session-capacity", filepath.Join(p.env.agentHome, "session-capacity"), call)
}

func (p paradev) createSession(opts launchOptions) (result, error) {
	if strings.TrimSpace(opts.prompt) == "" || opts.workspace == "" && (opts.project == "" || opts.branch == "") {
		return result{}, fail(exitError, "Нужен --prompt-file и либо --workspace, либо --project вместе с --branch")
	}
	if opts.workspace != "" && opts.allowCreate {
		return result{}, fail(exitError, "--allow-create применяется только при автоматическом выборе слота")
	}
	opts.agent = choose(opts.agent, "codex")
	if opts.agent != "codex" && opts.agent != "claude" {
		return result{}, fail(exitError, "--agent: выберите codex или claude")
	}
	if opts.agent == "codex" && !opts.cli && opts.effort != "" {
		return result{}, fail(exitError, "Superset 2.0.2 sessions create не поддерживает --effort. Опустите --effort для настройки пресета или используйте --cli")
	}
	if opts.mode != "" && (opts.agent != "codex" || opts.cli) {
		return result{}, fail(exitError, "--mode применяется только к Codex chat")
	}
	deadline := time.Now().Add(time.Minute)
	for {
		res, err := p.withLaunchLock(func() (result, error) { return p.launchSession(opts) })
		var failure *agentError
		if err == nil || opts.workspace != "" || !time.Now().Before(deadline) ||
			!errors.As(err, &failure) || failure.details["slotLocked"] != true {
			return res, err
		}
		if err := pause(p.ctx, 200*time.Millisecond); err != nil {
			return result{}, err
		}
	}
}

func (p paradev) launchSession(opts launchOptions) (result, error) {
	ws, active, err := p.liveWorkspaces()
	if err != nil {
		return result{}, err
	}
	count := countActivity(active).Working
	if count >= p.config.MaxSessions {
		return result{}, fail(exitLimit, "Выполняется %d из %d сессий — дождитесь свободного места", count, p.config.MaxSessions)
	}
	var target workspace
	switch {
	case opts.workspace == "":
		taken, err := p.takeSlot(slotOptions{project: opts.project, branch: opts.branch, task: opts.task,
			from: opts.from, existingOnly: !opts.allowCreate})
		if err != nil || taken.code != exitOK {
			return taken, err
		}
		data := taken.data.(map[string]any)
		target = workspace{ID: data["workspace"].(string), Name: data["slot"].(string), ProjectName: data["project"].(string),
			WorktreePath: data["path"].(string)}
	case opts.exactWorkspace:
		exact, err := exactWorkspace(ws, opts.workspace)
		if err != nil {
			return result{}, err
		}
		target = *exact
		if !containsPath(target.WorktreePath, p.env.cwd) {
			// Keep accepting the main checkout as project scope for older clients.
			projects, err := p.projects()
			if err != nil {
				return result{}, err
			}
			if !slices.ContainsFunc(projects, func(project project) bool {
				return belongsTo(target, project) && canonicalPath(project.Path) == canonicalPath(p.env.cwd)
			}) {
				return result{}, fail(exitCheck, "cwd не совпал с путём workspace или основной копии проекта")
			}
		}
	default:
		target, err = describeWorkspace(ws, opts.workspace)
		if err != nil {
			return result{}, err
		}
	}
	if !slotPattern.MatchString(target.Name) {
		if opts.branch != "" || opts.task != "" {
			return result{}, fail(exitCheck, "--branch/--task проверяются только при запуске в slot-N")
		}
		return p.launchAgent(target, opts, "", "")
	}
	return p.withSlotLock(target.ID, target.WorktreePath, func() (result, error) {
		slot, err := p.findSlot(target.ID, target.ProjectName)
		if err != nil {
			return result{}, err
		}
		if slot.ID != target.ID || !slotPattern.MatchString(slot.Name) || canonicalPath(slot.WorktreePath) != canonicalPath(target.WorktreePath) ||
			target.ProjectName != "" && slot.ProjectName != target.ProjectName ||
			target.ProjectID != "" && slot.ProjectID != target.ProjectID ||
			slotPattern.FindString(slot.Name) != slotPattern.FindString(target.Name) {
			return result{}, fail(exitCheck, "Назначение workspace изменилось во время запуска — исполнитель не запущен")
		}
		branch, err := p.checkPreparedSlot(slot, opts)
		if err != nil {
			return result{}, err
		}
		generation := uuid()
		path := slotStatePath(p.env, slot.WorktreePath) + ".json"
		var state slotState
		if err := readJSON(path, &state); err != nil {
			return result{}, err
		}
		state.Generation = generation
		if err := atomicJSON(path, state); err != nil {
			return result{}, err
		}
		output, err := p.launchAgent(slot.workspace, opts, branch, generation)
		if err == nil && state.Holder != nil {
			err = atomicJSON(path, slotState{Generation: generation})
		}
		return output, err
	})
}

func (p paradev) liveWorkspaces() ([]workspace, []liveSession, error) {
	ws, err := p.workspaces()
	if err != nil {
		return nil, nil, err
	}
	active, _, err := p.listSessions(ws, false, "")
	return ws, active, err
}

func (p paradev) checkPreparedSlot(slot slot, opts launchOptions) (string, error) {
	if !slot.exists || slot.checkout == "" || canonicalPath(slot.WorktreePath) == canonicalPath(slot.checkout) {
		return "", fail(exitCheck, "Нужен отдельный существующий слот с известной основной копией")
	}
	const occupiedMessage = "В слоте уже есть живая сессия — продолжите её или выделите отдельный слот"
	if reservationActive(slot) || slotSessionsBlockReuse(slot) {
		return "", fail(exitCheck, occupiedMessage)
	}
	if len(slot.chats) != 0 {
		state, err := p.chatState(slot.ID)
		if err != nil {
			return "", err
		}
		if !allChatsSuperseded(slot.chats, state) {
			return "", fail(exitCheck, occupiedMessage)
		}
	}
	occupied, err := p.nativeInSlot(slot)
	if err != nil {
		return "", err
	}
	if occupied {
		return "", fail(exitCheck, occupiedMessage)
	}
	g := gitClient{ctx: p.ctx, env: p.env, cwd: slot.WorktreePath}
	info, err := g.describe()
	if err != nil {
		return "", err
	}
	settings, err := loadSlotConfig(slot)
	if err != nil {
		return "", err
	}
	main, err := mainBranch(g, settings)
	if err != nil {
		return "", err
	}
	base := slotPattern.FindString(slot.Name)
	if info == nil || info.Branch == nil || *info.Branch == main || slot.Name == base {
		return "", fail(exitCheck, "Слот не подготовлен под задачу — сначала slot take/prepare, затем sess create")
	}
	branch := *info.Branch
	if opts.branch != "" && opts.branch != branch || opts.task != "" && slot.Name != base+" · "+opts.task {
		return "", fail(exitCheck, "Слот не соответствует ожидаемой ветке/задаче — исполнитель не запущен")
	}
	if len(info.Changes) != 0 {
		return "", fail(exitCheck, "Слот грязный — исполнитель не запущен")
	}
	return branch, nil
}

func (p paradev) launchAgent(target workspace, opts launchOptions, branch, generation string) (result, error) {
	inSlot := generation != ""
	startup := sessionRecord{"workspace": target.ID, "path": canonicalPath(target.WorktreePath), "branch": nonempty(branch)}
	if inSlot {
		startup["slotName"], startup["generation"] = target.Name, generation
	}
	patch := sessionRecord{"startup": startup}
	for key, value := range map[string]string{"task": opts.task, "model": opts.model, "mode": opts.mode, "effort": opts.effort, "branch": branch} {
		if value != "" {
			patch[key] = value
		}
	}
	prompt := startupPrompt(p.env, target, opts, branch, inSlot)
	session := liveSession{agent: opts.agent, workspaceID: target.ID, workspaceName: target.Name,
		project: target.ProjectName, cwd: target.WorktreePath, alias: opts.alias, kind: "cli"}
	if opts.agent == "codex" && !opts.cli {
		initial := prompt
		if inSlot {
			initial = ""
		}
		reply, err := p.createChat(target.ID, opts, initial)
		if err != nil {
			return result{}, err
		}
		session.kind, session.id, session.terminal = "chat", reply.SessionID, choose(reply.TerminalID, reply.SessionID)
		record, err := p.saveLiveSession(session, "created", "", "", patch, time.Now().UTC(), true)
		if err != nil {
			return result{}, fail(codeOf(err), "Чат %s создан, история не записана: %v", session.id, err)
		}
		rows, err := p.chatList(target.ID)
		if err != nil {
			return result{}, err
		}
		for _, row := range rows {
			if row.SessionID != session.id {
				continue
			}
			if row.HarnessSessionID != nil {
				session.nativeID = *row.HarnessSessionID
			}
			if row.TerminalID != nil && reply.TerminalID == "" {
				session.terminal = *row.TerminalID
			}
		}
		if session.nativeID != "" || session.terminal != record.string("terminal") {
			record, err = p.saveLiveSession(session, "observed", "", "", patch, time.Now().UTC(), true)
			if err != nil {
				return result{}, err
			}
		}
		if inSlot {
			sent, err := p.sendChat(session, prompt, time.Duration(p.config.SendAcceptTimeoutSec)*time.Second)
			if err != nil {
				return result{}, fail(exitNotAccepted, "Чат %s создан, доставка задания не подтверждена: %v. Проверьте paradev-agent last перед повтором", session.id, err)
			}
			if sent.SessionID != "" && (sent.SessionID != session.id || sent.TerminalID != "" && sent.TerminalID != session.terminal) {
				session, record, err = p.rememberTransport(session, sent)
				if err != nil {
					return result{}, err
				}
			}
		}
		text := "Chat " + reply.SessionID
		if opts.alias != "" {
			text += "\nАлиас " + opts.alias
		}
		return result{data: record, text: text}, nil
	}

	terminal, err := p.createAgent(target.ID, opts, prompt, "")
	if err != nil {
		return result{}, err
	}
	session.terminal = terminal
	if _, err := p.saveLiveSession(session, "created", "", "", patch, time.Now().UTC(), true); err != nil {
		return result{}, fail(codeOf(err), "Терминал %s создан, история не записана: %v", terminal, err)
	}
	found, err := p.awaitNative(terminal, opts.agent, time.Minute)
	if err != nil {
		return result{}, err
	}
	session.id = found.id
	record, err := p.saveLiveSession(session, "created", "", "", patch, time.Now().UTC(), true)
	text := fmt.Sprintf("Терминал %s\n%s session %s", terminal, opts.agent, session.id)
	if opts.alias != "" {
		text += "\nАлиас " + opts.alias
	}
	return result{data: record, text: text}, err
}

func appendFlag(args []string, name, value string) []string {
	if value != "" {
		return append(args, name, value)
	}
	return args
}

func (p paradev) createChat(workspace string, opts launchOptions, prompt string) (chatTransport, error) {
	args := []string{"sessions", "create", "--local", "--workspace", workspace, "--agent", opts.agent}
	args = appendFlag(args, "--prompt", prompt)
	args = appendFlag(args, "--model", opts.model)
	args = appendFlag(args, "--mode", opts.mode)
	var reply chatTransport
	if err := p.call(&reply, args...); err != nil {
		return reply, err
	}
	if reply.SessionID == "" {
		return reply, fail(exitError, "superset sessions create: нет sessionId")
	}
	return reply, nil
}

func (p paradev) createAgent(workspace string, opts launchOptions, prompt, resume string) (string, error) {
	args := []string{"agents", "create", "--local", "--workspace", workspace, "--agent", opts.agent}
	args = appendFlag(args, "--prompt", prompt)
	args = appendFlag(args, "--model", opts.model)
	args = appendFlag(args, "--effort", opts.effort)
	args = appendFlag(args, "--resume-session", resume)
	var reply sessionRecord
	if err := p.call(&reply, args...); err != nil {
		return "", err
	}
	nested, _ := reply["terminal"].(map[string]any)
	id := choose(reply.string("sessionId"), choose(reply.string("terminalId"), choose(sessionRecord(nested).string("id"), reply.string("id"))))
	if id == "" {
		return "", fail(exitError, "superset agents create: в ответе нет id терминала")
	}
	return id, nil
}

func (p paradev) awaitNative(id, agent string, timeout time.Duration) (liveSession, error) {
	end := time.Now().Add(timeout)
	for time.Now().Before(end) {
		_, active, err := p.liveWorkspaces()
		if err != nil {
			return liveSession{}, err
		}
		if i := slices.IndexFunc(active, func(s liveSession) bool { return s.terminal == id && s.id != "" && s.agent == agent }); i >= 0 {
			return active[i], nil
		}
		if err := pause(p.ctx, 2*time.Second); err != nil {
			return liveSession{}, err
		}
	}
	return liveSession{}, fail(exitError, "Терминал %s создан, но процесс %s с сессией не появился за %g с", id, agent, timeout.Seconds())
}

func (p paradev) sendChat(session liveSession, prompt string, timeout time.Duration) (chatTransport, error) {
	args := append([]string{"sessions", "send"}, chatArguments(session)...)
	args = append(args, "--prompt", prompt)
	p.timeout = timeout
	var response chatTransport
	err := p.call(&response, args...)
	return response, err
}

func (p paradev) rememberTransport(session liveSession, response chatTransport) (liveSession, sessionRecord, error) {
	if response.SessionID == "" {
		return liveSession{}, nil, fail(exitError, "superset chat: в ответе нет sessionId")
	}
	previous := session.id
	session.id, session.terminal = response.SessionID, choose(response.TerminalID, response.SessionID)
	saved, err := p.saveLiveSession(session, "resumed", "", previous, nil, time.Now().UTC(), false)
	if err != nil {
		return session, nil, err
	}
	rows, err := p.chatList(session.workspaceID)
	if err != nil {
		return session, saved, nil
	}
	for _, row := range rows {
		if row.SessionID != session.id {
			continue
		}
		session.chat = &row
		if row.TerminalID != nil && response.TerminalID == "" {
			session.terminal = *row.TerminalID
		}
		if row.HarnessSessionID != nil {
			session.nativeID = *row.HarnessSessionID
		}
		saved, err = p.saveLiveSession(session, "observed", "", previous, nil, time.Now().UTC(), true)
		break
	}
	return session, saved, err
}

func startupPrompt(env environment, target workspace, opts launchOptions, branch string, inSlot bool) string {
	cli := "paradev-agent"
	if path := env.get("AGENT_CLI_LAUNCHER"); filepath.IsAbs(path) {
		stable := filepath.Join(env.home, ".codex", "plugins", productName, "launch")
		if fileExists(stable) && canonicalPath(stable) == canonicalPath(path) {
			path = stable
		}
		cli = shellSingleQuote(path) + " --agent-cli"
	}
	lines := []string{"Перед выполнением задания проверь рабочий контекст:"}
	lines = append(lines, "1. Прочитай применимые AGENTS.md/CLAUDE.md.",
		"2. Сверь SUPERSET_WORKSPACE_ID, текущий путь и, если указана, фактическую Git-ветку с назначением ниже. "+
			"Если контекст неясен или правила проекта требуют проверки, вызови MCP status или "+cli+" status --json один раз.")
	meta, _ := json.Marshal(map[string]any{"workspace": target.ID, "path": target.WorktreePath, "branch": nonempty(branch), "task": nonempty(opts.task)})
	lines = append(lines, string(meta))
	if branch == "" {
		lines = append(lines, "Поле branch:null означает, что CLI не проверял ветку этого workspace; определи её по правилам продукта.")
	}
	lines = append(lines, "3. При несовпадении остановись и сообщи назначившему задачу. Не выделяй другой слот, не переключай чужую ветку и не запускай нового исполнителя.")
	if inSlot {
		lines = append(lines, "4. Если слот уже подготовлен и соответствует заданию, повторный prepare не нужен. Затем выполняй задание по процессу продукта.")
	} else {
		lines = append(lines, "4. Работай в указанной основной копии (workspace main). Не выделяй слот и не переходи в другой worktree. Ветку задачи готовь в этой копии по правилам проекта, затем выполняй задание.")
	}
	return strings.Join(append(lines, "", "Задание:", opts.prompt), "\n")
}
