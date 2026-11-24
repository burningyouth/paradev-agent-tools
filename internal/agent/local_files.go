package agent

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"
)

type localBase struct {
	File     string            `json:"file,omitempty"`
	Sections map[string]string `json:"sections,omitempty"`
}

type localConflict struct {
	Section string  `json:"section"`
	Source  *string `json:"source,omitempty"`
	Target  *string `json:"target,omitempty"`
}

type syncItem struct {
	Path      string          `json:"path"`
	Action    string          `json:"action"`
	Added     *[]string       `json:"added,omitempty"`
	Updated   *[]string       `json:"updated,omitempty"`
	Ahead     *[]string       `json:"ahead,omitempty"`
	Conflicts []localConflict `json:"conflicts,omitempty"`
	Backup    string          `json:"backup,omitempty"`
	content   []byte
}

type syncRun struct {
	Direction string     `json:"direction"`
	Items     []syncItem `json:"items"`
}

type syncResult struct {
	Applied   bool                `json:"applied"`
	Slot      string              `json:"slot"`
	Main      string              `json:"main"`
	Runs      []syncRun           `json:"runs"`
	Conflicts []map[string]string `json:"conflicts"`
	Backup    *string             `json:"backup"`
}

type markdownSection struct{ key, text string }

var heading = regexp.MustCompile(`^#{1,6}[ \t]+\S.*`)

func stamp(t time.Time) string { return t.UTC().Format("20060102-150405") }

func localHash(data []byte) string {
	digest := sha256.Sum256(data)
	return fmt.Sprintf("%x", digest[:8])
}

func normalizedMarkdown(text string) string { return strings.TrimRightFunc(text, unicode.IsSpace) }
func markdown(path string) bool             { return strings.EqualFold(filepath.Ext(path), ".md") }

func localEntries(config slotConfig) ([]string, error) {
	if len(config.Slot.LocalFiles) == 0 || string(config.Slot.LocalFiles) == "null" {
		return nil, nil
	}
	var raw []any
	if err := json.Unmarshal(config.Slot.LocalFiles, &raw); err != nil {
		return nil, fail(exitError, "slot.localFiles в .agent-cli.json — список путей")
	}
	entries := make([]string, 0, len(raw))
	for _, value := range raw {
		entry, _ := value.(string)
		clean := filepath.Clean(entry)
		if clean == "." || !filepath.IsLocal(clean) {
			return nil, fail(exitError, "slot.localFiles: «%v» — нужен относительный путь внутри репозитория", value)
		}
		entries = append(entries, clean)
	}
	return entries, nil
}

func splitMarkdown(text string) []markdownSection {
	sections := []markdownSection{{}}
	seen := map[string]int{}
	var current strings.Builder
	fence := false
	for line := range strings.SplitAfterSeq(text, "\n") {
		trimmed := strings.TrimLeftFunc(line, unicode.IsSpace)
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			fence = !fence
		}
		name := ""
		if !fence {
			name = strings.TrimSpace(heading.FindString(line))
		}
		if name != "" {
			sections[len(sections)-1].text = current.String()
			current.Reset()
			seen[name]++
			key := name
			if seen[name] > 1 {
				key = fmt.Sprintf("%s #%d", name, seen[name])
			}
			sections = append(sections, markdownSection{key: key})
		}
		current.WriteString(line)
	}
	sections[len(sections)-1].text = current.String()
	return sections
}

func hasSection(sections []markdownSection, key string) int {
	return slices.IndexFunc(sections, func(section markdownSection) bool { return section.key == key })
}

func mergeMarkdown(path string, source, target []byte, base localBase) syncItem {
	items := splitMarkdown(string(target))
	added, updated, ahead := []string{}, []string{}, []string{}
	conflicts := []localConflict{}
	last := ""
	for _, section := range splitMarkdown(string(source)) {
		at := hasSection(items, section.key)
		src := normalizedMarkdown(section.text)
		srcHash := localHash([]byte(src))
		if at < 0 {
			if src == "" || base.Sections[section.key] == srcHash {
				continue
			}
			items = slices.Insert(items, hasSection(items, last)+1, section)
			added = append(added, section.key)
		} else if dst := normalizedMarkdown(items[at].text); src != dst {
			switch base.Sections[section.key] {
			case localHash([]byte(dst)):
				items[at] = section
				updated = append(updated, section.key)
			case srcHash:
				ahead = append(ahead, section.key)
			default:
				source, target := section.text, items[at].text
				conflicts = append(conflicts, localConflict{
					Section: choose(section.key, "(текст до первого заголовка)"), Source: &source, Target: &target,
				})
			}
		}
		last = section.key
	}
	item := syncItem{Path: path, Action: "ahead", Added: &added, Updated: &updated, Ahead: &ahead, Conflicts: conflicts}
	if len(conflicts) > 0 {
		item.Action = "conflict"
	}
	if len(added)+len(updated) > 0 {
		var merged strings.Builder
		for i, section := range items {
			line := section.text
			if i < len(items)-1 && line != "" && !strings.HasSuffix(line, "\n\n") {
				line = normalizedMarkdown(line) + "\n\n"
			}
			merged.WriteString(line)
		}
		item.Action, item.content = "merge", []byte(merged.String())
	}
	return item
}

