package main

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	_ "embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"time"
)

//go:embed launch.sh
var launcher []byte

//go:embed opencode.js
var openCodeAdapter []byte

var (
	pluginName = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
	versionID  = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)
	targets    = []string{"darwin-arm64", "linux-amd64"}
)

type manifest struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	Description string `json:"description"`
}

type options struct {
	source, output, goPackage, binaries string
}

func main() {
	var opts options
	flag.StringVar(&opts.source, "source", "", "Plugin payload directory containing plugin.json")
	flag.StringVar(&opts.output, "out", "", "New output directory for the release")
	flag.StringVar(&opts.goPackage, "go-package", "", "Go main package to cross-compile from the current module")
	flag.StringVar(&opts.binaries, "bin-dir", "", "Directory containing prebuilt executables named by target")
	flag.Parse()
	if flag.NArg() != 0 {
		flag.Usage()
		os.Exit(2)
	}
	if err := pack(opts); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func pack(opts options) error {
	if opts.source == "" || opts.output == "" || (opts.goPackage != "" && opts.binaries != "") {
		return errors.New("usage: pack -source DIR -out NEW_DIR [-go-package PACKAGE | -bin-dir DIR]")
	}
	source, err := filepath.EvalSymlinks(opts.source)
	if err != nil {
		return err
	}
	source, err = filepath.Abs(source)
	if err != nil {
		return err
	}
	payload := os.DirFS(source)
	manifestJSON, err := fs.ReadFile(payload, "plugin.json")
	if err != nil {
		return err
	}
	var plugin manifest
	if err := json.Unmarshal(manifestJSON, &plugin); err != nil {
		return err
	}
	if !pluginName.MatchString(plugin.Name) || len(plugin.Name) > 64 || !versionID.MatchString(plugin.Version) || strings.TrimSpace(plugin.Description) == "" {
		return errors.New("plugin.json requires a name in kebab-case (up to 64 characters), a version X.Y.Z, and a description")
	}
	// Copy regular files only so a release can never follow a payload symlink.
	if err := fs.WalkDir(payload, ".", func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if !entry.IsDir() && !entry.Type().IsRegular() {
			return fmt.Errorf("payload entry %s must be a regular file or directory", name)
		}
		return nil
	}); err != nil {
		return err
	}
	output, err := filepath.Abs(opts.output)
	if err != nil {
		return err
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(output))
	if err != nil {
		return fmt.Errorf("output parent directory: %w", err)
	}
	output = filepath.Join(parent, filepath.Base(output))
	relative, err := filepath.Rel(source, output)
	if err != nil {
		return err
	}
	if relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(os.PathSeparator))) {
		return errors.New("output directory must be outside the plugin payload")
	}
	if err := os.Mkdir(output, 0o755); err != nil {
		return err
	}
	complete := false
	defer func() {
		if !complete {
			os.RemoveAll(output)
		}
	}()

	distribution := filepath.Join(output, "distribution")
	pluginDir := filepath.Join(distribution, "plugins", plugin.Name)
	if err := os.MkdirAll(pluginDir, 0o755); err != nil {
		return err
	}
	if err := os.CopyFS(pluginDir, payload); err != nil {
		return err
	}
	if opts.goPackage != "" || opts.binaries != "" {
		if err := installBinaries(opts, plugin, pluginDir); err != nil {
			return err
		}
	}
	if err := writeAdapters(distribution, plugin); err != nil {
		return err
	}
	archive := filepath.Join(output, plugin.Name+"-"+plugin.Version+".tar.gz")
	if err := writeArchive(distribution, archive, plugin.Name); err != nil {
		return err
	}
	complete = true
	fmt.Println(output)
	return nil
}

