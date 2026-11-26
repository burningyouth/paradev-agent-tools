package main

import (
	"archive/zip"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var platforms = []string{"darwin-arm64", "darwin-amd64", "linux-amd64", "linux-arm64"}

func writePlatformZIPs(dest, plugin string) error {
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	for _, platform := range platforms {
		file := filepath.Join(dest, name+"-"+platform+".zip")
		if err := writePlatformZIP(file, plugin, platform); err != nil {
			return err
		}
	}
	return nil
}

func writePlatformZIP(dest, plugin, platform string) error {
	file, err := os.CreateTemp(filepath.Dir(dest), ".platform-*.zip")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	z := zip.NewWriter(file)
	err = addZIPFile(z, "mcp/install-zip.sh", "Install.sh", 0o755)
	if err == nil {
		err = addZIPFile(z, "LICENSE", "LICENSE", 0o644)
	}
	if err == nil {
		err = filepath.WalkDir(plugin, func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			rel, err := filepath.Rel(plugin, path)
			if err != nil {
				return err
			}
			rel = filepath.ToSlash(rel)
			if entry.IsDir() {
				if dir, ok := strings.CutPrefix(rel, "bin/"); ok && dir != platform {
					return filepath.SkipDir
				}
				return nil
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			return addZIPFile(z, path, name+"/"+rel, info.Mode())
		})
	}
	if err := errors.Join(err, z.Close(), file.Close()); err != nil {
		return err
	}
	if err := os.Chmod(file.Name(), 0o644); err != nil {
		return err
	}
	return os.Rename(file.Name(), dest)
}

func addZIPFile(z *zip.Writer, path, name string, mode fs.FileMode) error {
	in, err := os.Open(path)
	if err != nil {
		return err
	}
	defer in.Close()
	header := &zip.FileHeader{Name: name, Method: zip.Deflate}
	header.SetMode(mode)
	header.SetModTime(time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC))
	out, err := z.CreateHeader(header)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	return err
}