func sectionHashes(contents []byte) map[string]string {
	hashes := map[string]string{}
	for _, section := range splitMarkdown(string(contents)) {
		hashes[section.key] = localHash([]byte(normalizedMarkdown(section.text)))
	}
	return hashes
}

func agreedLocalBase(path string, a, b []byte, previous localBase) localBase {
	if a == nil || b == nil {
		return previous
	}
	if bytes.Equal(a, b) {
		data := localBase{File: localHash(a)}
		if markdown(path) {
			data.Sections = sectionHashes(a)
		}
		return data
	}
	if !markdown(path) {
		return previous
	}
	sections := maps.Clone(previous.Sections)
	if sections == nil {
		sections = map[string]string{}
	}
	other := sectionHashes(b)
	for key, hash := range sectionHashes(a) {
		if other[key] == hash {
			sections[key] = hash
		}
	}
	return localBase{File: previous.File, Sections: sections}
}

func planLocalFile(path string, source, target []byte, base localBase) syncItem {
	item := syncItem{Path: path}
	switch {
	case source == nil:
		item.Action = "absent"
	case target == nil:
		item.Action, item.content = "copy", source
	case bytes.Equal(source, target):
		item.Action = "same"
	case markdown(path):
		return mergeMarkdown(path, source, target, base)
	case base.File == localHash(target):
		item.Action, item.content = "update", source
	case base.File == localHash(source):
		item.Action = "ahead"
	default:
		item.Action = "conflict"
		item.Conflicts = []localConflict{{Section: "(файл целиком)"}}
	}
	return item
}

// Inspect parents from the canonical checkout root. Configured paths must
// never redirect a copy or backup through a directory symlink.
func localPath(root, rel string) (string, fs.FileInfo, error) {
	if !filepath.IsLocal(rel) {
		return "", nil, fail(exitCheck, "Путь выходит из рабочей копии: %s", rel)
	}
	path := filepath.Clean(root)
	parts := strings.Split(filepath.Clean(rel), string(filepath.Separator))
	for _, part := range parts[:len(parts)-1] {
		path = filepath.Join(path, part)
		info, err := os.Lstat(path)
		if errors.Is(err, fs.ErrNotExist) {
			break
		}
		if err != nil {
			return "", nil, err
		}
		if !info.IsDir() {
			return "", nil, fail(exitCheck, "Ожидался обычный каталог: %s", path)
		}
	}
	path = filepath.Join(root, rel)
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return path, nil, nil
	}
	return path, info, err
}

func expandLocalEntry(a, b, entry string) ([]string, error) {
	inDirectory := false
	files := map[string]bool{}
	for _, root := range []string{a, b} {
		path, info, err := localPath(root, entry)
		if err != nil {
			return nil, err
		}
		if info == nil || !info.IsDir() {
			if info != nil && info.Mode().IsRegular() {
				files[entry] = true
			}
			continue
		}
		inDirectory = true
		if err := filepath.WalkDir(path, func(child string, item fs.DirEntry, err error) error {
			if err != nil || !item.Type().IsRegular() {
				return err
			}
			rel, err := filepath.Rel(root, child)
			if err == nil {
				files[rel] = true
			}
			return err
		}); err != nil {
			return nil, err
		}
	}
	if !inDirectory {
		return []string{entry}, nil
	}
	return slices.Sorted(maps.Keys(files)), nil
}

func syncLocalFiles(env environment, slot slot, entries, directions []string, apply bool) (*syncResult, error) {
	if len(entries) == 0 || slot.checkout == "" || canonicalPath(slot.checkout) == canonicalPath(slot.WorktreePath) {
		return nil, nil
	}
	statePath := filepath.Join(env.agentHome, "local-files.json")
	store := map[string]map[string]localBase{}
	if err := readJSON(statePath, &store); err != nil {
		return nil, err
	}
	bases := store[slot.WorktreePath]
	if bases == nil {
		bases = map[string]localBase{}
	}
	home, worktree := canonicalPath(slot.checkout), canonicalPath(slot.WorktreePath)
	state := &syncResult{Applied: apply, Slot: slot.WorktreePath, Main: slot.checkout, Runs: []syncRun{}, Conflicts: []map[string]string{}}
	backupDir := filepath.Join(env.agentHome, "backups", filepath.Base(slot.Name)+"-local-"+stamp(time.Now()))
	overlay := map[string][]byte{}
	read := func(root, rel string) ([]byte, error) {
		path, info, err := localPath(root, rel)
		if err != nil {
			return nil, err
		}
		if data, ok := overlay[path]; ok {
			return data, nil
		}
		if info == nil || !info.Mode().IsRegular() {
			return nil, nil
		}
		return os.ReadFile(path)
	}
	files := map[string]bool{}
	for _, direction := range directions {
		run := syncRun{Direction: direction, Items: []syncItem{}}
		from, to, side := home, worktree, "slot"
		if direction == "back" {
			from, to, side = worktree, home, "main"
		}
		for _, entry := range entries {
			paths, err := expandLocalEntry(from, to, entry)
			if err != nil {
				return nil, err
			}
			for _, path := range paths {
				source, err := read(from, path)
				if err != nil {
					return nil, err
				}
				target, err := read(to, path)
				if err != nil {
					return nil, err
				}
				item := planLocalFile(path, source, target, bases[path])
				if item.content != nil {
					if apply {
						if err := applyLocalFile(to, backupDir, side, &item, target); err != nil {
							return nil, err
						}
						if item.Backup != "" {
							state.Backup = &backupDir
						}
					} else {
						overlay[filepath.Join(to, path)] = item.content
					}
				}
				if len(item.Conflicts) != 0 {
					state.Conflicts = append(state.Conflicts, map[string]string{"direction": direction, "path": path})
				}
				run.Items = append(run.Items, item)
				files[path] = true
			}
		}
		state.Runs = append(state.Runs, run)
	}
	if apply {
		for path := range files {
			a, err := read(worktree, path)
			if err != nil {
				return nil, err
			}
			b, err := read(home, path)
			if err != nil {
				return nil, err
			}
			bases[path] = agreedLocalBase(path, a, b, bases[path])
		}
		if err := readJSON(statePath, &store); err != nil {
			return nil, err
		}
		store[slot.WorktreePath] = bases
		if err := atomicJSON(statePath, store); err != nil {
			return nil, err
		}
	}
	return state, nil
}

