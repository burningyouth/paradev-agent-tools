package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
)

type agentProcess struct {
	pid, parent, rssKB int
	agent              string
	launcher, nested   bool
}

var (
	processPattern = regexp.MustCompile(`^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$`)
	codexShim      = regexp.MustCompile(`^\S+\s+\S*/codex(?:\.js|/bin/codex\.js)(?:\s|$)`)
	idsInPSEnv     = regexp.MustCompile(` SUPERSET_(TERMINAL|WORKSPACE)_ID=([0-9A-Za-z-]+)`)
)

func agentProcesses(ctx context.Context, env environment, includeServers bool) ([]agentProcess, error) {
	out, err := env.run(ctx, "ps", []string{"-axo", "pid=,ppid=,rss=,command="}, commandOptions{})
	if err != nil {
		return nil, err
	}
	if out.status != 0 {
		return nil, fail(exitCheck, "Не удалось проверить процессы агентов: %s", out.diagnostic())
	}
	parents := map[int]int{}
	var processes []agentProcess
	for line := range strings.SplitSeq(out.stdout, "\n") {
		row := processPattern.FindStringSubmatch(strings.TrimSpace(line))
		if row == nil {
			continue
		}
		pid, _ := strconv.Atoi(row[1])
		parent, _ := strconv.Atoi(row[2])
		rssKB, _ := strconv.Atoi(row[3])
		parents[pid] = parent
		fields := strings.Fields(row[4])
		if len(fields) == 0 {
			continue
		}
		executable := filepath.Base(fields[0])
		shim := executable == "node" && codexShim.MatchString(row[4])
		server := len(fields) > 1 && (fields[1] == "app-server" || fields[1] == "mcp-server")
		var agent string
		switch {
		case executable == "claude":
			agent = "claude"
		case (executable == "codex" || shim) && (includeServers || !server):
			agent = "codex"
		default:
			continue
		}
		processes = append(processes, agentProcess{pid: pid, parent: parent, rssKB: rssKB, agent: agent, launcher: shim})
	}
	if includeServers {
		return processes, nil
	}
	hasAncestor := func(pid int, includes func(int) bool) bool {
		for parent, depth := parents[pid], 0; parent > 1 && depth < 64; parent, depth = parents[parent], depth+1 {
			if includes(parent) {
				return true
			}
		}
		return false
	}
	agents := make([]agentProcess, 0, len(processes))
	for _, row := range processes {
		if row.launcher && slices.ContainsFunc(processes, func(candidate agentProcess) bool {
			return candidate.agent == "codex" && !candidate.launcher &&
				hasAncestor(candidate.pid, func(pid int) bool { return pid == row.pid })
		}) {
			continue
		}
		agents = append(agents, row)
	}
	pids := make(map[int]bool, len(agents))
	for _, agent := range agents {
		pids[agent.pid] = true
	}
	for i := range agents {
		agents[i].nested = hasAncestor(agents[i].pid, func(pid int) bool { return pids[pid] })
	}
	return agents, nil
}

func processIDs(ctx context.Context, env environment, pid int) (terminal, workspace string, err error) {
	if runtime.GOOS == "linux" {
		buf, err := os.ReadFile(fmt.Sprintf("/proc/%d/environ", pid))
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, fs.ErrPermission) {
			return "", "", nil
		}
		if err != nil {
			return "", "", err
		}
		for part := range strings.SplitSeq(string(buf), "\x00") {
			name, value, _ := strings.Cut(part, "=")
			switch name {
			case "SUPERSET_TERMINAL_ID":
				terminal = value
			case "SUPERSET_WORKSPACE_ID":
				workspace = value
			}
		}
		return terminal, workspace, nil
	}
	flags := []string{"-p", strconv.Itoa(pid), "-o", "command="}
	args, err := env.run(ctx, "ps", flags, commandOptions{})
	if err != nil {
		return "", "", err
	}
	all, err := env.run(ctx, "ps", append([]string{"-E"}, flags...), commandOptions{})
	if err != nil {
		return "", "", err
	}
	text := strings.TrimPrefix(trimEnd(all.stdout), trimEnd(args.stdout))
	for _, match := range idsInPSEnv.FindAllStringSubmatch(text, -1) {
		switch match[1] {
		case "TERMINAL":
			terminal = match[2]
		case "WORKSPACE":
			workspace = match[2]
		}
	}
	return terminal, workspace, nil
}

func trimEnd(value string) string { return strings.TrimRight(value, " \t\r\n") }

type nativeMetadata struct {
	SessionID string `json:"sessionId"`
	Cwd       string `json:"cwd"`
	Status    string `json:"status"`
	Journal   string `json:"journal"`
}

func nativeSession(ctx context.Context, env environment, proc agentProcess) (nativeMetadata, error) {
	if proc.agent == "claude" {
		var info nativeMetadata
		home := choose(env.get("CLAUDE_CONFIG_DIR"), filepath.Join(env.home, ".claude"))
		err := readJSON(filepath.Join(home, "sessions", strconv.Itoa(proc.pid)+".json"), &info)
		return info, err
	}
	out, err := env.run(ctx, "lsof", []string{"-a", "-p", strconv.Itoa(proc.pid), "-Fn"}, commandOptions{})
	if err != nil {
		return nativeMetadata{}, err
	}
	matches := map[string]nativeMetadata{}
	for row := range strings.SplitSeq(out.stdout, "\n") {
		if !strings.HasPrefix(row, "n") {
			continue
		}
		path := row[1:]
		name := filepath.Base(path)
		if !strings.HasPrefix(name, "rollout-") || !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		if info := codexRolloutMeta(path); info.SessionID != "" {
			matches[path] = info
		}
	}
	if len(matches) != 1 {
		return nativeMetadata{}, nil
	}
	for _, info := range matches {
		return info, nil
	}
	return nativeMetadata{}, nil
}

func codexRolloutMeta(path string) nativeMetadata {
	file, err := os.Open(path)
	if err != nil {
		return nativeMetadata{}
	}
	defer file.Close()
	line, _ := bufio.NewReader(file).ReadBytes('\n')
	var record struct {
		Type    string `json:"type"`
		Payload struct {
			ID     string                             `json:"id"`
			Cwd    string                             `json:"cwd"`
			Source struct{ Subagent json.RawMessage } `json:"source"`
		} `json:"payload"`
	}
	// Some rollouts use a string for source; the other fields are still decoded.
	err = json.Unmarshal(line, &record)
	var wrongType *json.UnmarshalTypeError
	if err != nil && (!errors.As(err, &wrongType) || wrongType.Field != "payload.source") {
		return nativeMetadata{}
	}
	data := record.Payload
	if record.Type != "session_meta" || data.ID == "" || data.Cwd == "" ||
		(len(data.Source.Subagent) != 0 && string(data.Source.Subagent) != "null" && string(data.Source.Subagent) != "false") {
		return nativeMetadata{}
	}
	return nativeMetadata{SessionID: data.ID, Cwd: data.Cwd, Journal: path}
}
