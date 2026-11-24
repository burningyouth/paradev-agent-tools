package agent

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"
)

const (
	productName    = "paradev-agent-tools"
	clientMCP      = "multi-agent-mcp"
	pluginRepo     = "burningyouth/paradev-agent-tools"
	pluginMarket   = "burningyouth"
	pluginBranch   = "distribution"
	opencodeSource = "git+https://github.com/" + pluginRepo + ".git#" + pluginBranch
)

type clientPackage struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type clientChange struct {
	path          string
	before, after []byte
	link          string
}

type clientInstaller struct {
	ctx                                       context.Context
	env                                       environment
	source, installed, configHome, openConfig string
	client, openBinary                        string
	link, local                               bool
}

func ClientInstall(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	jsonOutput := slices.Contains(args, "--json")
	env, err := getEnvironment()
	var report map[string]any
	if err == nil {
		installer := clientInstaller{ctx: ctx, env: env, installed: filepath.Join(env.home, ".codex", "plugins", clientMCP)}
		installer.configHome = choose(env.get("XDG_CONFIG_HOME"), filepath.Join(env.home, ".config"))
		installer.openConfig = choose(env.get("OPENCODE_CONFIG_DIR"), filepath.Join(installer.configHome, "opencode"))
		exe, exeErr := os.Executable()
		if exeErr != nil {
			err = exeErr
		} else {
			installer.source = filepath.Dir(filepath.Dir(filepath.Dir(canonicalPath(exe))))
			report, err = installer.run(args, stdin, stdout, jsonOutput)
		}
	}
	if err != nil {
		if jsonOutput {
			_ = json.NewEncoder(stdout).Encode(map[string]any{"message": err.Error(), "activated": false})
		} else {
			fmt.Fprintln(stderr, err)
		}
		return 1
	}
	if report != nil {
		if jsonOutput {
			_ = json.NewEncoder(stdout).Encode(report)
		} else if report["message"] != nil {
			fmt.Fprintln(stdout, report["message"])
		} else if report["versionChoice"] == true {
			fmt.Fprintln(stdout, "Укажите --install opencode для OpenCode 2 или --install opencode-v1 для OpenCode 1.")
		}
	}
	return 0
}

func selectClient(in *bufio.Scanner, out io.Writer, question string, labels, choices []string) string {
	fmt.Fprintln(out, question)
	for i, label := range labels {
		fmt.Fprintf(out, "  %d. %s\n", i+1, label)
	}
	fmt.Fprintln(out, "  0. Выйти")
	for {
		fmt.Fprint(out, "> ")
		if !in.Scan() || strings.TrimSpace(in.Text()) == "0" {
			return ""
		}
		n, err := strconv.Atoi(strings.TrimSpace(in.Text()))
		if err == nil && n >= 1 && n <= len(choices) {
			return choices[n-1]
		}
		fmt.Fprintln(out, "Введите номер из списка.")
	}
}

