package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
)

type options struct {
	positionals []string
	flags       map[string]string
}

var flagTypes = map[string]bool{
	"json": false, "release-slot": false, "session-only": false, "after-reply": false,
	"summary-file": true, "result": true, "help": false, "force": false,
	"dry-run": false, "apply": false, "carry": false, "offline": false,
	"allow-unmerged": false, "allow-create": false, "workspace": true, "agent": true,
	"prompt-file": true, "model": true, "effort": true, "cli": false, "mode": true,
	"alias": true, "file": true, "text": true, "marker": true, "after": true,
	"timeout": true, "interval": true, "note": true, "rm": true, "idle": true,
	"recent": true, "keep-pen": false, "done": true, "project": true, "branch": true,
	"task": true, "title": true, "reason": true, "last-closed": false, "all-open": false,
	"from": true, "base": true, "name": true, "directory": true,
}

func parseOptions(args []string) (options, error) {
	opts := options{flags: make(map[string]string)}
	for i := 0; i < len(args); i++ {
		token := args[i]
		if token == "--" {
			opts.positionals = append(opts.positionals, args[i+1:]...)
			break
		}
		if token == "-h" {
			token = "--help"
		}
		if token == "-" || !strings.HasPrefix(token, "-") {
			opts.positionals = append(opts.positionals, token)
			continue
		}
		key, value, inline := strings.Cut(strings.TrimPrefix(token, "--"), "=")
		takesValue, exists := flagTypes[key]
		if !exists {
			return opts, fail(exitError, "Неизвестный флаг %s", token)
		}
		if takesValue && !inline {
			if i+1 >= len(args) || strings.HasPrefix(args[i+1], "-") {
				return opts, fail(exitError, "Укажите значение --%s", key)
			}
			i++
			value = args[i]
		}
		if !takesValue {
			if inline {
				return opts, fail(exitError, "Флаг --%s не принимает значение", key)
			}
			value = "true"
		}
		opts.flags[key] = value
	}
	return opts, nil
}

const help = `paradev-agent — задачи и сессии в Paradev

  paradev-agent status [--json]               текущий workspace и состояние Git
  paradev-agent slot take --project P --branch B   выделить подготовленный слот
  paradev-agent create --workspace W --prompt-file F   запустить агента
  paradev-agent send / wait / last            передать работу и получить результат
  paradev-agent close [алиас|UUID]             сохранить сессию и освободить слот
  paradev-agent close --result F               прочитать результат фонового закрытия
  paradev-agent task complete SESSION --workspace W   завершить задачу и оставить чат открытым
  paradev-agent resume [алиас|UUID]           продолжить сохранённую сессию
  paradev-agent ls [--json]                   живые Codex/Claude сессии
  paradev-agent log [--project P] [--task KEY] локальная история сессий
  paradev-agent gc [--project P] [--apply]    план уборки или применение
  paradev-agent activity FILE...              активные сессии по файлам
  paradev-agent commit <план.json> [--apply]   по умолчанию сухой прогон на временном индексе
  paradev-agent commit hunks <путь...>         пронумерованные ханки для поля include
  paradev-agent skills list                   встроенные инструкции
  paradev-agent install [--dry-run]           установить ссылку на команду
  paradev-agent hook install --agent codex|claude    установить хуки
  paradev-agent doctor                        проверка установки
  paradev-agent mcp                           MCP по stdio

  Общие флаги: --json, --help.
  Рабочие процессы: paradev-agent --help sessions|slots|orchestration|commit-plan|cleanup|setup.
`

