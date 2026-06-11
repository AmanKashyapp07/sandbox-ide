import dotenv from 'dotenv';
dotenv.config();
// dotenv reads the .env file and copies each KEY=VALUE pair into process.env.
// Must run BEFORE any other import that reads process.env (e.g. database config).
// In production you'd use real environment variables injected by the platform
// (Kubernetes secrets, AWS Secrets Manager) instead of a .env file.

import express from 'express';
import http from 'http';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { Server as SocketIOServer } from 'socket.io';
import { getPool } from './db';
import * as Y from 'yjs';
// @ts-ignore — no official TypeScript types for y-websocket's server utilities
import { setupWSConnection, setPersistence } from 'y-websocket/bin/utils';
import workspaceRoutes from './routes/workspace';
import authRoutes from './routes/auth';
import { requireAuth } from './middleware/auth';
import jwt from 'jsonwebtoken';
import * as fs from 'fs/promises';
import * as path from 'path';
import { warmPoolManager } from './sandbox/pool';
import { handleTerminalConnection, syncFileToTerminal } from './terminal/terminalHandler';

// =============================================================================
// EXPRESS APPLICATION SETUP
// =============================================================================
//
// WHY EXPRESS OVER RAW node:http?
//   Express adds middleware chaining (app.use), routing (app.get/post/…),
//   and request/response helpers on top of Node's http module. Writing all
//   of that by hand in raw http would be hundreds of lines of boilerplate.
//
// ARCHITECTURE OVERVIEW:
//
//   Browser (React)
//       │
//       ├── HTTP REST (port 4000)  ──→ Express routes  ──→ PostgreSQL
//       │     /api/auth/*                 (JWT auth, workspace CRUD,
//       │     /api/workspace/*             code execution via Docker)
//       │
//       ├── WebSocket (ws://:4000/<docName>)
//       │     y-websocket server  ──→ Yjs CRDT sync  ──→ PostgreSQL
//       │     (real-time collaborative editing)
//       │
//       └── Socket.IO (ws://:4000, /socket.io namespace)
//             WebRTC signaling for voice chat
//             (offer/answer/ICE candidate relay)
//
// WHY ONE PORT FOR ALL THREE PROTOCOLS?
//   HTTP, WebSocket, and Socket.IO all start as HTTP requests. WebSocket and
//   Socket.IO use the HTTP Upgrade header to switch protocols. A single HTTP
//   server can handle all three by inspecting the Upgrade header on each
//   incoming connection and routing accordingly.

const app = express();

// ---------------------------------------------------------------------------
// CORS — Cross-Origin Resource Sharing
// ---------------------------------------------------------------------------
// Browsers enforce the Same-Origin Policy: a page at http://localhost:5173
// (Vite dev server) cannot make fetch() calls to http://localhost:4000 unless
// the backend explicitly opts in via CORS response headers.
//
// cors() middleware adds:
//   Access-Control-Allow-Origin: *
//   Access-Control-Allow-Methods: GET,HEAD,PUT,PATCH,POST,DELETE
//   Access-Control-Allow-Headers: Content-Type, Authorization, ...
//
// In production you'd restrict the origin:
//   cors({ origin: 'https://yourdomain.com' })
// to prevent other websites from calling your API on behalf of logged-in users
// (CSRF via CORS exploit).
app.use(cors());

// ---------------------------------------------------------------------------
// JSON body parser
// ---------------------------------------------------------------------------
// Reads the raw request body bytes, parses them as JSON, and puts the result
// on req.body. Without this, req.body would be undefined for POST/PUT requests.
// Internally uses the 'body-parser' package, which buffers the stream into
// memory — default limit is 100 KB (raise it if you accept large code files).
app.use(express.json());

