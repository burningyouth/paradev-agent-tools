package agent

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"time"
)

func uuid() string {
	var data [16]byte
	rand.Read(data[:])
	data[6] = data[6]&0x0f | 0x40
	data[8] = data[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", data[:4], data[4:6], data[6:8], data[8:10], data[10:])
}

func syncDirectory(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	if err := dir.Sync(); err != nil && !errors.Is(err, syscall.EINVAL) && !errors.Is(err, syscall.ENOTSUP) {
		return err
	}
	return nil
}

func atomicJSON(path string, data any) error {
	parent := filepath.Dir(path)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return err
	}
	file, err := os.CreateTemp(parent, "."+filepath.Base(path)+"-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	err = writeCLIJSON(file, data)
	if err == nil {
		err = file.Sync()
	}
	if err := errors.Join(err, file.Close()); err != nil {
		return err
	}
	if err := os.Rename(file.Name(), path); err != nil {
		return err
	}
	return syncDirectory(parent)
}

func withRegistry(env environment, task func(*registry) error) (err error) {
	if err := os.MkdirAll(env.agentHome, 0o700); err != nil {
		return err
	}
	path := filepath.Join(env.agentHome, "sessions.lock")
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, fs.ErrExist) {
		return fail(exitCheck, "Реестр занят другой операцией: %s", path)
	}
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, file.Close(), os.Remove(path)) }()
	if err := json.NewEncoder(file).Encode(map[string]int{"pid": os.Getpid()}); err != nil {
		return err
	}
	reg, _, err := loadRegistry(env)
	if err != nil {
		return err
	}
	if err := task(&reg); err != nil {
		return err
	}
	return atomicJSON(filepath.Join(env.agentHome, "sessions.json"), reg)
}

func appendHistoryEvent(env environment, event historyEvent) error {
	path := filepath.Join(env.agentHome, "session-log.jsonl")
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil {
		return err
	}
	if len(data) != 0 && data[len(data)-1] != '\n' {
		if err := file.Truncate(int64(bytes.LastIndexByte(data, '\n') + 1)); err != nil {
			return err
		}
	}
	if err := json.NewEncoder(file).Encode(event); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	return syncDirectory(env.agentHome)
}

func (p paradev) observeSessions(sessions []liveSession, now time.Time) error {
	for _, session := range sessions {
		if err := p.recordLiveSession(session, "observed", "", "", now); err != nil {
			return err
		}
	}
	return nil
}

func (p paradev) recordLiveSession(session liveSession, eventType, note, from string, now time.Time) error {
	_, err := p.saveLiveSession(session, eventType, note, from, nil, now, true)
	return err
}

func (p paradev) saveLiveSession(session liveSession, eventType, note, from string, patch sessionRecord, now time.Time, includeGit bool) (sessionRecord, error) {
	return p.saveSessionWithBinding(session, eventType, note, from, patch, now, includeGit, nil)
}

