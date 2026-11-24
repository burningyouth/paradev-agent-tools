// Command pack builds the native installer and client distribution archives.
package main

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const name = "paradev-agent-tools"
const title = "Paradev Agent Tools"

type releaseManifest struct {
	Name, Version, Description string
}

func main() {
	clients := flag.String("clients", "", "additional client distribution tar.gz")
	flag.Parse()
	if err := build(*clients, flag.Args()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func build(clients string, args []string) error {
	if len(args) > 1 {
		return errors.New("укажите один путь к архиву установщика")
	}
	var manifest releaseManifest
	data, err := os.ReadFile("mcp/plugin.json")
	if err != nil {
		return err
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		return err
	}
	if manifest.Name != name || !regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`).MatchString(manifest.Version) {
		return errors.New("проверьте имя и версию в mcp/plugin.json")
	}
	archive := filepath.Join("dist", name+"-"+manifest.Version+".tar.gz")
	if len(args) == 1 {
		archive = args[0]
	}
	archive, err = filepath.Abs(archive)
	if err != nil {
		return err
	}
	if clients != "" {
		clients, err = filepath.Abs(clients)
		if err != nil {
			return err
		}
		if clients == archive {
			return errors.New("укажите разные пути к архивам")
		}
	}
	temp, err := os.MkdirTemp("", "paradev-agent-tools-build-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temp)
	distribution := filepath.Join(temp, title)
	plugin := filepath.Join(distribution, name)
	for _, pair := range [][2]string{
		{"LICENSE", "LICENSE"}, {"README.md", "README.md"}, {"AGENTS.md", "AGENTS.md"},
		{"skills", "skills"}, {"docs", "docs"}, {"examples/agent-cli", "examples/agent-cli"},
		{"examples/plugin-kit/README.md", "examples/plugin-kit/README.md"},
		{"mcp/launch", "launch"}, {"mcp/plugin.json", "plugin.json"}, {"mcp/mcp.json", "mcp.json"},
		{"mcp/assets", "assets"}, {"mcp/SKILL.md", "skills/multi-agent-mcp/SKILL.md"},
	} {
		if err := copyTree(pair[0], filepath.Join(plugin, pair[1])); err != nil {
			return err
		}
	}
	if err := os.Chmod(filepath.Join(plugin, "launch"), 0o755); err != nil {
		return err
	}
	for _, platform := range []string{"darwin-arm64", "darwin-amd64", "linux-amd64", "linux-arm64"} {
		goos, goarch, _ := strings.Cut(platform, "-")
		folder := filepath.Join(plugin, "bin", platform)
		if err := os.MkdirAll(folder, 0o755); err != nil {
			return err
		}
		for _, command := range []string{"paradev-agent", "codex"} {
			job := exec.Command("go", "build", "-trimpath", "-buildvcs=false", "-ldflags=-s -w", "-o", filepath.Join(folder, command), "./cmd/"+command)
			job.Env = append(os.Environ(), "GOOS="+goos, "GOARCH="+goarch, "CGO_ENABLED=0")
			job.Stdout, job.Stderr = os.Stderr, os.Stderr
			if err := job.Run(); err != nil {
				return fmt.Errorf("build %s for %s: %w", command, platform, err)
			}
		}
	}
	if err := addLicenses(filepath.Join(plugin, "licenses")); err != nil {
		return err
	}
	for _, file := range []string{"Install.command", "Install.sh"} {
		path := filepath.Join(distribution, file)
		if err := copyTree("mcp/install-entry.sh", path); err != nil {
			return err
		}
		if err := os.Chmod(path, 0o755); err != nil {
			return err
		}
	}
	if err := copyTree("LICENSE", filepath.Join(distribution, "LICENSE")); err != nil {
		return err
	}
	if err := copyTree("docs/multi-agent-mcp.md", filepath.Join(distribution, "Установка и проверка.md")); err != nil {
		return err
	}
	if clients != "" {
		root := filepath.Join(temp, "clients")
		if err := buildClients(root, plugin, manifest); err != nil {
			return err
		}
		if err := writeArchive(clients, root, ".agents", "LICENSE", "opencode.js", "package.json", "plugins"); err != nil {
			return err
		}
	}
	if err := writeArchive(archive, temp, title); err != nil {
		return err
	}
	fmt.Println(archive)
	if clients != "" {
		fmt.Println(clients)
	}
	return nil
}

func addLicenses(dest string) error {
	goroot, err := exec.Command("go", "env", "GOROOT").Output()
	if err != nil {
		return err
	}
	for _, file := range []string{"LICENSE", "PATENTS"} {
		if err := copyTree(filepath.Join(strings.TrimSpace(string(goroot)), file), filepath.Join(dest, "go", file)); err != nil {
			return err
		}
	}
	list, err := exec.Command("go", "list", "-deps", "-f",
		`{{with .Module}}{{if and (not .Main) .Dir}}{{.Path}}{{"\t"}}{{.Dir}}{{end}}{{end}}`,
		"./cmd/paradev-agent", "./cmd/codex").CombinedOutput()
	if err != nil {
		return fmt.Errorf("go list -deps: %w\n%s", err, list)
	}
	seen := map[string]bool{}
	for line := range strings.SplitSeq(string(list), "\n") {
		module, root, ok := strings.Cut(line, "\t")
		if !ok || seen[module] {
			continue
		}
		seen[module] = true
		files, err := os.ReadDir(root)
		if err != nil {
			return err
		}
		for _, entry := range files {
			file := entry.Name()
			switch key := strings.ToUpper(file); {
			case strings.HasPrefix(key, "LICENSE"), strings.HasPrefix(key, "NOTICE"), strings.HasPrefix(key, "COPYING"), key == "PATENTS":
				if !entry.IsDir() {
					if err := copyTree(filepath.Join(root, file), filepath.Join(dest, filepath.FromSlash(module), file)); err != nil {
						return err
					}
				}
			}
		}
	}
	return nil
}

func buildClients(root, plugin string, manifest releaseManifest) error {
	const pluginPath = "plugins/" + name
	for _, pair := range [][2]string{{plugin, pluginPath}, {"LICENSE", "LICENSE"}, {"mcp/opencode.js", "opencode.js"}} {
		if err := copyTree(pair[0], filepath.Join(root, pair[1])); err != nil {
			return err
		}
	}
	if err := saveJSON(filepath.Join(root, "package.json"), map[string]any{
		"name": name + "-opencode", "version": manifest.Version, "private": true, "type": "module", "license": "MIT",
		"description": manifest.Description, "exports": map[string]string{".": "./opencode.js"},
		"files": []string{"opencode.js", "plugins"}, "dependencies": map[string]string{"@opencode/plugin": "~2.3.1"},
	}); err != nil {
		return err
	}
	return saveJSON(filepath.Join(root, ".agents", "plugins", "marketplace.json"), map[string]any{
		"name": "burningyouth", "interface": map[string]string{"displayName": "burningyouth"},
		"plugins": []any{map[string]any{
			"name": manifest.Name, "source": map[string]string{"source": "local", "path": "./" + pluginPath},
			"policy": map[string]string{"installation": "AVAILABLE", "authentication": "ON_INSTALL"}, "category": "Productivity",
		}},
	})
}

func saveJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}

func copyTree(source, destination string) error {
	return filepath.WalkDir(source, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		target := filepath.Join(destination, relative)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("ожидался обычный файл: %s", path)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		return copyFile(path, target, info.Mode().Perm())
	})
}

func copyFile(source, target string, mode fs.FileMode) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	return errors.Join(err, out.Close())
}

func writeArchive(destination, root string, paths ...string) error {
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(destination), ".archive-*.tar.gz")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	gz := gzip.NewWriter(file)
	tw := tar.NewWriter(gz)
	for _, part := range paths {
		err = filepath.WalkDir(filepath.Join(root, part), func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			relative, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			header, err := tar.FileInfoHeader(info, "")
			if err != nil {
				return err
			}
			header.Name = filepath.ToSlash(relative)
			header.ModTime = time.Unix(0, 0)
			header.Uid, header.Gid, header.Uname, header.Gname = 0, 0, "", ""
			if err := tw.WriteHeader(header); err != nil {
				return err
			}
			if !info.Mode().IsRegular() {
				return nil
			}
			source, err := os.Open(path)
			if err != nil {
				return err
			}
			_, err = io.Copy(tw, source)
			return errors.Join(err, source.Close())
		})
		if err != nil {
			break
		}
	}
	if err := errors.Join(err, tw.Close(), gz.Close(), file.Close()); err != nil {
		return err
	}
	if err := os.Chmod(file.Name(), 0o644); err != nil {
		return err
	}
	return os.Rename(file.Name(), destination)
}