// ---------------------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------------------
// requireAuth is JWT middleware: it reads the Authorization: Bearer <token>
// header, verifies the JWT signature, and attaches the decoded payload to
// req.user. If the token is missing or invalid, it returns 401 immediately
// without calling the next handler.
app.use('/api/auth', authRoutes);
app.use('/api/workspace', requireAuth, workspaceRoutes);
// All workspace operations (file CRUD, code execution) are behind auth.

// =============================================================================
// HTTP SERVER — Shared by Express, WebSocket, and Socket.IO
// =============================================================================
// http.createServer(app) wraps the Express app in a Node.js HTTP server.
// We do NOT call server.listen() yet — we configure WebSocket servers first.
//
// WHY NOT USE app.listen()?
//   app.listen() creates its own internal HTTP server. We need a reference to
//   the server object so we can attach WebSocketServer to it (wss = new
//   WebSocketServer({ server })). If we used app.listen(), we'd have no way
//   to get that server reference.
const server = http.createServer(app);

// =============================================================================
// YJS CRDT PERSISTENCE LAYER
// =============================================================================
//
// WHAT IS CRDT?
//   Conflict-free Replicated Data Type. A data structure designed for
//   distributed systems where multiple nodes update their own copy concurrently
//   without a central coordinator. The CRDT algorithm guarantees that all
//   copies converge to the same state eventually, regardless of the order
//   in which updates are received.
//
// YJS SPECIFICALLY — Y.Text:
//   Yjs models a text document as a sequence of typed characters, each tagged
//   with a unique logical timestamp (Lamport clock: clientID + sequenceNumber).
//   When User A inserts "x" at position 5 and User B inserts "y" at position 5
//   simultaneously, Yjs uses clientID as a tiebreaker to deterministically
//   decide which character comes first — both users converge to the same result
//   without server coordination.
//
// WHY NOT OPERATIONAL TRANSFORMATION (OT)?
//   OT (used by Google Docs v1, ShareDB) requires a central server to receive
//   ALL operations and transform them in order. This is:
//     1. A single point of failure
//     2. A bottleneck at scale
//     3. Complex to implement correctly (proofs required for correctness)
//   CRDTs are decentralized — any peer can apply updates in any order and
//   eventually converge. Yjs can even sync offline changes made by a user.
//
// PERSISTENCE HOOK — setPersistence({ bindState, writeState }):
//   y-websocket handles in-memory Yjs docs for connected users but doesn't
//   know about our database. setPersistence lets us inject two hooks:
//
//   bindState(docName, ydoc):
//     Called when the FIRST client connects to a document (doc is "cold").
//     We load the saved Yjs binary state from PostgreSQL and apply it to ydoc
//     so the new client syncs with the persisted document history.
//
//   writeState(docName, ydoc):
//     Called when the LAST client disconnects (doc goes "cold" again).
//     We save the full Yjs state as binary bytes to PostgreSQL for durability.
//
// WHY STORE BINARY (BYTEA) INSTEAD OF PLAIN TEXT?
//   The Yjs state includes the full edit HISTORY — every insertion/deletion
//   with its author and logical timestamp. This history is what enables
//   correct CRDT merge when new clients connect. Plain text only stores the
//   final string, losing the CRDT metadata needed for conflict resolution.
//   Y.encodeStateAsUpdate(ydoc) produces a compact binary encoding of this.
setPersistence({
  bindState: async (docName: string, ydoc: Y.Doc) => {
    // docName format: "<workspaceId>-<fileId>" (set in CodeEditor.tsx)
    const match = docName.match(/^([0-9a-fA-F-]{36})-([0-9a-fA-F-]{36})$/);
    if (match) {
      const fileId = match[2];
      try {
        const res = await getPool().query(
          'SELECT content, yjs_state FROM files WHERE id = $1',
          [fileId]
        );
        if (res.rows.length > 0) {
          const { content, yjs_state } = res.rows[0];

          if (yjs_state) {
            // Apply the full binary Yjs state (includes complete edit history).
            // Y.applyUpdate merges the saved state into the in-memory ydoc.
            // "Merge" here is safe because Yjs updates are idempotent —
            // applying the same update twice has no effect.
            Y.applyUpdate(ydoc, yjs_state);
          } else if (content) {
            // Fallback for files created before Yjs was added: seed the ydoc
            // with the plain text content. ydoc.getText('monaco') returns the
            // Y.Text shared type that the Monaco editor is bound to.
            // 'monaco' is just a string key — a namespace within the Y.Doc.
            ydoc.getText('monaco').insert(0, content);
          }
        }
      } catch (err) {
        console.error('Error loading state from DB:', err);
        // Non-fatal: the user gets an empty document instead of the saved one.
        // Better than crashing the WebSocket connection for all users.
      }

      // AUTO-SAVE ON EVERY UPDATE — debounced 2 seconds.
      //
      // WHY DEBOUNCE?
      //   Yjs fires an 'update' event on EVERY character typed. A user typing
      //   at 60 WPM generates ~5 updates/second. Without debouncing, we'd run
      //   5 PostgreSQL UPDATE queries per second per user — a serious load spike.
      //   Debouncing delays the save until typing pauses for 2 seconds, batching
      //   many keystrokes into one DB write.
      //
      // WHY SAVE HERE AND NOT ONLY IN writeState?
      //   writeState fires when the LAST client disconnects. If the server
      //   crashes before that (power cut, OOM kill), writeState never fires
      //   and all in-flight edits are lost. This debounced auto-save acts as
      //   a durability safety net — at most 2 seconds of work is lost on crash.
      let saveTimeout: NodeJS.Timeout | null = null;
      ydoc.on('update', () => {
        if (saveTimeout) clearTimeout(saveTimeout);
        saveTimeout = setTimeout(async () => {
          try {
            const state = Y.encodeStateAsUpdate(ydoc);
            // encodeStateAsUpdate serializes the ENTIRE current state of the
            // Y.Doc as a binary update message. Any peer applying this update
            // will end up with the exact same document state.
            const contentText = ydoc.getText('monaco').toString();
            await getPool().query(
              'UPDATE files SET yjs_state = $1, content = $2 WHERE id = $3',
              [Buffer.from(state), contentText, fileId]
            );
            
            // Sync to active terminal container
            const workspaceId = match[1];
            syncFileToTerminal(workspaceId as string, fileId as string, contentText).catch((err) => {
              console.error('Failed to sync updated file to terminal:', err);
            });
            // We store BOTH:
            //   yjs_state (BYTEA): full CRDT state for collaborative sync
            //   content (TEXT): human-readable plain text for non-Yjs consumers
            //                   (e.g. running code via the execute endpoint which
            //                    reads the code string directly)
          } catch (err) {
            console.error('Error auto-saving state to DB:', err);
          }
        }, 400);
      });
    }
  },

  writeState: async (docName: string, ydoc: Y.Doc) => {
    // Called by y-websocket when the last client disconnects from this document.
    // Performs a final authoritative save of the complete Yjs state.
    const match = docName.match(/^([0-9a-fA-F-]{36})-([0-9a-fA-F-]{36})$/);
    if (match) {
      const workspaceId = match[1];
      const fileId = match[2];
      try {
        const state = Y.encodeStateAsUpdate(ydoc);
        const content = ydoc.getText('monaco').toString();
        await getPool().query(
          'UPDATE files SET yjs_state = $1, content = $2 WHERE id = $3',
          [Buffer.from(state), content, fileId]
        );
        syncFileToTerminal(workspaceId as string, fileId as string, content).catch((err) => {
          console.error('Failed to sync updated file to terminal on writeState:', err);
        });
      } catch (err) {
        console.error('Error writing state to DB:', err);
      }
    }
  }
});

