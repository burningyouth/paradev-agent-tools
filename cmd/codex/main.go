// Command codex forwards Codex stdio and relays the slot prompt into the current chat turn.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
)

const slotPromptLabel = "agent-cli: проверка рабочего слота"

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	binary := os.Getenv("AGENT_REAL_CODEX")
	current, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	actual, resolveErr := filepath.EvalSymlinks(binary)
	self, selfErr := filepath.EvalSymlinks(current)
	if os.Getenv("AGENT_CLI_CODEX_RELAY") != "" || !filepath.IsAbs(binary) ||
		resolveErr != nil || selfErr != nil || actual == self {
		fmt.Fprintln(os.Stderr, "agent-cli relay: AGENT_REAL_CODEX must point to the absolute path of the real Codex binary")
		return 1
	}
	relay := os.Getenv("SUPERSET_WORKSPACE_ID") != "" && os.Getenv("SUPERSET_TERMINAL_ID") != "" &&
		slices.Contains(args, "app-server") && slices.Contains(args, "--stdio")
	if !relay {
		env := append(os.Environ(), "AGENT_CLI_CODEX_RELAY=passthrough")
		if err := syscall.Exec(binary, append([]string{binary}, args...), env); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		return 0
	}

	cmd := exec.Command(binary, args...)
	cmd.Env = append(os.Environ(), "AGENT_CLI_CODEX_RELAY=chat")
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	done := make(chan struct{})
	defer func() { signal.Stop(signals); close(done) }()
	go func() {
		for {
			select {
			case sig := <-signals:
				_ = cmd.Process.Signal(sig)
			case <-done:
				return
			}
		}
	}()
	if err := forward(os.Stdout, stdout); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if err := cmd.Wait(); err != nil {
		var failed *exec.ExitError
		if errors.As(err, &failed) {
			return max(1, failed.ExitCode())
		}
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

func forward(out io.Writer, input io.Reader) error {
	reader := bufio.NewReader(input)
	encoder := json.NewEncoder(out)
	encoder.SetEscapeHTML(false)
	for {
		line, err := reader.ReadString('\n')
		if line != "" {
			line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
			if _, writeErr := fmt.Fprintln(out, line); writeErr != nil {
				return writeErr
			}
			if warning := slotWarning(line); warning != nil {
				if err := encoder.Encode(warning); err != nil {
					return err
				}
			}
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func slotWarning(line string) map[string]any {
	var event struct {
		Method string
		Params struct {
			ThreadID string
			TurnID   string
			Run      struct {
				EventName, Source, StatusMessage, Status string
				Entries                                  []struct{ Kind, Text string }
			}
		}
	}
	if json.Unmarshal([]byte(line), &event) != nil || event.Method != "hook/completed" ||
		event.Params.ThreadID == "" || event.Params.TurnID == "" {
		return nil
	}
	run := event.Params.Run
	if run.EventName != "userPromptSubmit" || run.Source != "user" || run.StatusMessage != slotPromptLabel || run.Status != "blocked" {
		return nil
	}
	for _, entry := range run.Entries {
		if entry.Kind != "feedback" {
			continue
		}
		if entry.Text == "" {
			return nil
		}
		return map[string]any{
			"method": "warning",
			"params": map[string]string{"threadId": event.Params.ThreadID, "turnId": event.Params.TurnID, "message": entry.Text},
		}
	}
	return nil
}
