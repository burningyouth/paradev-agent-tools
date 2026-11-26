package agent

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

func (p *clientInstaller) selectOpenCodeWorkspace(in *bufio.Scanner, out io.Writer) (string, error) {
	config, err := loadConfig(p.env)
	if err != nil {
		return "", err
	}
	workspaces, err := (paradev{ctx: p.ctx, env: p.env, config: config}).workspaces()
	if err != nil {
		return "", fmt.Errorf("не удалось получить список локальных workspace; укажите --workspace ПУТЬ: %w", err)
	}
	var labels, paths []string
	for _, workspace := range workspaces {
		if filepath.IsAbs(workspace.WorktreePath) && (workspace.WorktreeExists == nil || *workspace.WorktreeExists) {
			if info, err := os.Stat(workspace.WorktreePath); err == nil && info.IsDir() {
				paths = append(paths, workspace.WorktreePath)
				labels = append(labels, fmt.Sprintf("%s / %s — %s", workspace.ProjectName, workspace.Name, workspace.WorktreePath))
			}
		}
	}
	if len(paths) == 0 {
		return "", fmt.Errorf("нет доступных локальных workspace; укажите --workspace ПУТЬ")
	}
	return selectClient(in, out, "Выберите локальный workspace Paradev:", labels, paths), nil
}

func openCodeConfigFiles(dir string) []string {
	return []string{filepath.Join(dir, "opencode.json"), filepath.Join(dir, "opencode.jsonc")}
}

func (p *clientInstaller) installOpenCodeWorkspace(workspacePath, profile string) (map[string]any, error) {
	if workspacePath == "" {
		return nil, fmt.Errorf("укажите --workspace ПУТЬ к корню локального workspace Paradev")
	}
	disabled := p.env.get("OPENCODE_DISABLE_PROJECT_CONFIG")
	if disabled == "1" || strings.EqualFold(disabled, "true") || p.env.get("OPENCODE_CONFIG") != "" || p.env.get("OPENCODE_CONFIG_CONTENT") != "" {
		return nil, fmt.Errorf("OpenCode переопределяет конфигурацию через окружение; проверьте OPENCODE_DISABLE_PROJECT_CONFIG, OPENCODE_CONFIG и OPENCODE_CONFIG_CONTENT")
	}
	if !filepath.IsAbs(workspacePath) {
		workspacePath = filepath.Join(p.env.cwd, workspacePath)
	}
	root := canonicalPath(workspacePath)
	git := gitClient{ctx: p.ctx, env: p.env, cwd: root}
	gitRoot, err := git.requireRoot()
	if err != nil || canonicalPath(gitRoot) != root {
		return nil, fmt.Errorf("выберите корень локального Git worktree: %s", root)
	}
	if profile == "" {
		appHome := choose(strings.TrimSpace(p.env.get("SUPERSET_HOME_DIR")), filepath.Join(p.env.home, ".paradev"))
		profile = filepath.Join(appHome, "hooks", "opencode")
	}
	if !filepath.IsAbs(profile) {
		return nil, fmt.Errorf("--profile должен быть абсолютным путём к OPENCODE_CONFIG_DIR Paradev")
	}
	profile = canonicalPath(profile)
	if info, err := os.Stat(profile); err != nil || !info.IsDir() {
		return nil, fmt.Errorf("профиль OpenCode внутри Paradev не найден: %s; укажите --profile ПУТЬ", profile)
	}

	// OpenCode 2 reads the profile, then direct project configs and then .opencode
	// configs, walking ancestors farthest first in each project pass.
	dirs := []string{root}
	for dir := root; filepath.Dir(dir) != dir; {
		dir = filepath.Dir(dir)
		dirs = append(dirs, dir)
	}
	slices.Reverse(dirs)
	paths := openCodeConfigFiles(profile)
	for _, dir := range dirs {
		paths = append(paths, openCodeConfigFiles(dir)...)
	}
	for _, dir := range dirs {
		paths = append(paths, openCodeConfigFiles(filepath.Join(dir, ".opencode"))...)
	}
	target := filepath.Join(root, ".opencode", "opencode.jsonc")
	if profile == filepath.Dir(target) {
		return nil, fmt.Errorf("настройки workspace совпадают с общим профилем OpenCode: %s", profile)
	}
	existingConfig := ""
	pluginConfig := ""
	disabledPlugin := ""
	serverSources := map[string]openCodeServerSource{}
	for _, path := range paths {
		before, _, node, err := getSourceNode(path)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		if before == nil {
			continue
		}
		if mcp := node.get("mcp"); mcp != nil {
			if mcp.children == nil {
				return nil, fmt.Errorf("в %s ожидался объект mcp", path)
			}
			// V2 can still load the legacy flat configuration form.
			for name, entry := range mcp.children {
				if name != "servers" && name != "timeout" {
					serverSources[name] = openCodeServerSource{path, entry}
				}
			}
			if entries := mcp.get("servers"); entries != nil {
				if entries.children == nil {
					return nil, fmt.Errorf("в %s ожидался объект mcp.servers", path)
				}
				for name, entry := range entries.children {
					serverSources[name] = openCodeServerSource{path, entry}
				}
			}
		}
		if entries := node.get("plugins"); entries != nil {
			plugins, ok := entries.value.([]any)
			if !ok {
				return nil, fmt.Errorf("в %s ожидался массив plugins", path)
			}
			for _, entry := range plugins {
				if spec := openCodePluginSpec(entry); paradevPluginSpec(spec, filepath.Dir(path)) {
					pluginConfig, disabledPlugin = path, ""
				} else if spec == "-"+productName {
					pluginConfig, disabledPlugin = "", path
				} else if spec == "-*" {
					pluginConfig = ""
				}
			}
		}
	}
	for _, name := range []string{productName, "multi-agent-mcp"} {
		if server, ok := serverSources[name]; ok && !server.isParadev() {
			return nil, fmt.Errorf("имя MCP %s уже занято в %s; настройки не изменены", name, server.path)
		}
	}
	for _, name := range slices.Sorted(maps.Keys(serverSources)) {
		server := serverSources[name]
		if !server.isParadev() {
			continue
		}
		if server.disabled() {
			return nil, fmt.Errorf("MCP %s отключён в %s; включите его явно", name, server.path)
		}
		existingConfig = server.path
		break
	}
	if existingConfig == "" {
		if disabledPlugin != "" {
			return nil, fmt.Errorf("плагин Paradev Agent Tools отключён в %s; включите его явно", disabledPlugin)
		}
		existingConfig = pluginConfig
	}

	launch := filepath.Join(p.source, "launch")
	if p.dev {
		if pluginConfig != "" {
			return nil, fmt.Errorf("в %s уже подключён плагин; выберите отдельный профиль", pluginConfig)
		}
		for _, server := range serverSources {
			if server.isParadev() && !matchesClientCommand(server.node, launch, true) {
				return nil, fmt.Errorf("в %s уже подключён другой MCP Paradev; выберите отдельный профиль", server.path)
			}
		}
		if err := p.linkDevSkills(filepath.Join(root, ".opencode")); err != nil {
			return nil, err
		}
	}
	if p.managed {
		if err := setupZIPWorkspace(p, root, serverSources, pluginConfig); err != nil {
			return nil, err
		}
	}
	report := map[string]any{"target": "opencode-paradev", "workspace": root, "profile": profile, "activated": p.dev}
	if existingConfig != "" {
		report["status"], report["config"], report["backups"] = "already-configured", existingConfig, []string{}
		if p.managed {
			report["launcher"] = filepath.Join(p.installed, "launch")
			report["installed"] = p.installed
		} else if p.dev {
			report["launcher"] = launch
			report["installed"] = p.source
		}
		report["message"] = fmt.Sprintf("OpenCode внутри Paradev — %s\nMCP уже настроен: %s\nПроверьте подключение в этом workspace командой opencode mcp list.", root, existingConfig)
		return report, nil
	}

	if p.managed {
		launch = filepath.Join(p.installed, "launch")
		report["installed"] = p.installed
	}
	if manifest, err := readClientPackage(p.source); err != nil || manifest.Name != productName || !executableFile(launch) {
		return nil, fmt.Errorf("запустите установку через launch из готового пакета Paradev Agent Tools")
	}
	before, source, node, err := getSourceNode(target)
	if err != nil {
		return nil, err
	}
	updated, err := patchJSONC(source, node, []string{"mcp", "servers", productName}, map[string]any{
		"type": "local", "command": []string{launch}, "timeout": map[string]any{"execution": 180000},
	})
	if err != nil {
		return nil, err
	}
	backup, err := (clientChange{path: target, before: before, after: []byte(updated)}).apply()
	if err != nil {
		return nil, err
	}
	backups := []string{}
	if backup != "" {
		backups = append(backups, backup)
	}
	report["status"], report["config"], report["launcher"], report["backups"] = "configured", target, launch, backups
	report["message"] = fmt.Sprintf("OpenCode внутри Paradev — %s\nMCP настроен: %s\nКоманда: %s\nОткройте OpenCode в этом workspace и проверьте opencode mcp list.", root, target, launch)
	return report, nil
}

