package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"time"

	bundle "github.com/burningyouth/paradev-agent-tools"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func providerHome(env environment, agent string) string {
	if agent == "codex" {
		return choose(env.get("CODEX_HOME"), filepath.Join(env.home, ".codex"))
	}
	return choose(env.get("CLAUDE_CONFIG_DIR"), filepath.Join(env.home, ".claude"))
}

func plainFile(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fail(exitCheck, "Нужен обычный файл: %s", path)
	}
	return os.ReadFile(path)
}

func plainParents(path string) error {
	for parent := filepath.Dir(path); ; parent = filepath.Dir(parent) {
		info, err := os.Lstat(parent)
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		if err == nil && !info.IsDir() {
			return fail(exitCheck, "Каталог должен быть обычной папкой: %s", parent)
		}
		if filepath.Dir(parent) == parent {
			return nil
		}
	}
}

func replaceConfig(path string, before, after []byte, backup string) error {
	if err := plainParents(path); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".agent-cli-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, err = file.Write(after)
	if err == nil {
		err = file.Sync()
	}
	if err := errors.Join(err, file.Close()); err != nil {
		return err
	}
	current, err := plainFile(path)
	if err != nil {
		return err
	}
	if (current == nil) != (before == nil) || !bytes.Equal(current, before) {
		return fail(exitCheck, "Файл изменился во время установки: %s", path)
	}
	if backup != "" {
		if err := plainParents(backup); err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(backup), 0o700); err != nil {
			return err
		}
		copy, err := os.OpenFile(backup, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return err
		}
		_, err = copy.Write(before)
		if err := errors.Join(err, copy.Close()); err != nil {
			return err
		}
	}
	if err := os.Rename(file.Name(), path); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}

type routerItem struct {
	Agent  string  `json:"agent"`
	Path   string  `json:"path"`
	Action string  `json:"action"`
	Backup *string `json:"backup"`
	before []byte
}

func installRouter(env environment, opts options) (result, error) {
	for key := range opts.flags {
		if !slices.Contains([]string{"agent", "directory", "dry-run", "json", "force"}, key) {
			return result{}, fail(exitError, "Установка роутера не принимает --%s", key)
		}
	}
	choice := opts.flags["agent"]
	if choice == "" && opts.flags["json"] != "true" && tty(os.Stdin) && tty(os.Stdout) {
		fmt.Fprint(os.Stdout, "Подключить процессы agent-cli: codex, claude или all? ")
		_, _ = fmt.Fscanln(os.Stdin, &choice)
	}
	if !slices.Contains([]string{"codex", "claude", "all"}, choice) {
		return result{}, fail(exitError, "Нужно: paradev-agent install --agent codex|claude|all [--directory D] [--dry-run] [--force]")
	}
	custom := opts.flags["directory"]
	if custom != "" && choice == "all" {
		return result{}, fail(exitError, "--directory требует одного --agent")
	}
	source, err := bundle.Files.ReadFile("examples/agent-cli/SKILL.md")
	if err != nil {
		return result{}, err
	}
	dry := opts.flags["dry-run"] == "true"
	items := []routerItem{}
	for _, a := range []string{"codex", "claude"} {
		if choice != "all" && a != choice {
			continue
		}
		dir := filepath.Join(providerHome(env, a), "skills")
		if a == "codex" {
			dir = filepath.Join(env.home, ".agents", "skills")
		}
		if custom != "" {
			dir = absoluteOption(env, custom)
		}
		path := filepath.Join(dir, "agent-cli", "SKILL.md")
		if err := plainParents(path); err != nil {
			return result{}, err
		}
		before, err := plainFile(path)
		if err != nil {
			return result{}, err
		}
		item := routerItem{Agent: a, Path: path, Action: "create", before: before}
		if before != nil {
			switch {
			case bytes.Equal(before, source):
				item.Action = "unchanged"
			case !dry && opts.flags["force"] != "true":
				return result{}, fail(exitCheck, "Скилл уже существует или изменён: %s. Посмотрите --dry-run. Для замены с резервной копией используйте --force.", path)
			default:
				item.Action = "replace"
			}
		}
		items = append(items, item)
	}
	lines := []string{}
	for i := range items {
		item := &items[i]
		if !dry && item.Action != "unchanged" {
			var backup string
			if item.before != nil {
				backup = filepath.Join(env.agentHome, "backups", "skills", item.Agent+"-"+uuid()+".md")
				item.Backup = &backup
			}
			if err := replaceConfig(item.Path, item.before, source, backup); err != nil {
				return result{}, err
			}
		}
		lines = append(lines, item.Action+": "+item.Path)
		if item.Backup != nil {
			lines = append(lines, "  резервная копия: "+*item.Backup)
		}
	}
	return result{data: map[string]any{"dryRun": dry, "items": items}, text: strings.Join(lines, "\n")}, nil
}