func (p *clientInstaller) run(args []string, stdin io.Reader, stdout io.Writer, jsonOutput bool) (map[string]any, error) {
	for _, arg := range args {
		switch arg {
		case "--json":
		case "--local":
			p.local = true
		case "--link":
			p.link = true
		default:
			if strings.HasPrefix(arg, "-") || p.client != "" {
				return nil, fmt.Errorf("неизвестный аргумент установки %s", arg)
			}
			p.client = arg
		}
	}
	interactive := p.client == "" && !jsonOutput && tty(os.Stdin) && tty(os.Stdout)
	in := bufio.NewScanner(stdin)
	if interactive {
		p.client = selectClient(in, stdout, "К какому клиенту подключить Paradev Agent Tools?",
			[]string{"Codex через Git", "OpenCode", "Kilo Code / Kilo CLI", "Другой MCP-клиент", "Codex из распакованного комплекта", "OpenCode из распакованного комплекта"},
			[]string{"codex", "opencode-auto", "kilo", "manual", "codex-local", "opencode-local"})
		switch p.client {
		case "":
			return nil, nil
		case "codex-local":
			p.client, p.local = "codex", true
		case "opencode-local":
			p.client, p.local = "opencode-auto", true
		}
	}
	if p.client == "opencode-auto" {
		p.client, p.openBinary = p.detectOpenCode()
		if p.client == "" && interactive {
			p.client = selectClient(in, stdout, "Версия OpenCode не определилась. Укажите поколение клиента.",
				[]string{"OpenCode 2", "OpenCode 1"}, []string{"opencode", "opencode-v1"})
			if p.client == "" {
				return nil, nil
			}
		}
		if p.client == "" {
			return map[string]any{"versionChoice": true}, nil
		}
	}
	if !slices.Contains([]string{"codex", "opencode", "opencode-v1", "kilo", "manual"}, p.client) {
		return nil, fmt.Errorf("выберите codex, opencode-auto, kilo или manual")
	}
	linkTarget := ""
	if p.link {
		if !slices.Contains([]string{"manual", "kilo", "opencode-v1"}, p.client) {
			return nil, fmt.Errorf("используйте --link с manual, kilo или opencode-v1")
		}
		root, err := p.runClient("git", []string{"-C", p.source, "rev-parse", "--show-toplevel"}, 15*time.Second)
		if err != nil || filepath.Join(canonicalPath(strings.TrimSpace(root)), "plugins", productName) != p.source {
			return nil, fmt.Errorf("запустите установку с --link из Git-клона ветки distribution")
		}
		linkTarget = p.source
	}
	native := !p.local && (p.client == "codex" || p.client == "opencode")
	if !native && strings.HasPrefix(p.client, "opencode") && p.env.get("OPENCODE_CONFIG") != "" {
		return nil, fmt.Errorf("OpenCode использует OPENCODE_CONFIG. Добавьте MCP в выбранный файл или уберите переопределение")
	}
	if err := plainParents(p.installed); err != nil {
		return nil, err
	}
	lockHost := paradev{ctx: p.ctx, env: p.env}
	out, err := lockHost.withSlotLock(clientMCP, p.installed, func() (result, error) {
		return p.install(native, linkTarget)
	})
	if err != nil {
		return nil, err
	}
	return out.data.(map[string]any), nil
}

func (p *clientInstaller) install(native bool, linkTarget string) (result, error) {
	settings := []clientChange{}
	var market, display string
	var err error
	if !native {
		switch p.client {
		case "codex":
			market, display, settings, err = p.codexSettings()
		case "kilo":
			settings, err = p.kiloSettings()
		case "opencode", "opencode-v1":
			settings, err = p.openCodeSettings()
		}
		if err != nil {
			return result{}, err
		}
	}
	hooks, err := p.migrateClientHooks()
	if err != nil {
		return result{}, err
	}
	backup, err := p.installPackage(linkTarget)
	if err != nil {
		return result{}, err
	}
	backups := []string{}
	if backup != "" {
		backups = append(backups, backup)
	}
	for _, setting := range append(settings, hooks...) {
		backup, err := setting.apply()
		if err != nil {
			return result{}, err
		}
		if backup != "" {
			backups = append(backups, backup)
		}
	}
	info := map[string]any{"installed": p.installed, "backups": backups}
	var message string
	activated := false
	switch {
	case native:
		message, err = p.installFromGit()
		if err != nil {
			return result{}, err
		}
		activated = true
	case p.client == "codex":
		message = fmt.Sprintf("Перезапустите Codex. В Plugins выберите каталог «%s» и установите Paradev Agent Tools.", display)
		if binary := p.firstExecutable("codex"); binary != "" {
			if _, err := p.runClient(binary, []string{"plugin", "add", productName + "@" + market, "--json"}, 15*time.Second); err == nil {
				activated, message = true, "Codex подключён. Перезапустите Codex и откройте новый чат в папке проекта."
			} else {
				info["detail"] = err.Error()
			}
		}
	case p.client == "manual":
		message = "Укажите эту команду для локального MCP stdio.\n" + filepath.Join(p.installed, "launch")
	default:
		label := "OpenCode"
		if p.client == "kilo" {
			label = "Kilo"
		}
		activated, message = true, label+" подключён. Перезапустите клиент и откройте новый чат в папке проекта."
	}
	if len(hooks) != 0 {
		message += "\nЕсли Codex попросит, подтвердите обновлённые хуки в его интерфейсе."
	}
	info["message"], info["activated"] = message, activated
	return result{data: info}, nil
}

