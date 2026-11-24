package agent

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var activityMinutes = regexp.MustCompile(`^\d{1,6}m?$`)

type activityMatch struct {
	File     string `json:"file"`
	Terminal string `json:"terminal"`
	Why      string `json:"why"`
}

func fileActivity(p paradev, names []string, recent string) (result, error) {
	if len(names) == 0 {
		return result{}, fail(exitError, "Нужен путь: paradev-agent activity FILE... [--recent 30m]")
	}
	recent = choose(recent, "30m")
	if !activityMinutes.MatchString(recent) {
		return result{}, fail(exitError, "--recent задаётся в минутах, например 30m")
	}
	minutes, _ := strconv.Atoi(strings.TrimSuffix(recent, "m"))
	since := time.Now().Add(-time.Duration(minutes) * time.Minute)
	ws, err := p.workspaces()
	if err != nil {
		return result{}, err
	}
	sessions, _, err := p.listSessions(ws, false, "")
	if err != nil {
		return result{}, err
	}
	busy := []activityMatch{}
	var lines []string
	for _, session := range sessions {
		if session.terminal != "" && session.terminal == p.env.get("SUPERSET_TERMINAL_ID") &&
			session.workspaceID == p.env.get("SUPERSET_WORKSPACE_ID") {
			continue
		}
		var latest []string
		read := false
		for _, name := range names {
			path := name
			if !filepath.IsAbs(path) {
				path = filepath.Join(p.env.cwd, path)
			}
			why := ""
			if session.state != "idle" && containsPath(session.cwd, path) {
				why = "в worktree работающей сессии"
			} else {
				if !read {
					read = true
					info, err := p.transcript(session, time.Time{})
					if err != nil && (session.kind != "cli" || codeOf(err) != exitError) {
						return result{}, err
					}
					for _, row := range info.records {
						stamp, err := time.Parse(time.RFC3339Nano, row.Timestamp)
						if err != nil || stamp.Before(since) {
							continue
						}
						if row.searchText != "" {
							latest = append(latest, row.searchText)
						} else {
							encoded, _ := json.Marshal(row)
							latest = append(latest, string(encoded))
						}
					}
				}
				for _, text := range latest {
					if strings.Contains(text, filepath.Base(name)) {
						why = "упомянут в журнале недавно"
						break
					}
				}
			}
			if why != "" {
				id := choose(session.terminal, fmt.Sprintf("pid %d", session.pid))
				busy = append(busy, activityMatch{File: name, Terminal: id, Why: why})
				lines = append(lines, fmt.Sprintf("%s — %s: %s", name, id, why))
			}
		}
	}
	return result{data: map[string]any{"busy": busy},
		text: choose(strings.Join(lines, "\n"), "Активность по файлам не найдена")}, nil
}
