package agent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type doctorCheck struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Detail string `json:"detail"`
}

type doctorData struct {
	OK          bool          `json:"ok"`
	Checks      []doctorCheck `json:"checks"`
	Limitations []string      `json:"limitations"`
}

func doctor(ctx context.Context, env environment) result {
	config, configErr := loadConfig(env)
	checks := []doctorCheck{}
	add := func(name, detail string, good, required bool) {
		status := "ok"
		if !good {
			status = "warning"
			if required {
				status = "missing"
			}
		}
		checks = append(checks, doctorCheck{Name: name, Status: status, Detail: detail})
	}
	if configErr != nil {
		add("config", configErr.Error(), false, true)
	} else {
		add("config", "Пользовательский конфиг читается (или используются значения по умолчанию)", true, true)
	}
	add("platform", runtime.GOOS+": нужен запущенный локальный хост Paradev.", runtime.GOOS == "darwin" || runtime.GOOS == "linux", false)
	probe := func(name, command string, args ...string) {
		out, err := env.run(ctx, command, args, commandOptions{timeout: 5 * time.Second})
		switch {
		case err != nil:
			add(name, err.Error(), false, true)
		case out.status == 0:
			add(name, command, true, true)
		default:
			detail := fmt.Sprintf("%s: код %d", command, out.status)
			if out.status == 124 {
				detail += " (таймаут)"
			}
			add(name, detail, false, true)
		}
	}
	probe("git", "git", "--version")
	probe("superset", config.Superset, "--version")
	probe("ps", "ps", "-p", strconv.Itoa(os.Getpid()), "-o", "pid=")
	probe("lsof", "lsof", "-v")
	allSkills := true
	for _, name := range workSkills {
		if _, err := skillContent(name); err != nil {
			allSkills = false
		}
	}
	add("bundled-skills", "Встроенные SKILL.md", allSkills, true)
	for _, agent := range []string{"codex", "claude"} {
		directory := filepath.Join(env.home, ".agents", "skills")
		if agent == "claude" {
			directory = filepath.Join(choose(env.get("CLAUDE_CONFIG_DIR"), filepath.Join(env.home, ".claude")), "skills")
		}
		path := filepath.Join(directory, "agent-cli", "SKILL.md")
		add("router-"+agent, path, fileExists(path), false)
	}
	code := exitOK
	lines := make([]string, 0, len(checks)+1)
	for _, check := range checks {
		if check.Status == "missing" {
			code = exitCheck
		}
		lines = append(lines, check.Status+": "+check.Name+" — "+check.Detail)
	}
	lines = append(lines, "Вход в Superset, пресеты и доступ к журналам проверяются при работе с конкретной командой.")
	return result{code: code, text: strings.Join(lines, "\n"), data: doctorData{
		OK: code == exitOK, Checks: checks, Limitations: []string{"Не проверяет вход в Superset, пресеты агентов и доступ к журналам."},
	}}
}

func diagnose(p paradev) (result, error) {
	report := doctor(p.ctx, p.env)
	data := report.data.(doctorData)
	pids := hostPIDs(p.env)
	host := map[string]any{"status": "reachable", "pids": pids}
	config, err := loadConfig(p.env)
	if err == nil {
		p.config = config
		var workspaces []workspace
		workspaces, err = p.workspaces()
		if err == nil {
			host["workspaceCount"] = len(workspaces)
		}
	}
	if err != nil {
		host["status"] = "unavailable"
		var lines []string
		for line := range strings.SplitSeq(err.Error(), "\n") {
			if !strings.HasPrefix(line, "Hint:") {
				lines = append(lines, strings.ReplaceAll(line, " (recorded PID is dead)", ""))
			}
		}
		host["error"] = strings.TrimSpace(strings.Join(lines, "\n"))
		hint := "Проверьте, что Paradev/Superset Desktop открыт, пользователь вошёл в приложение и локальный хост доступен."
		for _, row := range pids {
			if row["process"] == "permission-denied" {
				hint = "Нет прав проверить PID хоста. Проверьте доступ клиента к локальному хосту Paradev и повторите диагностику."
				break
			}
		}
		host["hint"] = hint
		report.code = exitCheck
	}
	executable, _ := os.Executable()
	report.data = map[string]any{
		"ok": data.OK && err == nil, "checks": data.Checks, "limitations": data.Limitations, "host": host, "binaryPath": executable,
	}
	return report, nil
}

func hostPIDs(env environment) []map[string]any {
	roots := []string{filepath.Join(env.home, ".paradev"), filepath.Join(env.home, ".superset")}
	if root := env.get("PARADEV_HOME"); root != "" {
		roots = []string{root}
	}
	results := []map[string]any{}
	for _, root := range roots {
		dir := filepath.Join(root, "host")
		children, _ := os.ReadDir(dir)
		for _, entry := range children {
			path := filepath.Join(dir, entry.Name(), "manifest.json")
			if !fileExists(path) {
				continue
			}
			row := map[string]any{"path": path, "process": "unknown"}
			var manifest struct{ PID int }
			if readJSON(path, &manifest) == nil && manifest.PID > 0 {
				row["pid"] = manifest.PID
				switch syscall.Kill(manifest.PID, 0) {
				case nil:
					row["process"] = "running"
				case syscall.ESRCH:
					row["process"] = "exited"
				case syscall.EPERM:
					row["process"] = "permission-denied"
				}
			}
			results = append(results, row)
		}
	}
	return results
}
