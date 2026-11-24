package agent

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

type slotOptions struct {
	project, workspace, branch, task, from, name, base string
	dry, offline, carry, allowUnmerged, force          bool
	expectedFree, existingOnly                         bool
}

type gitRef struct{ name, sha string }

type slotAssignment struct {
	start, remote gitRef
	existing      bool
}

func gitHas(g gitClient, ref string) (bool, error) {
	out, err := g.raw("rev-parse", "--verify", "--quiet", ref)
	return out.status == 0, err
}

func slotBaseRef(g gitClient, remote, base string, offline bool) (gitRef, error) {
	display := remote + "/" + base
	if !offline {
		out, err := g.raw("fetch", "--quiet", "--atomic", "--prune", remote, "+refs/heads/*:refs/remotes/"+remote+"/*")
		if err != nil {
			return gitRef{}, err
		}
		if out.status != 0 {
			return gitRef{}, fail(exitError,
				"git fetch %s не прошёл — от старой базы %s не ответвляю:\n%s\nБез сети: --offline (ветка от текущего %s)",
				remote, display, strings.TrimSpace(out.stderr), display)
		}
	}
	out, err := g.raw("rev-parse", "--verify", "--quiet", "refs/remotes/"+display+"^{commit}")
	if err != nil {
		return gitRef{}, err
	}
	if out.status != 0 {
		detail := ""
		if offline {
			detail = " — с --offline нужна уже полученная ветка"
		}
		return gitRef{}, fail(exitError, "Нет %s%s", display, detail)
	}
	return gitRef{display, strings.TrimSpace(out.stdout)}, nil
}

func validBranch(g gitClient, name string) (bool, error) {
	if name == "" || strings.HasPrefix(name, "-") {
		return false, nil
	}
	out, err := g.raw("check-ref-format", "refs/heads/"+name)
	return out.status == 0, err
}

func checkoutOperation(g gitClient) (bool, error) {
	args := []string{"rev-parse", "--path-format=absolute"}
	for _, path := range []string{"MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_START"} {
		args = append(args, "--git-path", path)
	}
	out, err := g.git(args...)
	if err != nil {
		return false, err
	}
	return slices.ContainsFunc(strings.Split(strings.TrimSpace(out), "\n"), fileExists), nil
}

func (p paradev) nativeInSlot(s slot) (bool, error) {
	rows, err := agentProcesses(p.ctx, p.env, true)
	if err != nil {
		return false, err
	}
	for _, proc := range rows {
		_, workspace, err := processIDs(p.ctx, p.env, proc.pid)
		if err != nil {
			return false, err
		}
		if workspace == s.ID {
			return true, nil
		}
		meta, err := nativeSession(p.ctx, p.env, proc)
		if err != nil {
			return false, err
		}
		if containsPath(s.WorktreePath, meta.Cwd) {
			return true, nil
		}
	}
	return false, nil
}

func liveChat(rows []chatSession) bool {
	return slices.ContainsFunc(rows, func(row chatSession) bool { return row.Live })
}

func reservationActive(s slot) bool {
	return len(s.reservation) != 0 && string(s.reservation) != "null"
}

type slotAvailability struct {
	Branch   *string  `json:"branch"`
	Head     *string  `json:"head"`
	BaseRefs []string `json:"baseRefs,omitempty"`
	Reasons  []string `json:"reasons"`
}

