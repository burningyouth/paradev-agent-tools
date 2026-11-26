package agent

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	bundle "github.com/burningyouth/paradev-agent-tools"
)

var workSkills = []string{"agent-sessions", "agent-slots", "agent-orchestrate", "agent-commit", "agent-cleanup", "agent-setup", updateSkill}

var workflowTopics = map[string]string{
	"sessions": "agent-sessions", "slots": "agent-slots", "orchestration": "agent-orchestrate",
	"commit-plan": "agent-commit", "cleanup": "agent-cleanup", "setup": "agent-setup",
}

var skillFrontmatter = regexp.MustCompile(`(?s)^---\r?\n.*?\r?\n---\r?\n\s*`)

func skillContent(skill string) (string, error) {
	if !slices.Contains(workSkills, skill) {
		return "", fail(exitError, "Неизвестный скилл: %s. См. paradev-agent --help", skill)
	}
	data, err := bundle.Files.ReadFile("skills/" + skill + "/SKILL.md")
	return string(data), err
}

// An adjacent release path preserves the path exposed by the existing tool.
// A binary installed on its own materializes a versioned copy on demand.
func skillLocation(env environment, skill string) (string, string, error) {
	content, err := skillContent(skill)
	if err != nil {
		return "", "", err
	}
	exe, err := os.Executable()
	if err != nil {
		return "", "", err
	}
	for dir := filepath.Dir(canonicalPath(exe)); ; dir = filepath.Dir(dir) {
		path := filepath.Join(dir, "skills", skill, "SKILL.md")
		if data, err := os.ReadFile(path); err == nil && string(data) == content {
			return path, content, nil
		}
		if dir == filepath.Dir(dir) {
			break
		}
	}
	root := filepath.Join(env.agentHome, "bundled", pluginVersion())
	for _, item := range []string{"skills", "docs", "examples", "README.md", "AGENTS.md"} {
		err := fs.WalkDir(bundle.Files, item, func(name string, item fs.DirEntry, err error) error {
			if err != nil || item.IsDir() {
				return err
			}
			data, err := bundle.Files.ReadFile(name)
			if err != nil {
				return err
			}
			return materializeSkillFile(filepath.Join(root, filepath.FromSlash(name)), data)
		})
		if err != nil {
			return "", "", err
		}
	}
	return filepath.Join(root, "skills", skill, "SKILL.md"), content, nil
}

func materializeSkillFile(path string, content []byte) error {
	if data, err := os.ReadFile(path); err == nil && slices.Equal(data, content) {
		return nil
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(dir, ".skill-")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	if _, err := temp.Write(content); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(temp.Name(), path)
}

func skillsResult(env environment, args []string) (result, error) {
	if len(args) == 1 && args[0] == "list" {
		items := make([]map[string]string, 0, len(workSkills))
		lines := make([]string, 0, len(workSkills))
		for _, name := range workSkills {
			path, _, err := skillLocation(env, name)
			if err != nil {
				return result{}, err
			}
			items = append(items, map[string]string{"name": name, "path": path})
			lines = append(lines, name+"\t"+path)
		}
		return result{data: items, text: strings.Join(lines, "\n")}, nil
	}
	if len(args) == 2 && args[0] == "path" {
		path, _, err := skillLocation(env, args[1])
		return result{data: map[string]string{"path": path}, text: path}, err
	}
	return result{}, fail(exitError, "Нужно: paradev-agent skills list | path <имя>")
}

func installBinary(env environment, opts options) (result, error) {
	for key := range opts.flags {
		if !slices.Contains([]string{"directory", "dry-run", "json"}, key) {
			return result{}, fail(exitError, "paradev-agent install не принимает --%s. Справка: paradev-agent install --help", key)
		}
	}
	target, err := os.Executable()
	if err != nil {
		return result{}, err
	}
	if root, _ := releaseForExecutable(env, target); root != "" {
		target = filepath.Join(root, "paradev-agent")
	} else {
		target = canonicalPath(target)
	}
	dir := choose(opts.flags["directory"], filepath.Join(env.home, ".local", "bin"))
	if strings.HasPrefix(dir, "~/") {
		dir = filepath.Join(env.home, dir[2:])
	}
	if !filepath.IsAbs(dir) {
		dir = filepath.Join(env.cwd, dir)
	}
	path := filepath.Join(dir, "paradev-agent")
	dryRun := opts.flags["dry-run"] == "true"
	inspect := func() (string, error) {
		entry, err := os.Lstat(path)
		if os.IsNotExist(err) {
			return "", nil
		}
		if err != nil {
			return "", err
		}
		if entry.Mode()&os.ModeSymlink != 0 {
			resolved := canonicalPath(path)
			if resolved == target {
				return target, nil
			}
			if filepath.Base(resolved) == "agent.js" && filepath.Base(filepath.Dir(resolved)) == "bin" {
				root := filepath.Dir(filepath.Dir(resolved))
				for _, directory := range []string{root, filepath.Join(root, "mcp")} {
					if manifest, err := readClientPackage(directory); err == nil && manifest.Name == productName {
						return resolved, nil
					}
				}
			}
		}
		return "", fail(exitCheck, "Путь %s уже занят. Выберите другой каталог через --directory.", path)
	}
	previous, err := inspect()
	if err != nil {
		return result{}, err
	}
	status, text := "installed", "Установлено"
	var backup string
	if previous == target {
		status, text = "unchanged", "Уже установлено"
	} else if dryRun {
		status, text = "planned", "План установки"
	} else if previous != "" {
		oldLink, err := os.Readlink(path)
		if err != nil {
			return result{}, err
		}
		tmp := path + "." + uuid() + ".tmp"
		if err := os.Symlink(target, tmp); err != nil {
			return result{}, err
		}
		defer os.Remove(tmp)
		if current, err := inspect(); err != nil || current != previous {
			return result{}, fail(exitCheck, "Ссылка изменилась во время установки: %s", path)
		}
		backup = path + ".agent-cli-" + uuid() + ".bak"
		if err := os.Symlink(oldLink, backup); err != nil {
			return result{}, err
		}
		if err := os.Rename(tmp, path); err != nil {
			return result{}, err
		}
	} else {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return result{}, err
		}
		if err := os.Symlink(target, path); err != nil {
			if !os.IsExist(err) {
				return result{}, err
			}
			if current, err := inspect(); current != target {
				return result{}, fail(exitCheck, "Путь %s изменился во время установки: %v", path, err)
			}
			status, text = "unchanged", "Уже установлено"
		}
	}
	data := map[string]any{"status": status, "dryRun": dryRun, "path": path, "target": target}
	text = fmt.Sprintf("%s: %s → %s", text, path, target)
	if backup != "" {
		data["backup"] = backup
		text += "\nРезервная ссылка: " + backup
	}
	return result{data: data, text: text}, nil
}
