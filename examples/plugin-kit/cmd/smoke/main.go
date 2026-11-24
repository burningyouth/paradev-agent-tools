// Command smoke verifies an extracted example-status package as an MCP client.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type status struct {
	Cwd  string `json:"cwd"`
	OS   string `json:"os"`
	Arch string `json:"arch"`
}

func verify(launcher string) error {
	for _, name := range []string{"node", "npm", "go"} {
		if path, err := exec.LookPath(name); err == nil {
			return fmt.Errorf("test environment has %s at %s", name, path)
		}
	}

	manifest, err := os.ReadFile(filepath.Join(filepath.Dir(launcher), "plugin.json"))
	if err != nil {
		return err
	}
	var plugin struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal(manifest, &plugin); err != nil {
		return err
	}
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	expect := status{cwd, runtime.GOOS, runtime.GOARCH}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cli, err := exec.CommandContext(ctx, launcher, "status").Output()
	if err != nil {
		return fmt.Errorf("CLI status: %w", err)
	}
	var cliStatus status
	if err := json.Unmarshal(cli, &cliStatus); err != nil || cliStatus != expect {
		return fmt.Errorf("CLI status: got %s, want %+v", cli, expect)
	}

	client := mcp.NewClient(&mcp.Implementation{Name: "package-smoke", Version: "1.0.0"}, nil)
	command := exec.CommandContext(ctx, launcher, "mcp")
	command.Stderr = os.Stderr
	session, err := client.Connect(ctx, &mcp.CommandTransport{Command: command}, nil)
	if err != nil {
		return fmt.Errorf("MCP initialize: %w", err)
	}
	defer session.Close()
	if info := session.InitializeResult().ServerInfo; info.Name != plugin.Name || info.Version != plugin.Version {
		return fmt.Errorf("unexpected MCP server: %+v", info)
	}
	tools, err := session.ListTools(ctx, nil)
	if err != nil {
		return fmt.Errorf("MCP tools/list: %w", err)
	}
	if len(tools.Tools) != 1 || tools.Tools[0].Name != "status" {
		return fmt.Errorf("unexpected MCP tools: %+v", tools.Tools)
	}
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "status", Arguments: map[string]string{"cwd": cwd}})
	if err != nil {
		return fmt.Errorf("MCP status: %w", err)
	}
	data, err := json.Marshal(result.StructuredContent)
	if err != nil {
		return err
	}
	var mcpStatus status
	if err := json.Unmarshal(data, &mcpStatus); err != nil || result.IsError || mcpStatus != expect {
		return fmt.Errorf("MCP status: got %s, want %+v", data, expect)
	}
	fmt.Printf("CLI and MCP status passed on %s/%s without node, npm or go in PATH\n", expect.OS, expect.Arch)
	return nil
}

func main() {
	if len(os.Args) != 2 || !filepath.IsAbs(os.Args[1]) {
		fmt.Fprintln(os.Stderr, "usage: smoke /absolute/path/to/launch")
		os.Exit(2)
	}
	if err := verify(os.Args[1]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
