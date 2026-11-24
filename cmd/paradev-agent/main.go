package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/burningyouth/paradev-agent-tools/internal/agent"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if len(os.Args) > 1 && os.Args[1] == "install-client" {
		os.Exit(agent.ClientInstall(ctx, os.Args[2:], os.Stdin, os.Stdout, os.Stderr))
	}
	os.Exit(agent.Main(ctx, os.Args[1:], os.Stdout, os.Stderr))
}
