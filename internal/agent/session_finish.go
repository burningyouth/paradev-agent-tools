package agent

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

func digestJSON(value any) string {
	data, _ := json.Marshal(value)
	return fmt.Sprintf("%x", sha256.Sum256(data))
}

func promptFingerprint(records []transcriptRecord) string {
	prompts := [][2]string{}
	for _, entry := range records {
		if text := entry.prompt(); text != "" {
			prompts = append(prompts, [2]string{entry.UUID, text})
		}
	}
	return digestJSON(prompts)
}

func (p paradev) queueFinish(ws workspace, assigned *slot, session liveSession, opts closeOptions) (result, error) {
	path := canonicalPath(ws.WorktreePath)
	if !containsPath(path, p.env.cwd) || assigned != nil && assigned.checkout == "" {
		return result{}, fail(exitCheck, "Нужен cwd выбранного workspace и известная основная копия для освобождения слота")
	}
	info, err := p.transcript(session, time.Now().Add(2*time.Minute))
	if err != nil {
		return result{}, err
	}
	if info.state == "waiting" || info.waiting != nil {
		return result{}, fail(exitWaiting, "Сессия ждёт решения — задача не закрыта")
	}
	summary := opts.Note
	if opts.SummaryFile != "" {
		summary, err = readInput(p.env, opts.SummaryFile, "")
		if err != nil {
			return result{}, fail(exitError, "Не читается итог: %v", err)
		}
	} else if summary == "" {
		summary = "Работа приостановлена. Перед продолжением проверь Git и инструкции проекта."
		if answer := lastAnswer(info.records); answer != nil {
			summary = answer.Text
		}
	}
	if strings.TrimSpace(summary) == "" {
		return result{}, fail(exitError, "Итог пуст")
	}
	return p.withSlotLock(ws.ID, path, func() (result, error) {
		var owner *slotOwner
		releaseStatus := "not-applicable"
		if assigned != nil {
			current, err := p.findSlot(ws.ID, ws.ProjectName)
			if err != nil {
				return result{}, err
			}
			if canonicalPath(current.WorktreePath) != path || current.Name != assigned.Name {
				return result{}, fail(exitCheck, "Принадлежность слота изменилась — старая операция отменена")
			}
			if err := p.checkCloseSlot(current, &session, nil); err != nil {
				return result{}, err
			}
			actual, err := p.ownership(current)
			if err != nil {
				return result{}, err
			}
			owner, releaseStatus = &actual, "pending"
		}
		target := workerIdentity(session)
		prompts := promptFingerprint(info.records)
		key := digestJSON(map[string]any{"owner": owner, "target": target, "prompts": prompts, "workspacePath": path})
		jobDir := filepath.Join(p.env.agentHome, "finish-jobs", key)
		resultFile := filepath.Join(jobDir, "result.json")
		summaryFile := filepath.Join(jobDir, "summary.md")
		summaryHash := digestJSON(summary)
		var job workerJob
		if err := readJSON(resultFile, &job); err != nil {
			return result{}, err
		}
		if job.Status != "" {
			if job.SummaryHash != summaryHash {
				return result{}, fail(exitCheck, "Finish уже существует с другим итогом: %s", resultFile)
			}
			return queuedFinish(job, resultFile), nil
		}
		if err := os.MkdirAll(jobDir, 0o700); err != nil {
			return result{}, err
		}
		if err := os.WriteFile(summaryFile, []byte(summary), 0o600); err != nil {
			return result{}, err
		}
		opts.Reason = choose(opts.Reason, "close")
		patch := sessionRecord{"summaryFile": summaryFile, "closeReason": opts.Reason}
		if _, err := p.saveLiveSession(session, "checkpoint", truncateRunes(summary, 4000), "", patch, time.Now().UTC(), true); err != nil {
			return result{}, err
		}
		job = workerJob{Status: "queued", Operation: "finish", Owner: owner, WorkspacePath: path, Context: workContext(p.env),
			Target: target, Prompts: prompts, Receipt: "[[FINISH-" + uuid() + "]]", CreatedAt: time.Now().UTC(),
			SummaryFile: summaryFile, SummaryHash: summaryHash, Options: opts, Config: p.config,
			Close: map[string]any{"status": "pending"}, Release: map[string]any{"status": releaseStatus}}
		if err := atomicJSON(resultFile, job); err != nil {
			return result{}, err
		}
		if err := spawnSessionWorker(p.env, resultFile); err != nil {
			code := exitError
			job.Status, job.Error, job.Code = "error", err.Error(), &code
			return result{}, errors.Join(fail(exitError, "Worker не запущен: %v. Итог сохранён: %s", err, resultFile), atomicJSON(resultFile, job))
		}
		return queuedFinish(job, resultFile), nil
	})
}