func (p *clientInstaller) executables(client string) []string {
	candidates := []string{}
	if runtime.GOOS == "darwin" {
		apps := []string{"OpenCode.app/Contents/Resources/opencode-cli"}
		if client == "codex" {
			apps = []string{"ChatGPT.app/Contents/Resources/codex-cli/bin/codex", "Codex.app/Contents/Resources/codex-cli/bin/codex"}
		}
		for _, app := range apps {
			candidates = append(candidates, filepath.Join(p.env.home, "Applications", app), filepath.Join("/Applications", app))
		}
	}
	if binary, err := exec.LookPath(client); err == nil {
		candidates = append(candidates, binary)
	}
	return slices.DeleteFunc(candidates, func(path string) bool {
		info, err := os.Stat(path)
		return err != nil || !info.Mode().IsRegular() || info.Mode()&0o111 == 0
	})
}

func (p *clientInstaller) firstExecutable(client string) string {
	paths := p.executables(client)
	if len(paths) == 0 {
		return ""
	}
	return paths[0]
}

func (p *clientInstaller) runClient(binary string, args []string, timeout time.Duration) (string, error) {
	out, err := mustRun(p.ctx, p.env, binary, args, commandOptions{timeout: timeout, what: filepath.Base(binary)})
	return out, err
}

var openCodeVersion = regexp.MustCompile(`(?im)^(?:opencode\s+)?v?([12])\.\d+\.\d+(?:[-+][\w.+-]+)?$`)

func (p *clientInstaller) detectOpenCode() (string, string) {
	for _, path := range p.executables("opencode") {
		value, err := p.runClient(path, []string{"--version"}, 15*time.Second)
		if err == nil {
			parts := openCodeVersion.FindStringSubmatch(strings.TrimSpace(value))
			if parts != nil {
				if parts[1] == "1" {
					return "opencode-v1", path
				}
				return "opencode", path
			}
		}
	}
	return "", ""
}

func (p *clientInstaller) installFromGit() (string, error) {
	name := "OpenCode 2"
	binary := choose(p.openBinary, p.firstExecutable("opencode"))
	if p.client == "codex" {
		name, binary = "Codex", p.firstExecutable("codex")
	}
	fallback := "Для установки из распакованного комплекта используйте " + p.client + " --local."
	if binary == "" {
		return "", fmt.Errorf("команда %s не найдена. %s", p.client, fallback)
	}
	const timeout = 120 * time.Second
	if p.client == "codex" {
		out, err := p.runClient(binary, []string{"plugin", "marketplace", "add", pluginRepo, "--ref", pluginBranch, "--json"}, timeout)
		if err != nil {
			return "", fmt.Errorf("не удалось подключить %s через Git. %w\n%s", name, err, fallback)
		}
		var data struct {
			MarketplaceName string
			AlreadyAdded    bool
		}
		if err := json.Unmarshal([]byte(out), &data); err != nil {
			return "", err
		}
		if data.MarketplaceName == productName && data.AlreadyAdded {
			return "", fmt.Errorf("удалите старую регистрацию командой codex plugin marketplace remove %s и повторите установку", productName)
		}
		if data.MarketplaceName != pluginMarket {
			return "", fmt.Errorf("ожидался маркетплейс %s, получено %q", pluginMarket, data.MarketplaceName)
		}
		_, err = p.runClient(binary, []string{"plugin", "add", productName + "@" + pluginMarket, "--json"}, timeout)
		if err != nil {
			return "", fmt.Errorf("не удалось подключить %s через Git. %w\n%s", name, err, fallback)
		}
	} else if _, err := p.runClient(binary, []string{"plugin", "add", opencodeSource}, timeout); err != nil {
		return "", fmt.Errorf("не удалось подключить %s через Git. %w\n%s", name, err, fallback)
	}
	return name + " подключён через Git. Перезапустите клиент.", nil
}

