package agent

import (
	"bytes"
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
)

type slotStep struct {
	SymlinkIfMissing string            `json:"symlinkIfMissing,omitempty"`
	CopyIfMissing    []string          `json:"copyIfMissing,omitempty"`
	CloneIfMissing   stringList        `json:"cloneIfMissing,omitempty"`
	Ready            map[string]string `json:"ready,omitempty"`
	IfSame           []string          `json:"ifSame,omitempty"`
	Run              string            `json:"run,omitempty"`
	Cwd              string            `json:"cwd,omitempty"`
	IfChanged        []string          `json:"ifChanged,omitempty"`
	IfMissing        []string          `json:"ifMissing,omitempty"`
	IfNoHooks        bool              `json:"ifNoHooks,omitempty"`
	EnvFromMain      map[string]string `json:"envFromMain,omitempty"`
}

type stringList []string

func (s *stringList) UnmarshalJSON(data []byte) error {
	if len(data) > 0 && data[0] == '"' {
		var item string
		if err := json.Unmarshal(data, &item); err != nil {
			return err
		}
		*s = []string{item}
		return nil
	}
	return json.Unmarshal(data, (*[]string)(s))
}

var dependencyInstallers = []struct{ lock, command string }{
	{"package-lock.json", "npm ci"}, {"pnpm-lock.yaml", "pnpm install --frozen-lockfile"},
	{"yarn.lock", "yarn install --frozen-lockfile"},
}

func defaultSlotSteps(g gitClient, slot slot) ([]slotStep, error) {
	patterns := []string{"ls-files", "-z", "--"}
	for _, installer := range dependencyInstallers {
		patterns = append(patterns, "*"+installer.lock)
	}
	listed, err := g.raw(patterns...)
	if err != nil {
		return nil, err
	}
	locks := []string{}
	if listed.status == 0 {
		locks = nulRecords(listed.stdout)
	}
	slices.SortStableFunc(locks, func(a, b string) int { return strings.Count(a, "/") - strings.Count(b, "/") })
	steps := []slotStep{}
	for _, lock := range locks {
		dir := filepath.Dir(lock)
		modules := filepath.Join(dir, "node_modules")
		if dir != "." && (slot.checkout == "" || !fileExists(filepath.Join(slot.checkout, modules))) {
			continue
		}
		for _, installer := range dependencyInstallers {
			if !strings.HasSuffix(lock, installer.lock) {
				continue
			}
			ready := map[string]string{modules: modules}
			dirs := stringList{modules}
			var env map[string]string
			if installer.command == "npm ci" {
				ready, dirs = npmModuleSamples(slot, lock, modules)
				env = map[string]string{"npm_config_userconfig": ".npmrc"}
			}
			samples := make([]string, 0, len(dirs))
			for _, dir := range dirs {
				samples = append(samples, ready[dir])
			}
			steps = append(steps,
				slotStep{CloneIfMissing: dirs, Ready: ready, IfSame: []string{lock}},
				slotStep{Run: installer.command, Cwd: dir, IfChanged: []string{lock}, IfMissing: samples, EnvFromMain: env})
			break
		}
	}
	for _, hook := range []struct{ marker, run string }{{".husky", "npx husky"}, {"lefthook.yml", "npx lefthook install"}} {
		if fileExists(filepath.Join(slot.WorktreePath, hook.marker)) {
			steps = append(steps, slotStep{Run: hook.run, IfNoHooks: true})
		}
	}
	return steps, nil
}

func npmModuleSamples(slot slot, lock, modules string) (map[string]string, stringList) {
	ready := map[string]string{modules: modules}
	dirs := stringList{modules}
	data, err := os.ReadFile(filepath.Join(slot.WorktreePath, lock))
	if err != nil {
		return ready, dirs
	}
	var packages struct{ Packages json.RawMessage }
	if json.Unmarshal(data, &packages) != nil || len(packages.Packages) == 0 {
		return ready, dirs
	}
	// JSON object order determines the first required sample for each directory.
	decoder := json.NewDecoder(bytes.NewReader(packages.Packages))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return ready, dirs
	}
	type sample struct{ dir, path string }
	var candidates []sample
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return ready, dirs
		}
		name, _ := key.(string)
		var flags struct{ Optional, DevOptional, Peer bool }
		if decoder.Decode(&flags) != nil {
			return ready, dirs
		}
		index := strings.Index(name, "node_modules/")
		if index < 0 || flags.Optional || flags.DevOptional || flags.Peer || !filepath.IsLocal(name) {
			continue
		}
		dir := filepath.Dir(lock)
		candidates = append(candidates, sample{filepath.Join(dir, name[:index+len("node_modules")]), filepath.Join(dir, name)})
	}
	for i := len(candidates) - 1; i >= 0; i-- {
		candidate := candidates[i]
		if _, exists := ready[candidate.dir]; !exists {
			dirs = append(dirs, candidate.dir)
		}
		ready[candidate.dir] = candidate.path
	}
	return ready, dirs
}

func prepareSteps(g gitClient, slot slot, settings slotConfig) ([]slotStep, error) {
	if len(settings.Slot.Prepare) == 0 || string(settings.Slot.Prepare) == "null" {
		return defaultSlotSteps(g, slot)
	}
	var steps []slotStep
	err := json.Unmarshal(settings.Slot.Prepare, &steps)
	return steps, err
}