func queuedFinish(job workerJob, path string) result {
	return result{data: map[string]any{"status": job.Status, "resultFile": path, "summaryFile": job.SummaryFile,
		"receipt": job.Receipt, "close": job.Close, "release": job.Release},
		text: fmt.Sprintf("Close: %s. Итог: %s\nРезультат: %s\nДобавьте в финальный ответ: %s",
			job.Status, job.SummaryFile, path, job.Receipt)}
}

func (p paradev) finishAnswer(job *workerJob, deadline time.Time) (string, error) {
	rows, err := p.chatList(job.Target.Workspace)
	if err != nil {
		return "", err
	}
	rows = slices.DeleteFunc(rows, func(row chatSession) bool { return row.SessionID != job.Target.SessionID })
	if len(rows) != 1 || !rows[0].Live {
		return "", fail(exitCheck, "Вызывающий chat исчез или сменил идентичность — ничего не закрыто")
	}
	row := rows[0]
	term, native := row.SessionID, ""
	if row.TerminalID != nil {
		term = *row.TerminalID
	}
	if row.HarnessSessionID != nil {
		native = *row.HarnessSessionID
	}
	expected := ""
	if job.Target.NativeSessionID != nil {
		expected = *job.Target.NativeSessionID
	}
	if term != job.Target.Terminal || native != expected {
		return "", fail(exitCheck, "Вызывающий chat исчез или сменил идентичность — ничего не закрыто")
	}
	asSession := liveSession{id: row.SessionID, workspaceID: job.Target.Workspace}
	info, err := p.readChat(asSession, deadline)
	if err != nil {
		return "", err
	}
	if promptFingerprint(info.records) != job.Prompts {
		return "", fail(exitCheck, "После finish пришло новое сообщение — закрытие отменено")
	}
	prompt, finished := -1, ""
	for i, entry := range info.records {
		if entry.prompt() != "" {
			prompt = i
		}
		if entry.Subtype == "turn_duration" {
			finished = entry.TurnStatus
		}
	}
	analysis := analyzeTranscript(info.records, prompt, "")
	if analysis.apiError != "" {
		return "", fail(exitAPIError, "Ошибка финального ответа — чат оставлен открытым")
	}
	if info.waiting != nil || info.state == "waiting" || row.Status == "awaiting_input" {
		return "", fail(exitWaiting, "Сессия ждёт решения — закрытие отменено")
	}
	if finished == "completed" && analysis.turnEnded && analysis.answer != nil &&
		strings.Contains(analysis.answer.Text, job.Receipt) && row.Status == "idle" && info.state == "idle" {
		return analysis.answer.Text, nil
	}
	return "", nil
}

func (p paradev) runFinish(path string, job *workerJob) (result, error) {
	deadline := job.CreatedAt.Add(20 * time.Minute)
	ctx, cancel := context.WithDeadline(p.ctx, deadline)
	defer cancel()
	p.ctx = ctx
	err := p.finishTransaction(path, job, deadline)
	if job.Close["status"] == "closed" {
		var releaseErr error
		job.AdditionalSlots, releaseErr = p.releaseSessionSlots(job.Target)
		err = errors.Join(err, releaseErr)
	}
	code := exitOK
	if err != nil {
		code = codeOf(err)
		job.Status, job.Error = "blocked", err.Error()
		if code == exitError {
			job.Status = "error"
		}
		switch job.Release["status"] {
		case "pending":
			job.Release["status"] = "blocked"
		case "requested":
			job.Release["status"] = "unverified"
		}
	}
	job.Code = &code
	now := time.Now().UTC()
	job.FinishedAt = &now
	if err := atomicJSON(path, job); err != nil {
		return result{}, err
	}
	title := "Сессия сохранена"
	body := "Подробности: paradev-agent close --result " + path
	if job.Release["status"] == "released" {
		title = "Слот освобождён"
	}
	if code != exitOK {
		title = "Закрытие требует внимания"
	}
	job.Notification = p.notifyHook(job.Target.Workspace, title, body, 10*time.Second)
	if err := atomicJSON(path, job); err != nil {
		return result{}, err
	}
	return result{code: code, data: job}, nil
}

