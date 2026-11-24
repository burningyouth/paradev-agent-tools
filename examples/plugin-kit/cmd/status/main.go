package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

var version = "dev"

type statusInput struct {
	Cwd string `json:"cwd,omitempty" jsonschema:"Absolute path to inspect; defaults to the server working directory"`
}

type statusOutput struct {
	Cwd  string `json:"cwd"`
	OS   string `json:"os"`
	Arch string `json:"arch"`
}

func status(cwd string) (statusOutput, error) {
	if cwd == "" {
		var err error
		cwd, err = os.Getwd()
		if err != nil {
			return statusOutput{}, err
		}
	}
	if !filepath.IsAbs(cwd) {
		return statusOutput{}, errors.New("cwd must be an absolute path")
	}
	cwd = filepath.Clean(cwd)
	info, err := os.Stat(cwd)
	if err != nil {
		return statusOutput{}, err
	}
	if !info.IsDir() {
		return statusOutput{}, errors.New("cwd must be a directory")
	}
	return statusOutput{Cwd: cwd, OS: runtime.GOOS, Arch: runtime.GOARCH}, nil
}

func serve() error {
	server := mcp.NewServer(&mcp.Implementation{Name: "example-status", Version: version}, nil)
	mcp.AddTool(server, &mcp.Tool{
		Name:        "status",
		Description: "Report the local execution platform and verify a working directory.",
	}, func(_ context.Context, _ *mcp.CallToolRequest, input statusInput) (*mcp.CallToolResult, statusOutput, error) {
		result, err := status(input.Cwd)
		return nil, result, err
	})
	return server.Run(context.Background(), &mcp.StdioTransport{})
}

func run(args []string) error {
	if len(args) == 1 {
		switch args[0] {
		case "mcp":
			return serve()
		case "status":
			result, err := status("")
			if err != nil {
				return err
			}
			return json.NewEncoder(os.Stdout).Encode(result)
		case "--help", "-h":
			fmt.Println("Usage: launch status | mcp")
			return nil
		}
	}
	return errors.New("usage: launch status | mcp")
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