type hookEvent struct {
	action, event, label string
	timeout              int
}

var hookEvents = []hookEvent{
	{"session-start", "SessionStart", "agent-cli: регистрация сессии", 30},
	{"user-prompt-submit", "UserPromptSubmit", "agent-cli: проверка рабочего слота", 120},
	{"stop", "Stop", "agent-cli: сохранение состояния", 30},
	{"session-end", "SessionEnd", "agent-cli: освобождение слота", 3},
}

const hookPIDPrefix = `AGENT_HOOK_RUNTIME_PID="$PPID" `

func shellSingleQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func hookRunner(env environment) (string, error) {
	if launcher := env.get("AGENT_CLI_LAUNCHER"); filepath.IsAbs(launcher) {
		return shellSingleQuote(launcher) + " --agent-cli", nil
	}
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return shellSingleQuote(canonicalPath(exe)), nil
}

func ownedHook(row map[string]any, event hookEvent, agent, legacy string) bool {
	cmd, ok := row["command"].(string)
	if !ok {
		return false
	}
	cmd = strings.TrimPrefix(cmd, hookPIDPrefix)
	if cmd == legacy {
		return true
	}
	if row["type"] != "command" || row["statusMessage"] != event.label {
		return false
	}
	suffix := " hook " + event.action + " --agent " + agent
	if !strings.HasSuffix(cmd, suffix) {
		return false
	}
	runner := strings.TrimSuffix(cmd, suffix)
	matches := regexp.MustCompile(`^'(?:[^']|'\\'')*/(?:paradev-agent|launch)'(?: --agent-cli)?$|^'(?:[^']|'\\'')*/node(?:\.exe)?' '(?:[^']|'\\'')*/bin/agent\.js'$`)
	return matches.MatchString(runner)
}

func installHooks(env environment, agent string, dry bool) (result, error) {
	if !slices.Contains([]string{"codex", "claude"}, agent) {
		return result{}, fail(exitError, "--agent: выберите codex или claude")
	}
	path := filepath.Join(providerHome(env, agent), "settings.json")
	if agent == "codex" {
		path = filepath.Join(providerHome(env, agent), "hooks.json")
	}
	if err := plainParents(path); err != nil {
		return result{}, err
	}
	before, err := plainFile(path)
	if err != nil {
		return result{}, err
	}
	settings := map[string]any{}
	if before != nil {
		if err := json.Unmarshal(before, &settings); err != nil || settings == nil {
			return result{}, fail(exitCheck, "Неверный формат hooks: %s", path)
		}
	}
	raw, ok := settings["hooks"]
	hooks := map[string]any{}
	if ok {
		hooks, ok = raw.(map[string]any)
		if !ok {
			return result{}, fail(exitCheck, "Неверный формат hooks: %s", path)
		}
	}
	settings["hooks"] = hooks
	runner, err := hookRunner(env)
	if err != nil {
		return result{}, err
	}
	names := []string{}
	for _, e := range hookEvents {
		if e.action == "user-prompt-submit" && agent != "codex" {
			continue
		}
		legacy := runner + " hook " + e.action + " --agent " + agent
		command := hookPIDPrefix + legacy
		var groups []any
		if value, exists := hooks[e.event]; exists {
			groups, ok = value.([]any)
			if !ok {
				return result{}, fail(exitCheck, "Неверный формат %s: %s", e.event, path)
			}
		}
		newGroups := []any{}
		found := false
		for _, value := range groups {
			group, _ := value.(map[string]any)
			rows, ok := group["hooks"].([]any)
			if !ok {
				return result{}, fail(exitCheck, "Неверный формат %s: %s", e.event, path)
			}
			kept := []any{}
			for _, value := range rows {
				hook, ok := value.(map[string]any)
				if !ok {
					return result{}, fail(exitCheck, "Неверный формат %s: %s", e.event, path)
				}
				if ownedHook(hook, e, agent, legacy) {
					if found {
						continue
					}
					found = true
					hook["command"], hook["statusMessage"], hook["timeout"] = command, e.label, float64(e.timeout)
				}
				kept = append(kept, hook)
			}
			if len(rows) == 0 || len(kept) != 0 {
				group["hooks"] = kept
				newGroups = append(newGroups, group)
			}
		}
		if !found {
			newGroups = append(newGroups, map[string]any{"hooks": []any{map[string]any{
				"type": "command", "command": command, "statusMessage": e.label, "timeout": float64(e.timeout),
			}}})
		}
		hooks[e.event] = newGroups
		names = append(names, e.label)
	}
	var prior map[string]any
	_ = json.Unmarshal(before, &prior)
	changed := !reflect.DeepEqual(settings, prior)
	var backup *string
	if changed && !dry {
		if before != nil {
			backup = stringPtr(fmt.Sprintf("%s.agent-cli-%d.bak", path, time.Now().UnixMilli()))
		}
		var out bytes.Buffer
		if err := writeCLIJSON(&out, settings); err != nil {
			return result{}, err
		}
		if err := replaceConfig(path, before, out.Bytes(), nonemptyString(backup)); err != nil {
			return result{}, err
		}
	}
	data := map[string]any{"path": path, "changed": changed, "dryRun": dry, "backup": backup, "hooks": hooks, "names": names}
	if agent == "codex" {
		data["next"] = "Запустите codex в терминале и подтвердите именованные хуки через Hooks need review."
	}
	text, err := json.Marshal(data)
	return result{data: data, text: string(text)}, err
}

