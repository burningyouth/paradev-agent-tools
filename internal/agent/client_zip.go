package agent

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"time"
)

const updateSkill = "paradev-agent-update"

func (p *clientInstaller) linkReleaseSkills(dir string) error {
	for _, name := range []string{productName, updateSkill} {
		relative := filepath.Join("skills", name)
		if err := ensureReleaseLink(filepath.Join(dir, relative), filepath.Join(p.installed, "current", "package", relative)); err != nil {
			return err
		}
	}
	return nil
}

func (p *clientInstaller) installZIP() (map[string]any, error) {
	if err := prepareReleaseInstall(p.installed, p.source); err != nil {
		return nil, err
	}
	launch := filepath.Join(p.installed, "launch")
	report := map[string]any{"installed": p.installed, "launcher": launch, "target": p.client, "activated": p.client != "manual"}
	switch p.client {
	case "manual":
		report["message"] = "Укажите путь для локального MCP stdio: " + launch +
			"\nДля CLI используйте " + filepath.Join(p.installed, "paradev-agent") + " или выполните launch --agent-cli install."
		return report, nil
	case "codex":
		profile := providerHome(p.env, "codex")
		if err := p.installZIPCodex(profile, launch); err != nil {
			return nil, err
		}
		report["profile"] = profile
	case "opencode", "opencode-v1":
		if err := p.checkZIPOpenCode(launch); err != nil {
			return nil, err
		}
		settings, err := p.openCodeSettings()
		if err != nil {
			return nil, err
		}
		if err := p.linkReleaseSkills(p.openConfig); err != nil {
			return nil, err
		}
		for _, setting := range settings {
			if _, err := setting.apply(); err != nil {
				return nil, err
			}
		}
		report["profile"] = p.openConfig
	case "kilo":
		settings, err := p.kiloSettings()
		if err != nil {
			return nil, err
		}
		for _, setting := range settings {
			if _, err := setting.apply(); err != nil {
				return nil, err
			}
		}
		report["profile"] = filepath.Join(p.configHome, "kilo")
	}
	report["message"] = "ZIP подключён. Откройте новый чат после перезапуска клиента и проверьте источник через plugin_source."
	return report, nil
}

func (p *clientInstaller) installZIPCodex(profile, launch string) error {
	binary := p.firstExecutable("codex")
	if binary == "" {
		return fmt.Errorf("команда codex не найдена; добавьте MCP вручную: %s", launch)
	}
	if !filepath.IsAbs(profile) {
		return fmt.Errorf("CODEX_HOME должен быть абсолютным путём: %s", profile)
	}
	run := func(args ...string) (string, error) {
		return mustRun(p.ctx, p.env, binary, args, commandOptions{dir: p.env.home, timeout: 15 * time.Second, what: "codex " + strings.Join(args, " ")})
	}
	out, err := run("mcp", "list", "--json")
	if err != nil {
		return err
	}
	var servers []struct {
		Name      string
		Enabled   bool
		Transport struct {
			Type, Command string
			Args          []string
		}
	}
	if err := json.Unmarshal([]byte(out), &servers); err != nil {
		return err
	}
	found := false
	for _, server := range servers {
		if server.Name != productName {
			continue
		}
		if found || !server.Enabled || server.Transport.Type != "stdio" || server.Transport.Command != launch || len(server.Transport.Args) != 0 {
			return fmt.Errorf("имя MCP %s уже используется в профиле Codex %s", productName, profile)
		}
		found = true
	}
	if err := p.linkReleaseSkills(profile); err != nil {
		return err
	}
	if !found {
		_, err = run("mcp", "add", productName, "--", launch)
	}
	return err
}

func (p *clientInstaller) checkZIPOpenCode(launch string) error {
	for _, config := range openCodeConfigFiles(p.openConfig) {
		_, _, node, err := getSourceNode(config)
		if err != nil {
			return err
		}
		for _, keys := range [][]string{{"mcp", productName}, {"mcp", "servers", productName}} {
			if server := node.get(keys...); server != nil && (!matchesClientCommand(server, launch, true) || (openCodeServerSource{node: server}).disabled()) {
				return fmt.Errorf("имя MCP %s уже используется в %s", productName, config)
			}
		}
		for _, key := range []string{"plugins", "plugin"} {
			if entries := node.get(key); entries != nil {
				list, _ := entries.value.([]any)
				for _, entry := range list {
					if paradevPluginSpec(openCodePluginSpec(entry), p.openConfig) {
						return fmt.Errorf("в %s подключён плагин OpenCode; проверьте источник в клиенте", config)
					}
				}
			}
		}
	}
	return nil
}

func setupZIPWorkspace(p *clientInstaller, root string, servers map[string]openCodeServerSource, plugin string) error {
	launch := filepath.Join(p.installed, "launch")
	if plugin != "" {
		return fmt.Errorf("в %s уже подключён плагин; проверьте фактический источник в клиенте", plugin)
	}
	for _, server := range servers {
		if server.isParadev() && !matchesClientCommand(server.node, launch, true) {
			return fmt.Errorf("в %s уже подключён другой MCP Paradev; проверьте фактический источник в клиенте", server.path)
		}
	}
	if err := prepareReleaseInstall(p.installed, p.source); err != nil {
		return err
	}
	return p.linkReleaseSkills(filepath.Join(root, ".opencode"))
}
