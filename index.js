// index.js
require('dotenv').config();
const express = require('express');
const http = require('http');

const { handleTwilioCall } = require('./lib/twilioHandler');
const { setupAudioStream } = require('./lib/audio-stream');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Twilio Voice webhook: returns TwiML that starts the Media Stream
app.post('/twilio/voice', handleTwilioCall);

// Health
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// ----- Server 1: your existing backend (Twilio + Deepgram bridge) -----
const server = http.createServer(app);
setupAudioStream(server);

const PORT = parseInt(process.env.PORT || '5002', 10);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[${new Date().toISOString()}] info server_listen`, {
    url: `http://0.0.0.0:${PORT}`
  });
});

// ----- Server 2: dedicated WS for browser-only demo (no Twilio) -----
const { setupWebDemoLive } = require('./web-demo-live');
const demoServer = http.createServer();          // no Express needed
setupWebDemoLive(demoServer);                    // mounts WS at /web-demo/ws

const DEMO_PORT = parseInt(process.env.DEMO_PORT || '5055', 10);
demoServer.listen(DEMO_PORT, '0.0.0.0', () => {
  console.log(`[${new Date().toISOString()}] info demo_server_listen`, {
    url: `ws://0.0.0.0:${DEMO_PORT}/web-demo/ws`
  });
});