func installExecutor(ctx context.Context, env environment, agent string, dry, force bool) (result, error) {
	agents := []string{}
	for _, a := range []string{"codex", "claude"} {
		_, command := exec.LookPath(a)
		if agent == a || agent == "all" || agent == "" && (fileExists(providerHome(env, a)) || command == nil) {
			agents = append(agents, a)
		}
	}
	if len(agents) == 0 {
		return result{}, fail(exitError, "Укажите --agent codex|claude|all")
	}
	selection := agents[0]
	if len(agents) == 2 {
		selection = "all"
	}
	hooks := make([]any, len(agents))
	for i, a := range agents {
		plan, err := installHooks(env, a, true)
		if err != nil {
			return result{}, err
		}
		hooks[i] = plan.data
	}
	router, err := installRouter(env, options{flags: map[string]string{"agent": selection, "dry-run": fmt.Sprint(dry), "force": fmt.Sprint(force)}})
	if err != nil {
		return result{}, err
	}
	if !dry {
		for i, a := range agents {
			out, err := installHooks(env, a, false)
			if err != nil {
				return result{}, err
			}
			hooks[i] = out.data
		}
	}
	diagnostics := doctor(ctx, env)
	status := "installed"
	if dry {
		status = "planned"
	}
	data := map[string]any{"status": status, "dryRun": dry, "agents": agents, "hooks": hooks,
		"skills": router.data.(map[string]any)["items"], "diagnostics": diagnostics.data}
	return result{data: data, text: router.text, code: diagnostics.code}, nil
}

func registerExecutorTools(server *mcp.Server, env environment) {
	addMCPTool(server, env, "executor_install", func(ctx context.Context, in struct {
		Agent string `json:"agent,omitempty"`
		Dry   *bool  `json:"dryRun,omitempty"`
		Force bool   `json:"force,omitempty"`
	}) (result, error) {
		return installExecutor(ctx, env, in.Agent, in.Dry == nil || *in.Dry, in.Force)
	})
	addMCPTool(server, env, "executor_install_skills", func(_ context.Context, in struct {
		Agent     string `json:"agent"`
		Directory string `json:"directory,omitempty"`
		Cwd       string `json:"cwd,omitempty"`
		Dry       *bool  `json:"dryRun,omitempty"`
		Force     bool   `json:"force,omitempty"`
	}) (result, error) {
		local := env
		if in.Cwd != "" {
			local.cwd = absoluteOption(env, in.Cwd)
		}
		return installRouter(local, options{flags: map[string]string{"agent": in.Agent, "directory": in.Directory,
			"dry-run": fmt.Sprint(in.Dry == nil || *in.Dry), "force": fmt.Sprint(in.Force)}})
	})
	addMCPTool(server, env, "executor_install_hooks", func(_ context.Context, in struct {
		Agent string `json:"agent"`
		Dry   *bool  `json:"dryRun,omitempty"`
	}) (result, error) {
		return installHooks(env, in.Agent, in.Dry == nil || *in.Dry)
	})
}
