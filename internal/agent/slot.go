package agent

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

type slotConfig struct {
	Slot struct {
		MainBranch    string          `json:"mainBranch"`
		Remote        string          `json:"remote"`
		ClosedSubject string          `json:"closedSubject"`
		Take          string          `json:"take"`
		Release       string          `json:"release"`
		LocalFiles    json.RawMessage `json:"localFiles"`
		Prepare       json.RawMessage `json:"prepare"`
	} `json:"slot"`
}

type slot struct {
	workspace
	checkout    string
	exists      bool
	sessions    []liveSession
	liveChats   int
	reservation json.RawMessage
}

func (p paradev) slots(project string) ([]slot, error) {
	projects, err := p.projects()
	if err != nil {
		return nil, err
	}
	workspaces, err := p.workspaces()
	if err != nil {
		return nil, err
	}
	liveChats := make(map[string]int)
	sessions, _, err := p.scanSessions(workspaces, false, "", liveChats)
	if err != nil {
		return nil, err
	}
	checkouts, named := map[string]string{}, map[string]string{}
	for _, project := range projects {
		checkouts[project.ID] = project.Path
		if _, exists := named[project.Name]; exists {
			named[project.Name] = ""
		} else {
			named[project.Name] = project.Path
		}
	}
	result := make([]slot, 0, len(workspaces))
	for _, ws := range workspaces {
		if ws.WorktreePath == "" || project != "" && project != ws.ProjectName {
			continue
		}
		var reservation json.RawMessage
		if slotPattern.MatchString(ws.Name) {
			var state struct{ Active json.RawMessage }
			if err := readJSON(chatSlotPath(p.env, ws.ID), &state); err != nil {
				return nil, err
			}
			reservation = state.Active
		}
		checkout := checkouts[ws.ProjectID]
		if ws.ProjectID == "" {
			checkout = named[ws.ProjectName]
		}
		result = append(result, slot{
			workspace: ws, checkout: checkout, reservation: reservation,
			liveChats: liveChats[ws.ID],
			exists:    (ws.WorktreeExists == nil || *ws.WorktreeExists) && fileExists(ws.WorktreePath),
			sessions: slices.DeleteFunc(slices.Clone(sessions), func(s liveSession) bool {
				return s.workspaceID != ws.ID && !containsPath(ws.WorktreePath, s.cwd)
			}),
		})
	}
	return result, nil
}

func chatSlotPath(env environment, id string) string {
	key := sha256.Sum256([]byte(id))
	return filepath.Join(env.agentHome, "chat-slots", fmt.Sprintf("%x.json", key))
}

func slotStatePath(env environment, path string) string {
	key := sha256.Sum256([]byte(canonicalPath(path)))
	return filepath.Join(env.agentHome, "slot-locks", fmt.Sprintf("%x", key))
}

func (p paradev) withSlotLock(id, path string, action func() (result, error)) (output result, err error) {
	lockPath := slotStatePath(p.env, path) + ".lock"
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o700); err != nil {
		return result{}, err
	}
	file, err := os.OpenFile(lockPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, fs.ErrExist) {
		return result{}, &agentError{code: exitCheck, details: map[string]any{"slotLocked": true},
			message: fmt.Sprintf("Слот занят другой операцией. Блокировка: %s; не удаляйте её, пока операция работает", lockPath)}
	}
	if err != nil {
		return result{}, err
	}
	defer func() { err = errors.Join(err, file.Close(), os.Remove(lockPath)) }()
	if err := json.NewEncoder(file).Encode(map[string]any{"pid": os.Getpid(), "workspace": id}); err != nil {
		return result{}, err
	}
	return action()
}

func (p paradev) renameSlot(id, name string, timeout time.Duration) error {
	_, err := mustRun(p.ctx, p.env, p.config.Superset, []string{"ws", "update", id, "--local", "--name", name},
		commandOptions{what: "superset ws update", timeout: timeout})
	return err
}

func loadSlotConfig(slot slot) (slotConfig, error) {
	path := filepath.Join(slot.WorktreePath, ".agent-cli.json")
	if slot.checkout != "" {
		main := filepath.Join(slot.checkout, ".agent-cli.json")
		if fileExists(main) {
			path = main
		}
	}
	var config slotConfig
	err := readJSON(path, &config)
	return config, err
}

func mainBranch(git gitClient, config slotConfig) (string, error) {
	if config.Slot.MainBranch != "" {
		return config.Slot.MainBranch, nil
	}
	remote := choose(config.Slot.Remote, "origin")
	out, err := git.raw("symbolic-ref", "--quiet", "--short", "refs/remotes/"+remote+"/HEAD")
	if err != nil {
		return "", err
	}
	if out.status != 0 {
		return "main", nil
	}
	return strings.TrimPrefix(strings.TrimSpace(out.stdout), remote+"/"), nil
}

func slotMainRefs(config slotConfig, main string) []string {
	return []string{main, choose(config.Slot.Remote, "origin") + "/" + main}
}

func mergedInto(git gitClient, config slotConfig, main string) (bool, error) {
	for _, ref := range slotMainRefs(config, main) {
		out, err := git.raw("merge-base", "--is-ancestor", "HEAD", ref)
		if err != nil || out.status == 0 {
			return out.status == 0 && err == nil, err
		}
	}
	return false, nil
}

