package handler

import (
	"encoding/json"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// workspaceRoot returns the root directory for workspace file browsing.
// Defaults to ~/.multica/workspace if WORKSPACE_DIR is not set.
func workspaceRoot() string {
	if dir := os.Getenv("WORKSPACE_DIR"); dir != "" {
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "/tmp/multica-workspace"
	}
	return filepath.Join(home, ".multica", "workspace")
}

// safePath validates and resolves a relative path against the workspace root.
// Returns absolute path and true on success, or "" and false on traversal attempt.
func safePath(root, rel string) (string, bool) {
	if rel == "" || rel == "." {
		return root, true
	}
	// Clean and make relative
	rel = filepath.Clean("/" + rel)[1:] // strip leading /
	abs := filepath.Join(root, rel)

	// Verify the resolved path is inside root
	relToRoot, err := filepath.Rel(root, abs)
	if err != nil || strings.HasPrefix(relToRoot, "..") {
		return "", false
	}
	return abs, true
}

// ---------------------------------------------------------------------------
// Tree node types
// ---------------------------------------------------------------------------

// FileTreeNode represents a file or directory in the workspace tree.
type FileTreeNode struct {
	Name     string         `json:"name"`
	Path     string         `json:"path"`
	Type     string         `json:"type"` // "file" | "directory"
	Size     int64          `json:"size,omitempty"`
	ModTime  string         `json:"modTime,omitempty"`
	Children []FileTreeNode `json:"children,omitempty"`
}

// classifyFile returns a more specific type string based on file extension.
// For now we keep it simple — the frontend can classify further.
func classifyFile(name string, isDir bool) string {
	if isDir {
		return "directory"
	}
	return "file"
}

// buildFileTree recursively walks a directory and builds a FileTreeNode tree.
// Skips hidden files/dirs (starting with .) and common noise directories.
var skipDirs = map[string]bool{
	".git":         true,
	"node_modules": true,
	".next":        true,
	"__pycache__":  true,
	".venv":        true,
	"vendor":       true,
	"dist":         true,
	"build":        true,
}

func buildFileTree(root, relPath string, depth int) ([]FileTreeNode, error) {
	if depth > 10 {
		return nil, nil // prevent runaway recursion
	}

	absDir := filepath.Join(root, relPath)
	entries, err := os.ReadDir(absDir)
	if err != nil {
		return nil, err
	}

	nodes := make([]FileTreeNode, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".") && depth > 0 {
			continue
		}
		if entry.IsDir() && skipDirs[name] {
			continue
		}

		nodeRelPath := name
		if relPath != "" {
			nodeRelPath = relPath + "/" + name
		}

		info, err := entry.Info()
		if err != nil {
			continue
		}

		node := FileTreeNode{
			Name:    name,
			Path:    nodeRelPath,
			Type:    classifyFile(name, entry.IsDir()),
			Size:    info.Size(),
			ModTime: info.ModTime().UTC().Format(time.RFC3339),
		}

		if entry.IsDir() {
			children, err := buildFileTree(root, nodeRelPath, depth+1)
			if err != nil {
				slog.Warn("workspace tree: failed to read subdir", "path", nodeRelPath, "error", err)
				continue
			}
			node.Children = children
		}

		nodes = append(nodes, node)
	}

	// Sort: directories first, then files, alphabetical within each group
	sort.SliceStable(nodes, func(i, j int) bool {
		if nodes[i].Type != nodes[j].Type {
			return nodes[i].Type == "directory"
		}
		return strings.ToLower(nodes[i].Name) < strings.ToLower(nodes[j].Name)
	})

	return nodes, nil
}

// ---------------------------------------------------------------------------
// GET /api/workspace/tree — returns the full file tree
// ---------------------------------------------------------------------------

// GetWorkspaceTree returns the file tree for the workspace root or a subdirectory.
// Query params: path (optional, relative to workspace root)
func (h *Handler) GetWorkspaceTree(w http.ResponseWriter, r *http.Request) {
	root := workspaceRoot()

	// Ensure root exists
	if err := os.MkdirAll(root, 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create workspace directory")
		return
	}

	subPath := r.URL.Query().Get("path")
	dirPath, ok := safePath(root, subPath)
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid path")
		return
	}

	// Verify path exists and is a directory
	info, err := os.Stat(dirPath)
	if err != nil {
		writeError(w, http.StatusNotFound, "path not found")
		return
	}
	if !info.IsDir() {
		writeError(w, http.StatusBadRequest, "path is not a directory")
		return
	}

	children, err := buildFileTree(root, subPath, 0)
	if err != nil {
		slog.Error("workspace tree: failed to build tree", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to read directory")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"root":     root,
		"path":     subPath,
		"children": children,
	})
}

// ---------------------------------------------------------------------------
// GET /api/workspace/file?path=... — returns raw file content
// ---------------------------------------------------------------------------

