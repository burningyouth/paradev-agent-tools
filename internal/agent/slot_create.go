package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

func (p paradev) findProject(ref string) (project, error) {
	if ref == "" {
		return project{}, fail(exitError, "Нужен --project <имя или id проекта Superset>")
	}
	projects, err := p.projects()
	if err != nil {
		return project{}, err
	}
	names := []string{}
	matches := []project{}
	for _, row := range projects {
		names = append(names, row.Name)
		if ref == row.ID || ref == row.Name {
			matches = append(matches, row)
		}
	}
	if len(matches) != 1 {
		return project{}, fail(exitError, "Проект %s не найден однозначно в Superset. Есть: %s", ref, strings.Join(names, ", "))
	}
	found := matches[0]
	if found.Path == "" || !fileExists(found.Path) {
		return project{}, fail(exitError, "У проекта %s нет основной копии на диске", found.Name)
	}
	return found, nil
}

func belongsTo(ws workspace, project project) bool {
	return ws.ProjectID != "" && ws.ProjectID == project.ID || ws.ProjectID == "" && ws.ProjectName == project.Name
}

func slotNameTaken(g gitClient, project project, rows []workspace, name string, trees []string) (string, error) {
	for _, ws := range rows {
		if belongsTo(ws, project) && slotPattern.FindString(ws.Name) == name {
			return "воркспейс " + name + " уже есть", nil
		}
	}
	if branch, err := gitHas(g, "refs/heads/"+name); err != nil || branch {
		return "ветка " + name + " уже есть", err
	}
	for _, path := range trees {
		if filepath.Base(path) == name || path != project.Path && fileExists(filepath.Join(filepath.Dir(path), name)) {
			return "папка " + name + " уже занята", nil
		}
	}
	return "", nil
}

func (p paradev) createSlot(opts slotOptions) (result, error) {
	project, err := p.findProject(opts.project)
	if err != nil {
		return result{}, err
	}
	if opts.name != "" && !strictSlotName.MatchString(opts.name) {
		return result{}, fail(exitError, "Имя слота — «slot-N», а не «%s»", opts.name)
	}
	if opts.dry {
		return p.createProjectSlot(project, opts)
	}
	path := filepath.Join(p.env.agentHome, "create-slot-"+project.ID)
	return p.withSlotLock(project.ID, path, func() (result, error) { return p.createProjectSlot(project, opts) })
}

