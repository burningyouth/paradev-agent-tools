package agent

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

var jsoncToken = regexp.MustCompile(`^(?:[ \t\r\n]+|//[^\r\n]*|/\*(?s:.*?)\*/|"(?:[^"\\\r\n]|\\.)*"|[{}\[\],:]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)`)

type jsoncNode struct {
	start, end, close, last int
	comma                   bool
	children                map[string]*jsoncNode
	value                   any
}

type jsoncParser struct {
	source     string
	token      string
	start, end int
}

func (p *jsoncParser) next() error {
	for p.end < len(p.source) {
		p.start = p.end
		token := jsoncToken.FindString(p.source[p.end:])
		if token == "" {
			return fmt.Errorf("некорректный JSONC, позиция %d", p.start)
		}
		p.end += len(token)
		if strings.TrimSpace(token) != "" && token[0] != '/' {
			p.token = token
			return nil
		}
	}
	p.start, p.token = p.end, ""
	return nil
}

func (p *jsoncParser) value(depth int) (*jsoncNode, error) {
	if depth > 256 {
		return nil, fmt.Errorf("слишком глубокая вложенность JSONC")
	}
	n := &jsoncNode{start: p.start, end: p.end}
	object := p.token == "{"
	if !object && p.token != "[" {
		if err := json.Unmarshal([]byte(p.token), &n.value); err != nil {
			return nil, err
		}
		return n, p.next()
	}
	end := "]"
	values := []any{}
	fields := map[string]any{}
	if object {
		end = "}"
		n.children = map[string]*jsoncNode{}
	}
	if err := p.next(); err != nil {
		return nil, err
	}
	for p.token != end {
		var key string
		if object {
			if len(p.token) == 0 || p.token[0] != '"' || json.Unmarshal([]byte(p.token), &key) != nil || n.children[key] != nil {
				return nil, fmt.Errorf("некорректный или повторяющийся ключ JSONC, позиция %d", p.start)
			}
			if err := p.next(); err != nil {
				return nil, err
			}
			if p.token != ":" {
				return nil, fmt.Errorf("ожидалось двоеточие, позиция %d", p.start)
			}
			if err := p.next(); err != nil {
				return nil, err
			}
		}
		child, err := p.value(depth + 1)
		if err != nil {
			return nil, err
		}
		if object {
			n.children[key], fields[key] = child, child.value
		} else {
			values = append(values, child.value)
		}
		n.last = child.end
		n.comma = p.token == ","
		if !n.comma {
			break
		}
		if err := p.next(); err != nil {
			return nil, err
		}
	}
	if p.token != end {
		return nil, fmt.Errorf("ожидалось %s, позиция %d", end, p.start)
	}
	n.close, n.end = p.start, p.end
	n.value = values
	if object {
		n.value = fields
	}
	return n, p.next()
}

func parseJSONC(source string) (*jsoncNode, error) {
	p := &jsoncParser{source: source}
	if err := p.next(); err != nil {
		return nil, err
	}
	n, err := p.value(0)
	if err == nil && p.token != "" {
		err = fmt.Errorf("лишние символы после JSONC, позиция %d", p.start)
	}
	return n, err
}

func (n *jsoncNode) get(keys ...string) *jsoncNode {
	for _, key := range keys {
		if n == nil {
			return nil
		}
		n = n.children[key]
	}
	return n
}

func prettyJSON(data any) (string, error) {
	var buf bytes.Buffer
	err := writeCLIJSON(&buf, data)
	return buf.String(), err
}

func patchJSONC(source string, n *jsoncNode, keys []string, value any) (string, error) {
	for i, key := range keys {
		if n.children == nil {
			return "", fmt.Errorf("в настройках ожидался объект %s", strings.Join(keys[:i], "."))
		}
		child := n.children[key]
		if child == nil {
			for j := len(keys) - 1; j > i; j-- {
				value = map[string]any{keys[j]: value}
			}
			encoded, err := prettyJSON(value)
			if err != nil {
				return "", err
			}
			quoted, _ := json.Marshal(key)
			before := source[:n.close]
			if n.last != 0 && !n.comma {
				before = source[:n.last] + "," + source[n.last:n.close]
			}
			return before + "\n  " + string(quoted) + ": " + strings.ReplaceAll(strings.TrimSuffix(encoded, "\n"), "\n", "\n  ") + "\n" + source[n.close:], nil
		}
		n = child
	}
	encoded, err := prettyJSON(value)
	if err != nil {
		return "", err
	}
	return source[:n.start] + strings.TrimSuffix(encoded, "\n") + source[n.end:], nil
}
