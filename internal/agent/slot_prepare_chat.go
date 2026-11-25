package agent

import "strings"

// The target and holder IDs in a request select records. Caller identity comes
// from the harness environment and must match the host's current chat.
func (p paradev) prepareCaller(s slot, opts slotOptions) (*liveSession, error) {
	blocked := fail(exitCheck, "Слот занят — нужен единственный живой чат, подтверждённый окружением вызывающей сессии")
	var own *liveSession
	if len(s.sessions) != 0 {
		candidate := &s.sessions[0]
		terminal, thread := p.env.get("SUPERSET_TERMINAL_ID"), p.env.get("CODEX_THREAD_ID")
		if len(s.sessions) != 1 || candidate.chat == nil || !candidate.chat.Live || candidate.id == "" ||
			candidate.workspaceID != s.ID || p.env.get("SUPERSET_WORKSPACE_ID") != s.ID ||
			!containsPath(s.WorktreePath, p.env.cwd) || terminal == "" && thread == "" ||
			terminal != "" && terminal != nonemptyString(candidate.chat.TerminalID) ||
			thread != "" && (candidate.agent != "codex" || thread != candidate.nativeID && thread != candidate.id) ||
			(opts.ownerWorkspace != "" || opts.ownerSession != "") &&
				(opts.ownerWorkspace != s.ID || opts.ownerSession != candidate.id) {
			return nil, blocked
		}
		own = candidate
	}
	if reservationActive(s) {
		state, err := p.chatState(s.ID)
		if err != nil {
			return nil, err
		}
		if own == nil || state.Active == nil || !state.Active.Ready || state.Active.Branch != "" || state.Active.Completion != nil ||
			!sameChatTarget(state.Active.chatTarget, chatTarget{
				Workspace: s.ID, SessionID: own.id, Terminal: own.terminal, Cwd: s.WorktreePath,
			}) {
			return nil, blocked
		}
	}
	// The raw roster also contains harnesses that listSessions cannot identify.
	if s.liveChats != len(s.sessions) {
		return nil, blocked
	}
	occupied, err := p.otherNativeInSlot(s, own)
	if err != nil {
		return nil, err
	}
	if occupied {
		return nil, blocked
	}
	return own, nil
}

func (p paradev) prepareInOwnChat(s slot, opts slotOptions, recheck func() error) (result, error) {
	if !slotPattern.MatchString(s.Name) || !s.exists || s.checkout == "" || canonicalPath(s.WorktreePath) == canonicalPath(s.checkout) {
		return result{}, fail(exitCheck, "Нужен отдельный существующий слот с известной основной копией")
	}
	g := gitClient{ctx: p.ctx, env: p.env, cwd: s.WorktreePath}
	if valid, err := validBranch(g, opts.branch); err != nil {
		return result{}, err
	} else if !valid {
		return result{}, fail(exitError, "Некорректное имя ветки: %s", opts.branch)
	}
	cfg, err := loadSlotConfig(s)
	if err != nil {
		return result{}, err
	}
	if cfg.Slot.Take != "" {
		return result{}, fail(exitCheck, "Проектная команда slot.take требует слот без живой сессии")
	}
	main, err := mainBranch(g, cfg)
	if err != nil {
		return result{}, err
	}
	remote := choose(cfg.Slot.Remote, "origin")
	base := strings.TrimPrefix(choose(opts.from, main), remote+"/")
	if opts.branch == base || opts.branch == main {
		return result{}, fail(exitError, "%s — база, а не ветка задачи", opts.branch)
	}
	start, err := slotBaseRef(g, remote, base, opts.offline)
	if err != nil {
		return result{}, err
	}
	if err := recheck(); err != nil {
		return result{}, err
	}
	for _, ref := range []string{"refs/heads/" + opts.branch, "refs/remotes/" + remote + "/" + opts.branch} {
		exists, err := gitHas(g, ref)
		if err != nil {
			return result{}, err
		}
		if exists {
			return result{}, fail(exitCheck, "Из своего чата можно создать только новую ветку")
		}
	}
	info, err := g.describe()
	if err != nil {
		return result{}, err
	}
	busy, err := checkoutOperation(g)
	if err != nil {
		return result{}, err
	}
	if info == nil || canonicalPath(info.Root) != canonicalPath(s.WorktreePath) || info.Branch != nil ||
		info.Head == nil || *info.Head != start.sha || busy || len(info.Changes) != 0 {
		return result{}, fail(exitCheck, "Из своего чата нужна чистая рабочая копия с detached HEAD на SHA выбранной базы")
	}
	data := map[string]any{"slot": s.Name, "path": s.WorktreePath, "branch": opts.branch, "existing": false,
		"from": start.name, "base": start.sha, "fetched": !opts.offline, "branchOnly": true}
	if opts.dry {
		data["dryRun"] = true
		return result{data: data, text: "Сухой прогон: новая ветка " + opts.branch + " на текущем HEAD"}, nil
	}
	// Keep the chat reservation and generation. Checkout hooks and the normal
	// provisioning steps can change the live worktree, so this path only attaches HEAD.
	if _, err := g.git("-c", "core.hooksPath=/dev/null", "switch", "--no-recurse-submodules", "--no-track", "-c", opts.branch, start.sha); err != nil {
		return result{}, err
	}
	return result{data: data, text: s.Name + ": создана ветка " + opts.branch + " на текущем HEAD"}, nil
}
