package agent

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/dlclark/regexp2/v2"
)

const gcDefaultMarker = `\[\[DONE[^\]]*\]\]`

var (
	gcIdlePattern = regexp.MustCompile(`^(\d+)(s|m|h)$`)
	gcQuestionEnd = regexp.MustCompile(`\?[*_` + "`" + `)»"'\s]*$`)
)

type gcOptions struct {
	project, idle, done string
	apply               bool
}

type gcEntry struct {
	kind, reason, skip string
	session            *liveSession
	slot               *slot
	snapshot           *snapshotWorkspace
	terminal, pane     string
	data               any
}

type gcRules struct {
	keep map[string]bool
	idle time.Duration
	done *regexp2.Regexp
}

func gcProjects(p paradev, flag string, workspaces []workspace) ([]string, error) {
	if flag != "" {
		selected := []string{}
		for raw := range strings.SplitSeq(flag, ",") {
			if project := strings.TrimSpace(raw); project != "" && !slices.Contains(selected, project) {
				selected = append(selected, project)
			}
		}
		if len(selected) != 0 {
			return selected, nil
		}
	}
	row, err := currentWorkspace(p.env, workspaces, false)
	if err != nil || row == nil || row.ProjectName == "" {
		return nil, fail(exitError, "Не понял, какой это проект Superset — укажите --project <имя>[,<имя>]")
	}
	return []string{row.ProjectName}, nil
}

func loadGCRules(p paradev, opts gcOptions) (gcRules, error) {
	match := gcIdlePattern.FindStringSubmatch(choose(opts.idle, "30m"))
	if match == nil {
		return gcRules{}, fail(exitError, "--idle — длительность: 45s, 30m, 2h")
	}
	idle, err := time.ParseDuration(match[0])
	if err != nil {
		return gcRules{}, fail(exitError, "--idle — длительность: 45s, 30m, 2h")
	}
	pattern, err := projectPattern(choose(opts.done, gcDefaultMarker))
	if err != nil {
		return gcRules{}, fail(exitError, "Неверный --done: %v", err)
	}
	registry, _, err := loadRegistry(p.env)
	if err != nil {
		return gcRules{}, err
	}
	keep := make(map[string]bool, len(registry.Keep))
	for _, id := range registry.Keep {
		keep[id] = true
	}
	return gcRules{idle: idle, done: pattern, keep: keep}, nil
}

func (p paradev) gcJudge(s liveSession, rules gcRules) (reason, skip string) {
	switch {
	case p.ownSession(s):
		return "", "это текущая сессия"
	case rules.keep[s.id]:
		return "", "keep"
	case s.state == "waiting":
		return "", "ждёт разрешения или ответа"
	case s.state != "idle":
		return "", "работает"
	}
	info, err := p.transcript(s, time.Time{})
	if err != nil {
		return "", "нет журнала — состояние не проверить"
	}
	if info.state != "idle" {
		if info.state == "waiting" {
			return "", "ждёт разрешения или ответа"
		}
		return "", "работает"
	}
	if answer := lastAnswer(info.records); answer != nil {
		for raw := range strings.SplitSeq(answer.Text, "\n") {
			if line := strings.TrimSpace(raw); len(line) > 1 && gcQuestionEnd.MatchString(line) {
				return "", "вопрос в последнем ответе"
			}
		}
		matched, err := rules.done.MatchString(answer.Text)
		if err != nil {
			return "", "маркер завершения не удалось проверить"
		}
		if matched {
			return "готово (маркер в последнем ответе)", ""
		}
	}
	var updated time.Time
	if s.chat != nil {
		var date string
		if json.Unmarshal(s.chat.UpdatedAt, &date) == nil {
			updated, _ = time.Parse(time.RFC3339Nano, date)
		} else {
			milliseconds, _ := strconv.ParseInt(string(s.chat.UpdatedAt), 10, 64)
			if milliseconds != 0 {
				updated = time.UnixMilli(milliseconds)
			}
		}
	} else if path, err := nativeJournalPath(p.env, s); err == nil {
		if stat, err := os.Stat(path); err == nil {
			updated = stat.ModTime()
		}
	}
	if updated.IsZero() {
		return "", "нет журнала — состояние не проверить"
	}
	idle := time.Since(updated)
	text := fmt.Sprintf("простаивает %d мин", int(math.Round(idle.Minutes())))
	if idle >= rules.idle {
		return text, ""
	}
	return "", text + " — меньше порога"
}

