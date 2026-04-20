"use client";

import { useMemo, useState } from "react";
import { FileText, Eye, Code } from "lucide-react";
import { cn } from "@multica/ui/lib/utils";
import { Button } from "@multica/ui/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@multica/ui/components/ui/tooltip";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import type { WorkspaceFileResponse } from "@multica/core/types";

// ---------------------------------------------------------------------------
// Content type detection
// ---------------------------------------------------------------------------

type ViewerMode = "rendered" | "raw";

function isMarkdown(contentType: string, path: string): boolean {
  return contentType === "text/markdown" || path.endsWith(".md") || path.endsWith(".mdx");
}

function isCode(contentType: string): boolean {
  return [
    "text/x-go", "text/x-python", "text/javascript", "text/typescript",
    "text/x-rust", "text/x-shellscript", "text/css", "text/html",
    "text/x-sql", "text/xml", "text/yaml", "text/toml", "application/json",
    "text/csv",
  ].includes(contentType);
}

function isImage(contentType: string, path: string): boolean {
  if (contentType.startsWith("image/")) return true;
  return /\.(png|jpg|jpeg|gif|svg|webp|ico|bmp)$/i.test(path);
}

// ---------------------------------------------------------------------------
// Markdown renderer (simple)
// ---------------------------------------------------------------------------

function SimpleMarkdown({ content }: { content: string }) {
  // Very basic markdown rendering — highlights code blocks and headers
  const html = useMemo(() => {
    let text = content;

    // Code blocks
    text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      return `<pre class="bg-muted rounded-md p-3 my-2 overflow-x-auto text-xs font-mono"><code class="language-${lang}">${escapeHtml(code.trim())}</code></pre>`;
    });

    // Inline code
    text = text.replace(/`([^`]+)`/g, '<code class="bg-muted px-1 py-0.5 rounded text-xs font-mono">$1</code>');

    // Headers
    text = text.replace(/^### (.+)$/gm, '<h3 class="text-sm font-semibold mt-4 mb-2">$1</h3>');
    text = text.replace(/^## (.+)$/gm, '<h2 class="text-base font-semibold mt-4 mb-2">$1</h2>');
    text = text.replace(/^# (.+)$/gm, '<h1 class="text-lg font-bold mt-4 mb-2">$1</h1>');

    // Bold / italic
    text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/\*(.+?)\*/g, "<em>$1</em>");

    // Links
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="text-primary underline" target="_blank" rel="noopener">$1</a>');

    // Lists
    text = text.replace(/^- (.+)$/gm, '<li class="ml-4 list-disc">$1</li>');
    text = text.replace(/^(\d+)\. (.+)$/gm, '<li class="ml-4 list-decimal">$2</li>');

    // Horizontal rules
    text = text.replace(/^---$/gm, '<hr class="my-4 border-border" />');

    // Paragraphs (double newline)
    text = text.replace(/\n\n/g, '</p><p class="my-2">');
    text = `<p class="my-2">${text}</p>`;

    return text;
  }, [content]);

  return (
    <div
      className="prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Code viewer (line numbers + syntax-aware)
// ---------------------------------------------------------------------------

function CodeViewer({ content }: { content: string; path: string }) {
  const lines = content.split("\n");

  return (
    <div className="font-mono text-xs leading-5">
      <div className="flex">
        {/* Line numbers */}
        <div className="select-none text-right pr-3 pl-4 py-3 text-muted-foreground/50 border-r">
          {lines.map((_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
        {/* Code content */}
        <div className="flex-1 overflow-x-auto py-3 pl-3 pr-4">
          {lines.map((line, i) => (
            <div key={i} className="whitespace-pre">
              {line || "\u00A0"}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// JSON viewer (formatted)
// ---------------------------------------------------------------------------

function JsonViewer({ content }: { content: string }) {
  try {
    const parsed = JSON.parse(content);
    const formatted = JSON.stringify(parsed, null, 2);
    return <CodeViewer content={formatted} path="file.json" />;
  } catch {
    return <CodeViewer content={content} path="file.json" />;
  }
}

// ---------------------------------------------------------------------------
// Binary / fallback viewer
// ---------------------------------------------------------------------------

function BinaryFileView({ path, size }: { path: string; size: number }) {
  const ext = path.split(".").pop()?.toUpperCase() ?? "Unknown";

  return (
    <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
      <FileText className="h-12 w-12 text-muted-foreground/20" />
      <div className="text-center">
        <p className="text-sm font-medium">{ext} File</p>
        <p className="text-xs mt-1">{formatSize(size)}</p>
        <p className="text-xs mt-1 text-muted-foreground/60">
          Preview not available for this file type
        </p>
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface WorkspaceViewerProps {
  file: WorkspaceFileResponse | null;
  isLoading?: boolean;
  className?: string;
}

export function WorkspaceViewer({ file, isLoading, className }: WorkspaceViewerProps) {
  const [mode, setMode] = useState<ViewerMode>("rendered");

  if (isLoading) {
    return (
      <div className={cn("p-4 space-y-3", className)}>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-4/6" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    );
  }

  if (!file) {
    return (
      <div className={cn("flex flex-col items-center justify-center h-full text-muted-foreground", className)}>
        <FileText className="h-10 w-10 text-muted-foreground/20" />
        <p className="mt-3 text-sm">Select a file to view</p>
        <p className="mt-1 text-xs text-muted-foreground/60">
          Browse the workspace files on the left
        </p>
      </div>
    );
  }

  const isMd = isMarkdown(file.contentType, file.path);
  const isCodeFile = isCode(file.contentType);
  const isImg = isImage(file.contentType, file.path);
  const isBinary = file.contentType === "application/octet-stream";

  // Determine which viewer to show
  const canToggle = isMd || isCodeFile;
  const showRendered = mode === "rendered" && (isMd || isCodeFile);

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* Header bar */}
      <div className="flex h-9 items-center justify-between border-b px-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-mono text-muted-foreground truncate">
            {file.path}
          </span>
          <span className="text-[10px] text-muted-foreground/60 shrink-0">
            {formatSize(file.size)}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {canToggle && (
            <>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setMode("rendered")}
                      className={cn(
                        "text-muted-foreground",
                        mode === "rendered" && "bg-accent text-accent-foreground",
                      )}
                    >
                      <Eye className="h-3.5 w-3.5" />
                    </Button>
                  }
                />
                <TooltipContent>Rendered</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setMode("raw")}
                      className={cn(
                        "text-muted-foreground",
                        mode === "raw" && "bg-accent text-accent-foreground",
                      )}
                    >
                      <Code className="h-3.5 w-3.5" />
                    </Button>
                  }
                />
                <TooltipContent>Raw</TooltipContent>
              </Tooltip>
            </>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {isImg ? (
          <div className="flex items-center justify-center h-full p-4 bg-[repeating-conic-gradient(hsl(var(--muted))_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]">
            <img
              src={`data:${file.contentType};base64,${btoa(file.content)}`}
              alt={file.path}
              className="max-w-full max-h-full object-contain rounded"
            />
          </div>
        ) : isBinary ? (
          <BinaryFileView path={file.path} size={file.size} />
        ) : showRendered && isMd ? (
          <div className="p-6">
            <SimpleMarkdown content={file.content} />
          </div>
        ) : showRendered && isCodeFile && file.contentType === "application/json" ? (
          <JsonViewer content={file.content} />
        ) : (
          <CodeViewer content={file.content} path={file.path} />
        )}
      </div>
    </div>
  );
}
