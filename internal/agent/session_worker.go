package agent

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
)

type workerTarget struct {
	Kind            string  `json:"kind"`
	Agent           string  `json:"agent,omitempty"`
	SessionID       string  `json:"sessionId"`
	Terminal        string  `json:"terminal"`
	Workspace       string  `json:"workspace"`
	NativeSessionID *string `json:"nativeSessionId,omitempty"`
}

type workerContext struct {
	Cwd        string `json:"cwd"`
	AgentHome  string `json:"agentHome"`
	CodexHome  string `json:"codexHome,omitempty"`
	ClaudeHome string `json:"claudeHome,omitempty"`
}

type workerJob struct {
	Operation       string               `json:"operation,omitempty"`
	Status          string               `json:"status"`
	CallerPID       int                  `json:"callerPid,omitempty"`
	Target          workerTarget         `json:"target"`
	Config          configuration        `json:"config"`
	Options         closeOptions         `json:"options,omitempty"`
	Context         workerContext        `json:"context"`
	Owner           *slotOwner           `json:"owner,omitempty"`
	Session         sessionRecord        `json:"session,omitempty"`
	Hook            *hookTarget          `json:"hookTarget,omitempty"`
	HostManaged     bool                 `json:"hostManaged,omitempty"`
	ProjectBranch   bool                 `json:"projectBranch,omitempty"`
	RecoverMerged   bool                 `json:"recoverMerged,omitempty"`
	WorkspacePath   string               `json:"workspacePath,omitempty"`
	Prompts         string               `json:"prompts,omitempty"`
	Receipt         string               `json:"receipt,omitempty"`
	SummaryFile     string               `json:"summaryFile,omitempty"`
	SummaryHash     string               `json:"summaryHash,omitempty"`
	CreatedAt       time.Time            `json:"createdAt"`
	FinishedAt      *time.Time           `json:"finishedAt,omitempty"`
	Delivery        map[string]any       `json:"delivery,omitempty"`
	Close           map[string]any       `json:"close,omitempty"`
	Release         map[string]any       `json:"release,omitempty"`
	AdditionalSlots []slotReleaseOutcome `json:"additionalSlots,omitempty"`
	Notification    map[string]any       `json:"notification,omitempty"`
	Error           string               `json:"error,omitempty"`
	Code            *exitCode            `json:"code,omitempty"`
}

func workerIdentity(s liveSession) workerTarget {
	return workerTarget{Kind: s.kind, Agent: s.agent, SessionID: s.id, Terminal: s.terminal,
		Workspace: s.workspaceID, NativeSessionID: stringPtr(s.nativeID)}
}

func (t workerTarget) matches(s liveSession) bool {
	return t.Kind == s.kind && t.SessionID == s.id && t.Terminal == s.terminal && t.Workspace == s.workspaceID &&
		(t.Agent == "" || t.Agent == s.agent) && (t.NativeSessionID == nil || *t.NativeSessionID == s.nativeID)
}

func workContext(env environment) workerContext {
	return workerContext{Cwd: env.cwd, AgentHome: env.agentHome, CodexHome: env.get("CODEX_HOME"), ClaudeHome: env.get("CLAUDE_CONFIG_DIR")}
}

