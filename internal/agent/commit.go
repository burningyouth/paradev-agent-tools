package agent

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

type commitConfig struct {
	ForbiddenPaths   []string `json:"forbiddenPaths"`
	MessagePattern   string   `json:"messagePattern"`
	TrailerPattern   string   `json:"trailerPattern"`
	CloseCommand     string   `json:"closeCommand"`
	CloseMessage     string   `json:"closeMessage"`
	CloseMessageFrom string   `json:"closeMessageFrom"`
	CloseRequires    []string `json:"closeRequires"`
}

type commitStep struct {
	Number  int         `json:"n"`
	Kind    string      `json:"kind"`
	Message string      `json:"message"`
	Files   []string    `json:"files,omitempty"`
	Hunks   *[]planHunk `json:"hunks,omitempty"`
	Commit  string      `json:"sha,omitempty"`
	Command string      `json:"command,omitempty"`
	Warning *any        `json:"warning,omitempty"`
}

type commitBody struct {
	files   []string
	message string
}

type commitOutcome struct {
	Applied bool         `json:"applied"`
	Steps   []commitStep `json:"steps"`
}

type commitRunner struct {
	real, staged gitClient
	rules        commitConfig
	dir          string
	emptyTree    string
}

func commitPlan(g gitClient, file string, apply bool) (result, error) {
	root, err := g.requireRoot()
	if err != nil {
		return result{}, err
	}
	g.cwd = root
	var settings struct{ Commit commitConfig }
	if err := readJSON(filepath.Join(root, ".agent-cli.json"), &settings); err != nil {
		return result{}, err
	}
	plan, err := readPlan(file)
	if err != nil {
		return result{}, err
	}
	base, err := g.head()
	if err != nil {
		return result{}, err
	}
	tree, err := g.gitInput("", "hash-object", "-t", "tree", "--stdin")
	if err != nil {
		return result{}, err
	}
	emptyTree := strings.TrimSpace(tree)
	if err := validateCommitPlan(g, plan, settings.Commit, choose(base, emptyTree)); err != nil {
		return result{}, err
	}
	temp, err := os.MkdirTemp("", "agent-commit-")
	if err != nil {
		return result{}, err
	}
	defer os.RemoveAll(temp)
	staged := g
	staged.index = filepath.Join(temp, "index")
	runner := commitRunner{real: g, staged: staged, rules: settings.Commit, dir: temp, emptyTree: emptyTree}
	steps, err := runner.simulate(plan, base)
	if err != nil {
		return result{}, err
	}
	if apply {
		steps, err = runner.apply(plan)
		if err != nil {
			return result{}, err
		}
	}
	return result{data: commitOutcome{Applied: apply, Steps: steps}, text: formatCommitSteps(steps, apply)}, nil
}

func validateCommitPlan(g gitClient, plan []planEntry, rules commitConfig, base string) error {
	var planned []string
	for i, entry := range plan {
		if entry.message != "" {
			if err := checkCommitMessage(entry.message, rules.MessagePattern, rules.TrailerPattern, i+1); err != nil {
				return err
			}
		}
		var dirs []string
		for _, path := range entry.paths {
			if info, err := os.Lstat(filepath.Join(g.cwd, path)); err == nil && info.IsDir() {
				dirs = append(dirs, path)
			}
		}
		if len(dirs) != 0 {
			return fail(exitCheck, "Коммит %d: в paths — только файлы, а это каталоги: %s", i+1, strings.Join(dirs, ", "))
		}
		planned = append(planned, entry.paths...)
		for _, h := range entry.hunks {
			planned = append(planned, h.Path)
		}
	}
	staged, err := g.staged(base)
	if err != nil {
		return err
	}
	var clashes []string
	for _, file := range staged {
		if coversAny(planned, file) {
			clashes = append(clashes, file)
		}
	}
	if len(clashes) != 0 {
		return fail(exitCheck, "Файлы плана уже в индексе — уберите их оттуда (git restore --staged -- <путь>):\n%s", strings.Join(clashes, "\n"))
	}
	return nil
}