// =============================================================================
// YJS WEBSOCKET SERVER — Real-time collaborative editing
// =============================================================================
//
// HOW Y-WEBSOCKET WORKS INTERNALLY:
//   1. Client (CodeEditor.tsx) creates a Y.Doc and a WebsocketProvider pointing
//      at ws://localhost:4000/<docName>.
//   2. WebsocketProvider connects here (wss). setupWSConnection attaches Yjs
//      sync protocol handlers to the socket.
//   3. On connect, the server and client exchange "sync step 1" messages to
//      determine what updates each side is missing (using Yjs state vectors).
//   4. Each side sends the missing updates — client and server converge.
//   5. Subsequently, every local edit is immediately broadcast to all connected
//      peers for that docName (room), keeping all editors in sync with <50ms
//      latency on LAN.
//
// AWARENESS PROTOCOL:
//   Alongside document sync, Yjs also syncs ephemeral "awareness" state —
//   things that don't need to persist: cursor position, user name, color.
//   This is how the live cursor indicators (colored caret + name tag) work.
//   Awareness state is NOT persisted to PostgreSQL — it's in-memory only.
//
// WHY WEBSOCKET INSTEAD OF POLLING?
//   Polling (setInterval fetch every N seconds) introduces latency proportional
//   to the interval and wastes bandwidth with empty responses. WebSocket
//   maintains a persistent connection with no per-message overhead after the
//   initial handshake, enabling true real-time sync (<10ms propagation in
//   ideal conditions).
const wss = new WebSocketServer({ noServer: true });
// =============================================================================
// WEBSOCKET UPGRADE ROUTING
// =============================================================================
//
// WHY MANUAL UPGRADE HANDLING?
//   Express handles normal HTTP requests, but WebSocket traffic starts as an
//   HTTP request with Upgrade: websocket. We intercept the upgrade event
//   ourselves so one server can multiplex REST, Yjs sync, terminal shells,
//   and Socket.IO signaling on the same port.
//
// ROUTING RULES:
//   - /terminal/<workspaceId> → interactive terminal handler
//   - /socket.io/*            → Socket.IO signaling path
//   - everything else         → Express / Yjs handling
//
// WHY FILTER SOCKET.IO HERE?
//   Socket.IO also relies on HTTP upgrades. If y-websocket or the terminal
//   handler grabbed those requests first, it could break WebRTC signaling.
//   The early return keeps each protocol isolated to its own connection path.
server.on('upgrade', (request, socket, head) => {
  const parsedUrl = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
  if (parsedUrl.pathname.startsWith('/socket.io/')) {
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', async (ws, req) => {
  try {
    const parsedUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    
    // =============================================================================
    // ROUTE: TERMINAL WEBSOCKET SESSIONS
    // =============================================================================
    //
    // Terminal sessions are long-lived and stateful, so they are routed before
    // any collaborative-editing logic. The handler validates JWTs, hydrates a
    // warm container, and bridges the browser terminal UI to Docker exec.
    if (parsedUrl.pathname.startsWith('/terminal/')) {
      await handleTerminalConnection(ws, req);
      return;
    }

    // =============================================================================
    // ROUTE: YJS COLLABORATIVE EDITING
    // =============================================================================
    const token = parsedUrl.searchParams.get('token');
    
    if (!token) {
      console.log('[WS] Connection closed: Missing token');
      ws.close(4401, 'Unauthorized: Token required');
      return;
    }

    const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';
    let decodedUser: any;
    try {
      decodedUser = jwt.verify(token, JWT_SECRET);
    } catch (e: any) {
      console.log('[WS] Connection closed: Invalid token', e.message);
      ws.close(4401, 'Unauthorized: Invalid token');
      return;
    }

    const docName = parsedUrl.pathname.slice(1);
    if (!docName || docName === 'default') {
      setupWSConnection(ws, req, { docName });
      return;
    }

    // docName is <workspaceId>-<fileId> or workspace-<workspaceId>
    const match = docName.match(/^([0-9a-fA-F-]{36})(-.*)?$/) || docName.match(/^workspace-([0-9a-fA-F-]{36})$/);
    if (!match) {
      console.log('[WS] Connection closed: Invalid room format:', docName);
      ws.close(4000, 'Bad Request: Invalid room name format');
      return;
    }
    const workspaceId = match[1];

    const wsResult = await getPool().query('SELECT owner_id, is_public FROM workspaces WHERE id = $1', [workspaceId]);
    if (wsResult.rows.length === 0) {
      console.log('[WS] Connection closed: Workspace not found:', workspaceId);
      ws.close(4044, 'Workspace not found');
      return;
    }
    const workspace = wsResult.rows[0];

    let role = null;
    if (workspace.owner_id === decodedUser.id) {
      role = 'admin';
    } else {
      const collabResult = await getPool().query('SELECT role FROM workspace_collaborators WHERE workspace_id = $1 AND user_id = $2', [workspaceId, decodedUser.id]);
      if (collabResult.rows.length > 0) {
        role = collabResult.rows[0].role;
      } else if (workspace.is_public) {
        role = 'viewer';
      }
    }

    if (!role) {
      console.log('[WS] Connection closed: Forbidden (no role) for workspace:', workspaceId);
      ws.close(4403, 'Forbidden: You do not have access to this workspace');
      return;
    }

    // Enforce read-only for viewers
    if (role === 'viewer') {
      const originalOn = ws.on.bind(ws);
      ws.on = function(event: string, listener: any) {
        if (event === 'message') {
          const interceptedListener = (message: any, isBinary: boolean) => {
            if (isBinary && message.length > 0) {
              const messageType = message[0];
              if (messageType === 0) {
                // messageType = 0 is a Sync message
                // We only allow SyncStep1 (requesting state vector) from read-only.
                // SyncStep1 has format: [0, 0, ...stateVector]
                if (message.length > 1 && message[1] !== 0) {
                   return; // discard update
                }
              }
            }
            listener(message, isBinary);
          };
          return originalOn(event, interceptedListener);
        }
        return originalOn(event, listener);
      };
    }

    setupWSConnection(ws, req, { docName });
  } catch (error) {
    console.error('WebSocket connection error:', error);
    ws.close(4500, 'Internal Server Error');
  }
});

// =============================================================================
// SOCKET.IO SERVER — WebRTC Signaling for Voice Chat
// =============================================================================
//
// WHY SOCKET.IO ON TOP OF WEBSOCKET?
//   Socket.IO adds rooms (named channels), event-based messaging, and automatic
//   reconnection on top of raw WebSocket. For signaling, these features save
//   significant boilerplate.
//
// WHAT IS WEBRTC SIGNALING?
//   WebRTC enables peer-to-peer audio/video between browsers, but peers first
//   need to exchange connection metadata through a third-party server. This is
//   called "signaling". Our Socket.IO server is that signaling channel.
//
// THE WEBRTC HANDSHAKE FLOW (3-way):
//   1. OFFER:
//      Peer A calls RTCPeerConnection.createOffer() to describe its media
//      capabilities (codecs, bitrates) in SDP (Session Description Protocol)
//      format. It sends this offer to our server, which relays it to Peer B.
//
//   2. ANSWER:
//      Peer B receives the offer, creates an RTCPeerConnection, sets the remote
//      description (Peer A's offer), calls createAnswer(), and sends it back
//      through our server to Peer A.
//
//   3. ICE CANDIDATES:
//      ICE (Interactive Connectivity Establishment) finds the best network path
//      between peers. Each peer discovers its own candidates (local IP, STUN
//      server reflexive IP, TURN relay) and sends them through the signaling
//      server to the other peer. Once both have enough candidates, WebRTC
//      attempts to establish a direct P2P connection.
//
// AFTER SIGNALING:
//   Audio data flows DIRECTLY between browsers (P2P) without touching our
//   server. Our server is only involved during the 3-way handshake above.
//   This keeps voice latency low and our server bandwidth costs near zero.
const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication error'));
    
    const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';
    const decodedUser = jwt.verify(token, JWT_SECRET) as any;
    socket.data.user = decodedUser;
    next();
  } catch(err) {
    next(new Error('Authentication error'));
  }
});

