require('dotenv').config();
const authRouteContent = require('fs').readFileSync('src/routes/auth.ts', 'utf8');
const serverContent = require('fs').readFileSync('src/server.ts', 'utf8');
console.log("auth.ts JWT_SECRET definition: ", authRouteContent.split('\n').find(l => l.includes('JWT_SECRET =')));
console.log("server.ts WebSocket JWT_SECRET definition: ", serverContent.split('\n').find(l => l.includes('JWT_SECRET =')));