func (c clientChange) apply() (string, error) {
	if bytes.Equal(c.before, c.after) && c.link == "" {
		return "", nil
	}
	backup := ""
	if c.before != nil {
		backup = c.path + "." + clientMCP + "-" + uuid() + ".bak"
	}
	if c.link == "" {
		return backup, replaceConfig(c.path, c.before, c.after, backup)
	}
	if err := plainParents(c.path); err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(c.path), 0o700); err != nil {
		return "", err
	}
	tmp := c.path + "." + uuid() + ".tmp"
	if err := os.Symlink(c.link, tmp); err != nil {
		return "", err
	}
	defer os.Remove(tmp)
	current, err := plainFile(c.path)
	if err != nil {
		return "", err
	}
	if !bytes.Equal(current, c.before) || (current == nil) != (c.before == nil) {
		return "", fmt.Errorf("конфигурация изменилась во время установки: %s", c.path)
	}
	if backup != "" {
		f, err := os.OpenFile(backup, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return "", err
		}
		_, err = f.Write(c.before)
		if err := errors.Join(err, f.Close()); err != nil {
			return "", err
		}
	}
	return backup, os.Rename(tmp, c.path)
}

func readClientPackage(root string) (clientPackage, error) {
	var manifest clientPackage
	data, err := os.ReadFile(filepath.Join(root, "plugin.json"))
	if err != nil {
		return manifest, err
	}
	err = json.Unmarshal(data, &manifest)
	return manifest, err
}

func (p *clientInstaller) installPackage(link string) (string, error) {
	supplied, err := readClientPackage(p.source)
	if err != nil || supplied.Name != productName {
		return "", fmt.Errorf("в комплекте отсутствует манифест %s", productName)
	}
	info, err := os.Lstat(p.installed)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	if info != nil {
		present, err := readClientPackage(p.installed)
		if err != nil || (present.Name != productName && present.Name != clientMCP) {
			return "", fmt.Errorf("каталог уже используется либо Git-клон недоступен: %s", p.installed)
		}
		linked := info.Mode()&os.ModeSymlink != 0
		same := canonicalPath(p.installed) == p.source
		hasNative := fileExists(filepath.Join(p.installed, "bin", runtime.GOOS+"-"+runtime.GOARCH, "paradev-agent"))
		if link != "" && linked && same || link == "" && (linked || same || present == supplied && hasNative) {
			return "", nil
		}
		if same {
			return "", fmt.Errorf("запустите режим --link из отдельного Git-клона")
		}
	}
	if err := os.MkdirAll(filepath.Dir(p.installed), 0o700); err != nil {
		return "", err
	}
	staging := p.installed + "." + uuid() + ".tmp"
	defer os.RemoveAll(staging)
	if link != "" {
		err = os.Symlink(link, staging)
	} else {
		err = copyClientTree(p.source, staging)
	}
	if err != nil {
		return "", err
	}
	backup := ""
	if info != nil {
		backup = p.installed + "." + uuid() + ".bak"
		if err := os.Rename(p.installed, backup); err != nil {
			return "", err
		}
	}
	if err := os.Rename(staging, p.installed); err != nil {
		if backup != "" {
			err = errors.Join(err, os.Rename(backup, p.installed))
		}
		return "", err
	}
	return backup, nil
}

func copyClientTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		if rel == "runtime" {
			return filepath.SkipDir
		}
		dest := filepath.Join(dst, rel)
		if entry.IsDir() {
			return os.Mkdir(dest, 0o755)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("ожидался обычный файл в составе пакета: %s", path)
		}
		in, err := os.Open(path)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, info.Mode().Perm())
		if err != nil {
			return err
		}
		_, err = io.Copy(out, in)
		return errors.Join(err, out.Close())
	})
}

