package agent

import (
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"
)

type diffHunk struct {
	Index int    `json:"index"`
	Text  string `json:"text"`
}

type fileHunks struct {
	Path  string     `json:"path"`
	Hunks []diffHunk `json:"hunks"`
}

func parseDiff(patch string) (string, []diffHunk) {
	lines := strings.Split(patch, "\n")
	start := slices.IndexFunc(lines, isHunkLine)
	hunks := []diffHunk{}
	if start < 0 {
		return patch, hunks
	}
	begin := start
	for i := start + 1; i <= len(lines); i++ {
		if i < len(lines) && !isHunkLine(lines[i]) {
			continue
		}
		text := strings.TrimRight(strings.Join(lines[begin:i], "\n"), "\n")
		hunks = append(hunks, diffHunk{Index: len(hunks) + 1, Text: text})
		begin = i
	}
	return strings.Join(lines[:start], "\n"), hunks
}

func isHunkLine(line string) bool { return strings.HasPrefix(line, "@@") }

func hunkNumbers(raw json.RawMessage) ([]int, bool) {
	if len(raw) == 0 || raw[0] != '[' {
		return nil, false
	}
	var values []json.RawMessage
	if json.Unmarshal(raw, &values) != nil {
		return nil, false
	}
	numbers := make([]int, 0, len(values))
	for _, value := range values {
		number, err := strconv.ParseFloat(string(value), 64)
		if err != nil || number != float64(int(number)) {
			return nil, false
		}
		numbers = append(numbers, int(number))
	}
	return numbers, true
}

func selectHunks(hunks []diffHunk, selection planHunk) ([]diffHunk, error) {
	var selected []diffHunk
	if numbers, ok := hunkNumbers(selection.Include); ok {
		var missing []string
		for _, number := range numbers {
			if number < 1 || number > len(hunks) {
				missing = append(missing, strconv.Itoa(number))
			}
		}
		if len(missing) > 0 {
			return nil, fail(exitError, "%s: нет ханков %s (всего %d)", selection.Path, strings.Join(missing, ", "), len(hunks))
		}
		for _, hunk := range hunks {
			if slices.Contains(numbers, hunk.Index) {
				selected = append(selected, hunk)
			}
		}
		return selected, nil
	}
	var markers []string
	var marker string
	if selection.Include[0] == '"' && json.Unmarshal(selection.Include, &marker) == nil {
		markers = []string{marker}
	} else if json.Unmarshal(selection.Include, &markers) != nil {
		markers = nil
	}
	if len(markers) == 0 || slices.Contains(markers, "") {
		return nil, fail(exitError, "%s: include — номера ханков или непустые строки-маркеры", selection.Path)
	}
	for _, marker := range markers {
		if !slices.ContainsFunc(hunks, func(h diffHunk) bool { return strings.Contains(h.Text, marker) }) {
			return nil, fail(exitError, "%s: ни один ханк не содержит «%s»", selection.Path, marker)
		}
	}
	for _, hunk := range hunks {
		if slices.ContainsFunc(markers, func(marker string) bool { return strings.Contains(hunk.Text, marker) }) {
			selected = append(selected, hunk)
		}
	}
	return selected, nil
}

func buildPatch(header string, hunks []diffHunk) string {
	lines := []string{header}
	for _, hunk := range hunks {
		lines = append(lines, hunk.Text)
	}
	return strings.Join(lines, "\n") + "\n"
}

func listHunks(git gitClient, paths []string) (result, error) {
	root, err := git.requireRoot()
	if err != nil {
		return result{}, err
	}
	git.cwd = root
	files := make([]fileHunks, 0, len(paths))
	var lines []string
	for _, path := range paths {
		patch, err := git.unstagedPatch(path)
		if err != nil {
			return result{}, err
		}
		_, hunks := parseDiff(patch)
		files = append(files, fileHunks{Path: path, Hunks: hunks})
		lines = append(lines, "== "+path)
		if len(hunks) == 0 {
			lines = append(lines, "(нет изменений)")
		}
		for _, hunk := range hunks {
			lines = append(lines, fmt.Sprintf("-- ханк %d\n%s", hunk.Index, hunk.Text))
		}
	}
	return result{data: files, text: strings.Join(lines, "\n")}, nil
}