func (p paradev) createProjectSlot(project project, opts slotOptions) (result, error) {
	g := gitClient{ctx: p.ctx, env: p.env, cwd: project.Path}
	workspaces, err := p.workspaces()
	if err != nil {
		return result{}, err
	}
	tree, err := g.git("worktree", "list", "--porcelain", "-z")
	if err != nil {
		return result{}, err
	}
	var trees []string
	for _, line := range nulRecords(tree) {
		if path, ok := strings.CutPrefix(line, "worktree "); ok {
			trees = append(trees, path)
		}
	}
	name := opts.name
	if name != "" {
		reason, err := slotNameTaken(g, project, workspaces, name, trees)
		if err != nil {
			return result{}, err
		}
		if reason != "" {
			return result{}, fail(exitCheck, "%s: %s", name, reason)
		}
	}
	for index := 1; name == ""; index++ {
		try := fmt.Sprintf("slot-%d", index)
		reason, err := slotNameTaken(g, project, workspaces, try, trees)
		if err != nil {
			return result{}, err
		}
		if reason == "" {
			name = try
		}
	}
	cfg, err := loadSlotConfig(slot{workspace: workspace{WorktreePath: project.Path}, checkout: project.Path})
	if err != nil {
		return result{}, err
	}
	main, err := mainBranch(g, cfg)
	if err != nil {
		return result{}, err
	}
	remote := choose(cfg.Slot.Remote, "origin")
	base := strings.TrimPrefix(choose(opts.base, main), remote+"/")
	start, err := slotBaseRef(g, remote, base, opts.offline)
	if err != nil {
		return result{}, err
	}
	line := fmt.Sprintf("без ветки на %s %s", start.name, abbrev(start.sha))
	if opts.offline {
		line += " (без fetch, --offline)"
	}
	args := []string{"--local", "--project", project.ID, "--name", name, "--branch", name, "--skip-branch-prefix", "--base-branch", base}
	data := map[string]any{"slot": name, "project": project.Name, "from": start.name, "base": start.sha, "fetched": !opts.offline}
	if opts.dry {
		command := "superset ws create " + strings.Join(args, " ")
		data["dryRun"], data["command"] = true, command
		return result{data: data, text: fmt.Sprintf("Сухой прогон: %s/%s %s\n  %s\n  затем git switch --detach %s и git branch -D %s",
			project.Name, name, line, command, abbrev(start.sha), name)}, nil
	}

	var created sessionRecord
	if err := p.call(&created, append([]string{"ws", "create"}, args...)...); err != nil {
		return result{}, err
	}
	wrapped, _ := created["workspace"].(map[string]any)
	id := choose(created.string("id"), choose(sessionRecord(wrapped).string("id"), created.string("workspaceId")))
	workspaces, err = p.workspaces()
	if err != nil {
		return result{}, err
	}
	matches := []workspace{}
	for _, ws := range workspaces {
		if belongsTo(ws, project) && ws.Name == name && (id == "" || id == ws.ID) {
			matches = append(matches, ws)
		}
	}
	if len(matches) != 1 || matches[0].WorktreePath == "" {
		raw, _ := json.Marshal(created)
		return result{}, fail(exitError, "superset ws create: воркспейс %s не найден после создания\n%s", name, raw)
	}
	ws := matches[0]
	worktree := gitClient{ctx: p.ctx, env: p.env, cwd: ws.WorktreePath}
	if canonicalPath(ws.WorktreePath) == canonicalPath(project.Path) {
		return result{}, fail(exitCheck, "Paradev вернул основную копию вместо нового рабочего слота")
	}
	failAfterCreate := func(err error) (result, error) {
		return result{}, fail(codeOf(err), "%v\nВоркспейс %s (%s) создан: %s — без ветки его не увёл", err, name, ws.ID, ws.WorktreePath)
	}
	current, err := worktree.git("branch", "--show-current")
	if err != nil {
		return failAfterCreate(err)
	}
	if strings.TrimSpace(current) != name {
		return failAfterCreate(fail(exitCheck, "Новая рабочая копия не на ожидаемой временной ветке %s", name))
	}
	temporarySHA, err := worktree.head()
	if err != nil {
		return failAfterCreate(err)
	}
	if _, err := worktree.git("switch", "--quiet", "--detach", start.sha); err != nil {
		return failAfterCreate(err)
	}
	if _, err := worktree.git("update-ref", "-d", "refs/heads/"+name, temporarySHA); err != nil {
		return failAfterCreate(err)
	}
	info, err := worktree.describe()
	if err != nil {
		return result{}, err
	}
	if info == nil {
		return result{}, fail(exitCheck, "Рабочая копия созданного слота исчезла: %s", ws.WorktreePath)
	}
	dirty := len(info.Changes)
	notes := []string{line}
	if filepath.Base(ws.WorktreePath) != name {
		notes = append(notes, "папка не по имени слота: "+ws.WorktreePath)
	}
	code := exitOK
	if dirty > 0 {
		notes = append(notes, fmt.Sprintf("грязно после создания: %d файлов (setup проекта?) — prepare остановится", dirty))
		code = exitCheck
	}
	data["workspace"], data["path"], data["dirty"], data["notes"] = ws.ID, ws.WorktreePath, dirty, notes
	lines := []string{name + " создан: " + ws.WorktreePath}
	for _, note := range notes {
		lines = append(lines, "  "+note)
	}
	lines = append(lines, "воркспейс: "+ws.ID)
	return result{data: data, text: strings.Join(lines, "\n"), code: code}, nil
}

