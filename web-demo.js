const express = require("express");
const bus = require("./web-demo-bus");

function mountWebDemo(app) {
  const router = express.Router();
  const clients = new Set();

  // Live SSE stream to the web UI
  router.get("/stream", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write("\n");
    clients.add(res);

    // keep-alive
    const ping = setInterval(() => {
      try { res.write(`data: ${JSON.stringify({ type: "ping" })}\n\n`); } catch {}
    }, 25000);

    req.on("close", () => {
      clearInterval(ping);
      clients.delete(res);
    });
  });

  // Start button — kick off your generative flow (no FSM required)
  router.post("/start", express.json(), async (req, res) => {
    const { voice, voiceId } = req.body || {};
    bus.emit("status", `Web start requested (voice: ${voice || voiceId || "default"})`);
    broadcast({ role: "Agent", text: "Connecting…" });
    // If you want to signal your bridge explicitly, you can:
    bus.emit("webdemo:start", { voice, voiceId });
    res.json({ ok: true });
  });

  // Fanout helper
  function broadcast(payload) {
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const r of clients) { try { r.write(line); } catch {} }
  }

  // Bridge → UI
  bus.on("bridge:user",  (text) => broadcast({ role: "User",  text }));
  bus.on("bridge:agent", (text) => broadcast({ role: "Agent", text }));
  bus.on("status",       (text) => broadcast({ type: "status", text }));

  app.use("/web-demo", router);
}

module.exports = { mountWebDemo };