func checkCommitMessage(message, subjectPattern, trailerPattern string, number int) error {
	subject, _, _ := strings.Cut(message, "\n")
	if subjectPattern != "" {
		pattern, err := projectPattern(subjectPattern)
		if err != nil {
			return fail(exitCheck, "Коммит %d: неверный messagePattern: %v", number, err)
		}
		matches, err := pattern.MatchString(subject)
		if err != nil {
			return fail(exitCheck, "Коммит %d: не удалось проверить messagePattern: %v", number, err)
		}
		if !matches {
			return fail(exitCheck, "Коммит %d: «%s» не подходит под messagePattern %s", number, subject, subjectPattern)
		}
	}
	if trailerPattern != "" {
		pattern, err := projectPattern(trailerPattern)
		if err != nil {
			return fail(exitCheck, "Коммит %d: неверный trailerPattern: %v", number, err)
		}
		matches := false
		for line := range strings.SplitSeq(message, "\n") {
			matches, err = pattern.MatchString(line)
			if err != nil {
				return fail(exitCheck, "Коммит %d: не удалось проверить trailerPattern: %v", number, err)
			}
			if matches {
				break
			}
		}
		if !matches {
			return fail(exitCheck, "Коммит %d: нет строки по trailerPattern %s", number, trailerPattern)
		}
	}
	return nil
}

func covers(listed, file string) bool {
	return listed == file || strings.HasPrefix(file, strings.TrimSuffix(listed, "/")+"/")
}

func coversAny(listed []string, file string) bool {
	return slices.ContainsFunc(listed, func(path string) bool { return covers(path, file) })
}

func commitGlob(glob string) *regexp.Regexp {
	var source strings.Builder
	if strings.Contains(glob, "/") {
		source.WriteString("^")
	} else {
		source.WriteString("(?:^|/)")
	}
	for len(glob) > 0 {
		switch {
		case strings.HasPrefix(glob, "**/"):
			source.WriteString("(?:.*/)?")
			glob = glob[3:]
		case strings.HasPrefix(glob, "**"):
			source.WriteString(".*")
			glob = glob[2:]
		case glob[0] == '*':
			source.WriteString("[^/]*")
			glob = glob[1:]
		case glob[0] == '?':
			source.WriteString("[^/]")
			glob = glob[1:]
		default:
			source.WriteString(regexp.QuoteMeta(glob[:1]))
			glob = glob[1:]
		}
	}
	source.WriteString("$")
	return regexp.MustCompile(source.String())
}

func checkForbidden(files, globs []string, number int) error {
	patterns := make([]*regexp.Regexp, 0, len(globs))
	for _, glob := range globs {
		patterns = append(patterns, commitGlob(glob))
	}
	var found []string
	for _, file := range files {
		if slices.ContainsFunc(patterns, func(pattern *regexp.Regexp) bool { return pattern.MatchString(file) }) {
			found = append(found, file)
		}
	}
	if len(found) != 0 {
		return fail(exitCheck, "Коммит %d: запрещённые пути (forbiddenPaths): %s", number, strings.Join(found, ", "))
	}
	return nil
}

func (r commitRunner) stage(entry planEntry, base string, number int) ([]string, error) {
	g := r.staged
	if len(entry.paths) != 0 {
		if _, err := g.git(append([]string{"add", "--"}, entry.paths...)...); err != nil {
			return nil, err
		}
	}
	hunkPaths := make([]string, 0, len(entry.hunks))
	for _, selection := range entry.hunks {
		hunkPaths = append(hunkPaths, selection.Path)
		patch, err := g.unstagedPatch(selection.Path)
		if err != nil {
			return nil, err
		}
		header, hunks := parseDiff(patch)
		if len(hunks) == 0 {
			return nil, fail(exitCheck, "Коммит %d: у %s нет неиндексированных изменений (новый файл — в paths)", number, selection.Path)
		}
		selected, err := selectHunks(hunks, selection)
		if err != nil {
			return nil, err
		}
		if _, err := g.gitInput(buildPatch(header, selected), "apply", "--cached", "-"); err != nil {
			return nil, err
		}
	}
	return r.verifyStaged(entry, hunkPaths, choose(base, r.emptyTree), number)
}

