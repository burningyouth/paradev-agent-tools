package agent

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	bundle "github.com/burningyouth/paradev-agent-tools"
	"golang.org/x/sys/unix"
)

var releaseVersion = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

func releasePlatform(goos, arch string) (string, error) {
	if (goos == "darwin" || goos == "linux") && (arch == "amd64" || arch == "arm64") {
		return goos + "-" + arch, nil
	}
	return "", fmt.Errorf("для %s/%s ZIP не выпускается; поддерживаются macOS и Linux на arm64/amd64", goos, arch)
}

func managedRoot(env environment) string {
	return filepath.Join(canonicalPath(env.home), ".local", "share", productName)
}

type releaseState struct {
	Version  string `json:"version"`
	Previous string `json:"previous,omitempty"`
}

func currentRelease(root string) (releaseState, error) {
	var state releaseState
	if err := plainParents(filepath.Join(root, "current")); err != nil {
		return state, err
	}
	target, err := os.Readlink(filepath.Join(root, "current"))
	if err != nil {
		return state, err
	}
	version, previous, ok := strings.Cut(filepath.Base(target), "_")
	if !ok || !releaseVersion.MatchString(version) ||
		previous != "" && (!releaseVersion.MatchString(previous) || previous == version) ||
		target != filepath.Join("activations", version+"_"+previous) {
		return state, fmt.Errorf("неизвестная конфигурация ZIP в %s", root)
	}
	pkg := filepath.Join(root, "releases", version)
	if err := plainParents(filepath.Join(pkg, "plugin.json")); err != nil {
		return state, err
	}
	packageLink := filepath.Join(root, target, "package")
	if err := plainParents(packageLink); err != nil {
		return state, err
	}
	link, err := os.Readlink(packageLink)
	if err != nil || link != filepath.Join("..", "..", "releases", version) {
		return state, fmt.Errorf("повреждена ссылка на пакет в %s", root)
	}
	if err := validateReleasePackage(pkg, version); err != nil {
		return state, err
	}
	return releaseState{Version: version, Previous: previous}, nil
}

func validateReleasePackage(pkg, version string) error {
	manifest, err := readClientPackage(pkg)
	if err != nil || manifest.Name != productName || manifest.Version != version {
		return fmt.Errorf("в %s ожидался пакет %s %s", pkg, productName, version)
	}
	platform, err := releasePlatform(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return err
	}
	for _, path := range []string{"launch", "bin/" + platform + "/paradev-agent", "bin/" + platform + "/codex"} {
		info, err := os.Lstat(filepath.Join(pkg, path))
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
			return fmt.Errorf("в пакете отсутствует исполняемый файл %s", path)
		}
	}
	for _, path := range []string{"mcp.json", "skills/" + productName + "/SKILL.md", "skills/paradev-agent-update/SKILL.md"} {
		info, err := os.Lstat(filepath.Join(pkg, path))
		if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
			return fmt.Errorf("в пакете отсутствует %s", path)
		}
	}
	return nil
}

func withReleaseLock(root string, action func() error) error {
	return withPackageLock(filepath.Join(root, "update.lock"), action)
}

func withPackageLock(lock string, action func() error) error {
	if err := plainParents(lock); err != nil {
		return err
	}
	fd, err := unix.Open(lock, unix.O_CREAT|unix.O_RDWR|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0o600)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	var info unix.Stat_t
	if err := unix.Fstat(fd, &info); err != nil || info.Mode&unix.S_IFMT != unix.S_IFREG {
		return fmt.Errorf("некорректная блокировка ZIP: %s", lock)
	}
	if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return fmt.Errorf("не удалось заблокировать ZIP-установку %s: %w", lock, err)
	}
	return action()
}

// A single rename switches the package and its rollback target together.
func activateRelease(root string, state releaseState) error {
	target := filepath.Join("activations", state.Version+"_"+state.Previous)
	packageLink := filepath.Join(root, target, "package")
	if err := plainParents(packageLink); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(packageLink), 0o700); err != nil {
		return err
	}
	if err := ensureReleaseLink(packageLink, filepath.Join("..", "..", "releases", state.Version)); err != nil {
		return err
	}
	next := filepath.Join(root, ".current-"+uuid())
	if err := os.Symlink(target, next); err != nil {
		return err
	}
	defer os.Remove(next)
	return os.Rename(next, filepath.Join(root, "current"))
}

func ensureReleaseLink(path, target string) error {
	if err := plainParents(path); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if err := os.Symlink(target, path); errors.Is(err, fs.ErrExist) {
		if existing, err := os.Readlink(path); err == nil && existing == target {
			return nil
		}
		return fmt.Errorf("путь уже используется: %s", path)
	} else {
		return err
	}
}

func prepareReleaseInstall(root, source string) error {
	if err := plainParents(filepath.Join(root, "current")); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(root), 0o700); err != nil {
		return err
	}
	lock := filepath.Join(filepath.Dir(root), "."+productName+".install.lock")
	return withPackageLock(lock, func() error { return prepareReleaseInstallLocked(root, source) })
}

func prepareReleaseInstallLocked(root, source string) error {
	if err := plainParents(filepath.Join(root, "current")); err != nil {
		return err
	}
	manifest, err := readClientPackage(source)
	if err != nil || !releaseVersion.MatchString(manifest.Version) {
		return fmt.Errorf("некорректная версия ZIP-пакета: %s", source)
	}
	if err := validateReleasePackage(source, manifest.Version); err != nil {
		return err
	}
	if _, err := os.Lstat(root); err == nil {
		return withReleaseLock(root, func() error {
			state, err := currentRelease(root)
			if err != nil {
				return fmt.Errorf("путь уже используется: %s: %w", root, err)
			}
			if state.Version != manifest.Version {
				return fmt.Errorf("уже установлена версия %s. Для смены версии используйте %s --agent-cli update check", state.Version, filepath.Join(root, "launch"))
			}
			return nil
		})
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}

	staging, err := os.MkdirTemp(filepath.Dir(root), "."+productName+"-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	if err := os.Mkdir(filepath.Join(staging, "releases"), 0o700); err != nil {
		return err
	}
	if err := copyClientTree(source, filepath.Join(staging, "releases", manifest.Version)); err != nil {
		return err
	}
	for _, entry := range []string{"launch", "paradev-agent"} {
		script, err := bundle.Files.ReadFile("mcp/managed/" + entry)
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(staging, entry), script, 0o755); err != nil {
			return err
		}
	}
	if err := activateRelease(staging, releaseState{Version: manifest.Version}); err != nil {
		return err
	}
	return os.Rename(staging, root)
}

func packageDirectory(exe string) string {
	return filepath.Dir(filepath.Dir(filepath.Dir(canonicalPath(exe))))
}

func releaseForExecutable(env environment, exe string) (string, string) {
	root := managedRoot(env)
	pkg := packageDirectory(exe)
	version := filepath.Base(pkg)
	platform, err := releasePlatform(runtime.GOOS, runtime.GOARCH)
	if err != nil || filepath.Dir(pkg) != filepath.Join(root, "releases") || !releaseVersion.MatchString(version) ||
		canonicalPath(exe) != filepath.Join(pkg, "bin", platform, "paradev-agent") {
		return "", ""
	}
	return root, version
}
