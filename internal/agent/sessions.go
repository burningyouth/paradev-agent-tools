package agent

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"regexp"
	"slices"
	"strings"
	"time"
)

type chatSession struct {
	SessionID        string          `json:"sessionId"`
	TerminalID       *string         `json:"terminalId"`
	Harness          string          `json:"harness"`
	HarnessSessionID *string         `json:"harnessSessionId"`
	Status           string          `json:"status"`
	Title            *string         `json:"title"`
	Live             bool            `json:"live"`
	UpdatedAt        json.RawMessage `json:"updatedAt"`
}

type liveSession struct {
	kind, agent, terminal, id, nativeID, alias, workspaceID, workspaceName,
	project, cwd, title, state, journal string
	chat       *chatSession
	pid, rssMB int
}

type snapshotWorkspace struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Project   string `json:"project"`
	Branch    string `json:"branch"`
	Terminals []struct {
		ID    string `json:"id"`
		Title string `json:"title"`
		Agent *struct {
			State string `json:"state"`
		} `json:"agent"`
	} `json:"terminals"`
	Layout struct {
		Tabs []struct {
			Panes []paneTerminal `json:"panes"`
		} `json:"tabs"`
	} `json:"layout"`
}

type terminal struct{ workspace, name, project, title, state string }

var (
	stateLabel = map[string]string{
		"working": "работает", "idle": "ждёт задачу", "waiting": "ждёт разрешения/ответа", "unknown": "?",
	}
	slotPattern = regexp.MustCompile(`^slot-\d+`)
	titlePrefix = regexp.MustCompile(`^[^\p{L}\p{N}]+`)
)

func (p paradev) chatList(ws string) ([]chatSession, error) {
	var rows []chatSession
	if err := p.call(&rows, "sessions", "list", "--local", "--workspace", ws, "--limit", "200"); err != nil {
		return nil, err
	}
	var state struct{ Parked map[string]string }
	if err := readJSON(chatSlotPath(p.env, ws), &state); err != nil {
		return nil, err
	}
	for i := range rows {
		row := &rows[i]
		terminal := row.SessionID
		if row.TerminalID != nil {
			terminal = *row.TerminalID
		}
		if parked, ok := state.Parked[row.SessionID]; row.Status == "dead" || (ok && parked == terminal) {
			row.Live = false
		}
	}
	return rows, nil
}

func (p paradev) listSessions(workspaces []workspace, includeStopped bool, chatWorkspace string) ([]liveSession, []agentProcess, error) {
	var snapshot struct{ Workspaces []snapshotWorkspace }
	if err := p.call(&snapshot, "snapshot"); err != nil {
		return nil, nil, err
	}
	reg, _, err := loadRegistry(p.env)
	if err != nil {
		return nil, nil, err
	}
	alias := make(map[string]string, len(reg.Aliases))
	for name, terminal := range reg.Aliases {
		alias[terminal] = name
	}
	terminals := map[string]terminal{}
	for _, ws := range snapshot.Workspaces {
		for _, t := range ws.Terminals {
			state := ""
			if t.Agent != nil {
				state = t.Agent.State
			}
			terminals[t.ID] = terminal{ws.ID, ws.Name, ws.Project, strings.TrimSpace(titlePrefix.ReplaceAllString(t.Title, "")), state}
		}
	}
	paths := make(map[string]workspace, len(workspaces))
	var chats []liveSession
	nativeChats := map[string]bool{}
	for _, ws := range workspaces {
		paths[ws.ID] = ws
		if chatWorkspace != "" && ws.ID != chatWorkspace {
			continue
		}
		rows, err := p.chatList(ws.ID)
		if err != nil {
			return nil, nil, err
		}
		for _, row := range rows {
			agent := ""
			switch {
			case strings.HasPrefix(row.Harness, "codex"):
				agent = "codex"
			case strings.HasPrefix(row.Harness, "claude"):
				agent = "claude"
			default:
				continue
			}
			id, terminal := row.SessionID, row.SessionID
			if row.TerminalID != nil {
				terminal = *row.TerminalID
			}
			var nativeID, title string
			if row.HarnessSessionID != nil {
				nativeID = *row.HarnessSessionID
			}
			if row.Title != nil {
				title = *row.Title
			}
			state := "working"
			switch row.Status {
			case "idle", "not_loaded", "offline", "dead":
				state = "idle"
			case "awaiting_input":
				state = "waiting"
			}
			if nativeID != "" && row.Live {
				nativeChats[nativeID] = true
			}
			if includeStopped || row.Live {
				chats = append(chats, liveSession{
					kind: "chat", agent: agent, terminal: terminal, id: id, nativeID: nativeID,
					workspaceID: ws.ID, workspaceName: ws.Name, project: ws.ProjectName, cwd: ws.WorktreePath,
					alias: alias[terminal], title: title, state: state, chat: &row,
				})
			}
		}
	}
	processes, err := agentProcesses(p.ctx, p.env, false)
	if err != nil {
		return nil, nil, err
	}
	output := make([]liveSession, 0, len(processes)+len(chats))
	for _, proc := range processes {
		if proc.nested {
			continue
		}
		id, wsID, err := processIDs(p.ctx, p.env, proc.pid)
		if err != nil {
			return nil, nil, err
		}
		term := terminals[id]
		wsID = choose(wsID, term.workspace)
		ws := paths[wsID]
		native, err := nativeSession(p.ctx, p.env, proc)
		if err != nil {
			return nil, nil, err
		}
		if nativeChats[native.SessionID] {
			continue
		}
		if proc.agent == "codex" && native.Journal != "" {
			native.Status, err = codexActivity(native.Journal)
			if err != nil {
				return nil, nil, err
			}
		}
		output = append(output, liveSession{
			kind: "cli", agent: proc.agent, terminal: id, id: native.SessionID, alias: alias[id], workspaceID: wsID,
			workspaceName: choose(term.name, ws.Name), project: choose(term.project, ws.ProjectName),
			title: term.title, state: providerState(term.state, native.Status), pid: proc.pid, rssMB: (proc.rssKB + 512) / 1024,
			cwd: native.Cwd, journal: native.Journal,
		})
	}
	return append(output, chats...), processes, nil
}

