"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { cn } from "@multica/ui/lib/utils";
import { Button } from "@multica/ui/components/ui/button";
import { RefreshCw, X, Maximize2, Minimize2 } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebTerminalProps {
  /** WebSocket URL for the PTY session */
  wsUrl: string;
  /** Session ID for reconnection */
  sessionId?: string;
  /** Called when session ID is received */
  onConnected?: (sessionId: string) => void;
  /** Called when session exits */
  onExit?: (code: string) => void;
  /** Whether this terminal is currently visible */
  isActive?: boolean;
  className?: string;
}

// ---------------------------------------------------------------------------
// Terminal theme (matches Multica dark theme)
// ---------------------------------------------------------------------------

const terminalTheme = {
  background: "hsl(var(--background))",
  foreground: "hsl(var(--foreground))",
  cursor: "hsl(var(--foreground))",
  cursorAccent: "hsl(var(--background))",
  selectionBackground: "hsl(var(--accent))",
  selectionForeground: "hsl(var(--accent-foreground))",
  black: "#1a1a1a",
  red: "#ff6b6b",
  green: "#51cf66",
  yellow: "#ffd43b",
  blue: "#339af0",
  magenta: "#cc5de8",
  cyan: "#22b8cf",
  white: "#adb5bd",
  brightBlack: "#495057",
  brightRed: "#ff8787",
  brightGreen: "#69db7c",
  brightYellow: "#ffe066",
  brightBlue: "#4dabf7",
  brightMagenta: "#da77f2",
  brightCyan: "#3bc9db",
  brightWhite: "#e9ecef",
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function WebTerminal({
  wsUrl,
  sessionId: initialSessionId,
  onConnected,
  onExit,
  isActive = true,
  className,
}: WebTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId ?? null);
  const [connected, setConnected] = useState(false);
  const [exited, setExited] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Initialize terminal
  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.4,
      theme: terminalTheme,
      scrollback: 5000,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(containerRef.current);

    // Delay fit to allow DOM to settle
    setTimeout(() => fitAddon.fit(), 50);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    return () => {
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  // Handle resize
  useEffect(() => {
    if (!terminalRef.current || !fitAddonRef.current) return;

    const observer = new ResizeObserver(() => {
      if (fitAddonRef.current && terminalRef.current) {
        fitAddonRef.current.fit();
        const { cols, rows } = terminalRef.current;
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "resize", cols, rows }));
        }
      }
    });

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => observer.disconnect();
  }, []);

  // WebSocket connection
  const connect = useCallback(() => {
    if (!terminalRef.current) return;

    // Close existing connection
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setExited(false);
    const terminal = terminalRef.current;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setConnected(true);
      // Send initial size
      if (fitAddonRef.current) {
        fitAddonRef.current.fit();
      }
      const { cols, rows } = terminal;
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        switch (msg.type) {
          case "connected":
            setSessionId(msg.data);
            onConnected?.(msg.data);
            break;

          case "output":
            terminal.write(msg.data);
            break;

          case "exit":
            setExited(true);
            setConnected(false);
            onExit?.(msg.data);
            break;

          case "error":
            terminal.write(`\r\n\x1b[31mError: ${msg.data}\x1b[0m\r\n`);
            setExited(true);
            break;
        }
      } catch {
        // Binary data — write directly
        if (event.data instanceof ArrayBuffer) {
          terminal.write(new Uint8Array(event.data));
        }
      }
    };

    ws.onclose = () => {
      setConnected(false);
    };

    ws.onerror = () => {
      terminal.write("\r\n\x1b[31mConnection error\x1b[0m\r\n");
      setConnected(false);
    };

    // Forward terminal input to WebSocket
    terminal.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    wsRef.current = ws;

    return () => {
      ws.close();
    };
  }, [wsUrl, onConnected, onExit]);

  // Connect on mount or when wsUrl changes
  useEffect(() => {
    const cleanup = connect();
    return () => {
      cleanup?.();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  // Focus terminal when active
  useEffect(() => {
    if (isActive && terminalRef.current) {
      terminalRef.current.focus();
    }
  }, [isActive]);

  const handleReconnect = useCallback(() => {
    connect();
  }, [connect]);

  const handleDisconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setConnected(false);
  }, []);

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* Toolbar */}
      <div className="flex h-8 items-center justify-between border-b px-2 shrink-0 bg-muted/30">
        <div className="flex items-center gap-2">
          <div className={cn(
            "h-2 w-2 rounded-full",
            connected ? "bg-green-500" : exited ? "bg-yellow-500" : "bg-red-500",
          )} />
          <span className="text-[11px] text-muted-foreground font-mono">
            {sessionId ? sessionId.slice(0, 16) : "Terminal"}
          </span>
          {exited && (
            <span className="text-[10px] text-yellow-600">exited</span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {exited || !connected ? (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleReconnect}
              className="text-muted-foreground h-6 w-6"
            >
              <RefreshCw className="h-3 w-3" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleDisconnect}
              className="text-muted-foreground h-6 w-6"
            >
              <X className="h-3 w-3" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setIsFullscreen(!isFullscreen)}
            className="text-muted-foreground h-6 w-6"
          >
            {isFullscreen ? (
              <Minimize2 className="h-3 w-3" />
            ) : (
              <Maximize2 className="h-3 w-3" />
            )}
          </Button>
        </div>
      </div>

      {/* Terminal */}
      <div
        ref={containerRef}
        className={cn(
          "flex-1 min-h-0 overflow-hidden",
          isFullscreen && "fixed inset-0 z-50 bg-background",
        )}
        onClick={() => terminalRef.current?.focus()}
      />
    </div>
  );
}
