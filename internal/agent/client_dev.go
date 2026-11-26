package agent

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

func (p *clientInstaller) devCatalog() string {
	return filepath.Dir(filepath.Dir(p.source))
}

func (p *clientInstaller) useDevPackage() error {
	catalog := p.devCatalog()
	data, err := os.ReadFile(filepath.Join(catalog, ".agents", "plugins", "marketplace.json"))
	var manifest struct{ Name string }
	if p.source != filepath.Join(catalog, "plugins", productName) ||
		err != nil || json.Unmarshal(data, &manifest) != nil || manifest.Name != devMarket {
		return fmt.Errorf("запустите ./install.sh из клона Paradev Agent Tools")
	}
	p.installed = p.source
	return nil
}

func (p *clientInstaller) installDev() (map[string]any, error) {
	launch := filepath.Join(p.source, "launch")
	report := map[string]any{"target": p.client, "installed": p.source, "launcher": launch, "activated": true}
	switch p.client {
	case "manual":
		report["activated"] = false
		report["message"] = "Укажите путь для локального MCP stdio: " + launch
		return report, nil
	case "codex":
		if err := p.installDevCodex(); err != nil {
			return nil, err
		}
	case "opencode", "opencode-v1":
		if p.env.get("OPENCODE_CONFIG") != "" || p.env.get("OPENCODE_CONFIG_CONTENT") != "" {
			return nil, fmt.Errorf("OpenCode переопределяет конфигурацию; проверьте OPENCODE_CONFIG и OPENCODE_CONFIG_CONTENT")
		}
		paths := openCodeConfigFiles(p.openConfig)
		global := filepath.Join(p.configHome, "opencode")
		if canonicalPath(global) != canonicalPath(p.openConfig) {
			paths = append(openCodeConfigFiles(global), paths...)
		}
		if err := p.checkOpenCodeMCP(paths, launch); err != nil {
			return nil, err
		}
		settings, err := p.openCodeSettings()
		if err != nil {
			return nil, err
		}
		if err := p.linkDevSkills(p.openConfig); err != nil {
			return nil, err
		}
		if err := applyDevChanges(report, settings); err != nil {
			return nil, err
		}
	case "kilo":
		settings, err := p.kiloSettings()
		if err != nil {
			return nil, err
		}
		if err := applyDevChanges(report, settings); err != nil {
			return nil, err
		}
	}
	report["message"] = "Локальная сборка подключена. Перезапустите клиент и проверьте источник через plugin_source."
	return report, nil
}

func (p *clientInstaller) installDevCodex() error {
	binary := p.firstExecutable("codex")
	if binary == "" {
		return fmt.Errorf("команда codex не найдена; установите Codex и повторите подключение")
	}
	catalog := p.devCatalog()
	const timeout = 120 * time.Second
	out, err := p.runClient(binary, []string{"plugin", "marketplace", "add", catalog, "--json"}, timeout)
	if err != nil {
		return err
	}
	var registered struct{ MarketplaceName, InstalledRoot string }
	if err := json.Unmarshal([]byte(out), &registered); err != nil {
		return fmt.Errorf("не удалось прочитать результат регистрации маркетплейса Codex: %w", err)
	}
	if registered.MarketplaceName != devMarket || canonicalPath(registered.InstalledRoot) != catalog {
		return fmt.Errorf("Codex не подтвердил регистрацию %s из %s", devMarket, catalog)
	}
	_, err = p.runClient(binary, []string{"plugin", "add", productName + "@" + devMarket, "--json"}, timeout)
	return err
}

func (p *clientInstaller) linkDevSkills(dir string) error {
	for _, name := range []string{productName, updateSkill} {
		relative := filepath.Join("skills", name, "SKILL.md")
		if err := ensureReleaseLink(filepath.Join(dir, relative), filepath.Join(p.source, relative)); err != nil {
			return err
		}
	}
	return nil
}

func applyDevChanges(report map[string]any, changes []clientChange) error {
	backups := []string{}
	for _, change := range changes {
		backup, err := change.apply()
		if err != nil {
			return err
		}
		if backup != "" {
			backups = append(backups, backup)
		}
	}
	report["backups"] = backups
	return nil
}
