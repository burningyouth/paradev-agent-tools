package agent

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

type slotOwner struct {
	Workspace    string `json:"workspace"`
	Name         string `json:"name"`
	Project      string `json:"project"`
	Path         string `json:"path"`
	MainCheckout string `json:"mainCheckout"`
	GitDir       string `json:"gitDir"`
	Branch       string `json:"branch"`
	Head         string `json:"head"`
	Generation   string `json:"generation"`
	Rules        string `json:"rules"`
}

func settingsPath(s slot) string {
	if s.checkout != "" {
		candidate := filepath.Join(s.checkout, ".agent-cli.json")
		if fileExists(candidate) {
			return candidate
		}
	}
	return filepath.Join(s.WorktreePath, ".agent-cli.json")
}

func (p paradev) ownership(s slot) (slotOwner, error) {
	g := gitClient{ctx: p.ctx, env: p.env, cwd: s.WorktreePath}
	dir, err := g.git("rev-parse", "--absolute-git-dir")
	if err != nil {
		return slotOwner{}, err
	}
	branch, err := g.git("branch", "--show-current")
	if err != nil {
		return slotOwner{}, err
	}
	head, err := g.head()
	if err != nil {
		return slotOwner{}, err
	}
	policy, err := os.ReadFile(settingsPath(s))
	if errors.Is(err, fs.ErrNotExist) {
		policy = []byte("{}")
	} else if err != nil {
		return slotOwner{}, err
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, policy); err != nil {
		return slotOwner{}, err
	}
	var state struct{ Generation string }
	if err := readJSON(slotStatePath(p.env, s.WorktreePath)+".json", &state); err != nil {
		return slotOwner{}, err
	}
	return slotOwner{Workspace: s.ID, Name: s.Name, Project: s.ProjectName, Path: canonicalPath(s.WorktreePath),
		MainCheckout: canonicalPath(s.checkout), GitDir: canonicalPath(strings.TrimSpace(dir)), Branch: strings.TrimSpace(branch),
		Head: head, Generation: state.Generation, Rules: fmt.Sprintf("%x", sha256.Sum256(compact.Bytes()))}, nil
}

func (p paradev) ownedSlot(owner slotOwner) (slot, error) {
	slot, err := p.findSlot(owner.Workspace, owner.Project)
	if err != nil {
		return slot, err
	}
	current, err := p.ownership(slot)
	if err != nil {
		return slot, err
	}
	if current != owner {
		return slot, fail(exitCheck, "Принадлежность слота изменилась — старая операция отменена")
	}
	return slot, nil
}

type releaseOptions struct {
	from            string
	offline, cached bool
	alreadyDetached bool
}

type releaseReport struct {
	Slot       string      `json:"slot"`
	Was        string      `json:"was"`
	Branch     *string     `json:"branch"`
	Notes      []string    `json:"notes"`
	LocalFiles *syncResult `json:"localFiles"`
}

