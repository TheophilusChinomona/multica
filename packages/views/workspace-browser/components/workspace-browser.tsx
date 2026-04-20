"use client";

import { useState, useCallback, useEffect } from "react";
import {
  ChevronRight,
  ChevronDown,
  FileText,
  FileCode,
  FileImage,
  FileVideo,
  FileAudio,
  File,
  Folder,
  FolderOpen,
  Search,
  RefreshCw,
} from "lucide-react";
import { cn } from "@multica/ui/lib/utils";
import { Input } from "@multica/ui/components/ui/input";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import type { FileTreeNode } from "@multica/core/types";

// ---------------------------------------------------------------------------
// File type classification
// ---------------------------------------------------------------------------

function getNodeIcon(node: FileTreeNode, expanded?: boolean) {
  if (node.type === "directory") {
    return expanded ? FolderOpen : Folder;
  }

  const ext = node.name.split(".").pop()?.toLowerCase() ?? "";
  const name = node.name.toLowerCase();

  // Markdown
  if (ext === "md" || ext === "mdx") return FileText;

  // Code files
  if (["ts", "tsx", "js", "jsx", "go", "py", "rs", "java", "c", "cpp", "h", "rb", "php", "sh", "yaml", "yml", "json", "toml", "xml", "sql", "css", "html"].includes(ext)) {
    return FileCode;
  }

  // Images
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp"].includes(ext)) {
    return FileImage;
  }

  // Video
  if (["mp4", "webm", "mov", "avi", "mkv"].includes(ext)) {
    return FileVideo;
  }

  // Audio
  if (["mp3", "wav", "ogg", "flac", "aac", "m4a"].includes(ext)) {
    return FileAudio;
  }

  // Config files
  if (["env", "gitignore", "dockerignore", "editorconfig", "prettierrc", "eslintrc"].some((e) => name.includes(e))) {
    return FileCode;
  }

  return File;
}

function getFileColor(node: FileTreeNode): string {
  if (node.type === "directory") return "text-muted-foreground";

  const ext = node.name.split(".").pop()?.toLowerCase() ?? "";
  const name = node.name.toLowerCase();

  if (ext === "md" || ext === "mdx") return "text-blue-400";
  if (["ts", "tsx"].includes(ext)) return "text-blue-500";
  if (["js", "jsx", "mjs"].includes(ext)) return "text-yellow-500";
  if (ext === "go") return "text-cyan-400";
  if (ext === "py") return "text-green-400";
  if (ext === "rs") return "text-orange-400";
  if (ext === "json") return "text-yellow-400";
  if (["yaml", "yml", "toml"].includes(ext)) return "text-purple-400";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext)) return "text-pink-400";
  if (["env", "gitignore", "dockerignore"].some((e) => name.includes(e))) return "text-gray-500";

  return "text-muted-foreground";
}

function formatSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

// ---------------------------------------------------------------------------
// Tree node component
// ---------------------------------------------------------------------------

