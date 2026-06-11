import { IncomingMessage } from 'http';
import { WebSocket } from 'ws';
import { getPool } from '../db';
import jwt from 'jsonwebtoken';
import { warmPoolManager } from '../sandbox/pool';
import Docker from 'dockerode';
import tar from 'tar-stream';

// =============================================================================
// INTERACTIVE TERMINAL WEBSOCKET HANDLER
// =============================================================================
//
// PURPOSE:
//   Provides a persistent, bidirectional terminal session to users inside
//   a Docker container with their workspace files pre-hydrated. Unlike the
//   stateless code execution endpoint, terminal sessions are long-lived and
//   allow interactive shell commands, running scripts with input, and exploring
//   the workspace filesystem.
//
// ARCHITECTURE:
//   WebSocket (browser xterm.js) ←→ This handler ←→ Docker exec (PTY shell)
//
// LIFECYCLE:
//   1. Client connects to ws://localhost:4000/terminal/<workspaceId>?token=...
//   2. Handler validates JWT and checks user has editor role
//   3. Pops a warm container and hydrates it with workspace files
//   4. Spawns an interactive shell (/bin/sh) with Tty: true inside the container
//   5. Pipes WebSocket ←→ Docker stream bidirectionally
//   6. On disconnect or 10min idle: kills container and closes connections
//
// TTY MODE (Tty: true):
//   With Tty: true, the shell thinks it's connected to a real terminal. This enables:
//     - Interactive features (readline, arrow keys, history)
//     - Colored output (shells check isatty() before coloring)
//     - Screen-based applications (vim, nano, htop)
//   Output stream merges stdout/stderr into one — no frame demuxing needed.
//
// RESIZE HANDLING:
//   xterm.js sends a special JSON message when the terminal panel is resized:
//     { "type": "resize", "rows": 30, "cols": 120 }
//   The handler detects this (first byte is '{'), parses it, and calls
//   exec.resize() to inform the PTY of the new dimensions. All other messages
//   are raw bytes forwarded directly to stdin.
//
// SECURITY:
//   - JWT required (same as Yjs WebSocket)
//   - Editor role or above required (same as code execution)
//   - Container has same security constraints as code execution:
//       100MB RAM, 0.5 CPU, 50 PID limit, no network, read-only rootfs
//   - 10-minute idle timeout prevents zombie containers
//
// =============================================================================

class TerminalHistoryBuffer {
  private buffer: Buffer[] = [];
  private totalLength = 0;
  private maxBytes = 100 * 1024; // Keep last 100KB of terminal output

  public push(chunk: Buffer) {
    this.buffer.push(chunk);
    this.totalLength += chunk.length;
    while (this.totalLength > this.maxBytes && this.buffer.length > 0) {
      const removed = this.buffer.shift()!;
      this.totalLength -= removed.length;
    }
  }

  public getCombined(): Buffer {
    return Buffer.concat(this.buffer);
  }
}

interface TerminalSession {
  ws: WebSocket;
  container: Docker.Container;
  exec: Docker.Exec;
  stream: NodeJS.ReadWriteStream & {
    destroyed?: boolean;
    destroy?: () => void;
  };
  idleTimeout: NodeJS.Timeout;
  workspaceId: string;
  userId: string;
  outputBuffer: OutputBuffer; // Rate limiting buffer
  historyBuffer: TerminalHistoryBuffer; // Standard output cache
  isReconnecting?: boolean;
  teardownTimeout?: NodeJS.Timeout;
}

// =============================================================================
// SESSION STATE
// =============================================================================
//
// We keep only one active terminal per user-workspace pair. That prevents two
// shells from racing against the same workspace state and keeps reconnection
// behavior deterministic.
const activeSessions = new Map<string, TerminalSession>();

// Idle timeout: 10 minutes of no activity → auto-close.
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

// Reconnection grace period: 15 seconds to reload/reconnect.
const RECONNECT_GRACE_PERIOD_MS = 15000;

// =============================================================================
// PHASE 5: ADVANCED SECURITY — Output Rate Limiting & Audit Logging
// =============================================================================

// OUTPUT RATE LIMITING:
//   Prevents terminal output flood attacks (e.g., `yes` command, infinite loop printing)
//   from overwhelming the browser and causing UI lag/freeze.
//
//   Strategy: Buffer rapid output and flush in batches at fixed intervals.
//   Without rate limiting: `yes` generates ~100k messages/sec → browser lag
//   With rate limiting: Output batched into 50ms chunks → smooth rendering
const OUTPUT_RATE_LIMIT_MS = 50;        // Flush interval
const OUTPUT_RATE_LIMIT_BYTES = 64000;  // Max bytes per flush (64KB ≈ 1000 lines)