func (r commitRunner) verifyStaged(entry planEntry, hunkPaths []string, base string, number int) ([]string, error) {
	staged, err := r.staged.staged(base)
	if err != nil {
		return nil, err
	}
	var extra, empty []string
	for _, file := range staged {
		if !coversAny(entry.paths, file) && !slices.Contains(hunkPaths, file) {
			extra = append(extra, file)
		}
	}
	if len(extra) != 0 {
		return nil, fail(exitCheck, "Коммит %d: в индексе лишнее: %s", number, strings.Join(extra, ", "))
	}
	for _, path := range append(slices.Clone(entry.paths), hunkPaths...) {
		if !slices.ContainsFunc(staged, func(file string) bool { return covers(path, file) }) {
			empty = append(empty, path)
		}
	}
	if len(empty) != 0 {
		return nil, fail(exitCheck, "Коммит %d: без изменений: %s", number, strings.Join(empty, ", "))
	}
	for _, selection := range entry.hunks {
		want, ok := hunkNumbers(selection.Include)
		if !ok {
			continue
		}
		patch, err := r.staged.stagedPatch(base, selection.Path)
		if err != nil {
			return nil, err
		}
		_, got := parseDiff(patch)
		if len(got) != len(want) {
			remaining, err := r.staged.unstagedPatch(selection.Path)
			if err != nil {
				return nil, err
			}
			_, rest := parseDiff(remaining)
			return nil, fail(exitCheck, "Коммит %d: %s — в индексе %d ханков вместо %d (всего %d)", number, selection.Path, len(got), len(want), len(got)+len(rest))
		}
	}
	return staged, checkForbidden(staged, r.rules.ForbiddenPaths, number)
}

func (r commitRunner) readBase(base string) error {
	_, err := r.staged.git("read-tree", choose(base, "--empty"))
	return err
}

func (r commitRunner) writeCommit(base, message string) (string, error) {
	tree, err := r.staged.git("write-tree")
	if err != nil {
		return "", err
	}
	args := []string{"commit-tree", strings.TrimSpace(tree)}
	if base != "" {
		args = append(args, "-p", base)
	}
	out, err := r.staged.gitInput(strings.TrimRight(message, "\n")+"\n", append(args, "-F", "-")...)
	return strings.TrimSpace(out), err
}

func (r commitRunner) simulate(plan []planEntry, base string) ([]commitStep, error) {
	if err := r.readBase(base); err != nil {
		return nil, err
	}
	steps := []commitStep{}
	for i, entry := range plan {
		number := i + 1
		if entry.message != "" {
			files, err := r.stage(entry, base, number)
			if err != nil {
				return nil, err
			}
			base, err = r.writeCommit(base, entry.message)
			if err != nil {
				return nil, err
			}
			steps = append(steps, commitStep{Number: number, Kind: "commit", Message: entry.message, Files: files, Hunks: &entry.hunks})
		}
		if entry.close != "" {
			step, err := r.closeStep(entry.close, number)
			if err != nil {
				return nil, err
			}
			steps = append(steps, step)
		}
	}
	return steps, nil
}

func (r commitRunner) closeStep(task string, number int) (commitStep, error) {
	rules := r.rules
	if rules.CloseCommand == "" || (rules.CloseMessage == "" && rules.CloseMessageFrom == "") {
		return commitStep{}, fail(exitCheck, "Коммит %d: closeChange требует closeCommand и closeMessage или closeMessageFrom в .agent-cli.json", number)
	}
	fill := func(template string) string { return strings.ReplaceAll(template, "{task}", task) }
	command := fill(rules.CloseCommand)
	message := "(из вывода: " + command + ")"
	if rules.CloseMessage != "" {
		message = fill(rules.CloseMessage)
		if err := checkCommitMessage(message, rules.MessagePattern, "", number); err != nil {
			return commitStep{}, err
		}
	}
	var expected []string
	for _, path := range rules.CloseRequires {
		expected = append(expected, fill(path))
	}
	var warning any
	if len(expected) > 0 && !slices.ContainsFunc(expected, func(path string) bool {
		return fileExists(filepath.Join(r.real.cwd, path))
	}) {
		warning = "нет ни одного из: " + strings.Join(expected, ", ")
	}
	return commitStep{Number: number, Kind: "close", Message: message, Command: command, Warning: &warning}, nil
}