var commandHelp = map[string]string{
	"install": "install [--directory D] [--dry-run]\ninstall --agent codex|claude|all [--directory D] [--dry-run] [--force]",
	"skills":  "skills list | path ИМЯ | install --agent codex|claude|all [--dry-run] [--force]",
	"send":    "send ТЕРМИНАЛ|АЛИАС (--file F | --text T) [--timeout 20] [--force]",
	"wait":    "wait [ТЕРМИНАЛ|АЛИАС] [--after ЯКОРЬ] [--marker ИМЯ] [--timeout 1800] [--interval 5]",
	"last":    "last [ТЕРМИНАЛ|АЛИАС]",
	"create":  "create --workspace W --prompt-file F [--branch B] [--task KEY] [--agent codex|claude] [--cli] [--model M] [--mode M] [--effort E] [--alias A]\ncreate --project P --branch B --prompt-file F [--from BASE] [--allow-create]",
	"resume":  "resume [UUID|АЛИАС | --task KEY | --last-closed | --all-open] [--project P] [--workspace W] [--branch B] [--prompt-file F] [--dry-run] [--offline]",
	"close":   "close [UUID|АЛИАС] [--workspace W] [--session-only] [--after-reply] [--note T] [--summary-file F] [--reason T] [--dry-run]\nclose --result F",
	"alias":   "alias [ИМЯ ТЕРМИНАЛ] | alias --rm ИМЯ",
	"keep":    "keep [ТЕРМИНАЛ|АЛИАС|UUID] | keep --rm ТЕРМИНАЛ|АЛИАС|UUID",
	"forget":  "forget UUID|АЛИАС",
	"hook":    "hook install --agent codex|claude [--dry-run]\nhook session-start|user-prompt-submit|stop|session-end --agent codex|claude",
	"slot":    "slot ls [--project P]\nslot title --title T [--workspace W SESSION]\nslot prepare СЛОТ --branch B [--task T] [--from BASE] [--offline] [--carry] [--allow-unmerged] [--dry-run] [--project P] [--force]\nslot create --project P [--name slot-N] [--base BASE] [--offline] [--dry-run]\nslot take --project P --branch B [--task T] [--from BASE] [--offline] [--dry-run] [--carry] [--allow-unmerged]\nslot release [СЛОТ] [--dry-run]\nslot sync [СЛОТ] [--apply]\nslot sync-back [СЛОТ] [--apply]",
}

func helpFor(args []string) (string, error) {
	if len(args) == 0 {
		return help, nil
	}
	if len(args) == 1 && workflowTopics[args[0]] != "" {
		content, err := skillContent(workflowTopics[args[0]])
		return skillFrontmatter.ReplaceAllString(content, ""), err
	}
	command := args[0]
	if command == "sess" {
		if len(args) == 1 {
			return "paradev-agent sess ls|create|send|wait|last|close|finish|resume|alias|forget|keep|gc|log\n", nil
		}
		args = args[1:]
		command = args[0]
	}
	if command == "finish" {
		command = "close"
	}
	if reference := commandHelp[command]; reference != "" {
		lines := strings.Split(reference, "\n")
		if len(args) > 1 {
			for _, line := range lines {
				if strings.HasPrefix(line, command+" "+args[1]+" ") {
					return "paradev-agent " + line + " [--json]\n", nil
				}
			}
		}
		return "paradev-agent " + strings.Join(lines, "\nparadev-agent ") + "\nОбщие флаги: --json, --help.\n", nil
	}
	for line := range strings.SplitSeq(help, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "paradev-agent "+command+" ") {
			return strings.TrimSpace(line) + "\n", nil
		}
	}
	return "", fail(exitError, "Неизвестная команда или тема справки «%s». paradev-agent --help", command)
}

func Main(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	opts, err := parseOptions(args)
	if err != nil {
		fmt.Fprintf(stderr, "Ошибка: %v\n", err)
		return int(codeOf(err))
	}
	if len(opts.positionals) == 0 || opts.flags["help"] == "true" {
		content, err := helpFor(opts.positionals)
		if err != nil {
			fmt.Fprintf(stderr, "Ошибка: %v\n", err)
			return int(codeOf(err))
		}
		fmt.Fprint(stdout, content)
		return 0
	}
	env, err := getEnvironment()
	if err == nil && len(opts.positionals) == 1 && opts.positionals[0] == "mcp" {
		if err := serveMCP(ctx, env); err != nil {
			fmt.Fprintf(stderr, "Ошибка MCP: %v\n", err)
			return int(codeOf(err))
		}
		return 0
	}
	var output result
	if err == nil {
		output, err = dispatch(ctx, env, opts)
	}
	if err != nil {
		code := codeOf(err)
		if opts.flags["json"] == "true" {
			writeCLIJSON(stdout, map[string]any{"error": err.Error(), "code": code})
		} else {
			fmt.Fprintf(stderr, "Ошибка: %v\n", err)
		}
		return int(code)
	}
	if opts.flags["json"] == "true" {
		if err := writeCLIJSON(stdout, output.data); err != nil {
			fmt.Fprintf(stderr, "Ошибка: %v\n", err)
			return int(exitError)
		}
	} else if opts.positionals[0] == "hook" && opts.positionals[1] != "install" {
		data := output.runtimeOutput
		if data == nil {
			data = map[string]any{}
		}
		_ = json.NewEncoder(stdout).Encode(data)
	} else if strings.HasSuffix(output.text, "\n") {
		fmt.Fprint(stdout, output.text)
	} else {
		fmt.Fprintln(stdout, output.text)
	}
	return int(output.code)
}