func (p paradev) takeSlot(opts slotOptions) (result, error) {
	if opts.branch == "" {
		return result{}, fail(exitError, "Нужен --branch <ветка задачи>")
	}
	project, err := p.findProject(opts.project)
	if err != nil {
		return result{}, err
	}
	g := gitClient{ctx: p.ctx, env: p.env, cwd: project.Path}
	valid, err := validBranch(g, opts.branch)
	if err != nil {
		return result{}, err
	}
	if !valid {
		return result{}, fail(exitError, "Некорректное имя ветки: %s", opts.branch)
	}
	rows, err := p.slots(project.Name)
	if err != nil {
		return result{}, err
	}
	free := make([]slot, 0)
	for _, row := range rows {
		if !row.exists || canonicalPath(row.WorktreePath) == canonicalPath(row.checkout) {
			continue
		}
		worktree := gitClient{ctx: p.ctx, env: p.env, cwd: row.WorktreePath}
		branch, err := worktree.git("branch", "--show-current")
		if err != nil {
			return result{}, err
		}
		if strings.TrimSpace(branch) == opts.branch {
			return result{}, fail(exitCheck, "Ветка %s уже в %s (%s) — работайте там", opts.branch, row.Name, row.ID)
		}
		available, err := canTakeSlot(p, row, false)
		if err != nil {
			return result{}, err
		}
		if available {
			free = append(free, row)
		}
	}
	slices.SortStableFunc(free, func(a, b slot) int {
		x, _ := strconv.Atoi(strings.TrimPrefix(a.Name, "slot-"))
		y, _ := strconv.Atoi(strings.TrimPrefix(b.Name, "slot-"))
		switch {
		case x < y:
			return -1
		case x > y:
			return 1
		default:
			return 0
		}
	})
	prep := opts
	prep.project, prep.expectedFree = project.Name, true
	for _, available := range free {
		prepared, err := p.prepareSlot(available.ID, prep)
		if err != nil {
			var failure *agentError
			if errors.As(err, &failure) && (failure.details["slotLocked"] == true || failure.details["slotUnavailable"] == true) {
				continue
			}
			return result{}, err
		}
		data := map[string]any{"workspace": available.ID, "slot": prepared.data.(map[string]any)["slot"],
			"path": available.WorktreePath, "created": false, "prepare": prepared.data}
		return result{data: data, text: prepared.text + "\nворкспейс: " + available.ID, code: prepared.code}, nil
	}
	if opts.existingOnly {
		question := fmt.Sprintf("В проекте %s нет свободных слотов. Создать новый слот для %s?", project.Name, choose(opts.task, opts.branch))
		return result{data: map[string]any{"status": "confirmation_required", "project": project.Name, "question": question},
			text: question, code: exitWaiting}, nil
	}
	created, err := p.createSlot(slotOptions{project: project.ID, base: opts.from, offline: opts.offline, dry: opts.dry})
	if err != nil {
		return result{}, err
	}
	createdData := created.data.(map[string]any)
	name := createdData["slot"].(string)
	if opts.dry {
		data := map[string]any{"dryRun": true, "workspace": nil, "slot": name, "created": true, "create": createdData, "prepare": nil}
		return result{data: data, text: fmt.Sprintf("Свободного слота нет.\n%s\nзатем slot prepare %s --branch %s",
			created.text, name, opts.branch)}, nil
	}
	if created.code != 0 {
		return result{}, fail(created.code, "%s\nprepare не запускаю: слот грязный сразу после создания", created.text)
	}
	id := createdData["workspace"].(string)
	path := createdData["path"].(string)
	prepared, err := p.prepareSlot(id, prep)
	if err != nil {
		return result{}, err
	}
	data := map[string]any{"workspace": id, "slot": prepared.data.(map[string]any)["slot"], "path": path,
		"created": true, "create": createdData, "prepare": prepared.data}
	return result{data: data, text: fmt.Sprintf("Свободного слота нет — %s создан: %s\n%s\nворкспейс: %s",
		name, path, prepared.text, id), code: prepared.code}, nil
}
