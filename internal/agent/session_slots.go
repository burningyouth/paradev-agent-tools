package agent

import (
	"errors"
	"fmt"
	"time"
)

type slotState struct {
	Generation string        `json:"generation"`
	Holder     *workerTarget `json:"holder,omitempty"`
	Workspace  string        `json:"workspace,omitempty"`
	Branch     string        `json:"branch,omitempty"`
}

// Resolve the caller independently of the slot's project and cwd.
func (p paradev) slotHolder(workspaceID, sessionID string) (*workerTarget, error) {
	if workspaceID != "" || sessionID != "" {
		if workspaceID == "" || sessionID == "" {
			return nil, fail(exitCheck, "Укажите оба ID владельца слота: workspace и сессии")
		}
		s, err := p.lookupSession(sessionID, workspaceID)
		if err != nil {
			return nil, err
		}
		if sessionStopped(s) || s.id != sessionID || s.workspaceID != workspaceID {
			return nil, fail(exitCheck, "Нужен точный ID живой сессии владельца")
		}
		target := workerIdentity(s)
		return &target, nil
	}
	workspaceID = p.env.get("SUPERSET_WORKSPACE_ID")
	if p.env.get("SUPERSET_TERMINAL_ID") == "" && p.env.get("CODEX_THREAD_ID") == "" {
		return nil, nil
	}
	rows, err := p.workspaces()
	if err != nil {
		return nil, err
	}
	sessions, _, err := p.listSessions(rows, false, workspaceID)
	if err != nil {
		return nil, err
	}
	var holder *workerTarget
	for _, s := range sessions {
		if s.id == "" || s.terminal == "" || workspaceID != "" && s.workspaceID != workspaceID || !p.ownSession(s) {
			continue
		}
		if holder != nil {
			return nil, fail(exitCheck, "Владелец слота неоднозначен — укажите точные ID")
		}
		target := workerIdentity(s)
		holder = &target
	}
	return holder, nil
}

func (s slotState) heldBy(workspaceID string, owner workerTarget) bool {
	h := s.Holder
	return h != nil && s.Generation != "" && s.Workspace == workspaceID && h.SessionID != "" && h.Terminal != "" &&
		h.Kind == owner.Kind && (owner.Agent == "" || h.Agent == owner.Agent) && h.SessionID == owner.SessionID &&
		h.Terminal == owner.Terminal && h.Workspace == owner.Workspace &&
		(h.NativeSessionID == nil || owner.NativeSessionID == nil || *h.NativeSessionID == *owner.NativeSessionID)
}

type slotReleaseOutcome struct {
	Workspace string         `json:"workspace"`
	Name      string         `json:"name"`
	Status    string         `json:"status"`
	Result    map[string]any `json:"result,omitempty"`
	Error     string         `json:"error,omitempty"`
}

type slotClaim struct {
	workspace
	state slotState
}

func (p paradev) sessionSlotClaims(owner workerTarget) ([]slotClaim, error) {
	rows, err := p.workspaces()
	if err != nil {
		return nil, err
	}
	var claims []slotClaim
	var failures []error
	for _, ws := range rows {
		if ws.ID == owner.Workspace || ws.WorktreePath == "" {
			continue
		}
		statePath := slotStatePath(p.env, ws.WorktreePath) + ".json"
		var state slotState
		if err := readJSON(statePath, &state); err != nil {
			failures = append(failures, fmt.Errorf("%s: %w", ws.Name, err))
			continue
		}
		if state.heldBy(ws.ID, owner) {
			claims = append(claims, slotClaim{workspace: ws, state: state})
		}
	}
	return claims, errors.Join(failures...)
}

func (p paradev) releaseSessionSlots(owner workerTarget) ([]slotReleaseOutcome, error) {
	claims, claimErr := p.sessionSlotClaims(owner)
	var outcomes []slotReleaseOutcome
	failures := []error{claimErr}
	for _, ws := range claims {
		outcome := slotReleaseOutcome{Workspace: ws.ID, Name: ws.Name}
		statePath := slotStatePath(p.env, ws.WorktreePath) + ".json"
		err := p.waitForClose(15*time.Second, "Слот занят другой операцией", func() (bool, error) {
			_, err := p.withSlotLock(ws.ID, ws.WorktreePath, func() (result, error) {
				var current slotState
				if err := readJSON(statePath, &current); err != nil {
					return result{}, err
				}
				if !current.heldBy(ws.ID, owner) {
					outcome.Status = "changed"
					return result{}, nil
				}
				if current.Generation != ws.state.Generation {
					return result{}, fail(exitCheck, "Назначение слота изменилось")
				}
				fresh, err := p.findSlot(ws.ID, ws.ProjectName)
				if err != nil {
					return result{}, err
				}
				if canonicalPath(fresh.WorktreePath) != canonicalPath(ws.WorktreePath) {
					return result{}, fail(exitCheck, "Путь слота изменился")
				}
				if err := p.checkCloseSlot(fresh, nil, nil); err != nil {
					return result{}, err
				}
				actual, err := p.ownership(fresh)
				if err != nil {
					return result{}, err
				}
				if actual.Branch != "" && actual.Branch != current.Branch {
					return result{}, fail(exitCheck, "Ветка слота изменилась")
				}
				outcome.Result, err = p.completeLocked(fresh, releaseOptions{cached: true})
				if err != nil {
					return result{}, err
				}
				outcome.Status = "released"
				return result{}, atomicJSON(statePath, slotState{Generation: uuid()})
			})
			var failure *agentError
			if errors.As(err, &failure) && failure.details["slotLocked"] == true {
				return false, nil
			}
			return true, err
		})
		if err != nil {
			outcome.Status, outcome.Error = "blocked", err.Error()
			failures = append(failures, fmt.Errorf("%s: %w", ws.Name, err))
		}
		outcomes = append(outcomes, outcome)
	}
	return outcomes, errors.Join(failures...)
}