func slotList(p paradev, project string) (result, error) {
	slots, err := p.slots(project)
	if err != nil {
		return result{}, err
	}
	rows := make([]map[string]any, 0, len(slots))
	var lines []string
	for _, slot := range slots {
		data := map[string]any{
			"id": slot.ID, "name": slot.Name, "project": slot.ProjectName, "path": slot.WorktreePath,
			"exists": slot.exists, "mainCheckout": nonempty(slot.checkout), "reservation": slot.reservation,
			"sessions": len(slot.sessions), "branch": nil, "dirty": nil, "merged": nil,
		}
		rows = append(rows, data)
		label := slot.ProjectName + "/" + slot.Name
		if !slot.exists {
			lines = append(lines, label+"  (worktree нет на диске)")
			continue
		}
		g := gitClient{ctx: p.ctx, env: p.env, cwd: slot.WorktreePath}
		config, err := loadSlotConfig(slot)
		if err != nil {
			return result{}, err
		}
		main, err := mainBranch(g, config)
		if err != nil {
			return result{}, err
		}
		info, err := g.describe()
		if err != nil {
			return result{}, err
		}
		if info == nil {
			return result{}, fail(exitError, "%s — не git-репозиторий", slot.WorktreePath)
		}
		branch := "(detached)"
		if info.Branch != nil {
			branch = *info.Branch
		}
		dirty := "чисто"
		if n := len(info.Changes); n > 0 {
			dirty = fmt.Sprintf("грязно: %d", n)
		}
		merged := ""
		if branch != main && branch != "(detached)" {
			integrated, err := mergedInto(g, config, main)
			if err != nil {
				return result{}, err
			}
			data["merged"] = integrated
			merged = "не влита"
			if integrated {
				merged = "влита"
			}
		}
		occupancy := "свободен"
		if len(slot.reservation) != 0 && string(slot.reservation) != "null" {
			occupancy = "зарезервирован чатом"
		}
		if len(slot.sessions) > 0 {
			occupancy = fmt.Sprintf("сессий: %d", len(slot.sessions))
		}
		data["branch"], data["dirty"] = branch, len(info.Changes)
		lines = append(lines, fmt.Sprintf("%s  %s  %s  %s  %s", label, branch, dirty, merged, occupancy))
	}
	return result{data: rows, text: strings.Join(lines, "\n")}, nil
}

func selectedProject(ctx context.Context, env environment) (paradev, string, error) {
	host, err := mcpHost(ctx, env)
	if err != nil {
		return host, "", err
	}
	workspaces, err := host.workspaces()
	if err != nil {
		return host, "", err
	}
	projects, err := host.projects()
	if err != nil {
		return host, "", err
	}
	isolated := env
	isolated.get = overrideEnv(env.get, []string{"SUPERSET_WORKSPACE_ID"})
	ws, err := currentWorkspace(isolated, workspaces, false)
	if err != nil {
		return host, "", err
	}
	var candidates []project
	for _, project := range projects {
		if ws == nil && containsPath(project.Path, env.cwd) ||
			ws != nil && (ws.ProjectID != "" && project.ID == ws.ProjectID || ws.ProjectID == "" && project.Name == ws.ProjectName) {
			candidates = append(candidates, project)
		}
	}
	if len(candidates) != 1 || len(slices.DeleteFunc(projects, func(p project) bool { return p.Name != candidates[0].Name })) != 1 {
		return host, "", fail(exitCheck, "Проект Superset не определён однозначно. Выберите точный путь checkout через projects. При одинаковых именах проектов переименуйте один в Paradev.")
	}
	return host, candidates[0].Name, nil
}

func (p paradev) findSlot(ref, project string) (slot, error) {
	rows, err := p.slots(project)
	if err != nil {
		return slot{}, err
	}
	if ref == "" {
		workspaces := make([]workspace, 0, len(rows))
		for _, row := range rows {
			workspaces = append(workspaces, row.workspace)
		}
		current, err := currentWorkspace(p.env, workspaces, true)
		if err != nil {
			return slot{}, err
		}
		ref = current.ID
	}
	matches := slices.DeleteFunc(rows, func(s slot) bool {
		return ref != s.ID && ref != s.Name && ref != s.WorktreePath && ref != slotPattern.FindString(s.Name)
	})
	if len(matches) != 1 {
		return slot{}, fail(exitError, "Слот %s не найден однозначно. Уточните ID или проект.", ref)
	}
	return matches[0], nil
}

func syncCommand(host paradev, ref, project string, both, apply bool) (result, error) {
	original, err := host.findSlot(ref, project)
	if err != nil {
		return result{}, err
	}
	applySync := func() (result, error) {
		current := original
		if apply {
			var err error
			current, err = host.findSlot(original.ID, project)
			if err != nil {
				return result{}, err
			}
			if canonicalPath(original.WorktreePath) != canonicalPath(current.WorktreePath) ||
				canonicalPath(original.checkout) != canonicalPath(current.checkout) {
				return result{}, fail(exitCheck, "Назначение workspace изменилось во время синхронизации")
			}
		}
		if current.checkout == "" || canonicalPath(current.WorktreePath) == canonicalPath(current.checkout) {
			return result{}, fail(exitError, "Это основная копия проекта, а не слот")
		}
		config, err := loadSlotConfig(current)
		if err != nil {
			return result{}, err
		}
		paths, err := localEntries(config)
		if err != nil {
			return result{}, err
		}
		if len(paths) == 0 {
			return result{}, fail(exitError, "В .agent-cli.json проекта нет slot.localFiles — переносить нечего")
		}
		steps := []string{"back"}
		if both {
			steps = append(steps, "forward")
		}
		state, err := syncLocalFiles(host.env, current, paths, steps, apply)
		if err != nil {
			return result{}, err
		}
		code := exitOK
		lines := formatSync(state, "")
		if len(state.Conflicts) > 0 {
			code = exitCheck
		}
		if !apply {
			lines = append(lines, "Применить: --apply")
		}
		return result{data: state, text: strings.Join(lines, "\n"), code: code}, nil
	}
	if apply {
		return host.withSlotLock(original.ID, original.WorktreePath, applySync)
	}
	return applySync()
}