// =============================================================================
// WORKSPACE PRESENCE TRACKING — In-Memory Map
// =============================================================================
// Tracks which users are currently viewing each workspace. Completely
// independent of Yjs awareness — uses Socket.IO events for instant updates
// with no auth delay.
//
// Structure: Map<workspaceId, Map<socketId, { username, color }>>
const workspacePresence = new Map<string, Map<string, { username: string; color: string }>>();

const PRESENCE_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#06b6d4', '#3b82f6', '#a855f7', '#ec4899',
];

const getPresenceColor = (username: string) => {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
  }
  return PRESENCE_COLORS[Math.abs(hash) % PRESENCE_COLORS.length];
};

/**
 * Broadcasts the full presence list for a workspace to all connected sockets
 * in that workspace's presence room.
 */
const broadcastPresence = (workspaceId: string) => {
  const members = workspacePresence.get(workspaceId);
  const users = members ? Array.from(members.values()) : [];
  io.to(`presence-${workspaceId}`).emit('workspace-presence-update', users);
};

io.on('connection', (socket) => {

  // =========================================================================
  // WORKSPACE PRESENCE (join/leave/disconnect)
  // =========================================================================
  socket.on('join-workspace', ({ workspaceId }: { workspaceId: string }) => {
    const user = socket.data.user;
    if (!user || !workspaceId) return;

    // Track which workspace this socket is in for cleanup on disconnect
    socket.data.presenceWorkspaceId = workspaceId;

    // Join a Socket.IO room dedicated to presence for this workspace
    socket.join(`presence-${workspaceId}`);

    // Add user to presence map
    if (!workspacePresence.has(workspaceId)) {
      workspacePresence.set(workspaceId, new Map());
    }
    const username = (user.username || 'unknown') as string;
    workspacePresence.get(workspaceId)!.set(socket.id, {
      username,
      color: getPresenceColor(username) || '#8b5cf6',
    });

    // Broadcast updated presence list to ALL users in this workspace
    broadcastPresence(workspaceId);
  });

  socket.on('leave-workspace', () => {
    const workspaceId = socket.data.presenceWorkspaceId;
    if (!workspaceId) return;

    socket.leave(`presence-${workspaceId}`);
    const members = workspacePresence.get(workspaceId);
    if (members) {
      members.delete(socket.id);
      if (members.size === 0) {
        workspacePresence.delete(workspaceId);
      }
    }
    socket.data.presenceWorkspaceId = null;
    broadcastPresence(workspaceId);
  });

  socket.on('join-voice-room', async ({ workspaceId }) => {
    const user = socket.data.user;
    
    const wsResult = await getPool().query('SELECT owner_id, is_public FROM workspaces WHERE id = $1', [workspaceId]);
    if (wsResult.rows.length === 0) return;
    
    const workspace = wsResult.rows[0];
    let hasAccess = false;
    
    if (workspace.owner_id === user.id || workspace.is_public) {
      hasAccess = true;
    } else {
      const collabRes = await getPool().query('SELECT role FROM workspace_collaborators WHERE workspace_id = $1 AND user_id = $2', [workspaceId, user.id]);
      if (collabRes.rows.length > 0) hasAccess = true;
    }
    
    if (!hasAccess) return;

    socket.join(workspaceId);
    socket.data.workspaceId = workspaceId;

    socket.to(workspaceId).emit('user-joined-voice', { socketId: socket.id, user });

    const sockets = await io.in(workspaceId).fetchSockets();
    const existingPeers = sockets
      .filter(s => s.id !== socket.id)
      .map(s => ({ socketId: s.id, user: s.data.user }));

    socket.emit('existing-voice-users', existingPeers);
  });

  // Relay the WebRTC offer SDP from one peer to a specific target peer.
  // `to` is the target's socket.id. We use socket.to(to) instead of
  // io.to(to) to avoid the sender receiving its own event.
  socket.on('webrtc-offer', ({ offer, to, user }) => {
    socket.to(to).emit('webrtc-offer', { offer, from: socket.id, user });
  });

  // Relay the WebRTC answer SDP back to the peer who sent the offer.
  socket.on('webrtc-answer', ({ answer, to }) => {
    socket.to(to).emit('webrtc-answer', { answer, from: socket.id });
  });

  // Relay ICE candidates between peers.
  // ICE candidates contain network address info (IP:port pairs) that WebRTC
  // uses to try establishing a direct peer-to-peer connection (UDP preferred,
  // TCP fallback, TURN relay as last resort).
  socket.on('webrtc-ice-candidate', ({ candidate, to }) => {
    socket.to(to).emit('webrtc-ice-candidate', { candidate, from: socket.id });
  });

  // When a user disconnects (tab closed, network lost), clean up everything.
  socket.on('disconnect', () => {
    // Clean up voice chat
    if (socket.data.workspaceId) {
      io.to(socket.data.workspaceId).emit('user-left-voice', socket.id);
    }

    // Clean up workspace presence
    const presenceWsId = socket.data.presenceWorkspaceId;
    if (presenceWsId) {
      const members = workspacePresence.get(presenceWsId);
      if (members) {
        members.delete(socket.id);
        if (members.size === 0) {
          workspacePresence.delete(presenceWsId);
        }
      }
      broadcastPresence(presenceWsId);
    }
  });
});