interface OutputBuffer {
  chunks: Buffer[];
  totalBytes: number;
  flushTimer: NodeJS.Timeout | null;
}

// AUDIT LOGGING:
//   Records terminal session events for security monitoring, debugging, and compliance.
//   Logged events: connection, disconnection, command execution, errors
//   Note: We do NOT log keystroke content (privacy concern), only metadata
interface AuditLog {
  timestamp: Date;
  userId: string;
  workspaceId: string;
  event: 'connect' | 'disconnect' | 'idle_timeout' | 'error';
  details?: string;
}

type TerminalRole = 'viewer' | 'editor' | 'admin';

const auditLogs: AuditLog[] = [];
const MAX_AUDIT_LOGS = 10000; // Keep last 10k events in memory

function logAuditEvent(userId: string, workspaceId: string, event: AuditLog['event'], details?: string): void {
  const log: AuditLog = {
    timestamp: new Date(),
    userId,
    workspaceId,
    event
  };

  if (details !== undefined) {
    log.details = details;
  }
  
  auditLogs.push(log);
  
  // Prevent unbounded memory growth
  if (auditLogs.length > MAX_AUDIT_LOGS) {
    auditLogs.shift(); // Remove oldest entry
  }
  
  // Console logging for real-time monitoring
  console.log(`[Audit] ${event} | User: ${userId} | Workspace: ${workspaceId}${details ? ` | ${details}` : ''}`);
}

function bindWebSocketEvents(
  session: TerminalSession,
  ws: WebSocket,
  sessionKey: string
) {
  const resetIdleTimeout = () => {
    clearTimeout(session.idleTimeout);
    session.idleTimeout = setTimeout(() => {
      console.log('[Terminal] Idle timeout reached, closing session');
      logAuditEvent(session.userId, session.workspaceId, 'idle_timeout');
      session.ws.close(1000, 'Idle timeout');
    }, IDLE_TIMEOUT_MS);
  };

  ws.on('message', (data: Buffer) => {
    resetIdleTimeout();

    // Forward raw bytes directly to stdin
    if (session.stream && !session.stream.destroyed && session.stream.writable) {
      session.stream.write(data);
    }
  });

  ws.on('close', async () => {
    console.log('[Terminal] WebSocket closed, starting reconnection grace period');
    session.isReconnecting = true;
    session.teardownTimeout = setTimeout(async () => {
      console.log('[Terminal] Reconnection grace period expired, cleaning up');
      activeSessions.delete(sessionKey);
      await cleanupSession(session);
    }, RECONNECT_GRACE_PERIOD_MS);
  });

  ws.on('error', (err) => {
    console.error('[Terminal] WebSocket error:', err);
  });
}

// Expose audit logs for monitoring endpoints (future: GET /admin/terminal/audit)
export function getAuditLogs(limit: number = 100): AuditLog[] {
  return auditLogs.slice(-limit);
}