func spawnSessionWorker(env environment, path string) error {
	binary, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(binary, "__session-worker", path)
	cmd.Dir = env.agentHome
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

func (p paradev) queueClose(s liveSession, opts closeOptions) (result, error) {
	path := filepath.Join(p.env.agentHome, "close-jobs", uuid()+".json")
	id := workerIdentity(s)
	job := workerJob{Status: "queued", CallerPID: os.Getpid(), Target: id, Config: p.config,
		Options: opts, Context: workContext(p.env), CreatedAt: time.Now().UTC()}
	if err := atomicJSON(path, job); err != nil {
		return result{}, err
	}
	if err := spawnSessionWorker(p.env, path); err != nil {
		code := exitError
		job.Status, job.Error, job.Code = "error", err.Error(), &code
		return result{}, errors.Join(fail(exitError, "Не удалось запустить закрытие: %v. Результат: %s", err, path), atomicJSON(path, job))
	}
	return result{data: map[string]any{"status": "queued", "resultFile": path,
		"kind": id.Kind, "sessionId": id.SessionID, "terminal": id.Terminal, "workspace": id.Workspace},
		text: "Закрытие сессии " + s.id + " запущено отдельным процессом. Результат: " + path}, nil
}

func sessionWorker(ctx context.Context, env environment, path string) (result, error) {
	var job workerJob
	if err := readJSON(path, &job); err != nil || job.Status != "queued" {
		return result{}, err
	}
	lock, err := os.OpenFile(path+".worker", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		return result{}, nil
	}
	if err != nil {
		return result{}, err
	}
	if err := lock.Close(); err != nil {
		return result{}, err
	}
	env.cwd, env.agentHome = job.Context.Cwd, job.Context.AgentHome
	baseEnv := env.get
	env.get = func(key string) string {
		switch key {
		case "CODEX_HOME":
			return choose(job.Context.CodexHome, baseEnv(key))
		case "CLAUDE_CONFIG_DIR":
			return choose(job.Context.ClaudeHome, baseEnv(key))
		default:
			return baseEnv(key)
		}
	}
	p := paradev{ctx: ctx, env: env, config: job.Config, timeout: 30 * time.Second}
	if job.Operation == "finish" {
		return p.runFinish(path, &job)
	}
	if job.Operation == "session-end" {
		return p.runSessionEnd(path, &job)
	}
	if job.Operation != "" && job.Operation != "close" {
		return result{}, fail(exitError, "Неизвестная операция worker: %s", job.Operation)
	}
	job.Status = "running"
	if err := atomicJSON(path, job); err != nil {
		return result{}, err
	}
	out, err := p.runQueuedClose(job)
	if err != nil {
		return result{}, workerFailure(path, &job, err)
	}
	return out, atomicJSON(path, map[string]any{"status": "completed", "data": out.data, "text": out.text, "code": out.code})
}

func (p paradev) runQueuedClose(job workerJob) (result, error) {
	if job.CallerPID < 1 {
		return result{}, fail(exitCheck, "Worker не получил PID вызывающего CLI")
	}
	if err := p.waitForClose(10*time.Second, "Вызывающий CLI не завершился за 10 с — сессия оставлена открытой", func() (bool, error) {
		err := syscall.Kill(job.CallerPID, 0)
		if errors.Is(err, syscall.ESRCH) {
			return true, nil
		}
		return false, err
	}); err != nil {
		return result{}, err
	}
	session, err := p.lookupSession(job.Target.SessionID, job.Target.Workspace)
	if err != nil || !job.Target.matches(session) {
		return result{}, fail(exitCheck, "Сессия изменилась после запуска закрытия — ничего не закрыто")
	}
	workspaces, err := p.workspaces()
	if err != nil {
		return result{}, err
	}
	ws, err := exactWorkspace(workspaces, session.workspaceID)
	if err != nil {
		return result{}, err
	}
	var targetSlot *slot
	if slotPattern.MatchString(ws.Name) {
		found, err := p.findSlot(ws.ID, ws.ProjectName)
		if err != nil {
			return result{}, err
		}
		targetSlot = &found
	}
	return p.closeTarget(*ws, targetSlot, &session, nil, job.Options)
}

func workerFailure(path string, job *workerJob, err error) error {
	code := codeOf(err)
	job.Status, job.Error, job.Code = "error", err.Error(), &code
	var failure *agentError
	if errors.As(err, &failure) {
		if close, ok := failure.details["close"].(map[string]any); ok {
			job.Close = close
		}
		if release, ok := failure.details["release"].(map[string]any); ok {
			job.Release = release
		}
		if slots, ok := failure.details["additionalSlots"].([]slotReleaseOutcome); ok {
			job.AdditionalSlots = slots
		}
	}
	return errors.Join(err, atomicJSON(path, job))
}
