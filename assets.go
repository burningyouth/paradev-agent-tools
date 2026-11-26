package agentcli

import "embed"

// Files contains the workflows, router template and plugin identity embedded in the Go binary.
//
//go:embed skills/*/SKILL.md docs/*.md README.md AGENTS.md examples/agent-cli/SKILL.md mcp/plugin.json mcp/tools.json mcp/managed/*
var Files embed.FS
