/**
 * Main Chat phase — TypeScript contracts.
 * Desktop WebUI wrapper only. Never imports oh-my-pi core logic.
 */

// ---------------------------------------------------------------------------
// Chat state machine phases
// ---------------------------------------------------------------------------

export type ChatPhase =
  | 'idle'           // waiting for session link / launcher health
  | 'connecting'     // WS handshake in progress
  | 'live'           // session active, streaming possible
  | 'streaming'      // assistant is generating
  | 'tool_running'   // tool execution in progress
  | 'error'          // recoverable error
  | 'disconnected'   // lost connection
  | 'reconnecting'   // auto-reconnect in progress
  | 'ended';         // session ended (no reconnect)

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface ChatSession {
  id: string;
  name: string;
  link: string;
  createdAt: string;
  lastActiveAt: string | null;
  messageCount: number;
  isActive: boolean;
}

export interface SessionListResponse {
  sessions: ChatSession[];
}

// ---------------------------------------------------------------------------
// Data sources
// ---------------------------------------------------------------------------

export type DataSourceStatus = 'connected' | 'disconnected' | 'error' | 'loading';

export interface DataSource {
  id: string;
  name: string;
  type: string;
  status: DataSourceStatus;
  detail?: string;
}

export interface DataSourceListResponse {
  sources: DataSource[];
}

// ---------------------------------------------------------------------------
// User controls / runtime config
// ---------------------------------------------------------------------------

export interface RuntimeConfig {
  model: string;
  mode: 'normal' | 'safe' | 'debug';
  thinkingEnabled: boolean;
  maxTokens: number;
}

export interface RuntimeConfigResponse extends RuntimeConfig {
  availableModels: string[];
}

// ---------------------------------------------------------------------------
// Chat error
// ---------------------------------------------------------------------------

export interface ChatError {
  code: string;
  message: string;
  detail?: string;
  recoverable: boolean;
}

// ---------------------------------------------------------------------------
// Connection health (from Launcher)
// ---------------------------------------------------------------------------

export interface LauncherHealthStatus {
  healthy: boolean;
  phase: string;
  endpoint: string | null;
  checkedAt: string;
}