func (p paradev) releaseCheckout(saved slot, opts releaseOptions) (releaseReport, error) {
	baseName := slotPattern.FindString(saved.Name)
	if baseName == "" {
		return releaseReport{}, fail(exitError, "Имя «%s» без префикса slot-N — освобождать нечего", saved.Name)
	}
	if saved.checkout == "" || canonicalPath(saved.WorktreePath) == canonicalPath(saved.checkout) {
		return releaseReport{}, fail(exitError, "Это основная копия проекта, а не слот")
	}
	if reservationActive(saved) {
		return releaseReport{}, fail(exitCheck, "Слот зарезервирован чатом Paradev")
	}
	if len(saved.sessions) != 0 {
		return releaseReport{}, fail(exitCheck, "В слоте живая сессия")
	}
	if occupied, err := p.nativeInSlot(saved); err != nil || occupied {
		if err != nil {
			return releaseReport{}, err
		}
		return releaseReport{}, fail(exitCheck, "В слоте остались native-процессы")
	}
	cfg, err := loadSlotConfig(saved)
	if err != nil {
		return releaseReport{}, err
	}
	git := gitClient{ctx: p.ctx, env: p.env, cwd: saved.WorktreePath}
	info, err := git.describe()
	if err != nil {
		return releaseReport{}, err
	}
	if info == nil {
		return releaseReport{}, fail(exitCheck, "Слот должен быть Git-репозиторием")
	}
	if len(info.Changes) > 0 {
		return releaseReport{}, fail(exitCheck, "Слот грязный (%d файлов) — закоммитьте или уберите правки", len(info.Changes))
	}
	if busy, err := checkoutOperation(git); err != nil || busy {
		if err != nil {
			return releaseReport{}, err
		}
		return releaseReport{}, fail(exitCheck, "В слоте незавершённая операция Git")
	}
	main, err := mainBranch(git, cfg)
	if err != nil {
		return releaseReport{}, err
	}
	remote := choose(cfg.Slot.Remote, "origin")
	base := strings.TrimPrefix(choose(opts.from, main), remote+"/")
	branch := ""
	if info.Branch != nil {
		branch = *info.Branch
	}
	notes := []string{}
	switch {
	case opts.alreadyDetached && branch == "":
		notes = append(notes, "Git уже без ветки; повторный release пропущен")
	case cfg.Slot.Release != "":
		command := strings.NewReplacer("{branch}", branch, "{base}", base).Replace(cfg.Slot.Release)
		notes, err = slotCommand(git, command)
		if err != nil {
			return releaseReport{}, err
		}
	default:
		var start gitRef
		exists, err := gitHas(git, "refs/remotes/"+remote+"/"+base)
		if err != nil {
			return releaseReport{}, err
		}
		if opts.cached && !exists {
			start.name = "refs/heads/" + base
			hash, err := git.git("rev-parse", "--verify", start.name)
			if err != nil {
				return releaseReport{}, err
			}
			start.sha = strings.TrimSpace(hash)
		} else {
			start, err = slotBaseRef(git, remote, base, opts.offline || opts.cached)
			if err != nil {
				return releaseReport{}, err
			}
		}
		number, err := git.git("rev-list", "--count", "HEAD", "--not", "--remotes")
		if err != nil {
			return releaseReport{}, err
		}
		if n := strings.TrimSpace(number); branch != "" && n != "0" {
			notes = append(notes, fmt.Sprintf("не запушено коммитов: %s — остаются в ветке %s", n, branch))
		}
		if _, err := git.git("switch", "--quiet", "--detach", start.sha); err != nil {
			return releaseReport{}, err
		}
		notes = append(notes, "без ветки на "+start.name)
	}
	paths, err := localEntries(cfg)
	if err != nil {
		return releaseReport{}, err
	}
	files, err := syncLocalFiles(p.env, saved, paths, []string{"back"}, true)
	if err != nil {
		return releaseReport{}, err
	}
	if saved.Name != baseName {
		if err := p.renameSlot(saved.ID, baseName, p.timeout); err != nil {
			return releaseReport{}, err
		}
	}
	return releaseReport{Slot: baseName, Was: saved.Name, Branch: info.Branch, Notes: notes, LocalFiles: files}, nil
}

func (p paradev) completeLocked(s slot, opts releaseOptions) (map[string]any, error) {
	owner, err := p.ownership(s)
	if err != nil {
		return nil, err
	}
	opts.alreadyDetached = true
	report, err := p.releaseCheckout(s, opts)
	if err != nil {
		return nil, err
	}
	after, err := p.findSlot(s.ID, s.ProjectName)
	if err != nil {
		return nil, err
	}
	state, err := p.ownership(after)
	if err != nil {
		return nil, err
	}
	if state.Path != owner.Path || state.MainCheckout != owner.MainCheckout || state.Project != owner.Project ||
		state.GitDir != owner.GitDir || after.Name != report.Slot || state.Branch != "" || len(after.sessions) != 0 {
		return nil, fail(exitCheck, "Release вернулся, но Git/Superset postconditions не выполнены")
	}
	git := gitClient{ctx: p.ctx, env: p.env, cwd: after.WorktreePath}
	verified, err := git.describe()
	if err != nil {
		return nil, err
	}
	occupied, err := p.nativeInSlot(after)
	if err != nil {
		return nil, err
	}
	if verified == nil || len(verified.Changes) != 0 || occupied {
		return nil, fail(exitCheck, "Release вернулся, но Git/Superset postconditions не выполнены")
	}
	if owner.Branch != "" {
		sha, err := git.git("rev-parse", "refs/heads/"+owner.Branch)
		if err != nil || strings.TrimSpace(sha) != owner.Head {
			return nil, fail(exitCheck, "Release вернулся, но сохранённая ветка изменилась")
		}
	}
	if report.LocalFiles != nil && len(report.LocalFiles.Conflicts) != 0 {
		return nil, fail(exitCheck, "Слот освобождён, но перенос локальных файлов требует разбора")
	}
	return map[string]any{"result": report, "verified": map[string]any{
		"name": after.Name, "head": state.Head, "detached": true, "clean": true, "sessions": 0,
	}}, nil
}
