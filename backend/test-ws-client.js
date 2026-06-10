const WebSocket = require('ws');
// using a dummy token that is syntactically valid but will fail signature verification
const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjEyMyIsInVzZXJuYW1lIjoidGVzdCJ9.invalid_signature_xxx';
const ws = new WebSocket(`ws://localhost:4000/workspace-6dbdab59-d100-4553-bf22-b1f49d6323ed?token=${token}`);
ws.on('open', () => console.log('Connected'));
ws.on('close', (code, reason) => console.log('Closed', code, reason.toString()));
ws.on('error', (err) => console.log('Error', err.message));
