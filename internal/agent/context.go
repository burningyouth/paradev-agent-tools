package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

type exitCode int

const (
	exitOK exitCode = iota
	exitError
	exitTimeout
	exitWaiting
	exitIdle
	exitAPIError
	exitGone
	exitNotAccepted
	exitLimit
	exitCheck
)

type agentError struct {
	code    exitCode
	message string
	details map[string]any
}

func (e *agentError) Error() string { return e.message }

func fail(code exitCode, format string, args ...any) error {
	return &agentError{code: code, message: fmt.Sprintf(format, args...)}
}

func codeOf(err error) exitCode {
	var failure *agentError
	if errors.As(err, &failure) {
		return failure.code
	}
	return exitError
}

type result struct {
	data          any
	text          string
	code          exitCode
	runtimeOutput map[string]any
}

type commandOptions struct {
	dir     string
	env     []string
	unset   []string
	input   string
	timeout time.Duration
	what    string
}

type commandOutput struct {
	status int
	stdout string
	stderr string
}

func (out commandOutput) diagnostic() string {
	if out.stderr != "" {
		return strings.TrimSpace(out.stderr)
	}
	return strings.TrimSpace(out.stdout)
}

type runner func(context.Context, string, []string, commandOptions) (commandOutput, error)

type environment struct {
	cwd       string
	home      string
	agentHome string
	get       func(string) string
	run       runner
}

func getEnvironment() (environment, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return environment{}, err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return environment{}, err
	}
	agentHome := os.Getenv("AGENT_CLI_HOME")
	if agentHome == "" {
		agentHome = filepath.Join(home, ".agent-cli")
	}
	return environment{cwd: cwd, home: home, agentHome: agentHome, get: os.Getenv, run: runCommand}, nil
}

func runCommand(ctx context.Context, command string, args []string, opts commandOptions) (commandOutput, error) {
	if opts.timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, opts.timeout)
		defer cancel()
	}
	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Dir = opts.dir
	if len(opts.env) != 0 || len(opts.unset) != 0 {
		current := slices.DeleteFunc(os.Environ(), func(entry string) bool {
			name, _, _ := strings.Cut(entry, "=")
			return slices.Contains(opts.unset, name)
		})
		cmd.Env = append(current, opts.env...)
	}
	cmd.Stdin = strings.NewReader(opts.input)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	out := commandOutput{stdout: stdout.String(), stderr: stderr.String()}
	if err == nil {
		return out, nil
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		out.status = 124
		out.stderr = fmt.Sprintf("не завершилась за %g с", opts.timeout.Seconds())
		return out, nil
	}
	if ctx.Err() != nil {
		return out, ctx.Err()
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		out.status = max(1, exitErr.ExitCode())
		return out, nil
	}
	if errors.Is(err, exec.ErrNotFound) || errors.Is(err, fs.ErrNotExist) {
		return out, fail(exitError, "Команда не найдена: %s", command)
	}
	return out, err
}

func mustRun(ctx context.Context, env environment, command string, args []string, opts commandOptions) (string, error) {
	out, err := env.run(ctx, command, args, opts)
	if err != nil {
		return "", err
	}
	if out.status == 0 {
		return out.stdout, nil
	}
	what := opts.what
	if what == "" {
		what = strings.Join(append([]string{command}, args...), " ")
	}
	tail := out.diagnostic()
	if tail != "" {
		tail = "\n" + tail
	}
	return "", fail(exitError, "%s: код %d%s", what, out.status, tail)
}

func readJSON(path string, into any) error {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err == nil {
		err = json.Unmarshal(data, into)
	}
	if err != nil {
		return fail(exitError, "Не читается JSON %s: %v", path, err)
	}
	return nil
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func canonicalPath(path string) string {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	if absolute, err := filepath.Abs(path); err == nil {
		return absolute
	}
	return filepath.Clean(path)
}

func containsPath(root, path string) bool {
	if root == "" || path == "" {
		return false
	}
	rel, err := filepath.Rel(canonicalPath(root), canonicalPath(path))
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func nonempty(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func choose(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}