func (p *clientInstaller) migrateClientHooks() ([]clientChange, error) {
	var changes []clientChange
	for _, agent := range []string{"codex", "claude"} {
		name := "settings.json"
		if agent == "codex" {
			name = "hooks.json"
		}
		path := filepath.Join(providerHome(p.env, agent), name)
		data, err := os.ReadFile(path)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if !bytes.Contains(data, []byte("/runtime/node")) {
			continue
		}
		if _, err := plainFile(path); err != nil {
			return nil, err
		}
		var settings struct {
			Hooks map[string][]struct{ Hooks []map[string]any }
		}
		if err := json.Unmarshal(data, &settings); err != nil {
			return nil, err
		}
		previous := shellSingleQuote(filepath.Join(p.installed, "runtime", "node")) + " " + shellSingleQuote(filepath.Join(p.installed, "bin", "agent.js"))
		launcher := shellSingleQuote(filepath.Join(p.installed, "launch")) + " --agent-cli"
		// Patch just the exact command strings, preserving other hook settings.
		updated := string(data)
		for _, event := range hookEvents {
			suffix := " hook " + event.action + " --agent " + agent
			for _, group := range settings.Hooks[event.event] {
				for _, hook := range group.Hooks {
					cmd, _ := hook["command"].(string)
					if hook["type"] != "command" || (cmd != previous+suffix && cmd != hookPIDPrefix+previous+suffix) {
						continue
					}
					from, _ := json.Marshal(cmd)
					to, _ := json.Marshal(strings.Replace(cmd, previous, launcher, 1))
					updated = strings.Replace(updated, string(from), string(to), 1)
				}
			}
		}
		if updated != string(data) {
			changes = append(changes, clientChange{path: path, before: data, after: []byte(updated)})
		}
	}
	return changes, nil
}

func getSourceNode(path string) ([]byte, string, *jsoncNode, error) {
	before, err := plainFile(path)
	if err != nil {
		return nil, "", nil, err
	}
	source := string(before)
	if before == nil {
		source = "{}\n"
	}
	node, err := parseJSONC(source)
	return before, source, node, err
}

func matchesClientCommand(node *jsoncNode, launch string, requireLocal bool) bool {
	if node == nil {
		return false
	}
	command := node.get("command")
	if command == nil {
		return false
	}
	items, _ := command.value.([]any)
	if len(items) == 0 || items[0] != launch {
		return false
	}
	if requireLocal {
		t := node.get("type")
		return len(items) == 1 && t != nil && t.value == "local"
	}
	return true
}

func (p *clientInstaller) openCodeSettings() ([]clientChange, error) {
	path := filepath.Join(p.openConfig, "opencode.json")
	jsonc := filepath.Join(p.openConfig, "opencode.jsonc")
	if _, err := os.Lstat(jsonc); !errors.Is(err, fs.ErrNotExist) {
		path = jsonc
	}
	before, source, node, err := getSourceNode(path)
	if err != nil {
		return nil, err
	}
	keys := []string{"mcp", "servers", clientMCP}
	var timeout any = map[string]any{"execution": 180000}
	if p.client == "opencode-v1" {
		keys, timeout = []string{"mcp", clientMCP}, 180000
	}
	launch := filepath.Join(p.installed, "launch")
	settings := []clientChange{}
	if existing := node.get(keys...); existing != nil {
		if !matchesClientCommand(existing, launch, false) {
			return nil, fmt.Errorf("выбранное имя MCP-сервера уже занято: %s", path)
		}
	} else {
		updated, err := patchJSONC(source, node, keys, map[string]any{"type": "local", "timeout": timeout, "command": []string{launch}})
		if err != nil {
			return nil, err
		}
		settings = append(settings, clientChange{path: path, before: before, after: []byte(updated)})
	}
	relative := filepath.Join("skills", clientMCP, "SKILL.md")
	skill := filepath.Join(p.openConfig, relative)
	target := filepath.Join(p.installed, relative)
	if current, err := os.Readlink(skill); err == nil && current == target {
		return settings, nil
	}
	skillBefore, err := plainFile(skill)
	if err != nil {
		return nil, err
	}
	skillAfter, err := os.ReadFile(filepath.Join(p.source, relative))
	if err != nil {
		return nil, err
	}
	if skillBefore != nil {
		if !bytes.Contains(skillBefore, []byte("<!-- multi-agent-mcp bundled workflow -->")) {
			return nil, fmt.Errorf("личный скилл с таким именем уже существует: %s", skill)
		}
		const legacy = "e427f765042b966c825c033aaf1600bbae3a3bede8a3b8d5bb272f1111f82227"
		if !bytes.Equal(skillBefore, skillAfter) && fmt.Sprintf("%x", sha256.Sum256(skillBefore)) != legacy {
			return settings, nil
		}
	}
	change := clientChange{path: skill, before: skillBefore, after: skillAfter}
	if p.link {
		change.link = target
	}
	return append(settings, change), nil
}

