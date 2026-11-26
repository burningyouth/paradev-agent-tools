package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	bundle "github.com/burningyouth/paradev-agent-tools"
	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func pluginVersion() string {
	data, _ := bundle.Files.ReadFile("mcp/plugin.json")
	var identity struct{ Version string }
	_ = json.Unmarshal(data, &identity)
	return choose(identity.Version, "dev")
}

type toolResponse struct {
	Code      exitCode       `json:"code"`
	Data      any            `json:"data"`
	Status    string         `json:"status,omitempty"`
	StartedAt string         `json:"startedAt,omitempty"`
	Next      string         `json:"next,omitempty"`
	Host      map[string]any `json:"host,omitempty"`
}

type mcpDefinition struct {
	Description string          `json:"description"`
	Schema      json.RawMessage `json:"inputSchema"`
}

var mcpDefinitions = func() map[string]mcpDefinition {
	raw, err := bundle.Files.ReadFile("mcp/tools.json")
	if err != nil {
		panic(err)
	}
	var definitions map[string]mcpDefinition
	if err := json.Unmarshal(raw, &definitions); err != nil {
		panic(err)
	}
	return definitions
}()

var hostUnavailable = regexp.MustCompile(`(?i)manifest is stale|host service manifest|(?:host|daemon).*not running|ECONNREFUSED`)

func mcpReply(payload any, failed bool) (*mcp.CallToolResult, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(encoded)}},
		StructuredContent: payload, IsError: failed}, nil
}

func addMCPTool[T any](server *mcp.Server, env environment, name string, call func(context.Context, T) (result, error)) {
	spec := mcpDefinitions[name]
	var schema jsonschema.Schema
	if err := json.Unmarshal(spec.Schema, &schema); err != nil {
		panic(err)
	}
	resolved, err := schema.Resolve(nil)
	if err != nil {
		panic(err)
	}
	server.AddTool(&mcp.Tool{Name: name, Description: spec.Description, InputSchema: spec.Schema},
		func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			started := time.Now().UTC()
			raw := req.Params.Arguments
			if len(raw) == 0 {
				raw = json.RawMessage("{}")
			}
			var object any
			if err := json.Unmarshal(raw, &object); err != nil {
				return mcpReply(map[string]string{"error": err.Error()}, true)
			}
			if err := resolved.Validate(object); err != nil {
				return mcpReply(map[string]string{"error": err.Error()}, true)
			}
			var input T
			if err := json.Unmarshal(raw, &input); err != nil {
				return mcpReply(map[string]string{"error": err.Error()}, true)
			}
			res, err := call(ctx, input)
			payload := toolResponse{Code: res.code, Data: res.data}
			if err != nil {
				payload.Code = codeOf(err)
				data := map[string]any{"error": err.Error(), "code": payload.Code}
				var failure *agentError
				if errors.As(err, &failure) {
					for key, value := range failure.details {
						data[key] = value
					}
				}
				if hostUnavailable.MatchString(err.Error()) {
					payload.Host = describeHostFailure(env, err)
					data["error"] = payload.Host["error"]
				}
				payload.Data = data
			}
			expectedState := false
			switch name {
			case "session_create":
				if payload.Code == exitOK {
					payload.Status = "created"
				}
			case "session_send":
				if payload.Code == exitNotAccepted {
					payload.Status, payload.StartedAt = "delivery-unknown", started.Format(time.RFC3339Nano)
					payload.Next = "Проверьте session_journal. Сверьте время и полный текст. Отсутствие записи пока не подтверждает недоставку."
					expectedState = true
				} else if payload.Code == exitOK {
					payload.Status = "accepted"
					if data, ok := payload.Data.(map[string]any); ok && data["queued"] == true {
						payload.Status = "queued"
					}
				}
			case "session_wait":
				expectedState = err == nil
			}
			return mcpReply(payload, payload.Code != exitOK && !expectedState)
		})
}

func describeHostFailure(env environment, err error) map[string]any {
	pids := hostPIDs(env)
	message := strings.ReplaceAll(strings.Split(err.Error(), "\nHint:")[0], " (recorded PID is dead)", "")
	for _, row := range pids {
		if row["process"] == "permission-denied" {
			message = "Paradev недоступен; права на проверку PID отсутствуют."
			break
		}
	}
	return map[string]any{"status": "unavailable", "pids": pids, "error": message}
}

type noInput struct{}

type statusInput struct {
	Cwd         string `json:"cwd" jsonschema:"Absolute path of the selected project or worktree."`
	WorkspaceID string `json:"workspaceId,omitempty" jsonschema:"Exact workspace ID from projects."`
}

type scopedCwd struct {
	Cwd string `json:"cwd" jsonschema:"Absolute path of the selected project or worktree."`
}