// =============================================================================
// START THE SERVER
// =============================================================================
const PORT = process.env.PORT || 4000;
// on server startup, clean temp_sandboxes of any previous runs to prevent disk bloat from orphaned sandboxes.
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);

  // Initialize the warm container pool
  warmPoolManager.initializePools().catch((err) => {
    console.error('❌ Failed to initialize warm container pools:', err.message);
  });

  // Clean temp_sandbox folder of any files left from aborted executions or crashes
  const tempSandboxDir = path.join(process.cwd(), 'temp_sandbox');
  fs.readdir(tempSandboxDir)
    .then(async (files) => {
      for (const file of files) {
        // We preserve manual helper files or gitkeep files, but clean up the temp uuid/python files
        if (file !== '.gitkeep' && file !== 'test.py') {
          try {
            await fs.unlink(path.join(tempSandboxDir, file));
          } catch (err: any) {
            console.error(`Failed to delete temp file ${file}:`, err.message);
          }
        }
      }
      console.log('✅ Cleaned up old/orphaned files in temp_sandbox.');
    })
    .catch((err) => {
      // If the directory doesn't exist, that's fine, we'll create it during runs anyway
      if (err.code !== 'ENOENT') {
        console.error('Failed to read temp_sandbox directory:', err.message);
      }
    });

  // Quick DB connectivity check on startup.
  // SELECT NOW() is the lightest possible query — no table scan, just returns
  // the current timestamp from the DB server clock.
  // If this fails, the server is up but DB-dependent routes will all error.
  getPool().query('SELECT NOW()', (err, res) => {
    if (err) {
      console.error('❌ Failed to connect to PostgreSQL Database:', err.message);
    } else {
      console.log('✅ Successfully connected to PostgreSQL Database!');
    }
  });
});

// Process event listeners for graceful shutdown
const gracefulShutdown = async (signal: string) => {
  console.log(`Received ${signal}. Starting graceful shutdown...`);
  try {
    await warmPoolManager.cleanup();
  } catch (err: any) {
    console.error('Failed to clean up warm pool during shutdown:', err.message);
  }
  process.exit(0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));