package agent

import (
	"context"
	"maps"
	"slices"
	"strings"
	"time"
)

func sessionAliases(env environment, name, terminal, remove string) (result, error) {
	if name != "" && terminal == "" && remove == "" {
		return result{}, fail(exitError, "Нужно: paradev-agent alias <имя> <терминал>")
	}
	if (name != "" && terminal != "") || remove != "" {
		err := withRegistry(env, func(reg *registry) error {
			if remove != "" {
				delete(reg.Aliases, remove)
				return nil
			}
			for i := len(reg.Sessions) - 1; i >= 0; i-- {
				record := reg.Sessions[i]
				if record.string("terminal") != terminal {
					continue
				}
				record = maps.Clone(record)
				record["alias"] = name
				if err := recordRegistryEvent(env, reg, "alias-changed", record); err != nil {
					return err
				}
				break
			}
			reg.Aliases[name] = terminal
			return nil
		})
		if err != nil {
			return result{}, err
		}
	}
	reg, _, err := loadRegistry(env)
	if err != nil {
		return result{}, err
	}
	var lines []string
	for _, name := range slices.Sorted(maps.Keys(reg.Aliases)) {
		lines = append(lines, name+" → "+reg.Aliases[name])
	}
	return result{data: reg.Aliases, text: choose(strings.Join(lines, "\n"), "Алиасов нет")}, nil
}

func sessionKeep(p paradev, ref string, remove, exact bool) (result, error) {
	if ref != "" {
		id := ""
		if !exact {
			if found, err := p.lookupSession(ref, ""); err == nil {
				id = found.id
			}
		}
		if err := withRegistry(p.env, func(reg *registry) error {
			if !exact && id == "" {
				for i := len(reg.Sessions) - 1; i >= 0; i-- {
					row := reg.Sessions[i]
					if matchesSessionRecord(row, ref) {
						id = row.string("sessionId")
						break
					}
				}
			}
			id = choose(id, ref)
			if remove {
				reg.Keep = slices.DeleteFunc(reg.Keep, func(saved string) bool { return saved == id })
			} else if !slices.Contains(reg.Keep, id) {
				reg.Keep = append(reg.Keep, id)
			}
			return nil
		}); err != nil {
			return result{}, err
		}
	}
	reg, _, err := loadRegistry(p.env)
	if err != nil {
		return result{}, err
	}
	return result{data: reg.Keep, text: choose(strings.Join(reg.Keep, "\n"), "Пометок keep нет")}, nil
}

func sessionForget(env environment, ref, workspace string) (result, error) {
	removed := 0
	err := withRegistry(env, func(reg *registry) error {
		records := slices.Clone(reg.Sessions)
		for _, record := range records {
			if workspace != "" {
				if record.string("sessionId") != ref || record.string("workspace") != workspace {
					continue
				}
			} else if !matchesSessionRecord(record, ref) {
				continue
			}
			if err := recordRegistryEvent(env, reg, "forgotten", maps.Clone(record)); err != nil {
				return err
			}
			removed++
		}
		if removed == 0 {
			return fail(exitError, "В реестре нет сессии %s", ref)
		}
		return nil
	})
	return result{data: map[string]int{"removed": removed}, text: "Удалено из реестра: " + ref}, err
}

func recordRegistryEvent(env environment, reg *registry, kind string, record sessionRecord) error {
	date := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	record["updatedAt"] = date
	record["kind"] = choose(record.string("kind"), "cli")
	record["agent"] = choose(record.string("agent"), "claude")
	record["createdAt"] = choose(record.string("createdAt"), date)
	for _, field := range []string{"id", "lifecycleId"} {
		if record.string(field) == "" {
			record[field] = uuid()
		}
	}
	event := historyEvent{Version: reg.HistoryVersion + 1, Type: kind, At: date, Record: record}
	if err := appendHistoryEvent(env, event); err != nil {
		return err
	}
	reg.replay(event)
	return nil
}

func requireHistory(env environment, target targetInput) error {
	if target.Cwd != "" {
		if _, err := scopedEnv(env, target.Cwd); err != nil {
			return err
		}
	}
	reg, _, err := loadRegistry(env)
	if err != nil {
		return err
	}
	count := 0
	for _, row := range reg.Sessions {
		if target.SessionID != "" && target.WorkspaceID != "" && row.string("sessionId") == target.SessionID &&
			row.string("workspace") == target.WorkspaceID {
			count++
		}
	}
	if count != 1 {
		return fail(exitCheck, "Укажите точную запись из session_history для выбранного workspace")
	}
	return nil
}

func handleRegistryCommand(ctx context.Context, env environment, command string, args []string, opts options) (result, error) {
	name, terminal := "", ""
	if len(args) > 0 {
		name = args[0]
	}
	if len(args) > 1 {
		terminal = args[1]
	}
	remove := opts.flags["rm"]
	switch command {
	case "alias":
		if len(args) > 2 {
			return result{}, fail(exitError, "Лишние аргументы. Справка: agent alias --help")
		}
		return sessionAliases(env, name, terminal, remove)
	case "keep":
		if len(args) > 1 {
			return result{}, fail(exitError, "Лишние аргументы. Справка: agent keep --help")
		}
		config, err := loadConfig(env)
		if err != nil {
			return result{}, err
		}
		return sessionKeep(paradev{ctx: ctx, env: env, config: config}, choose(remove, name), remove != "", false)
	case "forget":
		if len(args) != 1 {
			return result{}, fail(exitError, "Нужно: paradev-agent forget <session-id|алиас>")
		}
		return sessionForget(env, name, "")
	default:
		return result{}, fail(exitError, "Неизвестная команда %s", command)
	}
}