func (r commitRunner) hook(name string) (string, error) {
	output, err := r.staged.git("rev-parse", "--git-path", "hooks/"+name)
	if err != nil {
		return "", err
	}
	path := strings.TrimSpace(output)
	if !filepath.IsAbs(path) {
		path = filepath.Join(r.real.cwd, path)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm()&0o111 == 0 || !info.Mode().IsRegular() {
		return "", nil
	}
	return path, nil
}

func (r commitRunner) runHook(path, name string, args ...string) error {
	if path == "" {
		return nil
	}
	out, err := r.real.env.run(r.real.ctx, path, args, commandOptions{dir: r.real.cwd, env: []string{"GIT_INDEX_FILE=" + r.staged.index}})
	if err != nil {
		return err
	}
	if out.status != 0 {
		return fail(exitCheck, "Хук %s отказал (код %d)\n%s", name, out.status, out.diagnostic())
	}
	return nil
}

func (r commitRunner) hookedMessage(message string) (string, error) {
	path, err := r.hook("pre-commit")
	if err != nil {
		return "", err
	}
	if err := r.runHook(path, "pre-commit"); err != nil {
		return "", err
	}
	path, err = r.hook("commit-msg")
	if err != nil || path == "" {
		return message, err
	}
	file := filepath.Join(r.dir, "COMMIT_EDITMSG")
	if err := os.WriteFile(file, []byte(strings.TrimRight(message, "\n")+"\n"), 0o600); err != nil {
		return "", err
	}
	if err := r.runHook(path, "commit-msg", file); err != nil {
		return "", err
	}
	out, err := os.ReadFile(file)
	return string(out), err
}

func (r commitRunner) runClose(step commitStep, base string) (commitBody, error) {
	args := strings.Fields(step.Command)
	if len(args) == 0 {
		return commitBody{}, fail(exitCheck, "Пустая команда закрытия")
	}
	out, err := r.real.env.run(r.real.ctx, args[0], args[1:], commandOptions{dir: r.real.cwd, env: []string{"GIT_INDEX_FILE=" + r.staged.index}})
	if err != nil {
		return commitBody{}, err
	}
	if out.status != 0 {
		return commitBody{}, fail(exitError, "%s: код %d\n%s", step.Command, out.status, out.diagnostic())
	}
	files, err := r.staged.staged(choose(base, r.emptyTree))
	if err != nil {
		return commitBody{}, err
	}
	if len(files) == 0 {
		return commitBody{}, fail(exitCheck, "%s ничего не проиндексировал", step.Command)
	}
	if err := checkForbidden(files, r.rules.ForbiddenPaths, step.Number); err != nil {
		return commitBody{}, err
	}
	message := step.Message
	if r.rules.CloseMessageFrom != "" {
		pattern, err := projectPattern(r.rules.CloseMessageFrom)
		if err != nil {
			return commitBody{}, fail(exitCheck, "Неверный closeMessageFrom: %v", err)
		}
		match, err := pattern.FindStringMatch(out.stdout + "\n" + out.stderr)
		if err != nil {
			return commitBody{}, fail(exitCheck, "Не удалось проверить closeMessageFrom: %v", err)
		}
		if match == nil || match.GroupByNumber(1) == nil || strings.TrimSpace(match.GroupByNumber(1).String()) == "" {
			return commitBody{}, fail(exitCheck, "В выводе %s нет сообщения по closeMessageFrom %s", step.Command, r.rules.CloseMessageFrom)
		}
		message = strings.TrimSpace(match.GroupByNumber(1).String())
		if err := checkCommitMessage(message, r.rules.MessagePattern, "", step.Number); err != nil {
			return commitBody{}, err
		}
	}
	return commitBody{files: files, message: message}, nil
}

func (r commitRunner) applyStep(step commitStep, build func(string, int) (commitBody, error)) (commitStep, error) {
	const attempts = 3
	for attempt := 1; attempt <= attempts; attempt++ {
		base, err := r.real.head()
		if err != nil {
			return step, err
		}
		if err := r.readBase(base); err != nil {
			return step, err
		}
		body, err := build(base, attempt)
		if err != nil {
			return step, err
		}
		message, err := r.hookedMessage(body.message)
		if err != nil {
			return step, err
		}
		staged, err := r.staged.staged(choose(base, r.emptyTree))
		if err != nil {
			return step, err
		}
		if !slices.Equal(staged, body.files) {
			return step, fail(exitCheck, "Коммит %d: хуки изменили состав индекса", step.Number)
		}
		sha, err := r.writeCommit(base, message)
		if err != nil {
			return step, err
		}
		subject, _, _ := strings.Cut(message, "\n")
		moved, err := r.real.raw("update-ref", "-m", "commit: "+subject, "HEAD", sha, choose(base, strings.Repeat("0", len(r.emptyTree))))
		if err != nil {
			return step, err
		}
		if moved.status != 0 {
			if attempt == attempts {
				return step, fail(exitCheck, "Коммит %d: HEAD сдвигается другой сессией, коммит не сделан\n%s", step.Number, strings.TrimSpace(moved.stderr))
			}
			continue
		}
		step.Files, step.Message, step.Commit = body.files, strings.TrimRight(message, "\n"), sha
		if _, err := r.real.git(append([]string{"reset", "-q", "--"}, body.files...)...); err != nil {
			return step, err
		}
		post, err := r.hook("post-commit")
		if err != nil {
			return step, err
		}
		return step, r.runHook(post, "post-commit")
	}
	panic("unreachable after the last update-ref attempt")
}

func (r commitRunner) apply(plan []planEntry) ([]commitStep, error) {
	done := []commitStep{}
	record := func(step commitStep, err error) error {
		if step.Commit != "" {
			done = append(done, step)
		}
		if err == nil {
			return nil
		}
		var shas []string
		for _, completed := range done {
			shas = append(shas, completed.Commit[:9])
		}
		return fail(codeOf(err), "%v\nУже закоммичено: %s", err, choose(strings.Join(shas, ", "), "ничего"))
	}
	for i, entry := range plan {
		number := i + 1
		if entry.message != "" {
			err := record(r.applyStep(commitStep{Number: number, Kind: "commit"}, func(base string, _ int) (commitBody, error) {
				files, err := r.stage(entry, base, number)
				return commitBody{files: files, message: entry.message}, err
			}))
			if err != nil {
				return nil, err
			}
		}
		if entry.close == "" {
			continue
		}
		step, err := r.closeStep(entry.close, number)
		if err != nil {
			return nil, record(step, err)
		}
		var closed commitBody
		err = record(r.applyStep(step, func(base string, attempt int) (commitBody, error) {
			if attempt == 1 {
				var err error
				closed, err = r.runClose(step, base)
				return closed, err
			}
			_, err := r.staged.git(append([]string{"add", "-A", "--"}, closed.files...)...)
			return closed, err
		}))
		if err != nil {
			return nil, err
		}
	}
	return done, nil
}

func formatCommitSteps(steps []commitStep, applied bool) string {
	lines := []string{"Сухой прогон — индекс и HEAD не тронуты:"}
	if applied {
		lines[0] = "Закоммичено (push не выполнялся):"
	}
	for _, step := range steps {
		message, _, _ := strings.Cut(step.Message, "\n")
		if step.Commit != "" {
			message = step.Commit[:9] + " " + message
		}
		lines = append(lines, fmt.Sprintf("%d. %s", step.Number, message))
		if step.Kind == "close" {
			lines = append(lines, "   ← "+step.Command)
			if step.Warning != nil && *step.Warning != nil {
				lines = append(lines, fmt.Sprintf("   ⚠ %s", *step.Warning))
			}
		}
		for _, file := range step.Files {
			lines = append(lines, "   "+file)
		}
		if step.Hunks != nil {
			for _, hunk := range *step.Hunks {
				selection, _ := json.Marshal(hunk.Include)
				lines = append(lines, fmt.Sprintf("   ханки %s: %s", hunk.Path, selection))
			}
		}
	}
	if !applied {
		lines = append(lines, "Проверки пройдены. Применить: paradev-agent commit <план> --apply")
	}
	return strings.Join(lines, "\n")
}