function TreeNodeItem({
  node,
  selectedPath,
  onSelect,
  expandedPaths,
  onToggleExpand,
  depth = 0,
}: {
  node: FileTreeNode;
  selectedPath: string;
  onSelect: (path: string) => void;
  expandedPaths: Set<string>;
  onToggleExpand: (path: string) => void;
  depth?: number;
}) {
  const isSelected = node.path === selectedPath;
  const isExpanded = expandedPaths.has(node.path);

  if (node.type === "directory") {
    const Icon = getNodeIcon(node, isExpanded);
    const ChevronIcon = isExpanded ? ChevronDown : ChevronRight;
    const childCount = node.children?.length ?? 0;

    return (
      <div>
        <button
          onClick={() => onToggleExpand(node.path)}
          className={cn(
            "flex w-full items-center gap-1 py-[3px] text-left text-[13px] rounded-sm transition-colors",
            isSelected
              ? "bg-accent text-accent-foreground"
              : "hover:bg-accent/50 text-foreground",
          )}
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          <ChevronIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
          <Icon className={cn("h-3.5 w-3.5 shrink-0", getFileColor(node))} />
          <span className="truncate flex-1">{node.name}</span>
          {childCount > 0 && (
            <span className="text-[10px] text-muted-foreground mr-1">{childCount}</span>
          )}
        </button>
        {isExpanded && node.children && (
          <div>
            {node.children.map((child) => (
              <TreeNodeItem
                key={child.path}
                node={child}
                selectedPath={selectedPath}
                onSelect={onSelect}
                expandedPaths={expandedPaths}
                onToggleExpand={onToggleExpand}
                depth={depth + 1}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const Icon = getNodeIcon(node);

  return (
    <button
      onClick={() => onSelect(node.path)}
      className={cn(
        "flex w-full items-center gap-1.5 py-[3px] text-left text-[13px] rounded-sm transition-colors group",
        isSelected
          ? "bg-accent text-accent-foreground"
          : "hover:bg-accent/50 text-foreground",
      )}
      style={{ paddingLeft: `${depth * 12 + 8 + 16}px` }}
    >
      <Icon className={cn("h-3.5 w-3.5 shrink-0", getFileColor(node))} />
      <span className="truncate flex-1">{node.name}</span>
      {node.size != null && node.size > 0 && (
        <span className="text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity mr-1">
          {formatSize(node.size)}
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Search results
// ----------------------------------------------------------------------

function SearchResults({
  results,
  onSelect,
  onClose,
}: {
  results: FileTreeNode[];
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="border-b">
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-[11px] text-muted-foreground">
          {results.length} result{results.length !== 1 ? "s" : ""}
        </span>
        <Button variant="ghost" size="xs" onClick={onClose} className="text-muted-foreground h-5 px-1.5">
          Clear
        </Button>
      </div>
      <div className="max-h-[300px] overflow-y-auto">
        {results.map((node) => {
          const Icon = getNodeIcon(node);
          return (
            <button
              key={node.path}
              onClick={() => { onSelect(node.path); onClose(); }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent/50"
            >
              <Icon className={cn("h-3.5 w-3.5 shrink-0", getFileColor(node))} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{node.name}</div>
                <div className="truncate text-muted-foreground text-[11px]">{node.path}</div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface WorkspaceBrowserProps {
  tree: FileTreeNode[] | null;
  selectedPath: string;
  onSelect: (path: string) => void;
  onRefresh?: () => void;
  isLoading?: boolean;
  className?: string;
}

export function WorkspaceBrowser({
  tree,
  selectedPath,
  onSelect,
  onRefresh,
  isLoading,
  className,
}: WorkspaceBrowserProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<FileTreeNode[] | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());

  // Auto-expand top-level dirs on first load
  useEffect(() => {
    if (tree && expandedPaths.size === 0) {
      const topDirs = tree.filter((n) => n.type === "directory").map((n) => n.path);
      setExpandedPaths(new Set(topDirs));
    }
  }, [tree]);

  const handleToggleExpand = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleSearchClear = useCallback(() => {
    setSearchQuery("");
    setSearchResults(null);
  }, []);

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search files..."
            className="h-7 pl-7 text-xs"
          />
        </div>
        {onRefresh && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onRefresh}
            disabled={isLoading}
            className="text-muted-foreground shrink-0"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} />
          </Button>
        )}
      </div>

      {/* Search results */}
      {searchResults && (
        <SearchResults
          results={searchResults}
          onSelect={onSelect}
          onClose={handleSearchClear}
        />
      )}

      {/* Tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {isLoading && !tree ? (
          <div className="p-3 space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : !tree || tree.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <Folder className="h-8 w-8 text-muted-foreground/30" />
            <p className="mt-2 text-xs">No files</p>
          </div>
        ) : (
          <div>
            {tree.map((node) => (
              <TreeNodeItem
                key={node.path}
                node={node}
                selectedPath={selectedPath}
                onSelect={onSelect}
                expandedPaths={expandedPaths}
                onToggleExpand={handleToggleExpand}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