func (p paradev) saveSessionWithBinding(session liveSession, eventType, note, from string, patch sessionRecord, now time.Time, includeGit bool, binding sessionRecord) (sessionRecord, error) {
	metadata := sessionRecord{}
	for key, value := range map[string]string{
		"kind": session.kind, "agent": session.agent, "sessionId": session.id, "nativeSessionId": session.nativeID,
		"alias": session.alias, "workspace": session.workspaceID, "workspaceName": session.workspaceName,
		"project": session.project, "cwd": session.cwd, "title": session.title, "terminal": session.terminal,
	} {
		if value != "" {
			metadata[key] = value
		}
	}
	if slot := slotPattern.FindString(session.workspaceName); slot != "" {
		metadata["slot"] = slot
		if _, task, ok := strings.Cut(session.workspaceName, " · "); ok {
			if task == "чат" {
				metadata["task"] = nil
			} else {
				metadata["task"] = task
			}
		}
	}
	if includeGit {
		if err := p.fillSessionGit(session, metadata); err != nil {
			return nil, err
		}
	}
	var saved sessionRecord
	err := withRegistry(p.env, func(reg *registry) error {
		var previous sessionRecord
		for i := len(reg.Sessions) - 1; i >= 0; i-- {
			old := reg.Sessions[i]
			if choose(old.string("agent"), "claude") != session.agent {
				continue
			}
			if matchesSessionRecord(old, from) || (session.nativeID != "" && old.string("nativeSessionId") == session.nativeID &&
				old.string("workspace") == session.workspaceID && choose(old.string("kind"), "cli") == session.kind) ||
				matchesSessionRecord(old, session.id) ||
				(session.terminal != "" && old.string("terminal") == session.terminal &&
					(old.string("sessionId") == "" || session.id == "")) {
				previous = old
				break
			}
		}
		if binding != nil && !sameRecordBinding(previous, binding) {
			return fail(exitCheck, "Сессия уже возобновлена или переназначена — старое событие отменено")
		}
		record := make(sessionRecord)
		maps.Copy(record, previous)
		maps.Copy(record, metadata)
		maps.Copy(record, patch)
		if record.string("id") == "" {
			record["id"] = uuid()
		}
		open := eventType == "observed" || eventType == "resumed" || eventType == "created"
		if record.string("lifecycleId") == "" || (open && previous.string("status") == "closed") {
			record["lifecycleId"] = uuid()
		}
		date := now.Format("2006-01-02T15:04:05.000Z")
		record["createdAt"] = choose(previous.string("createdAt"), date)
		if past := previous.string("sessionId"); past != "" && session.id != "" && past != session.id {
			record["resumedFrom"] = past
		} else if from != "" && from != session.id {
			record["resumedFrom"] = from
		}
		known := previous.strings("sessionIds")
		for _, id := range []string{previous.string("sessionId"), session.id, session.nativeID} {
			if id != "" && !slices.Contains(known, id) {
				known = append(known, id)
			}
		}
		record["sessionIds"] = known
		if record.string("alias") == "" {
			record["alias"] = nil
			for alias, target := range reg.Aliases {
				if target == session.terminal {
					record["alias"] = alias
					break
				}
			}
		}
		if note != "" {
			record["note"] = note
		}
		record["updatedAt"] = date
		if open {
			record["lastSeenAt"], record["closedAt"], record["status"] = date, nil, "open"
			for _, key := range []string{"release", "sessionOnly", "error"} {
				delete(record, key)
			}
		}
		switch eventType {
		case "resume-requested":
			record["lifecycleId"] = uuid()
		case "close-requested":
			record["status"] = "closing"
		case "closed":
			record["status"], record["closedAt"] = "closed", date
		case "close-failed":
			record["status"] = "unknown"
		}
		event := historyEvent{Version: reg.HistoryVersion + 1, Type: eventType, At: date, Record: record}
		if err := appendHistoryEvent(p.env, event); err != nil {
			return err
		}
		reg.replay(event)
		saved = record
		return nil
	})
	return saved, err
}

func matchesSessionRecord(record sessionRecord, ref string) bool {
	if ref == "" {
		return false
	}
	for _, key := range []string{"id", "alias", "sessionId", "nativeSessionId", "terminal"} {
		if record.string(key) == ref {
			return true
		}
	}
	return slices.Contains(record.strings("sessionIds"), ref)
}

func (p paradev) fillSessionGit(session liveSession, data sessionRecord) error {
	if session.cwd == "" || !fileExists(session.cwd) {
		return nil
	}
	git := gitClient{ctx: p.ctx, env: p.env, cwd: session.cwd}
	info, err := git.describe()
	if err != nil || info == nil {
		return err
	}
	common, err := git.git("rev-parse", "--git-common-dir")
	if err != nil {
		return err
	}
	common = strings.TrimSpace(common)
	if !filepath.IsAbs(common) {
		common = filepath.Join(session.cwd, common)
	}
	checkouts, err := git.git("worktree", "list", "--porcelain")
	if err != nil {
		return err
	}
	data["cwd"], data["gitCommonDir"] = info.Root, canonicalPath(common)
	for line := range strings.SplitSeq(checkouts, "\n") {
		if path, ok := strings.CutPrefix(line, "worktree "); ok {
			data["mainCheckout"] = path
			break
		}
	}
	if info.Branch != nil {
		data["branch"] = *info.Branch
	}
	if info.Head != nil {
		data["head"] = *info.Head
	} else {
		data["head"] = nil
	}
	data["dirty"] = len(info.Changes)
	return nil
}
