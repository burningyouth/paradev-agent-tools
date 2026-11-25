package agent

import (
	"context"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func registerCloseTools(server *mcp.Server, env environment) {
	addMCPTool(server, env, "chat_title", func(ctx context.Context, input struct {
		Cwd         string `json:"cwd"`
		WorkspaceID string `json:"workspaceId"`
		SessionID   string `json:"sessionId"`
		Title       string `json:"title"`
	}) (result, error) {
		host, _, err := projectHost(ctx, env, input.Cwd, input.WorkspaceID)
		if err != nil {
			return result{}, err
		}
		return host.titleChat(input.WorkspaceID, input.SessionID, input.Title)
	})
	addMCPTool(server, env, "task_complete", func(ctx context.Context, input struct {
		Cwd         string `json:"cwd"`
		WorkspaceID string `json:"workspaceId"`
		SessionID   string `json:"sessionId"`
		DryRun      bool   `json:"dryRun,omitempty"`
	}) (result, error) {
		host, _, err := projectHost(ctx, env, input.Cwd, input.WorkspaceID)
		if err != nil {
			return result{}, err
		}
		return host.requestTaskCompletion(input.WorkspaceID, input.SessionID, input.DryRun)
	})
	addMCPTool(server, env, "cleanup", func(ctx context.Context, input struct {
		Cwd   string `json:"cwd"`
		Idle  string `json:"idle,omitempty"`
		Done  string `json:"done,omitempty"`
		Apply bool   `json:"apply,omitempty"`
	}) (result, error) {
		host, project, err := projectHost(ctx, env, input.Cwd, "")
		if err != nil {
			return result{}, err
		}
		if strings.Contains(project, ",") {
			return result{}, fail(exitCheck, "Имя проекта содержит запятую")
		}
		return host.gc(gcOptions{project: project, idle: input.Idle, done: input.Done, apply: input.Apply})
	})
	addMCPTool(server, env, "session_close", func(ctx context.Context, input struct {
		slotTarget
		SessionID   string `json:"sessionId,omitempty"`
		Note        string `json:"note,omitempty"`
		SummaryFile string `json:"summaryFile,omitempty"`
		Reason      string `json:"reason,omitempty"`
		DryRun      bool   `json:"dryRun,omitempty"`
		Force       bool   `json:"force,omitempty"`
		SessionOnly bool   `json:"sessionOnly,omitempty"` // Compatibility with older MCP clients.
		AfterReply  bool   `json:"afterReply,omitempty"`
	}) (result, error) {
		if input.WorkspaceID == "" {
			return result{}, fail(exitError, "Укажите точный workspaceId")
		}
		host, project, err := projectHost(ctx, env, input.Cwd, input.WorkspaceID)
		if err != nil {
			return result{}, err
		}
		return host.closeCommand(input.SessionID, closeOptions{
			Workspace: input.WorkspaceID, Project: project, Note: input.Note,
			SummaryFile: input.SummaryFile, Reason: input.Reason, Dry: input.DryRun,
			Force: input.Force, AfterReply: input.AfterReply, exact: true,
		})
	})
}