func (p paradev) gc(opts gcOptions) (result, error) {
	workspaces, live, err := p.liveWorkspaces()
	if err != nil {
		return result{}, err
	}
	projects, err := gcProjects(p, opts.project, workspaces)
	if err != nil {
		return result{}, err
	}
	rules, err := loadGCRules(p, opts)
	if err != nil {
		return result{}, err
	}
	plan := []gcEntry{}
	protected := map[string]bool{}
	for _, session := range live {
		if session.terminal == "" {
			continue
		}
		protected[session.terminal] = true
		if slices.Contains(projects, session.project) {
			reason, skip := p.gcJudge(session, rules)
			plan = append(plan, gcEntry{kind: "session", session: &session, terminal: session.terminal, reason: reason, skip: skip})
		}
	}
	snapshots, err := p.workspaceSnapshot()
	if err != nil {
		return result{}, err
	}
	for _, ws := range snapshots {
		if !slices.Contains(projects, ws.Project) {
			continue
		}
		idle, err := p.idleTerminals(ws, protected)
		if err != nil {
			return result{}, err
		}
		for _, terminal := range idle {
			plan = append(plan, gcEntry{kind: "terminal", snapshot: &ws, terminal: terminal.Terminal, reason: terminal.Reason})
		}
		for _, pane := range stalePanes(ws) {
			plan = append(plan, gcEntry{kind: "pane", snapshot: &ws, pane: pane.Pane, terminal: pane.Terminal, reason: pane.Reason})
		}
	}
	slots, err := p.slots("")
	if err != nil {
		return result{}, err
	}
	for _, slot := range slots {
		base := slotPattern.FindString(slot.Name)
		if base == "" || !slices.Contains(projects, slot.ProjectName) {
			continue
		}
		blocked := ""
		switch {
		case !slot.exists:
			blocked = "рабочая копия слота отсутствует"
		case len(slot.sessions) > 1:
			blocked = "в слоте несколько сессий — автоматическое освобождение запрещено"
		}
		var info *gitStatus
		if blocked == "" {
			git := gitClient{ctx: p.ctx, env: p.env, cwd: slot.WorktreePath}
			info, err = git.describe()
			if err != nil {
				return result{}, err
			}
			if info == nil || len(info.Changes) != 0 {
				blocked = "рабочая копия грязная — закрытие и освобождение отложены"
			}
		}
		if blocked != "" {
			for i := range plan {
				item := &plan[i]
				if item.session != nil && item.session.workspaceID == slot.ID && item.reason != "" {
					item.reason, item.skip = "", blocked
				}
			}
		} else if len(slot.sessions) == 0 && (slot.Name != base || info.Branch != nil) {
			plan = append(plan, gcEntry{kind: "slot", slot: &slot, terminal: slot.ID,
				reason: "сессий нет — освободить слот и проверить результат"})
		}
	}
	if opts.apply {
		for i := range plan {
			if plan[i].reason == "" {
				continue
			}
			if err := p.applyGC(&plan[i], rules); err != nil {
				return result{}, err
			}
		}
	}
	return gcReport(plan, projects, opts.apply), nil
}

