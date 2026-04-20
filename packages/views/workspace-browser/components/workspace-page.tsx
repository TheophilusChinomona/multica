"use client";

import { useState, useCallback } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import {
  FolderTree,
  Terminal,
  RefreshCw,
  AlertCircle,
} from "lucide-react";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@multica/ui/components/ui/resizable";
import { Button } from "@multica/ui/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@multica/ui/components/ui/tooltip";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@multica/ui/components/ui/tabs";
import { toast } from "sonner";
import { api } from "@multica/core/api";
import { useQuery } from "@tanstack/react-query";

import { PageHeader } from "../../layout/page-header";
import { WorkspaceBrowser } from "./workspace-browser";
import { WorkspaceViewer } from "./workspace-viewer";
import { WebTerminal } from "./web-terminal";

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

const workspaceTreeKey = ["workspace-tree"];
const workspaceFileKey = (path: string) => ["workspace-file", path];

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function WorkspaceExplorerPage() {
  const [selectedPath, setSelectedPath] = useState<string>("");
  const [terminalTab, setTerminalTab] = useState<string>("terminal-1");
  const [terminalSessions, setTerminalSessions] = useState<{ id: string; label: string }[]>([
    { id: "terminal-1", label: "Terminal 1" },
  ]);

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "multica_explorer_layout",
  });

  // Fetch file tree
  const {
    data: treeData,
    isLoading: treeLoading,
    refetch: refetchTree,
    error: treeError,
  } = useQuery({
    queryKey: workspaceTreeKey,
    queryFn: () => api.getWorkspaceTree(),
    refetchInterval: 10000,
    retry: 1,
  });

  // Fetch selected file
  const {
    data: fileData,
    isLoading: fileLoading,
  } = useQuery({
    queryKey: workspaceFileKey(selectedPath),
    queryFn: () => api.getWorkspaceFile(selectedPath),
    enabled: !!selectedPath && !selectedPath.endsWith("/"),
    retry: 1,
  });

  const handleSelectFile = useCallback((path: string) => {
    setSelectedPath(path);
  }, []);

  const handleRefresh = useCallback(() => {
    refetchTree();
    toast.success("File tree refreshed");
  }, [refetchTree]);

  const handleNewTerminal = useCallback(() => {
    const id = `terminal-${Date.now()}`;
    const label = `Terminal ${terminalSessions.length + 1}`;
    setTerminalSessions((prev) => [...prev, { id, label }]);
    setTerminalTab(id);
  }, [terminalSessions.length]);

  const handleCloseTerminal = useCallback(
    (id: string) => {
      setTerminalSessions((prev) => {
        if (prev.length <= 1) return prev;
        const filtered = prev.filter((s) => s.id !== id);
        if (terminalTab === id) {
          setTerminalTab(filtered[filtered.length - 1]!.id);
        }
        return filtered;
      });
    },
    [terminalTab],
  );

  const tree = treeData?.children ?? null;

  // Error state
  if (treeError) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <AlertCircle className="h-8 w-8 text-destructive mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">
            Failed to load workspace files
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {treeError instanceof Error ? treeError.message : "Unknown error"}
          </p>
          <Button onClick={handleRefresh} size="xs" className="mt-3">
            <RefreshCw className="h-3 w-3 mr-1" />
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <PageHeader className="justify-between">
        <div className="flex items-center gap-2">
          <FolderTree className="h-4 w-4 text-muted-foreground" />
          <h1 className="text-sm font-semibold">Explorer</h1>
        </div>
      </PageHeader>

      <ResizablePanelGroup
        orientation="horizontal"
        className="flex-1 min-h-0"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
      >
        {/* Left panel: file tree */}
        <ResizablePanel id="files" defaultSize={280} minSize={200} maxSize={500} groupResizeBehavior="preserve-pixel-size">
          <WorkspaceBrowser
            tree={tree}
            selectedPath={selectedPath}
            onSelect={handleSelectFile}
            onRefresh={handleRefresh}
            isLoading={treeLoading}
            className="h-full border-r"
          />
        </ResizablePanel>

        <ResizableHandle />

        {/* Right panel: file viewer + terminal */}
        <ResizablePanel id="content" minSize="40%">
          <ResizablePanelGroup orientation="vertical" className="h-full">
            {/* Top: file viewer */}
            <ResizablePanel id="viewer" defaultSize={65} minSize={30}>
              <WorkspaceViewer
                file={fileData ?? null}
                isLoading={fileLoading && !!selectedPath}
                className="h-full"
              />
            </ResizablePanel>

            <ResizableHandle />

            {/* Bottom: terminal */}
            <ResizablePanel id="terminal" defaultSize={35} minSize={15}>
              <Tabs value={terminalTab} onValueChange={setTerminalTab} className="flex flex-col h-full">
                <div className="flex items-center border-b px-1 h-8 shrink-0 bg-muted/20">
                  <TabsList className="h-7 bg-transparent gap-0 p-0">
                    {terminalSessions.map((session) => (
                      <TabsTrigger
                        key={session.id}
                        value={session.id}
                        className="relative h-7 px-3 text-[11px] rounded-none data-[state=active]:bg-background data-[state=active]:shadow-none border-r"
                      >
                        <Terminal className="h-3 w-3 mr-1.5 text-muted-foreground" />
                        {session.label}
                        {terminalSessions.length > 1 && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCloseTerminal(session.id);
                            }}
                            className="ml-1.5 text-muted-foreground hover:text-foreground"
                          >
                            ×
                          </button>
                        )}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={handleNewTerminal}
                          className="text-muted-foreground h-6 w-6 ml-1"
                        >
                          <Terminal className="h-3 w-3" />
                        </Button>
                      }
                    />
                    <TooltipContent>New terminal</TooltipContent>
                  </Tooltip>
                </div>

                {terminalSessions.map((session) => (
                  <TabsContent
                    key={session.id}
                    value={session.id}
                    className="flex-1 min-h-0 mt-0 data-[state=inactive]:hidden"
                  >
                    <WebTerminal
                      wsUrl={api.getPTYWebSocketURL(undefined, {
                        cwd: treeData?.root,
                      })}
                      isActive={terminalTab === session.id}
                    />
                  </TabsContent>
                ))}
              </Tabs>
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
