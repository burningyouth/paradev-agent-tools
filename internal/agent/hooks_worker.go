package agent

import (
	"context"
	"errors"
	"path/filepath"
	"strconv"
	"time"
)

func (p paradev) queueSessionEnd(binding hookBinding, reason string) (result, error) {
	if !chatIdentity.MatchString(binding.Incarnation) || binding.Target.Workspace == "" {
		return result{}, fail(exitCheck, "Некорректная запись SessionStart")
	}
	path := filepath.Join(p.env.agentHome, "end-jobs", binding.Incarnation+".json")
	return p.withSlotLock(binding.Incarnation, path, func() (result, error) {
		var existing workerJob
		if err := readJSON(path, &existing); err != nil {
			return result{}, err
		}
		if existing.Status != "" {
			return hookResult(existing.Status, map[string]any{"resultFile": path}), nil
		}
		bound := binding.Session
		record, err := p.saveSessionWithBinding(liveFromRecord(bound), "checkpoint", "", "",
			sessionRecord{"closeReason": "session-end:" + choose(reason, "other")}, time.Now().UTC(), false, bound)
		if err != nil {
			return result{}, err
		}
		sessionOnly, _ := record["sessionOnly"].(bool)
		owner := binding.Owner
		if sessionOnly {
			owner = nil
		}
		job := workerJob{Operation: "session-end", Status: "queued", CreatedAt: time.Now().UTC(),
			Target: workerIdentity(liveFromRecord(record)), Hook: &binding.Target, Session: record, Owner: owner,
			ProjectBranch: binding.ProjectBranch, RecoverMerged: binding.SlotBlocked && owner != nil,
			Config: p.config, Context: workContext(p.env),
			Close: map[string]any{"status": "pending"}, Release: map[string]any{"status": "not-applicable"}}
		job.Context.Cwd = record.string("cwd")
		if owner != nil {
			job.Release["status"] = "pending"
		}
		if err := atomicJSON(path, job); err != nil {
			return result{}, err
		}
		if err := spawnSessionWorker(p.env, path); err != nil {
			return result{}, workerFailure(path, &job, err)
		}
		return hookResult("queued", map[string]any{"resultFile": path}), nil
	})
}

func (p paradev) runSessionEnd(path string, job *workerJob) (result, error) {
	ctx, cancel := context.WithTimeout(p.ctx, 210*time.Second)
	defer cancel()
	p.ctx = ctx
	job.Status = "waiting_exit"
	if err := atomicJSON(path, job); err != nil {
		return result{}, err
	}
	err := p.checkpointSessionEnd(job)
	job.Status = "completed"
	code := exitOK
	if err != nil {
		code = codeOf(err)
		job.Status, job.Error = "blocked", err.Error()
		if job.Release["status"] == "pending" {
			job.Release["status"] = "blocked"
		}
	}
	finished := time.Now().UTC()
	job.FinishedAt, job.Code = &finished, &code
	if save := atomicJSON(path, job); save != nil {
		return result{}, errors.Join(err, save)
	}
	title := "Сессия сохранена"
	body := "Продолжение доступно через paradev-agent resume"
	if job.Release["status"] == "released" {
		body = "Слот освобождён. " + body
	}
	if err != nil {
		title = "Слот не освобождён"
		body = "Подробности: paradev-agent close --result " + path
	}
	job.Notification = p.notifyHook(job.Target.Workspace, title, body, 10*time.Second)
	if save := atomicJSON(path, job); save != nil {
		return result{}, errors.Join(err, save)
	}
	return result{data: job, text: job.Status, code: code}, nil
}

