package agent

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"time"
)

const (
	releaseAPI = "https://api.github.com/repos/" + pluginRepo + "/releases/"
	releaseWeb = "https://github.com/" + pluginRepo + "/releases/download/"
	maxZIPSize = 128 << 20
)

var releaseDigest = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
var githubCommit = regexp.MustCompile(`^[a-f0-9]{40}$`)

type githubAsset struct {
	Name   string `json:"name"`
	State  string `json:"state"`
	URL    string `json:"browser_download_url"`
	Digest string `json:"digest"`
	Size   int64  `json:"size"`
}

type githubRelease struct {
	Tag        string `json:"tag_name"`
	Draft      bool   `json:"draft"`
	Prerelease bool   `json:"prerelease"`
	Assets     []githubAsset
}

func releaseHTTP() *http.Client {
	return &http.Client{Timeout: 2 * time.Minute, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		url := req.URL
		if len(via) == 1 && strings.HasPrefix(via[0].URL.String(), releaseWeb) &&
			url.Scheme == "https" && url.Host == "release-assets.githubusercontent.com" && url.User == nil &&
			strings.HasPrefix(url.EscapedPath(), "/github-production-release-asset/") {
			return nil
		}
		return fmt.Errorf("неожиданное перенаправление при чтении релиза GitHub: %s", url.Host)
	}}
}