// GetWorkspaceFile returns the raw content of a file in the workspace.
// Query params: path (required, relative to workspace root)
func (h *Handler) GetWorkspaceFile(w http.ResponseWriter, r *http.Request) {
	root := workspaceRoot()
	subPath := r.URL.Query().Get("path")
	if subPath == "" {
		writeError(w, http.StatusBadRequest, "path is required")
		return
	}

	filePath, ok := safePath(root, subPath)
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid path")
		return
	}

	// Stat first to check size and type
	info, err := os.Stat(filePath)
	if err != nil {
		writeError(w, http.StatusNotFound, "file not found")
		return
	}
	if info.IsDir() {
		writeError(w, http.StatusBadRequest, "path is a directory, use /api/workspace/tree")
		return
	}

	// Limit to 2MB for inline display
	const maxSize = 2 * 1024 * 1024
	if info.Size() > maxSize {
		writeError(w, http.StatusRequestEntityTooLarge, "file too large for inline display")
		return
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		slog.Error("workspace file: read failed", "path", subPath, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to read file")
		return
	}

	// Detect content type
	contentType := detectFileContentType(filePath, data)

	writeJSON(w, http.StatusOK, map[string]any{
		"path":        subPath,
		"content":     string(data),
		"contentType": contentType,
		"size":        info.Size(),
		"modTime":     info.ModTime().UTC().Format(time.RFC3339),
	})
}

// detectFileContentType returns a content type string for file rendering hints.
func detectFileContentType(path string, data []byte) string {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".md", ".mdx":
		return "text/markdown"
	case ".json":
		return "application/json"
	case ".yaml", ".yml":
		return "text/yaml"
	case ".toml":
		return "text/toml"
	case ".go":
		return "text/x-go"
	case ".py":
		return "text/x-python"
	case ".js", ".mjs":
		return "text/javascript"
	case ".ts", ".tsx":
		return "text/typescript"
	case ".rs":
		return "text/x-rust"
	case ".sh", ".bash":
		return "text/x-shellscript"
	case ".html", ".htm":
		return "text/html"
	case ".css":
		return "text/css"
	case ".svg":
		return "image/svg+xml"
	case ".csv":
		return "text/csv"
	case ".sql":
		return "text/x-sql"
	case ".xml":
		return "text/xml"
	case ".txt", ".env", ".gitignore", ".dockerignore":
		return "text/plain"
	default:
		// Heuristic: if it looks like text, say so
		if isTextContent(data) {
			return "text/plain"
		}
		return "application/octet-stream"
	}
}

// isTextContent does a quick check whether data appears to be text.
func isTextContent(data []byte) bool {
	if len(data) == 0 {
		return true
	}
	// Check first 512 bytes for null bytes
	check := data
	if len(check) > 512 {
		check = check[:512]
	}
	for _, b := range check {
		if b == 0 {
			return false
		}
	}
	return true
}

// ---------------------------------------------------------------------------
// GET /api/workspace/stats — directory stats (file count, total size)
// ---------------------------------------------------------------------------

type WorkspaceStats struct {
	FileCount  int    `json:"fileCount"`
	DirCount   int    `json:"dirCount"`
	TotalSize  int64  `json:"totalSize"`
	LastModTime string `json:"lastModTime,omitempty"`
}

func (h *Handler) GetWorkspaceStats(w http.ResponseWriter, r *http.Request) {
	root := workspaceRoot()

	if _, err := os.Stat(root); os.IsNotExist(err) {
		writeJSON(w, http.StatusOK, WorkspaceStats{})
		return
	}

	var stats WorkspaceStats
	var latestMod time.Time

	filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		name := d.Name()
		if strings.HasPrefix(name, ".") && path != root {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() && skipDirs[name] {
			return filepath.SkipDir
		}

		if d.IsDir() {
			stats.DirCount++
		} else {
			stats.FileCount++
			info, err := d.Info()
			if err == nil {
				stats.TotalSize += info.Size()
				if info.ModTime().After(latestMod) {
					latestMod = info.ModTime()
				}
			}
		}
		return nil
	})

	if !latestMod.IsZero() {
		stats.LastModTime = latestMod.UTC().Format(time.RFC3339)
	}

	writeJSON(w, http.StatusOK, stats)
}

// ---------------------------------------------------------------------------
// GET /api/workspace/search?q=... — file name search
// ---------------------------------------------------------------------------

func (h *Handler) SearchWorkspaceFiles(w http.ResponseWriter, r *http.Request) {
	root := workspaceRoot()
	query := strings.ToLower(r.URL.Query().Get("q"))
	if query == "" {
		writeJSON(w, http.StatusOK, []FileTreeNode{})
		return
	}

	// Limit results
	const maxResults = 50
	var results []FileTreeNode

	filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if len(results) >= maxResults {
			return filepath.SkipAll
		}

		name := d.Name()
		if strings.HasPrefix(name, ".") && path != root {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() && skipDirs[name] {
			return filepath.SkipDir
		}

		if strings.Contains(strings.ToLower(name), query) {
			relPath, _ := filepath.Rel(root, path)
			node := FileTreeNode{
				Name: name,
				Path: relPath,
				Type: classifyFile(name, d.IsDir()),
			}
			if info, err := d.Info(); err == nil {
				node.Size = info.Size()
				node.ModTime = info.ModTime().UTC().Format(time.RFC3339)
			}
			results = append(results, node)
		}
		return nil
	})

	writeJSON(w, http.StatusOK, results)
}

// ---------------------------------------------------------------------------
// Format file sizes
// ---------------------------------------------------------------------------

// marshalJSON is a helper to encode JSON responses for complex types.
func marshalJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
