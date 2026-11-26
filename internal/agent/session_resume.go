package agent

import (
	"cmp"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

type resumeOptions struct {
	launchOptions
	dry, offline, lastClosed, allOpen, exact bool
}

func resumeSelection(env environment, ref string, opts resumeOptions) ([]sessionRecord, error) {
	count := 0
	for _, yes := range []bool{ref != "", opts.task != "", opts.lastClosed, opts.allOpen} {
		if yes {
			count++
		}
	}
	if count != 1 {
		return nil, fail(exitError, "Укажите один селектор: <алиас|UUID>, --task KEY, --last-closed или --all-open")
	}
	reg, _, err := loadRegistry(env)
	if err != nil {
		return nil, err
	}
	rows := slices.DeleteFunc(reg.Sessions, func(record sessionRecord) bool {
		if opts.project != "" && record.string("project") != opts.project ||
			opts.task != "" && record.string("task") != opts.task {
			return true
		}
		if ref != "" {
			if opts.exact {
				return record.string("sessionId") != ref
			}
			return !matchesSessionRecord(record, ref)
		}
		if opts.lastClosed {
			return record.string("status") != "closed" && record.string("closedAt") == ""
		}
		closedAt, openMarker := record["closedAt"]
		return opts.allOpen && record.string("status") != "open" && !(openMarker && closedAt == nil)
	})
	if opts.lastClosed || opts.allOpen {
		field := "closedAt"
		if opts.allOpen {
			field = "lastSeenAt"
		}
		slices.SortStableFunc(rows, func(a, b sessionRecord) int { return cmp.Compare(b.string(field), a.string(field)) })
		if opts.lastClosed {
			rows = rows[:min(len(rows), 1)]
		}
	}
	if !opts.allOpen && len(rows) > 1 {
		lines := []string{}
		for _, row := range rows {
			lines = append(lines, fmt.Sprintf("%s %s %s", choose(row.string("sessionId"), row.string("id")),
				choose(row.string("project"), "—"), choose(row.string("task"), row.string("alias"))))
		}
		return nil, fail(exitCheck, "Несколько сессий — выберите UUID:\n%s", strings.Join(lines, "\n"))
	}
	return rows, nil
}

func sessionAsRecord(s liveSession) sessionRecord {
	return sessionRecord{"sessionId": s.id, "nativeSessionId": nonempty(s.nativeID), "kind": s.kind, "agent": s.agent,
		"workspace": s.workspaceID, "workspaceName": s.workspaceName, "project": s.project,
		"cwd": s.cwd, "terminal": s.terminal, "alias": nonempty(s.alias)}
}

func (p paradev) resumeSessions(ref string, opts resumeOptions) (result, error) {
	rows, err := resumeSelection(p.env, ref, opts)
	if err != nil {
		return result{}, err
	}
	if len(rows) == 0 && ref != "" {
		if opts.workspace == "" {
			return result{}, fail(exitError, "Сессии %s нет в реестре — укажите --workspace", ref)
		}
		ws, err := p.workspaces()
		if err != nil {
			return result{}, err
		}
		target, err := describeWorkspace(ws, opts.workspace)
		if err != nil {
			return result{}, err
		}
		if opts.project != "" && target.ProjectName != opts.project {
			return result{}, fail(exitCheck, "Workspace принадлежит другому проекту")
		}
		listed, _, err := p.listSessions(ws, true, target.ID)
		if err != nil {
			return result{}, err
		}
		var known sessionRecord
		for _, live := range listed {
			record := sessionAsRecord(live)
			if opts.exact && live.workspaceID == target.ID && live.id == ref || !opts.exact && matchesSessionRecord(record, ref) {
				known = record
				break
			}
		}
		if opts.exact && known == nil {
			return result{}, fail(exitGone, "Точный sessionId не найден в указанном workspace или истории проекта")
		}
		if known == nil {
			known = sessionRecord{"sessionId": ref, "agent": choose(opts.agent, "codex"), "workspace": target.ID,
				"branch": opts.branch, "cwd": target.WorktreePath}
		}
		rows = []sessionRecord{known}
	}
	if len(rows) == 0 && !opts.allOpen {
		return result{}, fail(exitGone, "Подходящей сессии в истории нет")
	}
	results := []sessionRecord{}
	code := exitOK
	for _, row := range rows {
		output, err := p.withLaunchLock(func() (result, error) {
			out, err := p.resumeSession(row, opts)
			return result{data: out}, err
		})
		if err != nil {
			if !opts.allOpen {
				return result{}, err
			}
			if code == exitOK {
				code = codeOf(err)
			}
			results = append(results, sessionRecord{"sessionId": nonempty(row.string("sessionId")),
				"alias": row["alias"], "status": "blocked", "error": err.Error(), "code": codeOf(err)})
			continue
		}
		results = append(results, output.data.(sessionRecord))
	}
	if !opts.allOpen && len(results) == 1 {
		row := results[0]
		return result{data: row, text: row.string("sessionId") + ": " + row.string("status")}, nil
	}
	var lines []string
	for _, row := range results {
		line := choose(row.string("alias"), choose(row.string("sessionId"), "(нет UUID)")) + ": " + row.string("status")
		if message := row.string("error"); message != "" {
			line += " — " + message
		}
		lines = append(lines, line)
	}
	return result{data: map[string]any{"sessions": results}, text: choose(strings.Join(lines, "\n"), "Нет сессий для восстановления"), code: code}, nil
}

func sameConversation(row sessionRecord, agent string, s liveSession) bool {
	return s.agent == agent && (matchesSessionRecord(row, s.id) || matchesSessionRecord(row, s.nativeID))
}

func (p paradev) resumeSession(row sessionRecord, opts resumeOptions) (sessionRecord, error) {
	id := row.string("sessionId")
	if id == "" {
		return nil, fail(exitCheck, "У записи %s нет UUID — resume невозможен", choose(row.string("alias"), row.string("id")))
	}
	agent := choose(opts.agent, choose(row.string("agent"), "claude"))
	if agent != "codex" && agent != "claude" {
		return nil, fail(exitError, "--agent: выберите codex или claude")
	}
	if saved := row.string("agent"); saved != "" && saved != agent {
		return nil, fail(exitError, "Сессия %s принадлежит %s — resume другим агентом невозможен", id, saved)
	}
	branch := choose(opts.branch, row.string("branch"))
	if opts.branch != "" && row.string("branch") != "" && branch != row.string("branch") {
		return nil, fail(exitCheck, "Сохранённая ветка %s не совпадает с --branch %s", row.string("branch"), branch)
	}
	chat := row.string("kind") == "chat"
	if chat && (opts.cli || opts.model != "" || opts.effort != "" || opts.mode != "") {
		return nil, fail(exitError, "Chat resume не принимает параметры запуска; используйте их при create")
	}
	workspaces, active, err := p.liveWorkspaces()
	if err != nil {
		return nil, err
	}
	target, found, err := resumeWorkspace(workspaces, row, opts.workspace)
	if err != nil {
		return nil, err
	}
	for _, session := range active {
		if sameConversation(row, agent, session) {
			if opts.workspace != "" && target.ID != session.workspaceID {
				return nil, fail(exitCheck, "Живая сессия находится в другом workspace")
			}
			record := sessionRecord(session.output())
			record["status"] = "already-open"
			return record, nil
		}
	}
	if countActivity(active).Working >= p.config.MaxSessions {
		return nil, fail(exitLimit, "Достигнут лимит выполняющихся сессий — дождитесь свободного места")
	}
	action, err := p.resumeAction(row, target, found, chat, branch)
	if err != nil {
		return nil, err
	}
	plan := sessionRecord{"sessionId": id, "workspace": nonempty(target.ID), "branch": nonempty(branch), "action": action}
	if alias, ok := row["alias"]; ok {
		plan["alias"] = alias
	}
	if opts.dry {
		plan["status"] = "planned"
		return plan, nil
	}
	if action == "take-slot-and-resume" {
		taken, err := p.takeSlot(slotOptions{project: row.string("project"), branch: branch, task: row.string("task"), offline: opts.offline})
		if err != nil {
			return nil, err
		}
		ws, err := p.workspaces()
		if err != nil {
			return nil, err
		}
		target, err = describeWorkspace(ws, taken.data.(map[string]any)["workspace"].(string))
		if err != nil {
			return nil, err
		}
	} else if action == "prepare-and-resume" {
		if _, err := p.prepareSlot(target.ID, slotOptions{branch: branch, task: row.string("task"), offline: opts.offline}); err != nil {
			return nil, err
		}
		ws, err := p.workspaces()
		if err != nil {
			return nil, err
		}
		target, err = describeWorkspace(ws, target.ID)
		if err != nil {
			return nil, err
		}
	}
	launch := func() (result, error) {
		resumed, err := p.resumeTransport(row, target, agent, branch, chat, opts)
		return result{data: resumed}, err
	}
	var output result
	if slotPattern.MatchString(target.Name) {
		output, err = p.withSlotLock(target.ID, target.WorktreePath, launch)
	} else {
		output, err = launch()
	}
	if err != nil {
		return nil, err
	}
	return output.data.(sessionRecord), nil
}

func resumeWorkspace(all []workspace, row sessionRecord, explicit string) (workspace, bool, error) {
	if explicit != "" {
		target, err := describeWorkspace(all, explicit)
		return target, err == nil, err
	}
	for _, target := range all {
		if target.ID == row.string("workspace") {
			return target, true, nil
		}
	}
	return workspace{}, false, nil
}

func (p paradev) resumeAction(row sessionRecord, target workspace, found, chat bool, branch string) (string, error) {
	if chat && (!found || target.ID != row.string("workspace") || !fileExists(target.WorktreePath)) {
		detail := row.string("sessionId")
		if native := row.string("nativeSessionId"); native != "" {
			detail += " и native UUID " + native
		}
		return "", fail(exitCheck, "Workspace chat удалён или изменён. Перенос chat не поддержан; сохранены UUID %s. Выберите восстановление контекста вручную", detail)
	}
	if !found || !fileExists(target.WorktreePath) {
		checkout, project := row.string("mainCheckout"), row.string("project")
		if project == "" || checkout == "" || !fileExists(checkout) || branch == "" {
			return "", fail(exitCheck, "Workspace удалён; для нового слота нужны сохранённые проект, основная копия и ветка")
		}
		git := gitClient{ctx: p.ctx, env: p.env, cwd: checkout}
		exists, err := gitHas(git, "refs/heads/"+branch)
		if err != nil {
			return "", err
		}
		if !exists {
			return "", fail(exitCheck, "Сохранённая ветка %s отсутствует — новую вместо неё не создаю", branch)
		}
		return "take-slot-and-resume", nil
	}
	if saved := row.string("project"); saved != "" && saved != target.ProjectName {
		return "", fail(exitCheck, "Workspace принадлежит другому проекту")
	}
	git := gitClient{ctx: p.ctx, env: p.env, cwd: target.WorktreePath}
	if saved := row.string("gitCommonDir"); saved != "" {
		path, err := git.git("rev-parse", "--path-format=absolute", "--git-common-dir")
		if err != nil {
			return "", err
		}
		if canonicalPath(strings.TrimSpace(path)) != saved {
			return "", fail(exitCheck, "Workspace теперь относится к другому Git-репозиторию")
		}
	}
	base := slotPattern.FindString(target.Name)
	if base == "" {
		if cwd := row.string("cwd"); cwd != "" && canonicalPath(cwd) != canonicalPath(target.WorktreePath) {
			return "", fail(exitCheck, "Путь рабочей копии изменился")
		}
		if branch != "" {
			current, err := git.git("branch", "--show-current")
			if err != nil {
				return "", err
			}
			if strings.TrimSpace(current) != branch {
				return "", fail(exitCheck, "Git-ветка рабочей копии изменилась")
			}
		}
		return "resume", nil
	}
	currentSlot, err := p.findSlot(target.ID, target.ProjectName)
	if err != nil {
		return "", err
	}
	if reservationActive(currentSlot) || slotSessionsBlockReuse(currentSlot) {
		return "", fail(exitCheck, "В workspace уже есть другая живая сессия или резерв")
	}
	state, err := p.chatState(target.ID)
	if err != nil {
		return "", err
	}
	if chat && state.Superseded[row.string("sessionId")] != "" {
		return "", fail(exitCheck, "Рабочий слот назначен заново. Этот чат нельзя продолжить в новой ветке.")
	}
	if occupied, err := p.nativeInSlot(currentSlot); err != nil || occupied {
		if err != nil {
			return "", err
		}
		return "", fail(exitCheck, "В слоте остались native-процессы")
	}
	if branch == "" {
		return "", fail(exitCheck, "В старой записи нет ветки — явно укажите --branch, чтобы проверить назначение")
	}
	if task := row.string("task"); task != "" && target.Name != base && target.Name != base+" · "+task {
		return "", fail(exitCheck, "Имя слота соответствует другой задаче")
	}
	info, err := git.describe()
	if err != nil {
		return "", err
	}
	if info == nil {
		return "", fail(exitCheck, "Слот должен быть Git-репозиторием")
	}
	if info.Branch != nil && *info.Branch == branch {
		if !allChatsSuperseded(currentSlot.chats, state) {
			return "", fail(exitCheck, "Открытый чат ещё привязан к этому слоту")
		}
		return "resume", nil
	}
	if info.Branch != nil || len(info.Changes) != 0 {
		return "", fail(exitCheck, "Слот занят другой веткой или грязный — переключение запрещено")
	}
	exists, err := gitHas(git, "refs/heads/"+branch)
	if err != nil {
		return "", err
	}
	if !exists {
		return "", fail(exitCheck, "Сохранённая ветка %s отсутствует", branch)
	}
	return "prepare-and-resume", nil
}

func (p paradev) resumeTransport(row sessionRecord, target workspace, agent, branch string, chat bool, opts resumeOptions) (sessionRecord, error) {
	workspaces, live, err := p.liveWorkspaces()
	if err != nil {
		return nil, err
	}
	fresh, err := exactWorkspace(workspaces, target.ID)
	if err != nil {
		return nil, err
	}
	if canonicalPath(fresh.WorktreePath) != canonicalPath(target.WorktreePath) || fresh.ProjectName != target.ProjectName {
		return nil, fail(exitCheck, "Назначение workspace изменилось")
	}
	for _, existing := range live {
		if sameConversation(row, agent, existing) {
			found := sessionRecord(existing.output())
			found["status"] = "already-open"
			return found, nil
		}
	}
	if countActivity(live).Working >= p.config.MaxSessions {
		return nil, fail(exitLimit, "Достигнут лимит выполняющихся сессий")
	}
	action, err := p.resumeAction(row, *fresh, true, chat, branch)
	if err != nil || action != "resume" {
		if err != nil {
			return nil, err
		}
		return nil, fail(exitCheck, "Ветка изменилась перед resume")
	}

	id := row.string("sessionId")
	session := liveSession{kind: choose(row.string("kind"), "cli"), agent: agent, id: id,
		nativeID: row.string("nativeSessionId"), terminal: choose(row.string("terminal"), id),
		workspaceID: fresh.ID, workspaceName: fresh.Name, project: fresh.ProjectName,
		cwd: fresh.WorktreePath, alias: choose(opts.alias, row.string("alias"))}
	patch := sessionRecord{}
	if slotPattern.MatchString(fresh.Name) {
		generation := uuid()
		if err := atomicJSON(slotStatePath(p.env, fresh.WorktreePath)+".json", map[string]string{"generation": generation}); err != nil {
			return nil, err
		}
		patch["startup"] = sessionRecord{"workspace": fresh.ID, "path": canonicalPath(fresh.WorktreePath), "slotName": fresh.Name,
			"branch": branch, "generation": generation}
	}
	if _, err := p.saveLiveSession(session, "resume-requested", "", "", patch, time.Now().UTC(), true); err != nil {
		return nil, err
	}
	prompt := fmt.Sprintf("Сессия восстановлена. Рабочая копия: %s; ветка: %s.\nГде остановились:\n%s\nСначала проверь paradev-agent status --json, фактический git diff и инструкции проекта.",
		fresh.WorktreePath, choose(branch, "(неизвестна)"), choose(row.string("note"), "Заметка не сохранена; прочитай последние сообщения."))
	if opts.prompt != "" {
		prompt += "\n\n" + opts.prompt
	}
	var saved sessionRecord
	if chat {
		var reply chatTransport
		if err := p.call(&reply, append([]string{"sessions", "resume"}, chatArguments(session)...)...); err != nil {
			return nil, err
		}
		session, saved, err = p.rememberTransport(session, reply)
		if err != nil {
			return nil, err
		}
		sent, err := p.sendChat(session, prompt, time.Duration(p.config.SendAcceptTimeoutSec)*time.Second)
		if err != nil {
			return nil, fail(exitNotAccepted, "Сессия возобновлена; доставка заметки не подтверждена: %v. Проверьте paradev-agent last, не повторяйте resume вслепую", err)
		}
		if sent.SessionID != "" && sent.SessionID != session.id {
			_, saved, err = p.rememberTransport(session, sent)
			if err != nil {
				return nil, err
			}
		}
	} else {
		launcher := opts.launchOptions
		launcher.agent, launcher.model, launcher.effort = agent, choose(opts.model, row.string("model")), choose(opts.effort, row.string("effort"))
		terminal, err := p.createAgent(fresh.ID, launcher, prompt, id)
		if err != nil {
			return nil, err
		}
		session.terminal = terminal
		if _, err := p.saveLiveSession(session, "resumed", "", id, patch, time.Now().UTC(), true); err != nil {
			return nil, err
		}
		found, err := p.awaitNative(terminal, agent, time.Minute)
		if err != nil {
			return nil, err
		}
		session.id = found.id
		saved, err = p.saveLiveSession(session, "resumed", "", id, patch, time.Now().UTC(), true)
		if err != nil {
			return nil, err
		}
	}
	saved["status"], saved["resumedFrom"] = "resumed", id
	return saved, nil
}

func absoluteOption(env environment, path string) string {
	if path == "" || filepath.IsAbs(path) {
		return path
	}
	return filepath.Join(env.cwd, path)
}