export async function handleTerminalConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
  let session: TerminalSession | null = null;

  try {
    // -------------------------------------------------------------------------
    // STEP 1: Parse the terminal URL and extract workspace context
    // -------------------------------------------------------------------------
    const parsedUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
    
    if (pathParts.length < 2 || pathParts[0] !== 'terminal') {
      console.log('[Terminal] Connection closed: Invalid path format');
      ws.close(4000, 'Bad Request: Expected /terminal/<workspaceId>');
      return;
    }

    const workspaceId = pathParts[1] as string;
    const token = parsedUrl.searchParams.get('token');
    const forceNew = parsedUrl.searchParams.get('forceNew') === 'true';

    if (!token) {
      console.log('[Terminal] Connection closed: Missing token');
      ws.close(4401, 'Unauthorized: Token required');
      return;
    }

    // -------------------------------------------------------------------------
    // STEP 2: Verify JWT and extract user identity
    // -------------------------------------------------------------------------
    const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';
    let decodedUser: any;
    try {
      decodedUser = jwt.verify(token, JWT_SECRET);
    } catch (e: any) {
      console.log('[Terminal] Connection closed: Invalid token', e.message);
      ws.close(4401, 'Unauthorized: Invalid token');
      return;
    }

    const userId = typeof decodedUser.id === 'string' ? decodedUser.id : String(decodedUser.id || '');
    if (!userId) {
      console.log('[Terminal] Connection closed: No user ID in token');
      ws.close(4401, 'Unauthorized: Invalid token payload');
      return;
    }

    // -------------------------------------------------------------------------
    // STEP 3: Check workspace access and role
    // -------------------------------------------------------------------------
    // Terminal access requires editor role or above (same as code execution).
    const wsResult = await getPool().query(
      'SELECT owner_id, is_public FROM workspaces WHERE id = $1',
      [workspaceId]
    );

    if (wsResult.rows.length === 0) {
      console.log('[Terminal] Connection closed: Workspace not found:', workspaceId);
      ws.close(4404, 'Workspace not found');
      return;
    }

    const workspace = wsResult.rows[0];
    let userRole: TerminalRole | null = null;

    if (workspace.owner_id === userId) {
      userRole = 'admin';
    } else {
      const collabResult = await getPool().query(
        'SELECT role FROM workspace_collaborators WHERE workspace_id = $1 AND user_id = $2',
        [workspaceId, userId]
      );
      if (collabResult.rows.length > 0) {
        userRole = collabResult.rows[0].role as TerminalRole;
      } else if (workspace.is_public) {
        userRole = 'viewer';
      }
    }

    if (!userRole) {
      console.log('[Terminal] Connection closed: No access to workspace');
      ws.close(4403, 'Forbidden: No access to this workspace');
      return;
    }

    // Viewers cannot open terminals (same policy as code execution)
    const roleHierarchy: Record<TerminalRole, number> = { viewer: 1, editor: 2, admin: 3 };
    if (roleHierarchy[userRole] < roleHierarchy.editor) {
      console.log('[Terminal] Connection closed: Insufficient role');
      ws.close(4403, 'Forbidden: Editor role required for terminal access');
      return;
    }

    // -------------------------------------------------------------------------
    // STEP 4: Enforce the one-terminal-per-workspace rule
    // -------------------------------------------------------------------------
    // Only allow one terminal per user-workspace combination.
    const sessionKey = `${userId}-${workspaceId}`;
    const existingSession = activeSessions.get(sessionKey);
    if (existingSession) {
      if (existingSession.isReconnecting && !forceNew) {
        console.log('[Terminal] Reconnecting to existing active session for', sessionKey);
        if (existingSession.teardownTimeout) {
          clearTimeout(existingSession.teardownTimeout);
          delete existingSession.teardownTimeout;
        }
        existingSession.isReconnecting = false;
        existingSession.ws = ws;

        // Replay cached output so a reconnecting client sees the recent shell state.
        const history = existingSession.historyBuffer.getCombined();
        if (history.length > 0) {
          ws.send(history);
        }

        // Rebind socket listeners to the newly attached WebSocket instance.
        bindWebSocketEvents(existingSession, ws, sessionKey);

        // Reset the idle timeout because the session is active again.
        const resetIdleTimeout = () => {
          clearTimeout(existingSession.idleTimeout);
          existingSession.idleTimeout = setTimeout(() => {
            console.log('[Terminal] Idle timeout reached, closing session');
            logAuditEvent(existingSession.userId, existingSession.workspaceId, 'idle_timeout');
            existingSession.ws.close(1000, 'Idle timeout');
          }, IDLE_TIMEOUT_MS);
        };
        resetIdleTimeout();

        // Record the reconnect for audit visibility.
        logAuditEvent(userId, workspaceId, 'connect', 'Reconnected successfully');
        console.log('[Terminal] Session reconnected for workspace:', workspaceId);
        return;
      } else {
        console.log('[Terminal] Closing existing session for new connection');
        await cleanupSession(existingSession);
        activeSessions.delete(sessionKey);
      }
    }

    // -------------------------------------------------------------------------
    // STEP 5: Load workspace files for container hydration
    // -------------------------------------------------------------------------
    const filesRes = await getPool().query(
      `WITH RECURSIVE file_path_cte AS (
        SELECT id, parent_id, name, type, content, name::text as path
        FROM files 
        WHERE workspace_id = $1 AND parent_id IS NULL
        UNION ALL
        SELECT f.id, f.parent_id, f.name, f.type, f.content, (cte.path || '/' || f.name)::text as path
        FROM files f
        INNER JOIN file_path_cte cte ON f.parent_id = cte.id
        WHERE f.workspace_id = $1
      )
      SELECT id, parent_id, name, type, content, path FROM file_path_cte;`,
      [workspaceId]
    );

    const workspaceFiles = filesRes.rows;

    // -------------------------------------------------------------------------
    // STEP 6: Pop a warm terminal container from the pool
    // -------------------------------------------------------------------------
    console.log('[Terminal] Popping warm container for workspace:', workspaceId);
    const warm = await warmPoolManager.popTerminalContainer();
    const container = warm.container;

    // -------------------------------------------------------------------------
    // STEP 7: Hydrate container with workspace files (tar stream)
    // -------------------------------------------------------------------------
    if (workspaceFiles.length > 0) {
      console.log('[Terminal] Hydrating container with', workspaceFiles.length, 'files');
      const execWrite = await container.exec({
        Cmd: ['tar', '-xf', '-', '-C', '/app'],
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true
      });
      const writeStream = await execWrite.start({ hijack: true, stdin: true });

      const pack = tar.pack();
      pack.pipe(writeStream);

      for (const file of workspaceFiles) {
        if (file.type === 'directory') {
          pack.entry({ name: file.path, type: 'directory' });
        } else {
          pack.entry({ name: file.path }, file.content || '');
        }
      }
      pack.finalize();

      await new Promise<void>((resolve, reject) => {
        writeStream.on('end', () => resolve());
        writeStream.on('error', (err) => reject(err));
      });
    }

    // -------------------------------------------------------------------------
    // STEP 8: Spawn an interactive shell with PTY
    // -------------------------------------------------------------------------
    console.log('[Terminal] Spawning interactive shell');
    const exec = await container.exec({
      Cmd: ['/bin/sh'],
      Tty: true,           // Allocate a pseudo-terminal (PTY)
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: '/app'   // Start shell in workspace directory
    });

    const stream = await exec.start({ hijack: true, stdin: true }) as TerminalSession['stream'];

    // -------------------------------------------------------------------------
    // STEP 9: Set up idle timeout
    // -------------------------------------------------------------------------
    let idleTimeout = setTimeout(() => {
      console.log('[Terminal] Idle timeout reached, closing session');
      logAuditEvent(userId, workspaceId, 'idle_timeout');
      if (session && session.ws) {
        session.ws.close(1000, 'Idle timeout');
      }
    }, IDLE_TIMEOUT_MS);

    // -------------------------------------------------------------------------
    // STEP 10: Create output buffer for rate limiting
    // -------------------------------------------------------------------------
    const outputBuffer: OutputBuffer = {
      chunks: [],
      totalBytes: 0,
      flushTimer: null
    };

    // Flush buffered output to the active WebSocket in batched chunks.
    const flushOutputBuffer = () => {
      if (outputBuffer.chunks.length === 0) return;

      if (session && session.ws && session.ws.readyState === WebSocket.OPEN) {
        // Concatenate all buffered chunks into a single message
        const combined = Buffer.concat(outputBuffer.chunks);
        session.ws.send(combined);
      }

      // Reset buffer
      outputBuffer.chunks = [];
      outputBuffer.totalBytes = 0;
      outputBuffer.flushTimer = null;
    };

    // Buffer each chunk and flush either on size threshold or timer expiry.
    const bufferOutput = (chunk: Buffer) => {
      outputBuffer.chunks.push(chunk);
      outputBuffer.totalBytes += chunk.length;

      // Flush immediately if buffer exceeds size limit (prevents memory buildup)
      if (outputBuffer.totalBytes >= OUTPUT_RATE_LIMIT_BYTES) {
        if (outputBuffer.flushTimer) {
          clearTimeout(outputBuffer.flushTimer);
          outputBuffer.flushTimer = null;
        }
        flushOutputBuffer();
        return;
      }

      // Schedule a flush if not already scheduled
      if (!outputBuffer.flushTimer) {
        outputBuffer.flushTimer = setTimeout(flushOutputBuffer, OUTPUT_RATE_LIMIT_MS);
      }
    };

    // Cache recent output so reconnecting sessions can catch up instantly.
    const historyBuffer = new TerminalHistoryBuffer();

    // -------------------------------------------------------------------------
    // STEP 11: Create session object and store it
    // -------------------------------------------------------------------------
    const currentSession: TerminalSession = {
      ws,
      container,
      exec,
      stream,
      idleTimeout,
      workspaceId,
      userId,
      outputBuffer,
      historyBuffer
    };
    session = currentSession;
    activeSessions.set(sessionKey, currentSession);

    // Log successful connection for audit visibility.
    logAuditEvent(userId, workspaceId, 'connect', `Role: ${userRole}`);

    // -------------------------------------------------------------------------
    // STEP 12: Pipe Docker stream → WebSocket & History Buffer
    // -------------------------------------------------------------------------
    stream.on('data', (chunk: Buffer) => {
      if (session) {
        session.historyBuffer.push(chunk);
      }
      bufferOutput(chunk); // Rate-limited batching keeps the browser responsive.
    });

    stream.on('end', () => {
      console.log('[Terminal] Docker stream ended');
      if (session && session.ws) {
        session.ws.close(1000, 'Shell terminated');
      }
    });

    stream.on('error', (err) => {
      console.error('[Terminal] Docker stream error:', err);
      if (session && session.ws) {
        session.ws.close(1011, 'Stream error');
      }
    });

    // -------------------------------------------------------------------------
    // STEP 13: Bind WebSocket event listeners
    // -------------------------------------------------------------------------
    bindWebSocketEvents(currentSession, ws, sessionKey);

    console.log('[Terminal] Session established for workspace:', workspaceId);

  } catch (error: any) {
    console.error('[Terminal] Setup error:', error);
    ws.close(1011, 'Internal server error');
    if (session) {
      await cleanupSession(session);
    }
  }
}