func doSlotSteps(g gitClient, slot slot, steps []slotStep, previous string) ([]string, error) {
	notes := []string{}
	for _, step := range steps {
		if path := step.SymlinkIfMissing; path != "" && slot.checkout != "" {
			target := filepath.Join(slot.WorktreePath, path)
			if !fileExists(target) {
				if !filepath.IsLocal(path) {
					return notes, fail(exitCheck, "Некорректный путь ссылки: %s", path)
				}
				if err := os.Symlink(filepath.Join(slot.checkout, path), target); err != nil {
					return notes, err
				}
				notes = append(notes, "ссылка "+path)
			}
		}
		for _, path := range step.CopyIfMissing {
			if !filepath.IsLocal(path) {
				return notes, fail(exitCheck, "Некорректный путь копирования: %s", path)
			}
			target, source := filepath.Join(slot.WorktreePath, path), filepath.Join(slot.checkout, path)
			if slot.checkout != "" && !fileExists(target) && fileExists(source) {
				if err := copyRegular(source, target); err != nil {
					return notes, err
				}
				notes = append(notes, "копия "+path)
			}
		}
		var clones []string
		for _, path := range step.CloneIfMissing {
			cloned, err := cloneSlotDir(g, slot, path, step)
			if err != nil {
				return notes, err
			}
			if cloned {
				clones = append(clones, path)
			}
		}
		if len(clones) > 0 {
			line := "клон " + clones[0]
			if len(clones) > 1 {
				line += fmt.Sprintf(" и ещё %d", len(clones)-1)
			}
			notes = append(notes, line)
		}
		if step.Run != "" {
			ran, err := runSlotStep(g, slot, step, previous)
			if err != nil {
				return notes, err
			}
			if ran {
				line := step.Run
				if step.Cwd != "" && step.Cwd != "." {
					line += " (" + step.Cwd + ")"
				}
				notes = append(notes, line)
			}
		}
	}
	return notes, nil
}

func copyRegular(source, target string) error {
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	info, err := os.Stat(source)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	return os.WriteFile(target, data, info.Mode().Perm())
}

func cloneSlotDir(g gitClient, slot slot, path string, step slotStep) (bool, error) {
	if !filepath.IsLocal(path) || filepath.Clean(path) == "." {
		return false, fail(exitCheck, "Некорректный путь клонирования: %s", path)
	}
	ready := choose(step.Ready[path], path)
	if slot.checkout == "" || fileExists(filepath.Join(slot.WorktreePath, ready)) || !fileExists(filepath.Join(slot.checkout, ready)) {
		return false, nil
	}
	flags := map[string][]string{"darwin": {"-c", "-R"}, "linux": {"-R", "--reflink=always"}}[runtime.GOOS]
	if flags == nil {
		return false, nil
	}
	for _, file := range step.IfSame {
		a, aErr := os.ReadFile(filepath.Join(slot.WorktreePath, file))
		b, bErr := os.ReadFile(filepath.Join(slot.checkout, file))
		if aErr != nil || bErr != nil || !bytes.Equal(a, b) {
			return false, nil
		}
	}
	source := filepath.Join(slot.checkout, path)
	target, _, err := localPath(canonicalPath(slot.WorktreePath), path)
	if err != nil {
		return false, err
	}
	if step.Ready[path] != "" {
		if err := os.RemoveAll(target); err != nil {
			return false, err
		}
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return false, err
	}
	out, err := g.env.run(g.ctx, "cp", append(flags, source, target), commandOptions{dir: g.cwd})
	if err == nil && out.status == 0 {
		return true, nil
	}
	return false, os.RemoveAll(target)
}

func runSlotStep(g gitClient, slot slot, step slotStep, previous string) (bool, error) {
	conditional := step.IfChanged != nil || step.IfMissing != nil || step.IfNoHooks
	run := !conditional
	if step.IfChanged != nil && previous != "" {
		out, err := g.raw(append([]string{"diff", "--quiet", previous, "HEAD", "--"}, step.IfChanged...)...)
		if err != nil {
			return false, err
		}
		run = run || out.status != 0
	}
	for _, path := range step.IfMissing {
		run = run || !fileExists(filepath.Join(slot.WorktreePath, path))
	}
	if step.IfNoHooks {
		out, err := g.raw("rev-parse", "--git-path", "hooks")
		if err != nil {
			return false, err
		}
		dir := strings.TrimSpace(out.stdout)
		if !filepath.IsAbs(dir) {
			dir = filepath.Join(slot.WorktreePath, dir)
		}
		run = run || out.status != 0 || !fileExists(dir)
	}
	if !run {
		return false, nil
	}
	var env []string
	for _, name := range slices.Sorted(maps.Keys(step.EnvFromMain)) {
		file := step.EnvFromMain[name]
		source := filepath.Join(slot.checkout, file)
		if slot.checkout != "" && fileExists(source) && !fileExists(filepath.Join(slot.WorktreePath, file)) {
			env = append(env, name+"="+source)
		}
	}
	args := strings.Fields(step.Run)
	if len(args) == 0 {
		return false, fail(exitCheck, "Пустая команда подготовки")
	}
	_, err := mustRun(g.ctx, g.env, args[0], args[1:], commandOptions{dir: filepath.Join(slot.WorktreePath, step.Cwd), env: env, what: step.Run})
	return err == nil, err
}
