import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import http from 'http';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { getPool } from './db';
import * as Y from 'yjs';
// @ts-ignore
import { setupWSConnection, setPersistence } from 'y-websocket/bin/utils';
import workspaceRoutes from './routes/workspace';
import authRoutes from './routes/auth';
import { requireAuth } from './middleware/auth';

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/workspace', requireAuth, workspaceRoutes);

const server = http.createServer(app);

setPersistence({
  bindState: async (docName: string, ydoc: Y.Doc) => {
    const match = docName.match(/^([0-9a-fA-F-]{36})-([0-9a-fA-F-]{36})$/);
    if (match) {
      const fileId = match[2];
      try {
        const res = await getPool().query('SELECT content, yjs_state FROM files WHERE id = $1', [fileId]);
        if (res.rows.length > 0) {
          const { content, yjs_state } = res.rows[0];
          if (yjs_state) {
            Y.applyUpdate(ydoc, yjs_state);
          } else if (content) {
            ydoc.getText('monaco').insert(0, content);
          }
        }
      } catch (err) {
        console.error('Error loading state from DB:', err);
      }
    }
  },
  writeState: async (docName: string, ydoc: Y.Doc) => {
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

// WebSocket server for Yjs
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  // Extract docName from the URL
  const docName = req.url?.slice(1).split('?')[0] || 'default';
  setupWSConnection(ws, req, { docName });
});

const PORT = process.env.PORT || 4000;

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  // Test Database Connection
  getPool().query('SELECT NOW()', (err, res) => {
    if (err) {
      console.error('❌ Failed to connect to PostgreSQL Database:', err.message);
    } else {
      console.log('✅ Successfully connected to PostgreSQL Database!');
    }
  });
});
