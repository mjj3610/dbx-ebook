package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// dirExists 目录是否存在
func dirExists(path string) bool {
	if path == "" {
		return false
	}
	stat, err := os.Stat(path)
	return err == nil && stat.IsDir()
}

// fileExists 文件是否存在
func fileExists(path string) bool {
	if path == "" {
		return false
	}
	stat, err := os.Stat(path)
	return err == nil && !stat.IsDir()
}

// isWritable 实际写一个探测文件确认目录可写（比权限位判断可靠，Windows 上尤其）
func isWritable(dir string) bool {
	if dir == "" {
		return false
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false
	}
	probe := filepath.Join(dir, ".dbx-write-test")
	if err := os.WriteFile(probe, []byte("ok"), 0o644); err != nil {
		return false
	}
	_ = os.Remove(probe)
	return true
}

// copyFile 复制文件（自动创建目标目录）
func copyFile(from, to string) error {
	if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		return err
	}
	source, err := os.Open(from)
	if err != nil {
		return err
	}
	defer source.Close()
	target, err := os.Create(to)
	if err != nil {
		return err
	}
	defer target.Close()
	if _, err := io.Copy(target, source); err != nil {
		return err
	}
	return target.Sync()
}

// expandUser 把 ~ / ~/xxx 展开成用户主目录；其余原样返回
func expandUser(path string) string {
	if path == "~" || strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		home, err := os.UserHomeDir()
		if err != nil {
			return path
		}
		if len(path) <= 2 {
			return home
		}
		return filepath.Join(home, path[2:])
	}
	// Windows 下用户常写成 %USERPROFILE%\Books
	if strings.Contains(path, "%") {
		return os.ExpandEnv(path)
	}
	return path
}

// ensureInside 防御性校验：结果路径必须落在 base 之内
func ensureInside(base, target string) (string, error) {
	absBase, err := filepath.Abs(base)
	if err != nil {
		return "", err
	}
	absTarget, err := filepath.Abs(target)
	if err != nil {
		return "", err
	}
	if absTarget != absBase && !strings.HasPrefix(absTarget, absBase+string(os.PathSeparator)) {
		return "", fmt.Errorf("路径越界：%s", target)
	}
	return absTarget, nil
}