func (p paradev) inspectSlot(s slot, allowMain, explain bool) (slotAvailability, error) {
	var check slotAvailability
	block := func(reason string) bool {
		check.Reasons = append(check.Reasons, reason)
		return !explain
	}
	failed := func(err error) (slotAvailability, error) {
		// A diagnostic probe on an already blocked slot must not prevent
		// planning another slot or suggest reuse with an incomplete check.
		if explain && len(check.Reasons) != 0 {
			block("inspection_failed")
			return check, nil
		}
		return check, err
	}
	switch {
	case !s.exists:
		block("missing_worktree")
		return check, nil
	case s.checkout == "":
		block("unknown_main_checkout")
		return check, nil
	case canonicalPath(s.WorktreePath) == canonicalPath(s.checkout):
		block("main_checkout")
		return check, nil
	}
	if !strictSlotName.MatchString(s.Name) && block("assigned") {
		return check, nil
	}
	if len(s.sessions) != 0 && block("live_session") {
		return check, nil
	}
	if reservationActive(s) && block("reserved") {
		return check, nil
	}
	conf, err := loadSlotConfig(s)
	if err != nil {
		return failed(err)
	}
	g := gitClient{ctx: p.ctx, env: p.env, cwd: s.WorktreePath}
	main, err := mainBranch(g, conf)
	if err != nil {
		return failed(err)
	}
	info, err := g.describe()
	if err != nil {
		return failed(err)
	}
	if info == nil {
		block("invalid_worktree")
		return check, nil
	}
	check.Branch, check.Head = info.Branch, info.Head
	if len(info.Changes) != 0 && block("dirty") {
		return check, nil
	}
	busy, err := checkoutOperation(g)
	if err != nil {
		return failed(err)
	}
	if busy && block("git_operation") {
		return check, nil
	}
	if info.Branch != nil && *info.Branch == main {
		if !allowMain && block("main_branch") {
			return check, nil
		}
	} else {
		merged, err := mergedInto(g, conf, main)
		if err != nil {
			return failed(err)
		}
		if !merged {
			check.BaseRefs = slotMainRefs(conf, main)
			if block("unmerged") {
				return check, nil
			}
		}
	}
	if len(s.sessions) != 0 {
		return check, nil
	}
	occupied, err := p.nativeInSlot(s)
	if err != nil {
		return failed(err)
	}
	if occupied && block("native_process") {
		return check, nil
	}
	if !occupied {
		chats, err := p.chatList(s.ID)
		if err != nil {
			return failed(err)
		}
		if liveChat(chats) {
			block("live_session")
		}
	}
	return check, nil
}

func unavailable(message string, check slotAvailability) error {
	return &agentError{code: exitCheck, message: message, details: map[string]any{
		"slotUnavailable": true, "slotAvailability": check,
	}}
}

func (p paradev) prepareSlot(ref string, opts slotOptions) (result, error) {
	initial, err := p.findSlot(ref, opts.project)
	if err != nil {
		return result{}, err
	}
	return p.withSlotLock(initial.ID, initial.WorktreePath, func() (result, error) {
		recheck := func() (slot, error) {
			current, err := p.findSlot(initial.ID, opts.project)
			if err != nil {
				return slot{}, err
			}
			if canonicalPath(current.WorktreePath) != canonicalPath(initial.WorktreePath) ||
				current.Name != initial.Name || current.ProjectName != initial.ProjectName {
				return slot{}, unavailable("Назначение слота изменилось во время подготовки", slotAvailability{Reasons: []string{"changed"}})
			}
			if !opts.expectedFree && reservationActive(current) {
				return slot{}, unavailable("Слот зарезервирован чатом Paradev", slotAvailability{Reasons: []string{"reserved"}})
			}
			if opts.expectedFree {
				check, err := p.inspectSlot(current, true, opts.dry)
				if err != nil {
					return slot{}, err
				}
				if len(check.Reasons) != 0 {
					return slot{}, unavailable("Состояние слота изменилось — обновите список слотов", check)
				}
			}
			return current, nil
		}
		current, err := recheck()
		if err != nil {
			return result{}, err
		}
		advance := func() error {
			return atomicJSON(slotStatePath(p.env, current.WorktreePath)+".json", map[string]string{"generation": uuid()})
		}
		if !opts.dry && !opts.expectedFree {
			if err := advance(); err != nil {
				return result{}, err
			}
		}
		return p.prepareCheckout(current, opts, func() error {
			if !opts.expectedFree {
				return nil
			}
			if _, err := recheck(); err != nil {
				return err
			}
			return advance()
		})
	})
}

