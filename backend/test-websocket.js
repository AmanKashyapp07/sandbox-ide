const http = require('http');
const { WebSocketServer } = require('ws');
const { Server: SocketIOServer } = require('socket.io');

const server = http.createServer((req, res) => res.end('OK'));
const wss = new WebSocketServer({ server });
const io = new SocketIOServer(server);

wss.on('connection', (ws) => {
  console.log('WS connected!');
  ws.send('Hello');
});

server.listen(4005, () => {
  const WebSocket = require('ws');
  const ws = new WebSocket('ws://localhost:4005/workspace-123');
  ws.on('open', () => console.log('Client connected'));
  ws.on('message', (m) => console.log('Client got:', m.toString()));
  ws.on('error', (err) => console.error('Client error:', err.message));
  ws.on('close', () => {
    console.log('Client closed');
    process.exit(0);
  });
});
