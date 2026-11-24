package agent

import (
	"time"

	"github.com/dlclark/regexp2/v2"
)

// Project patterns were defined as JavaScript regular expressions. Keep their
// lookarounds and capture groups when evaluating existing project configuration.
func projectPattern(source string) (*regexp2.Regexp, error) {
	pattern, err := regexp2.Compile(source, regexp2.ECMAScript)
	if err == nil {
		pattern.MatchTimeout = 250 * time.Millisecond
	}
	return pattern, err
}
