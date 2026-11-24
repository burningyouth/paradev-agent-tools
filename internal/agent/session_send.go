package agent

import (
	"fmt"
	"os"
	"slices"
	"strings"
	"time"
)

func readInput(env environment, file, text string) (string, error) {
	if file == "" {
		return text, nil
	}
	data, err := os.ReadFile(absoluteOption(env, file))
	return string(data), err
}

func (p paradev) sendSession(ref, workspaceID, text string, timeout time.Duration, force bool) (result, error) {
	if strings.TrimSpace(text) == "" {
		return result{}, fail(exitError, "Нужен --file или --text с непустым текстом")
	}
	if ref == "" {
		return result{}, fail(exitError, "Укажите терминал или алиас сессии")
	}
	session, err := p.lookupSession(ref, workspaceID)
	if err != nil {
		return result{}, err
	}
	if session.chat != nil && !session.chat.Live {
		resumed, err := p.resumeSessions(session.id, resumeOptions{launchOptions: launchOptions{workspace: session.workspaceID}, exact: workspaceID != ""})
		if err != nil {
			return result{}, err
		}
		session, err = p.lookupSession(resumed.data.(sessionRecord).string("sessionId"), session.workspaceID)
		if err != nil {
			return result{}, err
		}
	}
	info, err := p.transcript(session, time.Time{})
	if err != nil {
		return result{}, err
	}
	if info.state == "waiting" && !force {
		return result{}, fail(exitWaiting, "Сессия ждёт разрешения или ответа на вопрос — текст попал бы в диалог. --force, если так и нужно")
	}
	since := time.Now()
	deadline := since.Add(timeout)
	seen := map[string]bool{}
	for _, record := range info.records {
		seen[record.UUID] = true
	}
	maybeDelivered := func(err error) (result, error) {
		return result{}, fail(exitNotAccepted,
			"%v. Сообщение могло дойти — не отправляйте повторно вслепую: paradev-agent last %s или paradev-agent wait %s --marker … (без --after — от последнего сообщения)",
			err, ref, ref)
	}
	if session.chat != nil {
		reply, err := p.sendChat(session, trimEnd(text), max(time.Millisecond, time.Until(deadline)))
		if err != nil {
			return maybeDelivered(err)
		}
		if reply.SessionID != "" && (reply.SessionID != session.id || reply.TerminalID != "" && reply.TerminalID != session.terminal) {
			session, _, err = p.rememberTransport(session, reply)
			if err != nil {
				return maybeDelivered(err)
			}
		}
	} else {
		if session.workspaceID == "" {
			return result{}, fail(exitCheck, "Сессия не привязана к workspace Paradev")
		}
		_, err := mustRun(p.ctx, p.env, p.config.Superset,
			[]string{"terminals", "send", "--local", "--workspace", session.workspaceID, "--terminal", session.terminal, "--text", trimEnd(text)},
			commandOptions{what: "superset terminals send", timeout: max(time.Millisecond, time.Until(deadline))})
		if err != nil {
			return maybeDelivered(err)
		}
	}
	for time.Now().Before(deadline) {
		info, err := p.transcript(session, deadline)
		if err != nil {
			return maybeDelivered(err)
		}
		newRecords := slices.DeleteFunc(info.records, func(row transcriptRecord) bool { return seen[row.UUID] })
		if accepted := acceptedRecord(newRecords, text, since); accepted != nil {
			queued := accepted.Type == "attachment"
			reply := "Принято"
			if queued {
				reply += " (в очереди: сессия занята)"
			}
			data := map[string]any{"terminal": session.terminal, "sessionId": nonempty(session.id), "anchor": accepted.UUID,
				"timestamp": accepted.Timestamp, "queued": queued}
			return result{data: data, text: reply + ". Якорь: " + accepted.UUID}, nil
		}
		if err := pause(p.ctx, min(time.Until(deadline), time.Second)); err != nil {
			return maybeDelivered(err)
		}
	}
	return maybeDelivered(fmt.Errorf("подтверждения нет за %g с: сообщения нет в журнале %s", timeout.Seconds(), session.id))
}