type historyInput struct {
	Project string `json:"project,omitempty"`
	Task    string `json:"task,omitempty"`
}

type hunksInput struct {
	scopedCwd
	Paths []string `json:"paths" jsonschema:"Paths with unstaged changes."`
}

type planInput struct {
	scopedCwd
	Plan     []map[string]any `json:"plan,omitempty" jsonschema:"Exact commits to preview or apply."`
	PlanFile string           `json:"planFile,omitempty" jsonschema:"File path, relative to cwd when not absolute."`
	Apply    bool             `json:"apply,omitempty" jsonschema:"Apply the reviewed plan. Defaults to preview."`
}

type skillInput struct {
	Skill string `json:"skill" jsonschema:"Name from skills_list."`
}

type targetInput struct {
	WorkspaceID string `json:"workspaceId" jsonschema:"Exact workspace ID from projects."`
	SessionID   string `json:"sessionId" jsonschema:"Full and current session ID."`
	Cwd         string `json:"cwd,omitempty" jsonschema:"Absolute path of the selected project or worktree."`
}

type journalInput struct {
	targetInput
	Limit int    `json:"limit,omitempty"`
	After string `json:"after,omitempty"`
}

type waitInput struct {
	targetInput
	Timeout  int    `json:"timeout,omitempty"`
	Interval int    `json:"interval,omitempty"`
	After    string `json:"after,omitempty"`
	Marker   string `json:"marker,omitempty"`
}

func targetHost(ctx context.Context, env environment, target targetInput) (paradev, error) {
	if target.SessionID == "" || target.WorkspaceID == "" {
		return paradev{}, fail(exitError, "Укажите точные workspaceId и sessionId")
	}
	if target.Cwd != "" {
		var err error
		env, err = scopedEnv(env, target.Cwd)
		if err != nil {
			return paradev{}, err
		}
	}
	return mcpHost(ctx, env)
}

func scopedEnv(env environment, path string) (environment, error) {
	info, err := os.Stat(path)
	if !filepath.IsAbs(path) || err != nil || !info.IsDir() {
		return environment{}, fail(exitError, "Укажите существующий абсолютный путь проекта из projects или из рабочего окна клиента.")
	}
	env.cwd = path
	baseRun := env.run
	env.run = func(ctx context.Context, command string, args []string, opts commandOptions) (commandOutput, error) {
		opts.unset = append(opts.unset, "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX")
		return baseRun(ctx, command, args, opts)
	}
	return env, nil
}

func serveMCP(ctx context.Context, env environment) error {
	return nativeMCP(env).Run(ctx, &mcp.StdioTransport{})
}

func mcpHost(ctx context.Context, env environment) (paradev, error) {
	config, err := loadConfig(env)
	return paradev{ctx: ctx, env: env, config: config, timeout: 30 * time.Second}, err
}