func getReleaseResponse(ctx context.Context, client *http.Client, url string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	if strings.HasPrefix(url, releaseAPI) {
		req.Header.Set("Accept", "application/vnd.github+json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("GitHub вернул HTTP %d для %s", resp.StatusCode, url)
	}
	return resp, nil
}

func latestRelease(ctx context.Context, client *http.Client) (githubRelease, error) {
	var release githubRelease
	resp, err := getReleaseResponse(ctx, client, releaseAPI+"latest")
	if err != nil {
		return release, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if err != nil {
		return release, err
	}
	if len(data) > 1<<20 {
		return release, errors.New("слишком большой ответ GitHub Releases")
	}
	if err := json.Unmarshal(data, &release); err != nil {
		return release, err
	}
	version := strings.TrimPrefix(release.Tag, "v")
	if release.Draft || release.Prerelease || release.Tag != "v"+version || !releaseVersion.MatchString(version) {
		return release, errors.New("GitHub не вернул стабильный релиз vX.Y.Z")
	}
	return release, nil
}

func (r githubRelease) platformAsset(platform string) (githubAsset, error) {
	name := productName + "-" + platform + ".zip"
	expected := releaseWeb + r.Tag + "/" + name
	var found githubAsset
	for _, asset := range r.Assets {
		if asset.Name != name {
			continue
		}
		if found.Name != "" || asset.State != "uploaded" || asset.URL != expected ||
			!releaseDigest.MatchString(asset.Digest) || asset.Size <= 0 || asset.Size > maxZIPSize {
			return githubAsset{}, fmt.Errorf("не удалось подтвердить ZIP, размер или SHA-256: %s", expected)
		}
		found = asset
	}
	if found.Name == "" {
		return githubAsset{}, fmt.Errorf("в релизе %s отсутствует %s", r.Tag, name)
	}
	return found, nil
}

// Inputs have already been validated as numeric X.Y.Z without leading zeros.
func compareReleaseVersions(a, b string) int {
	parts := strings.Split(b, ".")
	for i, part := range strings.Split(a, ".") {
		if n := len(part) - len(parts[i]); n != 0 {
			return n
		}
		if n := strings.Compare(part, parts[i]); n != 0 {
			return n
		}
	}
	return 0
}

func downloadRelease(ctx context.Context, client *http.Client, asset githubAsset, dest string) error {
	resp, err := getReleaseResponse(ctx, client, asset.URL)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	file, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(file, hash), io.LimitReader(resp.Body, asset.Size+1))
	if err := errors.Join(err, file.Close()); err != nil {
		return err
	}
	if n != asset.Size || "sha256:"+hex.EncodeToString(hash.Sum(nil)) != asset.Digest {
		return fmt.Errorf("размер или SHA-256 скачанного ZIP не совпадает с GitHub Releases: %s", asset.Name)
	}
	return nil
}

func unpackRelease(archive, dest string) error {
	z, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer z.Close()
	if len(z.File) > 4096 {
		return errors.New("слишком много файлов в ZIP")
	}
	var total uint64
	for _, file := range z.File {
		clean := strings.TrimSuffix(file.Name, "/")
		if !fs.ValidPath(clean) || clean == "." || strings.ContainsAny(clean, "\\:") {
			return fmt.Errorf("недопустимый путь в ZIP: %s", file.Name)
		}
		mode := file.Mode()
		if mode.IsDir() {
			continue
		}
		if !mode.IsRegular() || file.UncompressedSize64 > maxZIPSize || total+file.UncompressedSize64 > maxZIPSize {
			return fmt.Errorf("недопустимый файл или размер в ZIP: %s", file.Name)
		}
		total += file.UncompressedSize64
		relative, ok := strings.CutPrefix(clean, productName+"/")
		if !ok {
			// The outer files are only used for first installation.
			if clean == "Install.sh" || clean == "LICENSE" {
				continue
			}
			return fmt.Errorf("неожиданный файл в ZIP: %s", file.Name)
		}
		target := filepath.Join(dest, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := unpackReleaseFile(file, target); err != nil {
			return err
		}
	}
	return nil
}

func unpackReleaseFile(file *zip.File, target string) error {
	source, err := file.Open()
	if err != nil {
		return err
	}
	defer source.Close()
	mode := fs.FileMode(0o644)
	if file.Mode().Perm()&0o111 != 0 {
		mode = 0o755
	}
	out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	n, err := io.Copy(out, io.LimitReader(source, int64(file.UncompressedSize64)+1))
	if err := errors.Join(err, out.Close()); err != nil {
		return err
	}
	if uint64(n) != file.UncompressedSize64 {
		return fmt.Errorf("размер файла в ZIP не совпадает: %s", file.Name)
	}
	return nil
}

type releaseSource struct {
	Source     string `json:"source"`
	Version    string `json:"version"`
	Executable string `json:"executable"`
	Launcher   string `json:"launcher,omitempty"`
	Root       string `json:"root,omitempty"`
	Active     string `json:"active,omitempty"`
	Previous   string `json:"previous,omitempty"`
	Profile    string `json:"profile,omitempty"`
	Package    string `json:"package,omitempty"`
	Workspace  string `json:"workspace,omitempty"`
	Latest     string `json:"latest,omitempty"`
	Status     string `json:"status,omitempty"`
	Asset      string `json:"asset,omitempty"`
	Digest     string `json:"digest,omitempty"`
	CheckError string `json:"checkError,omitempty"`
}

func loadedReleaseSource(env environment, exe string) releaseSource {
	exe = canonicalPath(exe)
	source := releaseSource{Source: "unverified", Version: pluginVersion(), Executable: exe}
	if root, version := releaseForExecutable(env, exe); root != "" && version == source.Version {
		source.Source, source.Root = "zip", root
		source.Launcher = filepath.Join(root, "launch")
		state, err := currentRelease(root)
		if err == nil {
			source.Active, source.Previous = state.Version, state.Previous
		} else {
			source.CheckError = err.Error()
		}
		return source
	}

	pkg := packageDirectory(exe)
	manifest, err := readClientPackage(pkg)
	if err != nil || manifest.Name != productName || manifest.Version != source.Version {
		return source
	}
	source.Root, source.Launcher = pkg, filepath.Join(pkg, "launch")
	profile := canonicalPath(providerHome(env, "codex"))
	if pkg == filepath.Join(profile, "plugins", "cache", pluginMarket, productName, source.Version) {
		source.Source, source.Profile = "codex-cache", profile
	} else if knownOpenCodePackage(pkg, source.Version) {
		source.Source, source.Package, source.Workspace = "opencode-package", opencodeSource, env.cwd
		source.Profile = choose(env.get("OPENCODE_CONFIG_DIR"), filepath.Join(choose(env.get("XDG_CONFIG_HOME"), filepath.Join(env.home, ".config")), "opencode"))
	}
	return source
}

// The lockfile ties the package actually executing to the catalog repository and ref.
// A checkout or an unrelated package can have the same name and version.
func knownOpenCodePackage(pkg, version string) bool {
	const npmName = productName + "-opencode"
	base := filepath.Dir(filepath.Dir(pkg))
	modules := filepath.Dir(base)
	if filepath.Base(base) != npmName || filepath.Base(modules) != "node_modules" ||
		pkg != filepath.Join(base, "plugins", productName) {
		return false
	}
	var lock struct {
		Packages map[string]struct {
			Dependencies      map[string]string
			Version, Resolved string
		}
	}
	data, err := os.ReadFile(filepath.Join(filepath.Dir(modules), "package-lock.json"))
	if err != nil || json.Unmarshal(data, &lock) != nil {
		return false
	}
	spec := lock.Packages[""].Dependencies[npmName]
	entry := lock.Packages["node_modules/"+npmName]
	repo, commit, ok := strings.Cut(entry.Resolved, "#")
	return (spec == "github:"+pluginRepo+"#"+pluginBranch || spec == opencodeSource) &&
		entry.Version == version && ok && githubCommit.MatchString(commit) &&
		(repo == "git+ssh://git@github.com/"+pluginRepo+".git" || repo == "git+https://github.com/"+pluginRepo+".git")
}

func previewRelease(ctx context.Context, client *http.Client, source releaseSource) (releaseSource, error) {
	release, err := latestRelease(ctx, client)
	if err != nil {
		return source, err
	}
	source.Latest = strings.TrimPrefix(release.Tag, "v")
	if !releaseVersion.MatchString(source.Version) {
		return source, errors.New("версия запущенного пакета не определена")
	}
	if compareReleaseVersions(source.Latest, source.Version) <= 0 {
		source.Status = "current"
		return source, nil
	}
	source.Status = "update-available"
	if source.Source == "zip" {
		platform, err := releasePlatform(runtime.GOOS, runtime.GOARCH)
		if err != nil {
			return source, err
		}
		asset, err := release.platformAsset(platform)
		if err != nil {
			return source, err
		}
		source.Asset, source.Digest = asset.Name, asset.Digest
	}
	return source, nil
}

func updateRelease(ctx context.Context, client *http.Client, root string, state releaseState, to, digest string) error {
	if !releaseVersion.MatchString(to) || compareReleaseVersions(to, state.Version) <= 0 || !releaseDigest.MatchString(digest) {
		return errors.New("укажите более новую версию и точный SHA-256 из update check")
	}
	platform, err := releasePlatform(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return err
	}
	release, err := latestRelease(ctx, client)
	if err != nil {
		return err
	}
	if release.Tag != "v"+to {
		return errors.New("доступная версия изменилась; повторите update check")
	}
	asset, err := release.platformAsset(platform)
	if err != nil {
		return err
	}
	if digest != asset.Digest {
		return errors.New("SHA-256 релиза изменился; повторите update check")
	}
	staging, err := os.MkdirTemp(root, ".download-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	archive := filepath.Join(staging, asset.Name)
	if err := downloadRelease(ctx, client, asset, archive); err != nil {
		return err
	}
	pkg := filepath.Join(staging, "package")
	if err := unpackRelease(archive, pkg); err != nil {
		return err
	}
	if err := validateReleasePackage(pkg, to); err != nil {
		return err
	}
	dest := filepath.Join(root, "releases", to)
	if err := plainParents(dest); err != nil {
		return err
	}
	if _, err := os.Lstat(dest); err == nil {
		// A rollback may leave this version in use by another MCP process.
		// Reuse it only when it still matches the verified archive.
		if err := sameReleaseTree(pkg, dest); err != nil {
			return err
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	} else if err := os.Rename(pkg, dest); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return activateRelease(root, releaseState{Version: to, Previous: state.Version})
}

func sameReleaseTree(verified, installed string) error {
	diff := func() error {
		return fmt.Errorf("локальный пакет отличается от проверенного ZIP: %s", installed)
	}
	var expected []string
	for i, root := range []string{verified, installed} {
		var files []string
		err := filepath.WalkDir(root, func(name string, entry fs.DirEntry, err error) error {
			if err != nil || entry.IsDir() {
				return err
			}
			relative, _ := filepath.Rel(root, name)
			files = append(files, relative)
			if i == 0 {
				return nil
			}
			local, err := entry.Info()
			if err != nil {
				return err
			}
			if !local.Mode().IsRegular() || !slices.Contains(expected, relative) {
				return diff()
			}
			original := filepath.Join(verified, relative)
			info, err := os.Stat(original)
			if err != nil || info.Size() != local.Size() || (info.Mode().Perm()&0o111) != (local.Mode().Perm()&0o111) {
				return diff()
			}
			a, err := hashReleaseFile(original)
			if err != nil {
				return err
			}
			b, err := hashReleaseFile(name)
			if err != nil {
				return err
			}
			if a != b {
				return diff()
			}
			return nil
		})
		if err != nil {
			return err
		}
		if i == 0 {
			expected = files
		} else if !slices.Equal(expected, files) {
			return diff()
		}
	}
	return nil
}

func hashReleaseFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	sum := sha256.New()
	_, err = io.Copy(sum, file)
	return hex.EncodeToString(sum.Sum(nil)), err
}

func releaseCommand(ctx context.Context, env environment, opts options) (result, error) {
	args := opts.positionals[1:]
	for flag := range opts.flags {
		if flag != "json" {
			return result{}, fmt.Errorf("update не принимает --%s", flag)
		}
	}
	exe, err := os.Executable()
	if err != nil {
		return result{}, err
	}
	source := loadedReleaseSource(env, exe)
	if len(args) == 1 && args[0] == "source" {
		return result{data: source, text: fmt.Sprintf("%s %s — %s", source.Source, source.Version, source.Executable)}, nil
	}
	if source.Source != "zip" {
		return result{}, fmt.Errorf("запущен %s (%s); используйте механизм обновления этого источника", source.Source, source.Executable)
	}
	if source.Active != source.Version {
		return result{}, fmt.Errorf("запущенная версия %s не совпадает с активной %s. Откройте новый чат или запустите %s", source.Version, source.Active, source.Launcher)
	}
	client := releaseHTTP()
	if len(args) == 0 || (len(args) == 1 && args[0] == "check") {
		info, err := previewRelease(ctx, client, source)
		if err != nil {
			return result{}, err
		}
		text := fmt.Sprintf("Paradev Agent Tools %s (%s) — актуально. GitHub Releases: %s.", info.Version, info.Root, info.Latest)
		if info.Status == "update-available" {
			text = fmt.Sprintf("Paradev Agent Tools (%s): %s → %s (%s).\nПосле подтверждения: %s --agent-cli update apply %s %s %s",
				info.Root, info.Version, info.Latest, info.Asset, shellSingleQuote(info.Launcher), info.Version, info.Latest, info.Digest)
		}
		if info.Previous != "" {
			text += fmt.Sprintf("\nОткат: %s --agent-cli update rollback %s %s", shellSingleQuote(info.Launcher), info.Version, info.Previous)
		}
		return result{data: info, text: text}, nil
	}
	apply := len(args) == 4 && args[0] == "apply"
	rollback := len(args) == 3 && args[0] == "rollback"
	if !apply && !rollback {
		return result{}, errors.New("нужно: update check | update apply FROM TO SHA256 | update rollback FROM TO")
	}
	to := args[2]
	err = withReleaseLock(source.Root, func() error {
		state, err := currentRelease(source.Root)
		if err != nil {
			return err
		}
		if state.Version != args[1] || state.Version != source.Version {
			return fmt.Errorf("активная версия изменилась (%s); повторите update check", state.Version)
		}
		if apply {
			return updateRelease(ctx, client, source.Root, state, to, args[3])
		}
		return rollbackRelease(source.Root, state, to)
	})
	if err != nil {
		return result{}, err
	}
	return result{data: releaseState{Version: to, Previous: source.Version},
		text: fmt.Sprintf("Активирована версия %s → %s в %s. Перезапустите клиент или откройте новый чат, который запустит MCP заново.", source.Version, to, source.Root)}, nil
}

func rollbackRelease(root string, state releaseState, to string) error {
	if to == "" || state.Previous != to {
		return errors.New("укажите точную предыдущую версию")
	}
	pkg := filepath.Join(root, "releases", to)
	if err := plainParents(filepath.Join(pkg, "plugin.json")); err != nil {
		return err
	}
	if err := validateReleasePackage(pkg, to); err != nil {
		return err
	}
	return activateRelease(root, releaseState{Version: to, Previous: state.Version})
}

// Release metadata checks should finish within a client tool call.
func checkedReleaseSource(ctx context.Context, source releaseSource) releaseSource {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	checked, err := previewRelease(ctx, releaseHTTP(), source)
	if err != nil {
		checked.CheckError = err.Error()
	}
	return checked
}
