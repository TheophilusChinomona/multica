package handler

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/creack/pty"
	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
)

// ---------------------------------------------------------------------------
// PTY Session Management
// ---------------------------------------------------------------------------

// PTYSession represents a running pseudo-terminal session.
type PTYSession struct {
	ID       string
	PTY      *os.File
	Cmd      *exec.Cmd
	Conn     *websocket.Conn
	mu       sync.Mutex
	done     chan struct{}
	lastSeen time.Time
}

// ptyManager tracks active PTY sessions.
type ptyManager struct {
	mu       sync.RWMutex
	sessions map[string]*PTYSession
}

var ptySessions = &ptyManager{
	sessions: make(map[string]*PTYSession),
}

func (m *ptyManager) add(id string, s *PTYSession) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sessions[id] = s
}

func (m *ptyManager) get(id string) *PTYSession {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.sessions[id]
}

func (m *ptyManager) remove(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.sessions, id)
}

// ---------------------------------------------------------------------------
// WebSocket upgrader
// ---------------------------------------------------------------------------

var ptyUpgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool {
		return true // CORS is handled by Chi middleware for HTTP; WS needs this
	},
}

// ---------------------------------------------------------------------------
// PTY WebSocket message types
// ---------------------------------------------------------------------------

type ptyMessage struct {
	Type string `json:"type"`
	Cols uint16 `json:"cols,omitempty"`
	Rows uint16 `json:"rows,omitempty"`
	Data string `json:"data,omitempty"`
}

// ---------------------------------------------------------------------------
// GET /ws/pty — WebSocket endpoint for terminal sessions
// ---------------------------------------------------------------------------

// HandlePTYWebSocket upgrades to WebSocket and manages a PTY session.
//
// Query params:
//   - id: session ID (optional, for reconnection; auto-generated if empty)
//   - cmd: command to run (default: $SHELL or /bin/bash)
//   - cwd: working directory (default: workspace root)
//
// Protocol:
//   - Server → Client: {"type":"output","data":"..."} (terminal output)
//   - Client → Server: {"type":"input","data":"..."} (keystrokes)
//   - Client → Server: {"type":"resize","cols":80,"rows":24}
//   - Server → Client: {"type":"exit","data":"exit code"}
//   - Server → Client: {"type":"connected","id":"session-id"}
func (h *Handler) HandlePTYWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := ptyUpgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("pty: websocket upgrade failed", "error", err)
		return
	}

	sessionID := r.URL.Query().Get("id")
	cmdStr := r.URL.Query().Get("cmd")
	cwd := r.URL.Query().Get("cwd")

	if cwd == "" {
		cwd = workspaceRoot()
		os.MkdirAll(cwd, 0o755)
	}

	if cmdStr == "" {
		cmdStr = os.Getenv("SHELL")
		if cmdStr == "" {
			cmdStr = "/bin/bash"
		}
	}

	// Check for existing session (reconnection)
	if sessionID != "" {
		if existing := ptySessions.get(sessionID); existing != nil {
			existing.mu.Lock()
			existing.Conn = conn
			existing.lastSeen = time.Now()
			existing.mu.Unlock()

			slog.Info("pty: reconnected session", "id", sessionID)

			// Notify client of reconnection
			conn.WriteJSON(ptyMessage{Type: "connected", Data: sessionID})

			// Resume PTY output streaming
			go streamPTYToClient(existing)
			handleClientInput(existing)
			return
		}
	}

	// Generate session ID
	if sessionID == "" {
		sessionID = generateSessionID()
	}

	// Create the command
	cmd := exec.Command(cmdStr)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(),
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"MULTICA_SESSION_ID="+sessionID,
	)

	// Start with PTY
	ptmx, err := pty.Start(cmd)
	if err != nil {
		slog.Error("pty: failed to start", "error", err)
		conn.WriteJSON(ptyMessage{Type: "error", Data: "failed to start terminal"})
		conn.Close()
		return
	}

	// Set initial size
	pty.Setsize(ptmx, &pty.Winsize{Rows: 24, Cols: 80})

	session := &PTYSession{
		ID:       sessionID,
		PTY:      ptmx,
		Cmd:      cmd,
		Conn:     conn,
		done:     make(chan struct{}),
		lastSeen: time.Now(),
	}

	ptySessions.add(sessionID, session)

	// Notify client
	conn.WriteJSON(ptyMessage{Type: "connected", Data: sessionID})

	slog.Info("pty: session started", "id", sessionID, "cmd", cmdStr, "cwd", cwd)

	// Stream PTY output to WebSocket
	go streamPTYToClient(session)

	// Handle client input
	handleClientInput(session)

	// Cleanup
	close(session.done)
	ptySessions.remove(sessionID)
	ptmx.Close()
	cmd.Process.Kill()

	slog.Info("pty: session ended", "id", sessionID)
}