type openCodeServerSource struct {
	path string
	node *jsoncNode
}

func (s openCodeServerSource) disabled() bool {
	disabled, enabled := s.node.get("disabled"), s.node.get("enabled")
	return disabled != nil && disabled.value == true || enabled != nil && enabled.value == false
}

func (s openCodeServerSource) isParadev() bool {
	command := s.node.get("command")
	kind := s.node.get("type")
	if command == nil || kind == nil || kind.value != "local" {
		return false
	}
	items, _ := command.value.([]any)
	if len(items) == 2 && items[0] == "/bin/sh" {
		items = items[1:]
	}
	if len(items) != 1 {
		return false
	}
	path, _ := items[0].(string)
	if !filepath.IsAbs(path) || filepath.Base(path) != "launch" {
		return false
	}
	dir := filepath.Dir(path)
	if _, err := currentRelease(dir); err == nil {
		return executableFile(path)
	}
	manifest, err := readClientPackage(dir)
	return err == nil && (manifest.Name == productName || manifest.Name == "multi-agent-mcp") && executableFile(path)
}

func executableFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0
}

func openCodePluginSpec(entry any) string {
	if object, ok := entry.(map[string]any); ok {
		entry = object["package"]
	}
	value, _ := entry.(string)
	return value
}

func paradevPluginSpec(spec, dir string) bool {
	source, _, _ := strings.Cut(spec, "#")
	switch source {
	case "git+https://github.com/" + pluginRepo + ".git", "git+https://github.com/" + pluginRepo,
		"github:" + pluginRepo, "git+ssh://git@github.com/" + pluginRepo + ".git":
		return true
	}
	if strings.HasPrefix(spec, "file://") {
		u, err := url.Parse(spec)
		if err != nil || u.Host != "" {
			return false
		}
		spec = u.Path
	}
	if !filepath.IsAbs(spec) {
		if !strings.HasPrefix(spec, "./") && !strings.HasPrefix(spec, "../") {
			return false
		}
		spec = filepath.Join(dir, spec)
	}
	var pkg struct{ Name string }
	data, err := os.ReadFile(filepath.Join(spec, "package.json"))
	return err == nil && json.Unmarshal(data, &pkg) == nil && pkg.Name == productName+"-opencode"
}
