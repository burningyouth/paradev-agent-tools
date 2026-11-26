package agent

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"syscall"
)

func configResult(env environment, args []string) (result, error) {
	if len(args) < 2 || args[1] != "maxSessions" {
		return result{}, fail(exitError, "Справка: paradev-agent config --help")
	}
	action := args[0]
	value := defaultMaxSessions
	switch action {
	case "get", "reset":
		if len(args) != 2 {
			return result{}, fail(exitError, "Справка: paradev-agent config --help")
		}
	case "set":
		if len(args) != 3 {
			return result{}, fail(exitError, "Нужно: paradev-agent config set maxSessions ЧИСЛО")
		}
		var err error
		value, err = strconv.Atoi(args[2])
		if err != nil || value <= 0 {
			return result{}, fail(exitError, "maxSessions должен быть положительным целым числом")
		}
	default:
		return result{}, fail(exitError, "Справка: paradev-agent config --help")
	}
	path := filepath.Join(env.agentHome, "config.json")
	if action != "get" {
		if err := updateMaxSessions(path, action, value); err != nil {
			return result{}, err
		}
	}
	config, err := loadConfig(env)
	if err != nil {
		return result{}, err
	}
	return result{
		text: strconv.Itoa(config.MaxSessions),
		data: map[string]any{"maxSessions": config.MaxSessions, "path": path},
	}, nil
}

func updateMaxSessions(path, action string, value int) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fmt.Errorf("блокировка config.json: %w", err)
	}
	// Preserve a linked profile’s target and all JSON fields owned by other commands.
	path = canonicalPath(path)
	fields := make(map[string]json.RawMessage)
	if err := readJSON(path, &fields); err != nil {
		return err
	}
	if fields == nil {
		return fail(exitError, "%s должен содержать объект JSON", path)
	}
	if action == "reset" {
		if _, exists := fields["maxSessions"]; !exists {
			return nil
		}
		delete(fields, "maxSessions")
	} else {
		fields["maxSessions"] = json.RawMessage(strconv.Itoa(value))
	}
	return atomicJSON(path, fields)
}
