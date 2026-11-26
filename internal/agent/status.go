package agent

import (
	"fmt"
	"slices"
	"strings"
	"time"
)

type gitChange struct {
	Code string `json:"code"`
	Path string `json:"path"`
}

type gitStatus struct {
	Root    string      `json:"root"`
	Branch  *string     `json:"branch"`
	Head    *string     `json:"head"`
	Changes []gitChange `json:"changes"`
}

func (g gitClient) describe() (*gitStatus, error) {
	if !fileExists(g.cwd) {
		return nil, nil
	}
	root, err := g.raw("rev-parse", "--show-toplevel")
	if err != nil || root.status != 0 {
		return nil, err
	}
	branch, err := g.git("branch", "--show-current")
	if err != nil {
		return nil, err
	}
	head, err := g.head()
	if err != nil {
		return nil, err
	}
	raw, err := g.git("--no-optional-locks", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all")
	if err != nil {
		return nil, err
	}
	changes := make([]gitChange, 0)
	for _, item := range nulRecords(raw) {
		if len(item) >= 3 {
			changes = append(changes, gitChange{Code: item[:2], Path: item[3:]})
		}
	}
	return &gitStatus{Root: strings.TrimSpace(root.stdout), Branch: stringPtr(strings.TrimSpace(branch)), Head: stringPtr(head), Changes: changes}, nil
}

func stringPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func statusResult(p paradev, explicitWorkspace string, isolated bool) (result, error) {
	env := p.env
	workspaces, err := p.workspaces()
	if err != nil {
		return result{}, err
	}
	var ws *workspace
	if explicitWorkspace != "" {
		ws, err = exactWorkspace(workspaces, explicitWorkspace)
		if err == nil && !containsPath(ws.WorktreePath, env.cwd) {
			err = fail(exitCheck, "cwd должен находиться в выбранном workspace")
		}
	} else if isolated {
		env.get = overrideEnv(env.get, []string{"SUPERSET_WORKSPACE_ID"})
		ws, err = currentWorkspace(env, workspaces, false)
	} else {
		ws, err = currentWorkspace(env, workspaces, false)
	}
	if err != nil {
		return result{}, err
	}
	if inherited := p.env.get("SUPERSET_WORKSPACE_ID"); isolated && inherited != "" && (ws == nil || ws.ID != inherited) {
		env.get = overrideEnv(env.get, []string{"SUPERSET_TERMINAL_ID", "CODEX_THREAD_ID"})
	}
	path := env.cwd
	var dataWorkspace any
	var project, slot, workspaceLabel string
	sessions := []liveSession{}
	if ws != nil {
		path = choose(ws.WorktreePath, path)
		project = ws.ProjectName
		if name := ws.slotName(); name != "" {
			projects, err := p.projects()
			if err != nil {
				return result{}, err
			}
			for _, candidate := range projects {
				if belongsTo(*ws, candidate) && candidate.Path != "" &&
					canonicalPath(candidate.Path) != canonicalPath(ws.WorktreePath) {
					slot = name
					break
				}
			}
		}
		workspaceLabel = fmt.Sprintf("%s (%s)", ws.Name, ws.ID)
		dataWorkspace = map[string]any{"id": ws.ID, "name": ws.Name, "path": path, "exists": fileExists(path)}
		all, _, err := p.listSessions(workspaces, false, "")
		if err != nil {
			return result{}, err
		}
		sessions = slices.DeleteFunc(all, func(s liveSession) bool {
			return s.workspaceID != ws.ID && !containsPath(ws.WorktreePath, s.cwd)
		})
		if err := p.observeSessions(sessions, time.Now().UTC()); err != nil {
			return result{}, err
		}
	}
	git := gitClient{ctx: p.ctx, env: env, cwd: path}
	info, err := git.describe()
	if err != nil {
		return result{}, err
	}
	matches := currentSessions(env, sessions, ws)
	selection := "none"
	var selected any
	switch {
	case len(matches) > 1:
		selection = "ambiguous"
	case len(matches) == 1:
		selection, selected = "selected", matches[0].summary()
	case len(sessions) > 0:
		selection = "unmatched"
	}
	lines := []string{
		"Проект: " + choose(project, "(вне Superset)"),
		"Workspace: " + choose(workspaceLabel, "(не найден по cwd)"),
		"Слот: " + choose(slot, "—"),
		"Путь: " + path,
	}
	if !fileExists(path) {
		lines[3] += " (нет на диске)"
	}
	if info == nil {
		lines = append(lines, "Git: не репозиторий")
	} else {
		branch := "(detached HEAD)"
		if info.Branch != nil {
			branch = *info.Branch
		}
		if info.Head != nil {
			branch += " · " + (*info.Head)[:min(9, len(*info.Head))]
		}
		lines = append(lines, "Ветка: "+branch)
		if len(info.Changes) == 0 {
			lines = append(lines, "Изменения: чисто")
		} else {
			lines = append(lines, fmt.Sprintf("Изменения: %d", len(info.Changes)))
		}
		for _, file := range info.Changes {
			lines = append(lines, fmt.Sprintf("  %s %s", file.Code, file.Path))
		}
	}
	switch selection {
	case "none":
		lines = append(lines, "Сессии: живых сессий нет")
	case "ambiguous":
		lines = append(lines, "Сессии: несколько; для last/close укажите ID или алиас")
	case "unmatched":
		lines = append(lines, "Текущая сессия не найдена; остальные сессии workspace:")
	default:
		lines = append(lines, "Сессии:")
	}
	all := make([]map[string]any, 0, len(sessions))
	for _, s := range sessions {
		all = append(all, s.summary())
		marker := "·"
		if len(matches) == 1 && s.terminal == matches[0].terminal && s.id == matches[0].id {
			marker = "→"
		}
		lines = append(lines, fmt.Sprintf("  %s %s/%s %s — %s", marker, s.agent, s.kind,
			choose(s.alias, choose(s.id, choose(s.terminal, fmt.Sprintf("pid %d", s.pid)))), choose(stateLabel[s.state], s.state)))
	}
	return result{
		data: map[string]any{"project": nonempty(project), "workspace": dataWorkspace, "slot": nonempty(slot),
			"git": info, "session": selected, "selection": selection, "sessions": all},
		text: strings.Join(lines, "\n"),
	}, nil
}

func overrideEnv(base func(string) string, clear []string) func(string) string {
	return func(key string) string {
		if slices.Contains(clear, key) {
			return ""
		}
		return base(key)
	}
}