func nativeMCP(env environment) *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{Name: productName, Version: pluginVersion()}, &mcp.ServerOptions{
		Instructions: "Use projects to find local paths and IDs. Pass the absolute selected project cwd to project tools. Keep exact workspaceId, latest sessionId and send anchor. After uncertain delivery inspect session_journal before retry. Idle means a turn ended. A queued close requires the receipt in your answer and later close_result. Review cleanup and commit plans before applying. For requests to update Paradev Agent Tools, use skill_read with paradev-agent-update and identify the running source with plugin_source.",
	})
	executable, _ := os.Executable()
	loaded := loadedReleaseSource(env, executable)
	addMCPTool(server, env, "plugin_source", func(ctx context.Context, input struct {
		Check bool `json:"check"`
	}) (result, error) {
		source := loaded
		if source.Source == "zip" {
			if state, err := currentRelease(source.Root); err != nil {
				source.CheckError = err.Error()
			} else {
				source.Active, source.Previous, source.CheckError = state.Version, state.Previous, ""
			}
		}
		if input.Check && source.CheckError == "" {
			source = checkedReleaseSource(ctx, source)
		}
		return result{data: source}, nil
	})
	addMCPTool(server, env, "projects", func(ctx context.Context, _ noInput) (result, error) {
		host, err := mcpHost(ctx, env)
		if err != nil {
			return result{}, err
		}
		return projectsResult(host)
	})
	addMCPTool(server, env, "status", func(ctx context.Context, input statusInput) (result, error) {
		scoped, err := scopedEnv(env, input.Cwd)
		if err != nil {
			return result{}, err
		}
		host, err := mcpHost(ctx, scoped)
		if err != nil {
			return result{}, err
		}
		return statusResult(host, input.WorkspaceID, true)
	})
	addMCPTool(server, env, "diagnose", func(ctx context.Context, _ noInput) (result, error) {
		return diagnose(paradev{ctx: ctx, env: env, timeout: 30 * time.Second})
	})
	addMCPTool(server, env, "session_list", func(ctx context.Context, _ noInput) (result, error) {
		host, err := mcpHost(ctx, env)
		if err != nil {
			return result{}, err
		}
		return listSessionsResult(host)
	})
	addMCPTool(server, env, "session_history", func(_ context.Context, input historyInput) (result, error) {
		return sessionLog(env, input.Project, input.Task)
	})
	addMCPTool(server, env, "session_journal", func(ctx context.Context, input journalInput) (result, error) {
		p, err := targetHost(ctx, env, input.targetInput)
		if err != nil {
			return result{}, err
		}
		return sessionJournal(p, input.SessionID, input.WorkspaceID, input.After, input.Limit)
	})
	addMCPTool(server, env, "session_last", func(ctx context.Context, input targetInput) (result, error) {
		p, err := targetHost(ctx, env, input)
		if err != nil {
			return result{}, err
		}
		return sessionLast(p, input.SessionID, input.WorkspaceID)
	})
	addMCPTool(server, env, "session_wait", func(ctx context.Context, input waitInput) (result, error) {
		p, err := targetHost(ctx, env, input.targetInput)
		if err != nil {
			return result{}, err
		}
		if input.Timeout < 0 || input.Timeout > 1800 || input.Interval < 0 || input.Interval > 30 {
			return result{}, fail(exitError, "Недопустимый timeout или interval")
		}
		timeout, interval := input.Timeout, input.Interval
		if timeout == 0 {
			timeout = 15
		}
		if interval == 0 {
			interval = 3
		}
		return sessionWait(p, waitOptions{ref: input.SessionID, workspace: input.WorkspaceID, after: input.After, marker: input.Marker,
			timeout: time.Duration(timeout) * time.Second, interval: time.Duration(min(interval, timeout)) * time.Second})
	})
	addMCPTool(server, env, "close_result", func(_ context.Context, input struct {
		Result string `json:"result"`
	}) (result, error) {
		return closeResult(input.Result)
	})
	addMCPTool(server, env, "skills_list", func(_ context.Context, _ noInput) (result, error) {
		return skillsResult(env, []string{"list"})
	})
	addMCPTool(server, env, "skill_read", func(_ context.Context, input skillInput) (result, error) {
		path, content, err := skillLocation(env, input.Skill)
		return result{data: map[string]string{"path": path, "instructions": content}}, err
	})
	addMCPTool(server, env, "commit_hunks", func(ctx context.Context, input hunksInput) (result, error) {
		scoped, err := scopedEnv(env, input.Cwd)
		if err != nil {
			return result{}, err
		}
		return listHunks(gitClient{ctx: ctx, env: scoped, cwd: scoped.cwd}, input.Paths)
	})
	addMCPTool(server, env, "commit_plan", func(ctx context.Context, input planInput) (result, error) {
		scoped, err := scopedEnv(env, input.Cwd)
		if err != nil {
			return result{}, err
		}
		file, cleanup, err := planPath(scoped.cwd, input)
		if err != nil {
			return result{}, err
		}
		defer cleanup()
		return commitPlan(gitClient{ctx: ctx, env: scoped, cwd: scoped.cwd}, file, input.Apply)
	})
	addMCPTool(server, env, "slot_list", func(ctx context.Context, input scopedCwd) (result, error) {
		scoped, err := scopedEnv(env, input.Cwd)
		if err != nil {
			return result{}, err
		}
		host, project, err := selectedProject(ctx, scoped)
		if err != nil {
			return result{}, err
		}
		return slotList(host, project)
	})
	registerRegistryTools(server, env)
	registerSlotTools(server, env)
	registerLaunchTools(server, env)
	registerCloseTools(server, env)
	registerExecutorTools(server, env)
	return server
}

func planPath(cwd string, input planInput) (string, func(), error) {
	if (input.Plan != nil) == (input.PlanFile != "") {
		return "", nil, fail(exitError, "Укажите одно поле: plan или planFile")
	}
	if input.PlanFile != "" {
		path := input.PlanFile
		if !filepath.IsAbs(path) {
			path = filepath.Join(cwd, path)
		}
		return path, func() {}, nil
	}
	file, err := os.CreateTemp("", "agent-plan-*.json")
	if err != nil {
		return "", nil, err
	}
	cleanup := func() { os.Remove(file.Name()) }
	if err := errors.Join(json.NewEncoder(file).Encode(input.Plan), file.Close()); err != nil {
		cleanup()
		return "", nil, err
	}
	return file.Name(), cleanup, nil
}
