package agent

import (
	"regexp"
	"strings"
)

type paneTerminal struct {
	ID         string `json:"id"`
	TerminalID string `json:"terminalId"`
}

type terminalCleanup struct {
	Pane, Terminal, Reason string
}

var shellPrompt = regexp.MustCompile(`[%$#❯➜>»]\s*$`)

func (p paradev) workspaceSnapshot() ([]snapshotWorkspace, error) {
	var snapshot struct{ Workspaces []snapshotWorkspace }
	err := p.call(&snapshot, "snapshot")
	return snapshot.Workspaces, err
}

func (p paradev) snapshotOf(id string) (snapshotWorkspace, error) {
	rows, err := p.workspaceSnapshot()
	if err != nil {
		return snapshotWorkspace{}, err
	}
	for _, row := range rows {
		if row.ID == id {
			return row, nil
		}
	}
	return snapshotWorkspace{ID: id}, nil
}

func workspacePanes(ws snapshotWorkspace) []paneTerminal {
	var result []paneTerminal
	for _, tab := range ws.Layout.Tabs {
		for _, pane := range tab.Panes {
			if pane.TerminalID != "" {
				result = append(result, pane)
			}
		}
	}
	return result
}

func (p paradev) hostCommand(what string, args ...string) error {
	_, err := mustRun(p.ctx, p.env, p.config.Superset, args, commandOptions{what: "superset " + what, timeout: p.timeout})
	return err
}

func (p paradev) closePane(workspace, pane string) error {
	return p.hostCommand("panes close", "panes", "close", "--workspace", workspace, "--pane", pane)
}

func (p paradev) closeTerminal(workspace, id string) (map[string]any, error) {
	ws, err := p.snapshotOf(workspace)
	if err != nil {
		return nil, err
	}
	return p.closeSnapshotTerminal(ws, id)
}

func (p paradev) closeSnapshotTerminal(ws snapshotWorkspace, terminal string) (map[string]any, error) {
	for _, pane := range workspacePanes(ws) {
		if pane.TerminalID == terminal {
			return map[string]any{"pane": pane.ID, "terminal": terminal}, p.closePane(ws.ID, pane.ID)
		}
	}
	return map[string]any{"terminal": terminal},
		p.hostCommand("terminals close", "terminals", "close", "--local", "--workspace", ws.ID, "--terminal", terminal)
}

func stalePanes(ws snapshotWorkspace) []terminalCleanup {
	live := map[string]bool{}
	for _, terminal := range ws.Terminals {
		live[terminal.ID] = true
	}
	var result []terminalCleanup
	for _, pane := range workspacePanes(ws) {
		if !live[pane.TerminalID] {
			result = append(result, terminalCleanup{Pane: pane.ID, Terminal: pane.TerminalID, Reason: "панель без терминала"})
		}
	}
	return result
}

func (p paradev) idleTerminals(ws snapshotWorkspace, protected map[string]bool) ([]terminalCleanup, error) {
	var response struct {
		Sessions []struct {
			TerminalID string
			Exited     bool
		}
	}
	if err := p.call(&response, "terminals", "list", "--local", "--workspace", ws.ID); err != nil {
		return nil, err
	}
	exited := map[string]bool{}
	for _, item := range response.Sessions {
		exited[item.TerminalID] = item.Exited
	}
	var plan []terminalCleanup
	for _, terminal := range ws.Terminals {
		id := terminal.ID
		if protected[id] || id == p.env.get("SUPERSET_TERMINAL_ID") {
			continue
		}
		reason := ""
		switch {
		case exited[id]:
			reason = "терминал завершился"
		case terminal.Agent != nil:
			if terminal.Agent.State == "exited" {
				reason = "агент завершился"
			}
		case strings.TrimSpace(titlePrefix.ReplaceAllString(terminal.Title, "")) == "":
			var screen struct{ Text string }
			err := p.call(&screen, "terminals", "read", "--local", "--workspace", ws.ID, "--terminal", id, "--max-lines", "5")
			if err != nil {
				return nil, err
			}
			text := trimEnd(screen.Text)
			last := text[strings.LastIndex(text, "\n")+1:]
			if last == "" || shellPrompt.MatchString(last) {
				reason = "пустой шелл"
			}
		}
		if reason != "" {
			plan = append(plan, terminalCleanup{Terminal: id, Reason: reason})
		}
	}
	return plan, nil
}

func (p paradev) tidyWorkspace(workspace string) ([]map[string]any, error) {
	tidied := []map[string]any{}
	_, live, err := p.liveWorkspaces()
	if err != nil {
		return nil, err
	}
	protected := map[string]bool{}
	for _, s := range live {
		protected[s.terminal] = true
	}
	ws, err := p.snapshotOf(workspace)
	if err != nil || len(ws.Terminals) == 0 && len(workspacePanes(ws)) == 0 {
		return tidied, err
	}
	targets, err := p.idleTerminals(ws, protected)
	if err != nil {
		return nil, err
	}
	for _, target := range targets {
		out, err := p.closeSnapshotTerminal(ws, target.Terminal)
		if err != nil {
			return nil, err
		}
		out["reason"] = target.Reason
		tidied = append(tidied, out)
	}
	ws, err = p.snapshotOf(workspace)
	if err != nil {
		return nil, err
	}
	for _, pane := range stalePanes(ws) {
		if err := p.closePane(workspace, pane.Pane); err != nil {
			return nil, err
		}
		tidied = append(tidied, map[string]any{"pane": pane.Pane, "terminal": pane.Terminal, "reason": pane.Reason})
	}
	return tidied, nil
}