// =============================================================================
// CLEANUP HELPER
// =============================================================================
// Closes all resources associated with a terminal session:
//   - Clears the idle timeout
//   - Ends the Docker stream
//   - Removes the container (kills the shell)
//   - Closes the WebSocket if still open
async function cleanupSession(session: TerminalSession): Promise<void> {
  try {
    clearTimeout(session.idleTimeout);

    if (session.stream && !session.stream.destroyed) {
      session.stream.end();
      session.stream.destroy?.();
    }

    if (session.container) {
      await session.container.remove({ force: true }).catch((err) => {
        console.error('[Terminal] Failed to remove container:', err.message);
      });
      
      // Notify the pool manager so it can shrink or refill the terminal pool.
      warmPoolManager.releaseTerminalContainer();
    }

    if (session.ws.readyState === WebSocket.OPEN || session.ws.readyState === WebSocket.CONNECTING) {
      session.ws.close();
    }
  } catch (err) {
    console.error('[Terminal] Cleanup error:', err);
  }
}

// =============================================================================
// REAL-TIME FILESYSTEM SYNCHRONIZATION HELPERS
// =============================================================================

export async function syncFileToTerminal(workspaceId: string, fileId: string, content: string): Promise<void> {
  try {
    const session = Array.from(activeSessions.values()).find(s => s.workspaceId === workspaceId);
    if (!session || !session.container) {
      return;
    }

    const pathResult = await getPool().query(
      `WITH RECURSIVE file_path_cte AS (
        SELECT id, parent_id, name, name::text as path
        FROM files 
        WHERE workspace_id = $1 AND parent_id IS NULL
        UNION ALL
        SELECT f.id, f.parent_id, f.name, (cte.path || '/' || f.name)::text as path
        FROM files f
        INNER JOIN file_path_cte cte ON f.parent_id = cte.id
        WHERE f.workspace_id = $1
      )
      SELECT path FROM file_path_cte WHERE id = $2;`,
      [workspaceId, fileId]
    );

    if (pathResult.rows.length === 0) {
      return;
    }

    const filePath = pathResult.rows[0].path;

    const exec = await session.container.exec({
      Cmd: ['sh', '-c', `mkdir -p "$(dirname "/app/${filePath}")" && cat > "/app/${filePath}"`],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true
    });

    const writeStream = await exec.start({ hijack: true, stdin: true });
    writeStream.end(content);

    console.log(`[TerminalSync] Automatically synchronized ${filePath} to active container`);
  } catch (err: any) {
    console.error('[TerminalSync] Failed to sync file update:', err.message);
  }
}

export async function syncDeleteToTerminal(workspaceId: string, filePath: string): Promise<void> {
  try {
    const session = Array.from(activeSessions.values()).find(s => s.workspaceId === workspaceId);
    if (!session || !session.container) {
      return;
    }

    const exec = await session.container.exec({
      Cmd: ['rm', '-rf', `/app/${filePath}`]
    });
    await exec.start({ hijack: true, stdin: false });
    console.log(`[TerminalSync] Automatically deleted /app/${filePath} inside active container`);
  } catch (err: any) {
    console.error('[TerminalSync] Failed to sync file deletion:', err.message);
  }
}

export async function syncFolderToTerminal(workspaceId: string, folderPath: string): Promise<void> {
  try {
    const session = Array.from(activeSessions.values()).find(s => s.workspaceId === workspaceId);
    if (!session || !session.container) {
      return;
    }

    const exec = await session.container.exec({
      Cmd: ['mkdir', '-p', `/app/${folderPath}`]
    });
    await exec.start({ hijack: true, stdin: false });
    console.log(`[TerminalSync] Automatically created folder /app/${folderPath} inside active container`);
  } catch (err: any) {
    console.error('[TerminalSync] Failed to sync folder creation:', err.message);
  }
}