func applyLocalFile(root, backupDir, side string, item *syncItem, target []byte) error {
	path, info, err := localPath(root, item.Path)
	if err != nil {
		return err
	}
	if info != nil && !info.Mode().IsRegular() {
		return fail(exitCheck, "Целевой локальный файл должен быть обычным файлом: %s", path)
	}
	if target != nil {
		current, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(current, target) {
			return fail(exitCheck, "Целевой локальный файл изменился: %s", path)
		}
		item.Backup = filepath.Join(backupDir, side, item.Path)
		if err := os.MkdirAll(filepath.Dir(item.Backup), 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(item.Backup, target, 0o600); err != nil {
			return err
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	flags := os.O_WRONLY | os.O_CREATE
	if target == nil {
		flags |= os.O_EXCL
	} else {
		flags |= os.O_TRUNC
	}
	file, err := os.OpenFile(path, flags, 0o600)
	if err != nil {
		return err
	}
	_, err = file.Write(item.content)
	return errors.Join(err, file.Close())
}

func formatSync(state *syncResult, indent string) []string {
	if state == nil {
		return nil
	}
	icons := map[string]string{"copy": "+", "merge": "~", "update": "~", "same": "=", "ahead": "·", "conflict": "!", "absent": "·"}
	var lines []string
	for _, run := range state.Runs {
		from, to := "слот", "основная копия"
		if run.Direction == "forward" {
			from, to = to, from
		}
		dry := ""
		if !state.Applied {
			dry = " (сухой прогон)"
		}
		lines = append(lines, fmt.Sprintf("%sЛокальные файлы, %s → %s%s:", indent, from, to, dry))
		for _, item := range run.Items {
			icon := icons[item.Action]
			if len(item.Conflicts) > 0 {
				icon = "!"
			}
			lines = append(lines, fmt.Sprintf("%s  %s %s — %s", indent, icon, item.Path, describeSync(item, from, to)))
		}
	}
	if len(state.Conflicts) > 0 {
		lines = append(lines, fmt.Sprintf("%s  Конфликт: сравните вручную — diff %s/<путь> %s/<путь>", indent, state.Main, state.Slot))
	}
	if state.Backup != nil {
		lines = append(lines, indent+"  Бэкап перезаписанного: "+*state.Backup)
	}
	return lines
}

func describeSync(item syncItem, from, to string) string {
	parts := []string{}
	switch item.Action {
	case "copy":
		parts = append(parts, "скопировано")
	case "update":
		where := "основной копии"
		if to == "слот" {
			where = "слоте"
		}
		parts = append(parts, fmt.Sprintf("обновлено (в %s не менялось с прошлого переноса)", where))
	case "same":
		parts = append(parts, "одинаково — пропущено")
	case "absent":
		parts = append(parts, fmt.Sprintf("нет в источнике (%s) — пропущено", from))
	case "ahead":
		if item.Ahead == nil || len(*item.Ahead) == 0 {
			parts = append(parts, fmt.Sprintf("в цели (%s) новее — пропущено", to))
		}
	}
	for _, item := range []struct {
		label  string
		values *[]string
	}{{"+ разделы: ", item.Added}, {"обновлены: ", item.Updated}, {"в цели новее: ", item.Ahead}} {
		if item.values != nil && len(*item.values) > 0 {
			parts = append(parts, item.label+strings.Join(*item.values, ", "))
		}
	}
	if len(item.Conflicts) > 0 {
		sections := make([]string, 0, len(item.Conflicts))
		for _, conflict := range item.Conflicts {
			sections = append(sections, conflict.Section)
		}
		parts = append(parts, "КОНФЛИКТ (не перетираю): "+strings.Join(sections, ", "))
	}
	return strings.Join(parts, "; ")
}