func (p *clientInstaller) kiloSettings() ([]clientChange, error) {
	keys := []string{"mcp", productName}
	launch := filepath.Join(p.installed, "launch")
	var registered bool
	var first *clientChange
	changes := []clientChange{}
	for _, name := range []string{"kilo.jsonc", "kilo.json", "config.json"} {
		path := filepath.Join(p.configHome, "kilo", name)
		before, source, node, err := getSourceNode(path)
		if err != nil {
			return nil, err
		}
		if existing := node.get(keys...); existing != nil {
			registered = true
			if !matchesClientCommand(existing, launch, true) {
				return nil, fmt.Errorf("выбранное имя MCP-сервера уже занято: %s", path)
			}
			if value := existing.get("enabled"); value != nil && value.value == false {
				updated, err := patchJSONC(source, node, append([]string{"mcp", productName}, "enabled"), true)
				if err != nil {
					return nil, err
				}
				changes = append(changes, clientChange{path: path, before: before, after: []byte(updated)})
			}
		}
		if first == nil && (before != nil || name == "kilo.json") || first != nil && first.before == nil && before != nil {
			updated, err := patchJSONC(source, node, keys, map[string]any{"type": "local", "command": []string{launch}, "enabled": true})
			if err != nil {
				return nil, err
			}
			first = &clientChange{path: path, before: before, after: []byte(updated)}
		}
	}
	if registered {
		return changes, nil
	}
	return []clientChange{*first}, nil
}

func (p *clientInstaller) codexSettings() (string, string, []clientChange, error) {
	path := filepath.Join(p.env.home, ".agents", "plugins", "marketplace.json")
	before, err := plainFile(path)
	if err != nil {
		return "", "", nil, err
	}
	market := map[string]any{"name": "multi-agent-private", "interface": map[string]any{"displayName": "Paradev Agent Tools"}, "plugins": []any{}}
	if before != nil {
		market = nil
		if err := json.Unmarshal(before, &market); err != nil {
			return "", "", nil, err
		}
	}
	name, _ := market["name"].(string)
	plugins, ok := market["plugins"].([]any)
	if name == "" || !ok {
		return "", "", nil, fmt.Errorf("ожидался список plugins: %s", path)
	}
	const location = "./.codex/plugins/multi-agent-mcp"
	entry, legacy := -1, -1
	for i, value := range plugins {
		item, _ := value.(map[string]any)
		uses := item["source"] == location
		if src, ok := item["source"].(map[string]any); ok {
			uses = src["path"] == location
		}
		switch {
		case item["name"] == productName:
			if !uses || entry != -1 {
				return "", "", nil, fmt.Errorf("выбранное имя плагина уже занято: %s", path)
			}
			entry = i
		case item["name"] == clientMCP && uses:
			legacy = i
		}
	}
	ui, _ := market["interface"].(map[string]any)
	display, _ := ui["displayName"].(string)
	oldDisplay := name == "multi-agent-private" && display == "Multi Agent · Private"
	if oldDisplay {
		display = "Paradev Agent Tools"
		ui["displayName"] = display
	}
	display = choose(display, name)
	if entry != -1 && legacy == -1 && !oldDisplay {
		return name, display, nil, nil
	}
	if legacy != -1 && entry != -1 {
		plugins = append(plugins[:legacy], plugins[legacy+1:]...)
	} else if legacy != -1 {
		plugins[legacy].(map[string]any)["name"] = productName
	} else if entry == -1 {
		plugins = append(plugins, map[string]any{"name": productName, "source": map[string]string{"source": "local", "path": location},
			"policy": map[string]string{"installation": "AVAILABLE", "authentication": "ON_INSTALL"}, "category": "Productivity"})
	}
	market["plugins"] = plugins
	updated, err := prettyJSON(market)
	return name, display, []clientChange{{path: path, before: before, after: []byte(updated)}}, err
}