func (p paradev) checkpointSessionEnd(job *workerJob) error {
	if job.Hook == nil {
		return fail(exitCheck, "SessionEnd не содержит точной привязки к runtime")
	}
	target := *job.Hook
	pid, _ := strconv.Atoi(target.RuntimePID)
	var ws *workspace
	if err := p.waitForClose(90*time.Second, "Сессия/native-процессы не завершились в срок — слот не освобождён", func() (bool, error) {
		if _, err := currentHookRecord(p.env, job.Session); err != nil {
			return false, err
		}
		rows, err := p.workspaces()
		if err != nil {
			return false, err
		}
		ws, err = exactWorkspace(rows, target.Workspace)
		if err != nil {
			return false, err
		}
		sessions, processes, err := p.listSessions(rows, false, target.Workspace)
		if err != nil {
			return false, err
		}
		for _, session := range sessions {
			if session.workspaceID == target.Workspace && session.terminal == target.Terminal && session.agent == target.Agent &&
				(session.kind == "chat" && (session.id == job.Target.SessionID || session.nativeID == target.NativeID) ||
					session.kind == "cli" && session.id == target.NativeID) {
				return false, nil
			}
		}
		for _, proc := range processes {
			if proc.pid == pid && proc.agent == target.Agent {
				return false, nil
			}
		}
		return true, nil
	}); err != nil {
		return err
	}
	job.Close["status"] = "closed"
	current, err := currentHookRecord(p.env, job.Session)
	if err != nil {
		return err
	}
	sessionOnly, _ := current["sessionOnly"].(bool)
	owner := job.Owner
	if sessionOnly {
		owner = nil
	}
	patch := sessionRecord{"closeReason": job.Session["closeReason"]}
	var s slot
	recover := false
	if owner != nil {
		if existing, ok := current["release"].(map[string]any); ok && existing["status"] == "released" {
			existing["duplicate"] = true
			job.Release = existing
			return nil
		}
		s, err = p.findSlot(owner.Workspace, owner.Project)
		if err != nil {
			return err
		}
		actual, err := p.ownership(s)
		if err != nil {
			return err
		}
		if actual != *owner {
			valid, err := p.validProjectBranch(s, owner, actual, job.ProjectBranch)
			if err != nil {
				return err
			}
			if !valid {
				return fail(exitCheck, "Принадлежность слота изменилась")
			}
			owner = &actual
			patch["branch"], patch["head"] = owner.Branch, owner.Head
		}
		if job.RecoverMerged {
			ch := chatTarget{Workspace: s.ID, SessionID: job.Target.SessionID, Terminal: job.Target.Terminal, Cwd: s.WorktreePath}
			assigned, err := p.recordedChatAssignment(s, *owner, ch, target.NativeID, false)
			if err != nil {
				return err
			}
			recover = !assigned
			if recover {
				safe, err := p.canRecoverMerged(s, *owner)
				if err != nil {
					return err
				}
				if !safe {
					owner = nil
				}
			}
		}
	}
	record, err := p.saveSessionWithBinding(liveFromRecord(current), "closed", "", "", patch, time.Now().UTC(), false, current)
	if err != nil {
		return err
	}
	if owner == nil {
		job.Release["status"] = "not-applicable"
		return nil
	}
	err = p.waitForClose(15*time.Second, "Слот занят другой операцией", func() (bool, error) {
		updated, err := currentHookRecord(p.env, record)
		if err != nil {
			return false, err
		}
		if release, ok := updated["release"].(map[string]any); ok && release["status"] == "released" {
			release["duplicate"] = true
			job.Release = release
			return true, nil
		}
		out, err := p.closeTarget(*ws, &s, nil, record, closeOptions{SkipTidy: true, expectedOwner: owner, Recover: recover})
		var failure *agentError
		if errors.As(err, &failure) && failure.details["slotLocked"] == true {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		job.Release = out.data.(sessionRecord)["release"].(map[string]any)
		return true, nil
	})
	return err
}

func (p paradev) canRecoverMerged(s slot, owner slotOwner) (bool, error) {
	if reservationActive(s) || owner.Branch == "" {
		return false, nil
	}
	g := gitClient{ctx: p.ctx, env: p.env, cwd: s.WorktreePath}
	cfg, err := loadSlotConfig(s)
	if err != nil || cfg.Slot.Release != "" {
		return false, err
	}
	main, err := mainBranch(g, cfg)
	if err != nil || main == owner.Branch {
		return false, err
	}
	if err := requireCleanSlot(g); err != nil {
		if codeOf(err) == exitCheck {
			return false, nil
		}
		return false, err
	}
	return mergedInto(g, cfg, main)
}