func installBinaries(opts options, plugin manifest, destination string) error {
	binDir := filepath.Join(destination, "bin")
	if err := os.Mkdir(binDir, 0o755); err != nil {
		return err
	}
	for _, target := range targets {
		binary := filepath.Join(binDir, target)
		if opts.goPackage != "" {
			goos, goarch, _ := strings.Cut(target, "-")
			goBinary := filepath.Join(runtime.GOROOT(), "bin", "go")
			command := exec.Command(goBinary, "build", "-mod=readonly", "-trimpath", "-buildvcs=false", "-ldflags", "-X main.version="+plugin.Version, "-o", binary, opts.goPackage)
			env := slices.DeleteFunc(os.Environ(), func(value string) bool {
				key, _, _ := strings.Cut(value, "=")
				return key == "GOOS" || key == "GOARCH" || key == "CGO_ENABLED"
			})
			command.Env = append(env, "GOOS="+goos, "GOARCH="+goarch, "CGO_ENABLED=0")
			command.Stderr = os.Stderr
			if err := command.Run(); err != nil {
				return fmt.Errorf("build %s: %w", target, err)
			}
		} else {
			content, err := os.ReadFile(filepath.Join(opts.binaries, target))
			if err != nil {
				return err
			}
			if err := os.WriteFile(binary, content, 0o755); err != nil {
				return err
			}
		}
	}
	file, err := os.OpenFile(filepath.Join(destination, "launch"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o755)
	if err != nil {
		return err
	}
	_, err = file.Write(launcher)
	return errors.Join(err, file.Close())
}

func writeAdapters(distribution string, plugin manifest) error {
	marketplaceDir := filepath.Join(distribution, ".agents", "plugins")
	if err := os.MkdirAll(marketplaceDir, 0o755); err != nil {
		return err
	}
	marketplace := map[string]any{
		"name": plugin.Name + "-marketplace",
		"plugins": []map[string]any{{
			"name":   plugin.Name,
			"source": map[string]string{"source": "local", "path": "./plugins/" + plugin.Name},
			"policy": map[string]string{"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
		}},
	}
	if err := writeJSON(filepath.Join(marketplaceDir, "marketplace.json"), marketplace); err != nil {
		return err
	}
	openCode := map[string]any{
		"name":        plugin.Name,
		"version":     plugin.Version,
		"description": plugin.Description,
		"private":     true,
		"type":        "module",
		"main":        "./index.js",
		"files":       []string{"index.js", "plugins"},
	}
	if err := writeJSON(filepath.Join(distribution, "package.json"), openCode); err != nil {
		return err
	}
	adapter := strings.ReplaceAll(string(openCodeAdapter), "@PLUGIN_NAME@", plugin.Name)
	return os.WriteFile(filepath.Join(distribution, "index.js"), []byte(adapter), 0o644)
}

func writeJSON(destination string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(destination, append(data, '\n'), 0o644)
}

func writeArchive(source, destination, prefix string) error {
	file, err := os.Create(destination)
	if err != nil {
		return err
	}
	digest := sha256.New()
	compressed := gzip.NewWriter(io.MultiWriter(file, digest))
	archive := tar.NewWriter(compressed)
	tree := os.DirFS(source)
	err = fs.WalkDir(tree, ".", func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		header, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		header.Name = path.Join(prefix, name)
		header.ModTime = time.Unix(0, 0)
		header.Uid, header.Gid, header.Uname, header.Gname = 0, 0, "", ""
		header.AccessTime, header.ChangeTime = time.Time{}, time.Time{}
		if err := archive.WriteHeader(header); err != nil || entry.IsDir() {
			return err
		}
		input, err := tree.Open(name)
		if err != nil {
			return err
		}
		_, err = io.Copy(archive, input)
		return errors.Join(err, input.Close())
	})
	if err := errors.Join(err, archive.Close(), compressed.Close(), file.Close()); err != nil {
		return err
	}
	sum := fmt.Sprintf("%x  %s\n", digest.Sum(nil), filepath.Base(destination))
	return os.WriteFile(destination+".sha256", []byte(sum), 0o644)
}