func (p paradev) prepareCheckout(s slot, opts slotOptions, beforeApply func() error) (result, error) {
	if opts.branch == "" {
		return result{}, fail(exitError, "Нужен --branch <ветка задачи>")
	}
	if s.checkout != "" && canonicalPath(s.WorktreePath) == canonicalPath(s.checkout) {
		return result{}, fail(exitError, "Это основная копия проекта, а не слот — её ветку не переключаю")
	}
	if !s.exists {
		return result{}, fail(exitGone, "Рабочая копия слота отсутствует: %s", s.WorktreePath)
	}
	if len(s.sessions) != 0 && !opts.force {
		ids := make([]string, 0, len(s.sessions))
		for _, session := range s.sessions {
			ids = append(ids, choose(session.terminal, strconv.Itoa(session.pid)))
		}
		return result{}, fail(exitError, "В слоте живая сессия (%s) — переключение ветки её сломает", strings.Join(ids, ", "))
	}
	g := gitClient{ctx: p.ctx, env: p.env, cwd: s.WorktreePath}
	if valid, err := validBranch(g, opts.branch); err != nil || !valid {
		if err != nil {
			return result{}, err
		}
		return result{}, fail(exitError, "Некорректное имя ветки: %s", opts.branch)
	}
	cfg, err := loadSlotConfig(s)
	if err != nil {
		return result{}, err
	}
	main, err := mainBranch(g, cfg)
	if err != nil {
		return result{}, err
	}
	remote := choose(cfg.Slot.Remote, "origin")
	base := strings.TrimPrefix(choose(opts.from, main), remote+"/")
	if opts.branch == base {
		return result{}, fail(exitError, "%s — база, а не ветка задачи", base)
	}
	start, err := slotBaseRef(g, remote, base, opts.offline)
	if err != nil {
		return result{}, err
	}
	assignment := slotAssignment{start: start}
	local, err := gitHas(g, "refs/heads/"+opts.branch)
	if err != nil {
		return result{}, err
	}
	remoteRef := "refs/remotes/" + remote + "/" + opts.branch
	tracked, err := gitHas(g, remoteRef)
	if err != nil {
		return result{}, err
	}
	if tracked {
		hash, err := g.git("rev-parse", remoteRef+"^{commit}")
		if err != nil {
			return result{}, err
		}
		assignment.remote = gitRef{remote + "/" + opts.branch, strings.TrimSpace(hash)}
	}
	assignment.existing = local || tracked
	paths, err := localEntries(cfg)
	if err != nil {
		return result{}, err
	}
	data := map[string]any{"slot": s.Name, "path": s.WorktreePath, "branch": opts.branch,
		"existing": assignment.existing, "from": start.name, "base": start.sha, "fetched": !opts.offline}
	busy := s.Name
	if prefix := slotPattern.FindString(s.Name); prefix != "" {
		busy = prefix + " · " + choose(opts.task, opts.branch)
	}
	if cfg.Slot.Take != "" {
		return p.prepareUsingHook(s, opts, cfg.Slot.Take, base, paths, g, assignment, busy, data, beforeApply)
	}
	return p.prepareUsingGit(s, opts, cfg, main, paths, g, assignment, busy, data, beforeApply)
}

func assertPrepared(g gitClient, branch string, assignment slotAssignment) error {
	actual, err := g.git("branch", "--show-current")
	if err != nil {
		return err
	}
	if strings.TrimSpace(actual) != branch {
		return fail(exitCheck, "Подготовка не переключила слот на ветку %s", branch)
	}
	expected := assignment.start
	if assignment.existing {
		expected = assignment.remote
	}
	if expected.sha == "" {
		return nil
	}
	out, err := g.raw("merge-base", "--is-ancestor", expected.sha, "HEAD")
	if err != nil {
		return err
	}
	if out.status != 0 {
		return fail(exitCheck, "Ветка %s не содержит актуальный %s %s — слот не готов; результат подготовки сохранён",
			branch, expected.name, abbrev(expected.sha))
	}
	return nil
}

func abbrev(sha string) string { return sha[:min(9, len(sha))] }