func (p paradev) finishTransaction(path string, job *workerJob, deadline time.Time) error {
	summary, err := os.ReadFile(job.SummaryFile)
	if err != nil {
		return err
	}
	if digestJSON(string(summary)) != job.SummaryHash {
		return fail(exitCheck, "Сохранённый итог изменился — чат оставлен открытым")
	}
	job.Status = "waiting_reply"
	if err := atomicJSON(path, job); err != nil {
		return err
	}
	end := time.Now().Add(10 * time.Minute)
	if deadline.Before(end) {
		end = deadline
	}
	err = p.waitForClose(time.Until(end), "Нет подтверждённого финального ответа с receipt — чат оставлен открытым", func() (bool, error) {
		if job.Owner != nil {
			if _, err := p.ownedSlot(*job.Owner); err != nil {
				return false, err
			}
		}
		answer, err := p.finishAnswer(job, end)
		return answer != "", err
	})
	if err != nil {
		return err
	}
	_, err = p.withSlotLock(job.Target.Workspace, job.WorkspacePath, func() (result, error) {
		return result{}, p.finishUnderLock(path, job, deadline, string(summary))
	})
	return err
}

func (p paradev) finishUnderLock(path string, job *workerJob, deadline time.Time, summary string) error {
	workspaces, err := p.workspaces()
	if err != nil {
		return err
	}
	ws, err := exactWorkspace(workspaces, job.Target.Workspace)
	if err != nil || canonicalPath(ws.WorktreePath) != job.WorkspacePath {
		return fail(exitCheck, "Путь выбранного workspace изменился — чат оставлен открытым")
	}
	answer, err := p.finishAnswer(job, deadline)
	if err != nil {
		return err
	}
	if answer == "" {
		return fail(exitCheck, "Сессия снова активна — закрытие отменено")
	}
	session, err := p.lookupSession(job.Target.SessionID, job.Target.Workspace)
	if err != nil || !job.Target.matches(session) || session.state != "idle" {
		return fail(exitCheck, "Сессия снова активна или исчезла — закрытие отменено")
	}
	if job.Owner != nil {
		current, err := p.ownedSlot(*job.Owner)
		if err != nil {
			return err
		}
		if err := p.checkCloseSlot(current, &session, nil); err != nil {
			return err
		}
	}
	job.Status = "closing"
	job.Delivery = map[string]any{"status": "confirmed", "at": time.Now().UTC(), "answer": answer}
	job.Close["status"] = "requested"
	if err := atomicJSON(path, job); err != nil {
		return err
	}
	opts := closeOptions{Note: truncateRunes(summary, 4000), Reason: job.Options.Reason}
	if _, err := p.closeTransport(session, opts); err != nil {
		return err
	}
	job.Close = map[string]any{"status": "closed", "at": time.Now().UTC()}
	if job.Owner == nil {
		job.Status = "completed"
		return atomicJSON(path, job)
	}
	if err := atomicJSON(path, job); err != nil {
		return err
	}
	var fresh slot
	if err := p.waitForClose(min(time.Until(deadline), 90*time.Second), "Chat/native-процессы не завершились в срок — слот не освобождён", func() (bool, error) {
		var err error
		fresh, err = p.ownedSlot(*job.Owner)
		if err != nil {
			return false, err
		}
		occupied, err := p.nativeInSlot(fresh)
		return !occupied && len(fresh.sessions) == 0, err
	}); err != nil {
		return err
	}
	job.Status, job.Release["status"] = "releasing", "requested"
	if err := atomicJSON(path, job); err != nil {
		return err
	}
	if err := atomicJSON(slotStatePath(p.env, fresh.WorktreePath)+".json", map[string]string{"generation": uuid()}); err != nil {
		return err
	}
	release, err := p.completeLocked(fresh, releaseOptions{})
	if err != nil {
		return err
	}
	job.Release = release
	job.Release["status"] = "released"
	if _, err := p.saveLiveSession(session, "released", "", "", sessionRecord{"release": release}, time.Now().UTC(), false); err != nil {
		return err
	}
	job.Status = "completed"
	return atomicJSON(path, job)
}
