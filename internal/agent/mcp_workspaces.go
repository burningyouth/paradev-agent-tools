package agent

import (
	"context"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type slotTarget struct {
	scopedCwd
	WorkspaceID string `json:"workspaceId"`
}

func projectHost(ctx context.Context, env environment, cwd, wsID string) (paradev, string, error) {
	scoped, err := scopedEnv(env, cwd)
	if err != nil {
		return paradev{}, "", err
	}
	host, project, err := selectedProject(ctx, scoped)
	if err != nil || wsID == "" {
		return host, project, err
	}
	workspaces, err := host.workspaces()
	if err != nil {
		return host, "", err
	}
	ws, err := exactWorkspace(workspaces, wsID)
	if err != nil {
		return host, "", err
	}
	if ws.ProjectName != project {
		return host, "", fail(exitCheck, "Workspace принадлежит другому проекту, выберите его путь явно")
	}
	return host, project, nil
}

func registerSlotTools(server *mcp.Server, env environment) {
	addMCPTool(server, env, "slot_create", func(ctx context.Context, input struct {
		scopedCwd
		Name    string `json:"name,omitempty"`
		Base    string `json:"base,omitempty"`
		DryRun  bool   `json:"dryRun,omitempty"`
		Offline bool   `json:"offline,omitempty"`
	}) (result, error) {
		host, project, err := projectHost(ctx, env, input.Cwd, "")
		if err != nil {
			return result{}, err
		}
		return host.createSlot(slotOptions{project: project, name: input.Name, base: input.Base, dry: input.DryRun, offline: input.Offline})
	})
	addMCPTool(server, env, "slot_take", func(ctx context.Context, input struct {
		scopedCwd
		Branch        string `json:"branch"`
		Task          string `json:"task,omitempty"`
		From          string `json:"from,omitempty"`
		DryRun        bool   `json:"dryRun,omitempty"`
		Offline       bool   `json:"offline,omitempty"`
		Carry         bool   `json:"carry,omitempty"`
		AllowUnmerged bool   `json:"allowUnmerged,omitempty"`
	}) (result, error) {
		host, project, err := projectHost(ctx, env, input.Cwd, "")
		if err != nil {
			return result{}, err
		}
		return host.takeSlot(slotOptions{project: project, branch: input.Branch, task: input.Task, from: input.From,
			dry: input.DryRun, offline: input.Offline, carry: input.Carry, allowUnmerged: input.AllowUnmerged})
	})
	addMCPTool(server, env, "slot_prepare", func(ctx context.Context, input struct {
		slotTarget
		Branch        string `json:"branch"`
		Task          string `json:"task,omitempty"`
		From          string `json:"from,omitempty"`
		DryRun        bool   `json:"dryRun,omitempty"`
		Offline       bool   `json:"offline,omitempty"`
		Carry         bool   `json:"carry,omitempty"`
		AllowUnmerged bool   `json:"allowUnmerged,omitempty"`
		Force         bool   `json:"force,omitempty"`
	}) (result, error) {
		if input.WorkspaceID == "" {
			return result{}, fail(exitError, "Укажите точный workspaceId")
		}
		host, project, err := projectHost(ctx, env, input.Cwd, input.WorkspaceID)
		if err != nil {
			return result{}, err
		}
		return host.prepareSlot(input.WorkspaceID, slotOptions{project: project, branch: input.Branch, task: input.Task, from: input.From,
			dry: input.DryRun, offline: input.Offline, carry: input.Carry, allowUnmerged: input.AllowUnmerged, force: input.Force})
	})
	for _, tool := range []struct {
		name string
		both bool
	}{
		{"slot_sync", true},
		{"slot_sync_back", false},
	} {
		addMCPTool(server, env, tool.name, func(ctx context.Context, input struct {
			slotTarget
			Apply bool `json:"apply,omitempty"`
		}) (result, error) {
			if input.WorkspaceID == "" {
				return result{}, fail(exitError, "Укажите точный workspaceId")
			}
			host, project, err := projectHost(ctx, env, input.Cwd, input.WorkspaceID)
			if err != nil {
				return result{}, err
			}
			return syncCommand(host, input.WorkspaceID, project, tool.both, input.Apply)
		})
	}
}

func registerRegistryTools(server *mcp.Server, env environment) {
	addMCPTool(server, env, "aliases", func(_ context.Context, _ noInput) (result, error) {
		return sessionAliases(env, "", "", "")
	})
	addMCPTool(server, env, "kept_sessions", func(_ context.Context, _ noInput) (result, error) {
		return sessionKeep(paradev{env: env}, "", false, true)
	})
	addMCPTool(server, env, "session_forget", func(_ context.Context, input targetInput) (result, error) {
		if err := requireHistory(env, input); err != nil {
			return result{}, err
		}
		return sessionForget(env, input.SessionID, input.WorkspaceID)
	})
	addMCPTool(server, env, "session_keep", func(ctx context.Context, input struct {
		targetInput
		Remove bool `json:"remove,omitempty"`
	}) (result, error) {
		if err := requireHistory(env, input.targetInput); err != nil {
			return result{}, err
		}
		return sessionKeep(paradev{ctx: ctx, env: env}, input.SessionID, input.Remove, true)
	})
	addMCPTool(server, env, "session_alias", func(ctx context.Context, input struct {
		targetInput
		Alias  string `json:"alias"`
		Remove bool   `json:"remove,omitempty"`
	}) (result, error) {
		if input.Alias == "" {
			return result{}, fail(exitError, "Укажите алиас")
		}
		host, err := targetHost(ctx, env, input.targetInput)
		if err != nil {
			return result{}, err
		}
		session, err := host.lookupSession(input.SessionID, input.WorkspaceID)
		if err != nil {
			return result{}, err
		}
		if input.Remove {
			reg, _, err := loadRegistry(host.env)
			if err != nil {
				return result{}, err
			}
			if reg.Aliases[input.Alias] != session.terminal {
				return result{}, fail(exitCheck, "Алиас принадлежит другому терминалу или отсутствует")
			}
			return sessionAliases(host.env, "", "", input.Alias)
		}
		return sessionAliases(host.env, input.Alias, session.terminal, "")
	})
}