func slotCommand(g gitClient, command string) ([]string, error) {
	args := strings.Fields(command)
	if len(args) == 0 {
		return nil, fail(exitCheck, "Пустая команда проекта")
	}
	text, err := mustRun(g.ctx, g.env, args[0], args[1:], commandOptions{dir: g.cwd, what: command})
	if err != nil {
		return nil, err
	}
	lines := slices.DeleteFunc(strings.Split(text, "\n"), func(s string) bool { return s == "" })
	var summary []string
	for _, line := range lines {
		if strings.HasPrefix(line, "✅") || strings.HasPrefix(line, "⚠️") {
			summary = append(summary, line)
		}
	}
	if len(summary) == 0 {
		return lines[max(0, len(lines)-10):], nil
	}
	return summary, nil
}

func (p paradev) prepareUsingHook(s slot, opts slotOptions, hook, base string, paths []string, g gitClient,
	assignment slotAssignment, busy string, data map[string]any, beforeApply func() error) (result, error) {
	command := strings.NewReplacer("{branch}", opts.branch, "{base}", base).Replace(hook)
	data["command"] = command
	if !opts.dry {
		if err := beforeApply(); err != nil {
			return result{}, err
		}
	}
	files, err := syncLocalFiles(p.env, s, paths, []string{"back", "forward"}, !opts.dry)
	if err != nil {
		return result{}, err
	}
	data["localFiles"] = files
	if opts.dry {
		data["dryRun"] = true
		lines := append([]string{"Сухой прогон: " + s.Name + " → " + command}, formatSync(files, "  ")...)
		return result{data: data, text: strings.Join(lines, "\n")}, nil
	}
	output, err := slotCommand(g, command)
	if err != nil {
		return result{}, err
	}
	if err := assertPrepared(g, opts.branch, assignment); err != nil {
		return result{}, err
	}
	if busy != s.Name {
		if err := p.renameSlot(s.ID, busy, p.timeout); err != nil {
			return result{}, err
		}
	}
	data["output"], data["slot"] = output, busy
	lines := []string{busy + ": " + command}
	for _, line := range output {
		lines = append(lines, "  "+line)
	}
	return result{data: data, text: strings.Join(append(lines, formatSync(files, "  ")...), "\n")}, nil
}