func writeCLIJSON(w io.Writer, value any) error {
	encoder := json.NewEncoder(w)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

func dispatch(ctx context.Context, env environment, opts options) (result, error) {
	command, args := opts.positionals[0], opts.positionals[1:]
	switch command {
	case "skills":
		if len(args) == 1 && args[0] == "install" {
			return installRouter(env, opts)
		}
		return skillsResult(env, args)
	case "install":
		if len(args) != 0 {
			return result{}, fail(exitError, "Нужно: paradev-agent install [--directory D] [--dry-run] [--json]")
		}
		if opts.flags["agent"] != "" {
			return installRouter(env, opts)
		}
		return installBinary(env, opts)
	case "hook":
		if len(args) != 1 {
			return result{}, fail(exitError, "Справка: paradev-agent hook --help")
		}
		if args[0] == "install" {
			return installHooks(env, opts.flags["agent"], opts.flags["dry-run"] == "true")
		}
		var input hookInput
		if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
			return result{}, fail(exitError, "Hook ожидает JSON runtime на stdin")
		}
		config, err := loadConfig(env)
		if err != nil {
			return result{}, err
		}
		return (paradev{ctx: ctx, env: env, config: config}).sessionHook(args[0], opts.flags["agent"], input)
	case "doctor", "diagnose":
		if len(args) != 0 {
			return result{}, fail(exitError, "Нужно: paradev-agent doctor [--json]")
		}
		if command == "diagnose" {
			return diagnose(paradev{ctx: ctx, env: env})
		}
		return doctor(ctx, env), nil
	case "status", "ls":
		if len(args) != 0 {
			return result{}, fail(exitError, "Нужно: paradev-agent %s [--json]", command)
		}
		config, err := loadConfig(env)
		if err != nil {
			return result{}, err
		}
		host := paradev{ctx: ctx, env: env, config: config}
		if command == "ls" {
			return listSessionsResult(host)
		}
		return statusResult(host, "", false)
	case "slot", "activity":
		config, err := loadConfig(env)
		if err != nil {
			return result{}, err
		}
		host := paradev{ctx: ctx, env: env, config: config}
		if command == "activity" {
			return fileActivity(host, args, opts.flags["recent"])
		}
		if len(args) > 0 {
			slotOpts := slotOptions{
				project: opts.flags["project"], branch: opts.flags["branch"], task: opts.flags["task"],
				from: opts.flags["from"], name: opts.flags["name"], base: opts.flags["base"],
				dry: opts.flags["dry-run"] == "true", offline: opts.flags["offline"] == "true",
				carry: opts.flags["carry"] == "true", allowUnmerged: opts.flags["allow-unmerged"] == "true",
				force: opts.flags["force"] == "true",
			}
			switch args[0] {
			case "ls":
				return slotList(host, opts.flags["project"])
			case "title":
				sessionID := ""
				if len(args) == 2 {
					sessionID = args[1]
				}
				if len(args) > 2 || (sessionID != "") != (opts.flags["workspace"] != "") {
					return result{}, fail(exitError, "Нужно: paradev-agent slot title --title T [--workspace W SESSION]")
				}
				return host.titleChat(opts.flags["workspace"], sessionID, opts.flags["title"])
			case "create":
				return host.createSlot(slotOpts)
			case "take":
				return host.takeSlot(slotOpts)
			case "release":
				if len(args) > 2 {
					return result{}, fail(exitError, "Нужно: paradev-agent slot release [<слот>]")
				}
				ref := ""
				if len(args) == 2 {
					ref = args[1]
				}
				target, err := host.findSlot(ref, slotOpts.project)
				if err != nil {
					return result{}, err
				}
				settings := closeCLIOptions(opts)
				settings.Workspace = target.ID
				return host.closeCommand("", settings)
			case "prepare":
				if len(args) != 2 {
					return result{}, fail(exitError, "Нужно: paradev-agent slot prepare <слот> --branch B")
				}
				return host.prepareSlot(args[1], slotOpts)
			case "sync", "sync-back":
				ref := ""
				if len(args) > 1 {
					ref = args[1]
				}
				return syncCommand(host, ref, opts.flags["project"], args[0] == "sync", opts.flags["apply"] == "true")
			}
		}
		return result{}, fail(exitError, "Нужно: paradev-agent slot ls | create | take | prepare | sync-back | sync")
	case "commit":
		if len(args) == 0 {
			return result{}, fail(exitError, "Нужно: paradev-agent commit <план.json> [--apply]")
		}
		git := gitClient{ctx: ctx, env: env, cwd: env.cwd}
		if args[0] == "hunks" {
			return listHunks(git, args[1:])
		}
		return commitPlan(git, args[0], opts.flags["apply"] == "true")
	case "sess":
		if len(args) == 0 {
			return result{}, fail(exitError, "Нужно: paradev-agent sess <команда>")
		}
		switch args[0] {
		case "ls", "last", "wait", "log", "close", "alias", "forget", "keep", "send", "create", "resume", "gc":
		case "finish":
			args[0] = "close"
		default:
			return result{}, fail(exitError, "Неизвестная команда sess %s", args[0])
		}
		opts.positionals = args
		return dispatch(ctx, env, opts)
	case "log":
		if len(args) != 0 {
			return result{}, fail(exitError, "Нужно: paradev-agent log [--project P] [--task KEY] [--json]")
		}
		return sessionLog(env, opts.flags["project"], opts.flags["task"])
	case "alias", "keep", "forget":
		return handleRegistryCommand(ctx, env, command, args, opts)
	case "send", "create", "resume":
		return dispatchSessionLifecycle(ctx, env, command, args, opts)
	case "last", "wait":
		if len(args) > 1 {
			return result{}, fail(exitError, "Лишние аргументы. Справка: agent %s --help", command)
		}
		ref := ""
		if len(args) == 1 {
			ref = args[0]
		}
		config, err := loadConfig(env)
		if err != nil {
			return result{}, err
		}
		host := paradev{ctx: ctx, env: env, config: config}
		if command == "last" {
			return sessionLast(host, ref, "")
		}
		timeout, err := secondsOption("timeout", opts.flags["timeout"], 1800)
		if err != nil {
			return result{}, err
		}
		interval, err := secondsOption("interval", opts.flags["interval"], 5)
		if err != nil {
			return result{}, err
		}
		return sessionWait(host, waitOptions{ref: ref, after: opts.flags["after"], marker: opts.flags["marker"],
			timeout: timeout, interval: interval})
	case "close", "finish":
		if len(args) > 1 {
			return result{}, fail(exitError, "Лишние аргументы. Справка: paradev-agent close --help")
		}
		ref := ""
		if len(args) == 1 {
			ref = args[0]
		}
		settings := closeCLIOptions(opts)
		if settings.Result != "" {
			return closeResult(absoluteOption(env, settings.Result))
		}
		config, err := loadConfig(env)
		if err != nil {
			return result{}, err
		}
		return (paradev{ctx: ctx, env: env, config: config}).closeCommand(ref, settings)
	case "chat-slot-hook", "task":
		config, err := loadConfig(env)
		if err != nil {
			return result{}, err
		}
		host := paradev{ctx: ctx, env: env, config: config}
		if command == "task" {
			if len(args) != 2 || args[0] != "complete" {
				return result{}, fail(exitError, "Нужно: paradev-agent task complete SESSION --workspace W [--dry-run]")
			}
			return host.requestTaskCompletion(opts.flags["workspace"], args[1], opts.flags["dry-run"] == "true")
		}
		if len(args) != 1 {
			return result{}, fail(exitError, "Укажите событие chat-slot-hook")
		}
		var input struct {
			Target chatTarget `json:"target"`
		}
		if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
			return result{}, err
		}
		return host.chatLifecycle(args[0], input.Target)
	case "gc":
		if len(args) != 0 {
			return result{}, fail(exitError, "Нужно: paradev-agent gc [--project P] [--idle 30m] [--done REGEX] [--apply]")
		}
		config, err := loadConfig(env)
		if err != nil {
			return result{}, err
		}
		host := paradev{ctx: ctx, env: env, config: config}
		return host.gc(gcOptions{project: opts.flags["project"], idle: opts.flags["idle"],
			done: opts.flags["done"], apply: opts.flags["apply"] == "true"})
	case "__session-worker":
		if len(args) != 1 {
			return result{}, fail(exitError, "Нужен путь к заданию")
		}
		return sessionWorker(ctx, env, args[0])
	default:
		return result{}, fail(exitError, "Неизвестная группа %s. paradev-agent --help", command)
	}
}
