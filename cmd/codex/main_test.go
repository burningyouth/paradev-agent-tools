package main

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestForwardRelaysOnlySlotPromptInSameTurn(t *testing.T) {
	hook := `{"method":"hook/completed","params":{"threadId":"native","turnId":"turn","run":{"eventName":"userPromptSubmit","source":"user","statusMessage":"` + slotPromptLabel + `","status":"blocked","entries":[{"kind":"feedback","text":"Где продолжить?"}]}}}`
	request := `{"id":1,"method":"turn/start"}`
	foreign := strings.Replace(hook, slotPromptLabel, "Foreign hook", 1)
	completed := `{"method":"turn/completed","params":{"turn":{"id":"turn"}}}`
	warning := `{"method":"warning","params":{"threadId":"native","turnId":"turn","message":"Где продолжить?"}}`
	var out bytes.Buffer
	if err := forward(&out, strings.NewReader(strings.Join([]string{request, foreign, hook, completed}, "\r\n"))); err != nil {
		t.Fatal(err)
	}
	decode := func(lines []string) []any {
		t.Helper()
		result := make([]any, len(lines))
		for i, line := range lines {
			if err := json.Unmarshal([]byte(line), &result[i]); err != nil {
				t.Fatalf("%q: %v", line, err)
			}
		}
		return result
	}
	got := decode(strings.Split(strings.TrimSpace(out.String()), "\n"))
	want := decode([]string{request, foreign, hook, warning, completed})
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("relay output:\n%s", &out)
	}
}
