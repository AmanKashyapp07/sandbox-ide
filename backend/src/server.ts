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
import * as fs from 'fs/promises';
import * as path from 'path';

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
            // We store BOTH:
            //   yjs_state (BYTEA): full CRDT state for collaborative sync
            //   content (TEXT): human-readable plain text for non-Yjs consumers
            //                   (e.g. running code via the execute endpoint which
            //                    reads the code string directly)
          } catch (err) {
            console.error('Error auto-saving state to DB:', err);
          }
        }, 2000);
      });
    }
  },

  writeState: async (docName: string, ydoc: Y.Doc) => {
    // Called by y-websocket when the last client disconnects from this document.
    // Performs a final authoritative save of the complete Yjs state.
    const match = docName.match(/^([0-9a-fA-F-]{36})-([0-9a-fA-F-]{36})$/);
    if (match) {
      const fileId = match[2];
      try {
        const state = Y.encodeStateAsUpdate(ydoc);
        const content = ydoc.getText('monaco').toString();
        await getPool().query(
          'UPDATE files SET yjs_state = $1, content = $2 WHERE id = $3',
          [Buffer.from(state), content, fileId]
        );
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
const wss = new WebSocketServer({ server });
// Attaching to `server` means the WebSocket server shares port 4000 with
// Express. Incoming connections are differentiated by the Upgrade header:
//   Upgrade: websocket → handled by wss
//   (no Upgrade header) → handled by Express

wss.on('connection', (ws, req) => {
  // Extract the Yjs document name from the URL path.
  // Client connects to ws://localhost:4000/<workspaceId>-<fileId>
  // req.url = "/<workspaceId>-<fileId>" (may include ?<querystring>)
  const docName = req.url?.slice(1).split('?')[0] || 'default';

  // setupWSConnection handles the entire Yjs sync protocol over this socket:
  //   - Sync step 1 & 2 (state vector exchange + missing update transmission)
  //   - Awareness updates (cursor positions, user info)
  //   - Persistence hooks (calls our bindState/writeState at appropriate times)
  setupWSConnection(ws, req, { docName });
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

io.on('connection', (socket) => {

  socket.on('join-voice-room', async ({ workspaceId, user }) => {
    // socket.join() puts this socket into a named room.
    // io.to(workspaceId).emit() then broadcasts to all sockets in that room.
    socket.join(workspaceId);
    socket.data.workspaceId = workspaceId;
    socket.data.user = user;

    // Notify existing users in the room that someone new joined.
    // socket.to(room) = broadcast to all sockets in `room` EXCEPT the sender.
    socket.to(workspaceId).emit('user-joined-voice', { socketId: socket.id, user });

    // Send the new user the list of already-connected peers so it can
    // initiate WebRTC offers to each of them.
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

  // When a user disconnects (tab closed, network lost), notify their voice room.
  socket.on('disconnect', () => {
    if (socket.data.workspaceId) {
      io.to(socket.data.workspaceId).emit('user-left-voice', socket.id);
      // The remaining peers use socket.id to find and close the RTCPeerConnection
      // they established with this user, removing their audio track from the UI.
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