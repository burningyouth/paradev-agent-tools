package agent

import (
	"context"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type launchInput struct {
	Prompt     string `json:"prompt,omitempty"`
	PromptFile string `json:"promptFile,omitempty"`
	Branch     string `json:"branch,omitempty"`
	Task       string `json:"task,omitempty"`
	Agent      string `json:"agent,omitempty"`
	CLI        bool   `json:"cli,omitempty"`
	Model      string `json:"model,omitempty"`
	Mode       string `json:"mode,omitempty"`
	Effort     string `json:"effort,omitempty"`
	Alias      string `json:"alias,omitempty"`
}

func (input launchInput) options(host paradev, project, workspace string, required bool) (launchOptions, error) {
	if input.Prompt != "" && input.PromptFile != "" || required && input.Prompt == "" && input.PromptFile == "" {
		return launchOptions{}, fail(exitError, "Укажите одно поле: prompt или promptFile")
	}
	prompt, err := readInput(host.env, input.PromptFile, input.Prompt)
	if err != nil {
		return launchOptions{}, err
	}
	if (input.Prompt != "" || required) && strings.TrimSpace(prompt) == "" {
		return launchOptions{}, fail(exitError, "Задание пустое")
	}
	return launchOptions{project: project, workspace: workspace, prompt: prompt, branch: input.Branch,
		task: input.Task, agent: input.Agent, alias: input.Alias, model: input.Model, mode: input.Mode,
		effort: input.Effort, cli: input.CLI}, nil
}

func registerLaunchTools(server *mcp.Server, env environment) {
	addMCPTool(server, env, "session_create", func(ctx context.Context, input struct {
		slotTarget
		launchInput
	}) (result, error) {
		if input.WorkspaceID == "" {
			return result{}, fail(exitError, "Укажите точный workspaceId")
		}
		host, _, err := projectHost(ctx, env, input.Cwd, input.WorkspaceID)
		if err != nil {
			return result{}, err
		}
		opts, err := input.options(host, "", input.WorkspaceID, true)
		if err != nil {
			return result{}, err
		}
		return host.createSession(opts)
	})
	addMCPTool(server, env, "session_resume", func(ctx context.Context, input struct {
		scopedCwd
		launchInput
		WorkspaceID string `json:"workspaceId,omitempty"`
		SessionID   string `json:"sessionId,omitempty"`
		LastClosed  bool   `json:"lastClosed,omitempty"`
		AllOpen     bool   `json:"allOpen,omitempty"`
		DryRun      bool   `json:"dryRun,omitempty"`
		Offline     bool   `json:"offline,omitempty"`
	}) (result, error) {
		host, project, err := projectHost(ctx, env, input.Cwd, input.WorkspaceID)
		if err != nil {
			return result{}, err
		}
		opts, err := input.options(host, project, input.WorkspaceID, false)
		if err != nil {
			return result{}, err
		}
		return host.resumeSessions(input.SessionID, resumeOptions{launchOptions: opts, exact: true,
			lastClosed: input.LastClosed, allOpen: input.AllOpen, dry: input.DryRun, offline: input.Offline})
	})
	addMCPTool(server, env, "session_send", func(ctx context.Context, input struct {
		targetInput
		File    string `json:"file,omitempty"`
		Text    string `json:"text,omitempty"`
		Timeout int    `json:"timeout,omitempty"`
		Force   bool   `json:"force,omitempty"`
	}) (result, error) {
		host, err := targetHost(ctx, env, input.targetInput)
		if err != nil {
			return result{}, err
		}
		if (input.File == "") == (input.Text == "") {
			return result{}, fail(exitError, "Укажите одно поле: text или file")
		}
		text, err := readInput(host.env, input.File, input.Text)
		if err != nil {
			return result{}, err
		}
		if input.Timeout < 0 || input.Timeout > 1800 {
			return result{}, fail(exitError, "timeout должен быть от 1 до 1800")
		}
		timeout := input.Timeout
		if timeout == 0 {
			timeout = host.config.SendAcceptTimeoutSec
		}
		return host.sendSession(input.SessionID, input.WorkspaceID, text, time.Duration(timeout)*time.Second, input.Force)
	})
}