// streamPTYToClient reads from the PTY and sends output to the WebSocket.
func streamPTYToClient(session *PTYSession) {
	buf := make([]byte, 4096)
	for {
		select {
		case <-session.done:
			return
		default:
		}

		n, err := session.PTY.Read(buf)
		if err != nil {
			if err != io.EOF {
				slog.Debug("pty: read error", "id", session.ID, "error", err)
			}
			// Send exit notification
			session.mu.Lock()
			if session.Conn != nil {
				session.Conn.WriteJSON(ptyMessage{Type: "exit", Data: "0"})
			}
			session.mu.Unlock()
			return
		}

		session.mu.Lock()
		conn := session.Conn
		session.mu.Unlock()

		if conn != nil {
			err := conn.WriteJSON(ptyMessage{
				Type: "output",
				Data: string(buf[:n]),
			})
			if err != nil {
				slog.Debug("pty: write error", "id", session.ID, "error", err)
				return
			}
		}
	}
}

// handleClientInput reads WebSocket messages and writes to the PTY.
func handleClientInput(session *PTYSession) {
	for {
		select {
		case <-session.done:
			return
		default:
		}

		session.mu.Lock()
		conn := session.Conn
		session.mu.Unlock()

		if conn == nil {
			time.Sleep(100 * time.Millisecond)
			continue
		}

		_, msgBytes, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				slog.Debug("pty: client disconnected", "id", session.ID)
			}
			return
		}

		var msg ptyMessage
		if err := json.Unmarshal(msgBytes, &msg); err != nil {
			continue
		}

		session.lastSeen = time.Now()

		switch msg.Type {
		case "input":
			if _, err := session.PTY.Write([]byte(msg.Data)); err != nil {
				slog.Debug("pty: write to pty failed", "id", session.ID, "error", err)
			}

		case "resize":
			if msg.Cols > 0 && msg.Rows > 0 {
				pty.Setsize(session.PTY, &pty.Winsize{
					Rows: msg.Rows,
					Cols: msg.Cols,
				})
			}
		}
	}
}

// generateSessionID creates a simple session ID.
func generateSessionID() string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 12)
	for i := range b {
		b[i] = chars[time.Now().UnixNano()%int64(len(chars))]
		time.Sleep(1 * time.Nanosecond)
	}
	return "pty-" + string(b)
}

// ---------------------------------------------------------------------------
// REST API for session management
// ---------------------------------------------------------------------------

type PTYSessionInfo struct {
	ID       string `json:"id"`
	Cmd      string `json:"cmd,omitempty"`
	LastSeen string `json:"lastSeen"`
}

// ListPTYSessions returns all active PTY sessions.
func (h *Handler) ListPTYSessions(w http.ResponseWriter, r *http.Request) {
	ptySessions.mu.RLock()
	defer ptySessions.mu.RUnlock()

	sessions := make([]PTYSessionInfo, 0, len(ptySessions.sessions))
	for _, s := range ptySessions.sessions {
		sessions = append(sessions, PTYSessionInfo{
			ID:       s.ID,
			LastSeen: s.lastSeen.Format(time.RFC3339),
		})
	}

	writeJSON(w, http.StatusOK, sessions)
}

// KillPTYSession terminates a specific PTY session.
func (h *Handler) KillPTYSession(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "id")
	session := ptySessions.get(sessionID)
	if session == nil {
		writeError(w, http.StatusNotFound, "session not found")
		return
	}

	session.PTY.Close()
	session.Cmd.Process.Kill()
	ptySessions.remove(sessionID)

	writeJSON(w, http.StatusOK, map[string]string{"status": "killed"})
}
