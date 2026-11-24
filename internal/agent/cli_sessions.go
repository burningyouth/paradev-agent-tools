package agent

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"strings"
)

func dispatchSessionLifecycle(ctx context.Context, env environment, command string, args []string, opts options) (result, error) {
	if len(args) > 1 || command == "create" && len(args) != 0 {
		return result{}, fail(exitError, "Лишние аргументы. Справка: agent %s --help", command)
	}
	ref := ""
	if len(args) == 1 {
		ref = args[0]
	}
	cfg, err := loadConfig(env)
	if err != nil {
		return result{}, err
	}
	host := paradev{ctx: ctx, env: env, config: cfg}
	if command == "send" {
		message, err := readInput(env, opts.flags["file"], opts.flags["text"])
		if err != nil {
			return result{}, err
		}
		timeout, err := secondsOption("timeout", opts.flags["timeout"], cfg.SendAcceptTimeoutSec)
		if err != nil {
			return result{}, err
		}
		return host.sendSession(ref, "", message, timeout, opts.flags["force"] == "true")
	}
	start := launchOptions{
		workspace: opts.flags["workspace"], project: opts.flags["project"], branch: opts.flags["branch"], task: opts.flags["task"],
		from: opts.flags["from"], agent: opts.flags["agent"], alias: opts.flags["alias"], model: opts.flags["model"],
		mode: opts.flags["mode"], effort: opts.flags["effort"], cli: opts.flags["cli"] == "true", allowCreate: opts.flags["allow-create"] == "true",
	}
	start.prompt, err = readInput(env, opts.flags["prompt-file"], "")
	if err != nil {
		return result{}, err
	}
	if command == "resume" {
		return host.resumeSessions(ref, resumeOptions{launchOptions: start,
			dry: opts.flags["dry-run"] == "true", offline: opts.flags["offline"] == "true",
			lastClosed: opts.flags["last-closed"] == "true", allOpen: opts.flags["all-open"] == "true"})
	}
	output, err := host.createSession(start)
	if err != nil || output.code != exitWaiting || opts.flags["json"] == "true" || !tty(os.Stdin) || !tty(os.Stdout) {
		return output, err
	}
	body, _ := output.data.(map[string]any)
	if body["status"] != "confirmation_required" {
		return output, nil
	}
	fmt.Fprint(os.Stdout, body["question"], " [да/НЕТ] ")
	answer, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	switch strings.ToLower(strings.TrimSpace(answer)) {
	case "да", "yes", "y":
		start.allowCreate = true
		return host.createSession(start)
	default:
		return result{data: map[string]string{"status": "cancelled"}, text: "Запуск отменён."}, nil
	}
}

func tty(file *os.File) bool {
	info, err := file.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}