func (p paradev) applyGC(item *gcEntry, rules gcRules) error {
	switch item.kind {
	case "session":
		session, err := p.lookupSession(item.session.id, item.session.workspaceID)
		if err != nil {
			return err
		}
		if reason, skip := p.gcJudge(session, rules); reason == "" {
			item.reason, item.skip = "", skip
			return nil
		}
		out, err := p.closeCommand(session.id, closeOptions{Workspace: session.workspaceID,
			Reason: "gc", Note: "gc: " + item.reason, SkipTidy: true, exact: true})
		item.data = out.data
		return err
	case "slot":
		out, err := p.closeCommand("", closeOptions{Workspace: item.slot.ID, Reason: "gc", exact: true})
		item.data = out.data
		return err
	case "pane":
		current, err := p.snapshotOf(item.snapshot.ID)
		if err != nil {
			return err
		}
		if !slices.ContainsFunc(stalePanes(current), func(pane terminalCleanup) bool {
			return pane.Pane == item.pane && pane.Terminal == item.terminal
		}) {
			item.reason, item.skip = "", "состояние панели изменилось"
			return nil
		}
		return p.closePane(current.ID, item.pane)
	case "terminal":
		current, err := p.snapshotOf(item.snapshot.ID)
		if err != nil {
			return err
		}
		_, live, err := p.liveWorkspaces()
		if err != nil {
			return err
		}
		protected := map[string]bool{}
		for _, s := range live {
			protected[s.terminal] = true
		}
		idle, err := p.idleTerminals(current, protected)
		if err != nil {
			return err
		}
		if !slices.ContainsFunc(idle, func(row terminalCleanup) bool { return row.Terminal == item.terminal }) {
			item.reason, item.skip = "", "состояние терминала изменилось"
			return nil
		}
		_, err = p.closeSnapshotTerminal(current, item.terminal)
		return err
	}
	return nil
}

func gcReport(plan []gcEntry, projects []string, applied bool) result {
	done, keep := []map[string]any{}, []map[string]any{}
	first := "Сухой прогон — закрыть"
	if applied {
		first = "Закрыто"
	}
	lines := []string{first + " (" + strings.Join(projects, ", ") + "):"}
	freed := 0
	for _, item := range plan {
		if item.reason == "" && item.skip == "" {
			continue
		}
		data := map[string]any{"kind": item.kind, "terminal": item.terminal}
		var label string
		switch {
		case item.session != nil:
			s := item.session
			label = fmt.Sprintf("сессия %s %s «%s» %d МБ", s.terminal[:min(8, len(s.terminal))], s.workspaceName, s.title, s.rssMB)
			data["sessionId"] = nonempty(s.id)
			if item.reason != "" {
				freed += s.rssMB
				data["workspace"] = s.workspaceID
			}
		case item.slot != nil:
			label = "освободить слот " + item.slot.Name
			data["slot"] = item.slot.Name
			if item.reason != "" {
				data["workspace"] = item.slot.ID
			}
		default:
			entity, id := "терминал", item.terminal
			if item.pane != "" {
				entity, id = "панель", item.pane
				data["pane"] = item.pane
			}
			label = entity + " " + id[:min(13, len(id))] + " " + item.snapshot.Name
			if item.reason != "" {
				data["workspace"] = item.snapshot.ID
			}
		}
		if item.reason != "" {
			data["reason"] = item.reason
			if item.data != nil {
				data["result"] = item.data
			}
			done = append(done, data)
			lines = append(lines, "  ✕ "+label+" — "+item.reason)
		} else {
			data["skip"] = item.skip
			keep = append(keep, data)
			lines = append(lines, "  · "+label+" — оставляю: "+item.skip)
		}
	}
	if len(done) == 0 {
		lines = append(lines, "  нечего закрывать")
	}
	last := fmt.Sprintf("Память сессий: ~%d МБ.", freed)
	if !applied {
		last += " Закрыть: paradev-agent gc --apply"
	}
	return result{data: map[string]any{"applied": applied, "projects": projects, "close": done, "keep": keep, "freedMb": freed},
		text: strings.Join(append(lines, last), "\n")}
}
