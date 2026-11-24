package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

type configuration struct {
	MaxSessions          int    `json:"maxSessions"`
	Superset             string `json:"superset"`
	SendAcceptTimeoutSec int    `json:"sendAcceptTimeoutSec"`
}

func loadConfig(env environment) (configuration, error) {
	const defaultSuperset = "~/.superset/bin/superset"
	config := configuration{MaxSessions: 5, Superset: defaultSuperset, SendAcceptTimeoutSec: 20}
	err := readJSON(filepath.Join(env.agentHome, "config.json"), &config)
	config.Superset = resolveSuperset(env, choose(env.get("SUPERSET_BIN"), config.Superset))
	return config, err
}

func resolveSuperset(env environment, value string) string {
	const classic = ".superset/bin/superset"
	search := func(name string) string {
		for _, dir := range filepath.SplitList(env.get("PATH")) {
			if dir != "" {
				candidate := filepath.Join(dir, name)
				if fileExists(candidate) {
					return candidate
				}
			}
		}
		return ""
	}
	for _, dir := range []string{classic, ".paradev/bin/superset", "superset/bin/superset"} {
		fallback := filepath.Join(env.home, dir)
		if strings.HasPrefix(value, "~/") {
			if name := filepath.Join(env.home, value[2:]); fileExists(name) {
				return name
			}
		} else if strings.ContainsRune(value, '/') && fileExists(value) {
			return value
		} else if !strings.ContainsRune(value, '/') {
			if path := search(value); path != "" {
				return path
			}
		}
		if fileExists(fallback) {
			return fallback
		}
	}
	if value == "~/"+classic {
		return choose(search("superset"), filepath.Join(env.home, classic))
	}
	if strings.HasPrefix(value, "~/") {
		return filepath.Join(env.home, value[2:])
	}
	return choose(search(value), choose(pathIfQualified(value), filepath.Join(env.home, classic)))
}

func pathIfQualified(path string) string {
	if strings.ContainsRune(path, '/') {
		return path
	}
	return ""
}

type paradev struct {
	ctx     context.Context
	env     environment
	config  configuration
	timeout time.Duration
}

type workspace struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	ProjectID      string `json:"projectId"`
	ProjectName    string `json:"projectName"`
	WorktreePath   string `json:"worktreePath"`
	WorktreeExists *bool  `json:"worktreeExists"`
}

type project struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`
}

func (p paradev) call(out any, args ...string) error {
	what := "superset " + strings.Join(args[:min(2, len(args))], " ")
	raw, err := mustRun(p.ctx, p.env, p.config.Superset, append(slices.Clone(args), "--json"),
		commandOptions{what: what, timeout: p.timeout})
	if err != nil {
		return err
	}
	if err := json.Unmarshal([]byte(raw), out); err != nil {
		return fail(exitError, "%s: ответ не JSON\n%s", what, raw[:min(500, len(raw))])
	}
	return nil
}

func (p paradev) workspaces() ([]workspace, error) {
	var raw json.RawMessage
	if err := p.call(&raw, "ws", "list", "--local"); err != nil {
		return nil, err
	}
	rows := []workspace{}
	if len(raw) > 0 && raw[0] == '[' {
		err := json.Unmarshal(raw, &rows)
		return rows, err
	}
	var wrapped struct {
		Workspaces []workspace `json:"workspaces"`
		Items      []workspace `json:"items"`
	}
	if err := json.Unmarshal(raw, &wrapped); err != nil {
		return nil, err
	}
	if wrapped.Workspaces != nil {
		return wrapped.Workspaces, nil
	}
	if wrapped.Items != nil {
		return wrapped.Items, nil
	}
	return rows, nil
}

func (p paradev) projects() ([]project, error) {
	rows := []project{}
	err := p.call(&rows, "projects", "list")
	return rows, err
}

func currentWorkspace(env environment, workspaces []workspace, required bool) (*workspace, error) {
	id := env.get("SUPERSET_WORKSPACE_ID")
	var match *workspace
	matched, longest := 0, 0
	for _, row := range workspaces {
		if id != "" {
			if row.ID == id {
				match, matched = &row, matched+1
			}
			continue
		}
		if !containsPath(row.WorktreePath, env.cwd) {
			continue
		}
		path := canonicalPath(row.WorktreePath)
		switch {
		case len(path) > longest:
			longest, match, matched = len(path), &row, 1
		case len(path) == longest && path == canonicalPath(match.WorktreePath):
			matched++
		}
	}
	if matched > 1 {
		return nil, fail(exitError, "Текущий workspace Superset неоднозначен")
	}
	if match != nil || (!required && id == "") {
		return match, nil
	}
	if id != "" {
		return nil, fail(exitGone, "Workspace Superset %s из окружения не найден", id)
	}
	return nil, fail(exitGone, "Не удалось определить текущий workspace Superset по cwd")
}

func exactWorkspace(workspaces []workspace, id string) (*workspace, error) {
	for _, row := range workspaces {
		if row.ID == id {
			return &row, nil
		}
	}
	return nil, fail(exitGone, "Укажите существующий точный workspaceId: %s. Используйте projects.", id)
}

func projectsResult(p paradev) (result, error) {
	workspaces, err := p.workspaces()
	if err != nil {
		return result{}, err
	}
	projects, err := p.projects()
	if err != nil {
		return result{}, err
	}
	items := make([]map[string]string, 0, len(workspaces))
	var lines []string
	for _, row := range workspaces {
		items = append(items, map[string]string{
			"id": row.ID, "name": row.Name, "projectId": row.ProjectID,
			"projectName": row.ProjectName, "path": row.WorktreePath,
		})
		lines = append(lines, fmt.Sprintf("%s  %s  %s", row.ID, row.Name, row.WorktreePath))
	}
	return result{
		data: map[string]any{"projects": projects, "workspaces": items},
		text: strings.Join(lines, "\n"),
	}, nil
}
