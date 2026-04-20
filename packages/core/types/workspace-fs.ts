// Workspace file system types

export interface FileTreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modTime?: string;
  children?: FileTreeNode[];
}

export interface WorkspaceTreeResponse {
  root: string;
  path: string;
  children: FileTreeNode[];
}

export interface WorkspaceFileResponse {
  path: string;
  content: string;
  contentType: string;
  size: number;
  modTime: string;
}

export interface WorkspaceStats {
  fileCount: number;
  dirCount: number;
  totalSize: number;
  lastModTime?: string;
}

// PTY session types

export interface PTYSessionInfo {
  id: string;
  cmd?: string;
  lastSeen: string;
}

export interface PTYMessage {
  type: "output" | "input" | "resize" | "connected" | "exit" | "error";
  data?: string;
  cols?: number;
  rows?: number;
}