func codexActivity(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	status := ""
	reader := bufio.NewReader(file)
	for {
		line, err := reader.ReadBytes('\n')
		var row struct {
			Type    string `json:"type"`
			Payload struct {
				Type, Role string
			}
		}
		if json.Unmarshal(line, &row) == nil {
			switch {
			case row.Type == "response_item" && row.Payload.Type == "message" && row.Payload.Role == "user":
				status = "busy"
			case row.Type == "event_msg":
				switch row.Payload.Type {
				case "user_message", "task_started", "turn_started":
					status = "busy"
				case "task_complete", "turn_complete", "turn_aborted":
					status = "idle"
				}
			}
		}
		if err == io.EOF {
			return status, nil
		}
		if err != nil {
			return "", err
		}
	}
}

func providerState(terminal, native string) string {
	switch {
	case terminal == "blocked":
		return "waiting"
	case terminal == "working" || native == "busy":
		return "working"
	case terminal == "idle" || native == "idle":
		return "idle"
	}
	return choose(terminal, choose(native, "unknown"))
}

func (s liveSession) summary() map[string]any {
	var pid any
	if s.pid != 0 {
		pid = s.pid
	}
	return map[string]any{"kind": s.kind, "agent": s.agent, "terminal": nonempty(s.terminal),
		"sessionId": nonempty(s.id), "alias": nonempty(s.alias), "state": s.state, "pid": pid}
}

func (s liveSession) output() map[string]any {
	data := s.summary()
	data["workspace"], data["workspaceName"] = nonempty(s.workspaceID), nonempty(s.workspaceName)
	data["project"], data["cwd"] = nonempty(s.project), nonempty(s.cwd)
	data["title"], data["rssMb"] = nonempty(s.title), s.rssMB
	if s.chat == nil {
		data["journal"] = nonempty(s.journal)
	} else {
		if s.chat.HarnessSessionID != nil {
			data["nativeSessionId"] = s.nativeID
		}
		if len(s.chat.UpdatedAt) != 0 {
			data["updatedAt"] = s.chat.UpdatedAt
		}
		data["live"] = s.chat.Live
	}
	return data
}

func currentSessions(env environment, sessions []liveSession, ws *workspace) []liveSession {
	thread, terminal := env.get("CODEX_THREAD_ID"), env.get("SUPERSET_TERMINAL_ID")
	if thread != "" {
		return slices.DeleteFunc(slices.Clone(sessions), func(s liveSession) bool {
			return s.terminal == "" || s.agent != "codex" || (s.id != thread && s.nativeID != thread)
		})
	}
	if terminal != "" {
		exact := slices.DeleteFunc(slices.Clone(sessions), func(s liveSession) bool { return s.terminal != terminal })
		if len(exact) != 0 {
			return exact
		}
	}
	if ws == nil {
		return nil
	}
	return slices.DeleteFunc(slices.Clone(sessions), func(s liveSession) bool {
		return s.terminal == "" || s.workspaceID != ws.ID
	})
}

func listSessionsResult(p paradev) (result, error) {
	workspaces, err := p.workspaces()
	if err != nil {
		return result{}, err
	}
	sessions, processes, err := p.listSessions(workspaces, false, "")
	if err != nil {
		return result{}, err
	}
	if err := p.observeSessions(sessions, time.Now().UTC()); err != nil {
		return result{}, err
	}
	items := make([]map[string]any, 0, len(sessions))
	lines := make([]string, 0, len(sessions)+2)
	short := func(s string) string { return choose(s[:min(8, len(s))], "—") }
	count := 0
	for _, s := range sessions {
		items = append(items, s.output())
		if s.terminal != "" {
			count++
		}
		lines = append(lines, fmt.Sprintf("%s  %-11s  %-12s %-14s %5d МБ  %s/%s  %s  [%s]",
			short(s.terminal), s.agent+"/"+s.kind, s.alias, choose(stateLabel[s.state], s.state),
			s.rssMB, choose(s.project, "вне Superset"), choose(s.workspaceName, "—"), s.title, short(s.id)))
	}
	nested, sum := []int{}, 0
	for _, proc := range processes {
		if proc.nested {
			nested, sum = append(nested, proc.pid), sum+proc.rssKB
		}
	}
	if len(nested) != 0 {
		lines = append(lines, fmt.Sprintf("Вложенных агентов (codex/claude, подагенты): %d, %d МБ", len(nested), (sum+512)/1024))
	}
	lines = append(lines, fmt.Sprintf("Сессий в Superset: %d из %d", count, p.config.MaxSessions))
	return result{
		data: map[string]any{"sessions": items, "count": count, "limit": p.config.MaxSessions, "nestedPids": nested},
		text: strings.Join(lines, "\n"),
	}, nil
}
