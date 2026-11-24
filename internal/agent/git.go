package agent

import (
	"context"
	"strings"
)

type gitClient struct {
	ctx   context.Context
	env   environment
	cwd   string
	index string
}

func (g gitClient) options(args []string, input string) commandOptions {
	opts := commandOptions{dir: g.cwd, what: "git " + args[0], input: input}
	if g.index != "" {
		opts.env = []string{"GIT_INDEX_FILE=" + g.index}
	}
	return opts
}

func (g gitClient) git(args ...string) (string, error) {
	return g.gitInput("", args...)
}

func (g gitClient) gitInput(input string, args ...string) (string, error) {
	return mustRun(g.ctx, g.env, "git", args, g.options(args, input))
}

func (g gitClient) raw(args ...string) (commandOutput, error) {
	return g.env.run(g.ctx, "git", args, g.options(args, ""))
}

func (g gitClient) requireRoot() (string, error) {
	out, err := g.raw("rev-parse", "--show-toplevel")
	if err != nil {
		return "", err
	}
	if out.status != 0 {
		return "", fail(exitError, "%s — не git-репозиторий", g.cwd)
	}
	return strings.TrimSpace(out.stdout), nil
}

func (g gitClient) head() (string, error) {
	out, err := g.raw("rev-parse", "--verify", "--quiet", "HEAD")
	if err != nil || out.status != 0 {
		return "", err
	}
	return strings.TrimSpace(out.stdout), nil
}

func (g gitClient) staged(base string) ([]string, error) {
	out, err := g.git("diff-index", "--cached", "--name-only", "-z", "--no-renames", base)
	return nulRecords(out), err
}

func nulRecords(data string) []string {
	if data == "" {
		return []string{}
	}
	return strings.Split(strings.TrimSuffix(data, "\x00"), "\x00")
}

func (g gitClient) unstagedPatch(path string) (string, error) {
	return g.git("diff", "--no-renames", "--", path)
}

func (g gitClient) stagedPatch(base, path string) (string, error) {
	return g.git("diff-index", "--cached", "-p", "--no-renames", base, "--", path)
}