func (p paradev) prepareUsingGit(s slot, opts slotOptions, cfg slotConfig, main string, paths []string, g gitClient,
	assignment slotAssignment, busy string, data map[string]any, beforeApply func() error) (result, error) {
	info, err := g.describe()
	if err != nil {
		return result{}, err
	}
	if info == nil {
		return result{}, fail(exitError, "%s — не git-репозиторий", s.WorktreePath)
	}
	current := "(detached)"
	if info.Branch != nil {
		current = *info.Branch
	}
	if current != main && !opts.allowUnmerged {
		merged, err := mergedInto(g, cfg, main)
		if err != nil {
			return result{}, err
		}
		if !merged {
			return result{}, fail(exitCheck, "Ветка слота %s не влита в %s — влейте её или повторите с --allow-unmerged", current, main)
		}
	}
	var backup string
	dirty := len(info.Changes)
	if dirty > 0 {
		if opts.dry && !opts.carry {
			return result{}, fail(exitCheck, "Слот грязный (%d файлов) — prepare сделает бэкап и остановится; перенести правки: --carry", dirty)
		}
		if !opts.dry {
			backup, err = backupChanges(p.env, s, g, info.Changes)
			if err != nil {
				return result{}, err
			}
			if !opts.carry {
				return result{}, fail(exitCheck, "Слот грязный (%d файлов). Копия: %s\nОчистите слот или повторите с --carry, чтобы перенести правки на новую ветку", dirty, backup)
			}
		}
	}
	steps, err := prepareSteps(g, s, cfg)
	if err != nil {
		return result{}, err
	}
	label := "существующая"
	if !assignment.existing {
		label = "от " + assignment.start.name + " " + abbrev(assignment.start.sha)
		if opts.offline {
			label = "без fetch (--offline), " + label
		}
	}
	if !opts.dry {
		if err := beforeApply(); err != nil {
			return result{}, err
		}
	}
	files, err := syncLocalFiles(p.env, s, paths, []string{"back", "forward"}, !opts.dry)
	if err != nil {
		return result{}, err
	}
	data["localFiles"] = files
	if opts.dry {
		data["dryRun"], data["carry"], data["hooks"] = true, dirty, steps
		lines := []string{fmt.Sprintf("Сухой прогон: %s → ветка %s %s", s.Name, opts.branch, label)}
		if dirty > 0 {
			lines = append(lines, fmt.Sprintf("  перенесу правки: %d файлов", dirty))
		}
		if len(steps) > 0 {
			lines = append(lines, fmt.Sprintf("  хуки: %d", len(steps)))
		}
		return result{data: data, text: strings.Join(append(lines, formatSync(files, "  ")...), "\n")}, nil
	}
	args := []string{"switch", "--no-track", "-c", opts.branch, assignment.start.sha}
	if assignment.existing {
		args = []string{"switch", opts.branch}
	}
	switched, err := g.raw(args...)
	if err != nil {
		return result{}, err
	}
	if switched.status != 0 {
		tail := ""
		if backup != "" {
			tail = "\nКопия правок: " + backup
		}
		return result{}, fail(exitError, "git %s: %s%s", strings.Join(args, " "), strings.TrimSpace(switched.stderr), tail)
	}
	if assignment.remote.sha != "" {
		if _, err := g.git("merge", "--ff-only", "--quiet", assignment.remote.sha); err != nil {
			return result{}, err
		}
	}
	previous := ""
	if info.Head != nil {
		previous = *info.Head
	}
	hooks, err := doSlotSteps(g, s, steps, previous)
	if err != nil {
		return result{}, err
	}
	if err := assertPrepared(g, opts.branch, assignment); err != nil {
		return result{}, err
	}
	behind, err := g.git("rev-list", "--count", "HEAD.."+assignment.start.sha)
	if err != nil {
		return result{}, err
	}
	if n := strings.TrimSpace(behind); n != "0" {
		hooks = append(hooks, fmt.Sprintf("позади %s на %s: merge — по решению человека", assignment.start.name, n))
	}
	if busy != s.Name {
		if err := p.renameSlot(s.ID, busy, p.timeout); err != nil {
			return result{}, err
		}
	}
	data["slot"], data["carried"], data["backup"], data["hooks"] = busy, dirty, nonempty(backup), hooks
	lines := []string{fmt.Sprintf("%s: ветка %s %s", busy, opts.branch, label)}
	if backup != "" {
		lines = append(lines, "Правки перенесены, копия: "+backup)
	}
	for _, hook := range hooks {
		lines = append(lines, "  "+hook)
	}
	return result{data: data, text: strings.Join(append(lines, formatSync(files, "  ")...), "\n")}, nil
}

func backupChanges(env environment, s slot, g gitClient, changes []gitChange) (string, error) {
	dir := filepath.Join(env.agentHome, "backups", filepath.Base(s.Name)+"-"+stamp(time.Now()))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	var statuses []string
	for _, change := range changes {
		statuses = append(statuses, change.Code+" "+change.Path)
		path, info, err := localPath(canonicalPath(s.WorktreePath), change.Path)
		if err != nil {
			return "", err
		}
		if info == nil || !info.Mode().IsRegular() {
			continue
		}
		if err := copyRegular(path, filepath.Join(dir, "files", change.Path)); err != nil {
			return "", err
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "status.txt"), []byte(strings.Join(statuses, "\n")+"\n"), 0o600); err != nil {
		return "", err
	}
	patch, err := g.git("diff", "--binary", "HEAD")
	if err != nil {
		return "", err
	}
	err = os.WriteFile(filepath.Join(dir, "diff.patch"), []byte(patch), 0o600)
	return dir, err
}

var strictSlotName = regexp.MustCompile(`^slot-\d+$`)
