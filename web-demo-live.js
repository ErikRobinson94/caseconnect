
// web-demo-live.js
// Browser mic <-> Deepgram Agent bridge (NO Twilio).
// PCM16 @ 16k, 20ms framing, preroll flush, transcript forwarding.
// Avatar voice is chosen via ?voiceId=1|2|3 -> VOICE_{id}_TTS (fallback DG_TTS_VOICE).

const WebSocket = require("ws");
const bus = require("./web-demo-bus");

// tiny helpers (same shaping as phone bridge)
function sanitizeASCII(str) {
  if (!str) return "";
  return String(str)
    .replace(/[\u0000-\u001F\u007F-\uFFFF]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function compact(s, max = 380) {
  if (!s) return "";
  const t = s.length <= max ? s : s.slice(0, max);
  if (t.length >= 40) return t;
  return "You are the intake specialist. Determine existing client vs accident. If existing: ask full name, best phone, and attorney; then say you will transfer. If accident: collect full name, phone, email, what happened, when, and city/state; confirm all; then say you will transfer. Be warm, concise, and stop speaking if the caller talks.";
}

function setupWebDemoLive(server, { route = "/web-demo/ws" } = {}) {
  const wss = new WebSocket.Server({ server, path: route, perMessageDeflate: false });

  wss.on("connection", (browserWS, req) => {
    let closed = false;

    // ---- read voiceId from query (defaults to 1) ----
    let voiceId = 1;
    try {
      const u = new URL(req.url, "http://localhost");
      const v = parseInt(u.searchParams.get("voiceId") || "1", 10);
      if ([1, 2, 3].includes(v)) voiceId = v;
    } catch {}

    // map per-avatar TTS from env
    const ttsFromEnv =
      process.env[`VOICE_${voiceId}_TTS`] ||
      process.env.DG_TTS_VOICE ||
      "aura-2-odysseus-en";

    // ---- Deepgram Agent ----
    const dgUrl = process.env.DG_AGENT_URL || "wss://agent.deepgram.com/v1/agent/converse";
    const dgKey = process.env.DEEPGRAM_API_KEY;
    if (!dgKey) {
      try { browserWS.send(JSON.stringify({ type: "status", text: "Missing DEEPGRAM_API_KEY" })); } catch {}
      return;
    }
    const agentWS = new WebSocket(dgUrl, ["token", dgKey]);

    const sttModel = (process.env.DG_STT_MODEL || "nova-2").trim();
    const llmModel = (process.env.LLM_MODEL || "gpt-4o-mini").trim();
    const ttsVoice = ttsFromEnv; // chosen per avatar

    // prompt/greeting parity with the phone bridge
    const firm      = process.env.FIRM_NAME  || "Benji Personal Injury";
    const agentName = process.env.AGENT_NAME || "Alexis";
    const DEFAULT_PROMPT =
      `You are ${agentName} for ${firm}. First ask: existing client or accident? Ask exactly one question per turn and wait for the reply. Existing: get name, best phone, attorney; then say youll transfer. Accident: get name, phone, email, what happened, when, city/state; confirm, then say youll transfer. Stop if the caller talks.`;

    const useEnv = String(process.env.DISABLE_ENV_INSTRUCTIONS || "false").toLowerCase() !== "true";
    const rawEnvPrompt = useEnv ? (process.env.AGENT_INSTRUCTIONS || "") : "";
    const rawPrompt = sanitizeASCII(rawEnvPrompt || DEFAULT_PROMPT);
    const prompt = compact(rawPrompt, 380);

    const greeting = sanitizeASCII(
      process.env.AGENT_GREETING ||
      `Thank you for calling ${firm}. Were you in an accident, or are you an existing client?`
    );

    let settingsSent = false;
    let settingsApplied = false;

    function sendSettings() {
      if (settingsSent) return;
      const temperature = Number(process.env.LLM_TEMPERATURE || "0.15");
      const settings = {
        type: "Settings",
        audio: {
          input:  { encoding: "linear16", sample_rate: 16000 },
          output: { encoding: "linear16", sample_rate: 16000 },
        },
        agent: {
          language: "en",
          greeting,
          listen: { provider: { type: "deepgram", model: sttModel, smart_format: true } },
          think:  { provider: { type: "open_ai", model: llmModel, temperature }, prompt },
          speak:  { provider: { type: "deepgram", model: ttsVoice } },
        },
      };
      try {
        agentWS.send(JSON.stringify(settings));
        settingsSent = true;
        // tell the UI exactly what we applied
        try {
          browserWS.send(JSON.stringify({
            type: "settings",
            sttModel, ttsVoice, llmModel, temperature,
            greeting, prompt_len: prompt.length
          }));
        } catch {}
      } catch (e) {
        try { browserWS.send(JSON.stringify({ type: "status", text: "Failed to send Settings to Deepgram." })); } catch {}
      }
    }

    agentWS.on("open", () => {
      try { browserWS.send(JSON.stringify({ type: "status", text: "Connected to Deepgram." })); } catch {}
      bus?.emit("status", "Web demo connected to Deepgram.");
      sendSettings();
    });

    // keepalive
    const keepalive = setInterval(() => {
      if (agentWS.readyState === WebSocket.OPEN) {
        try { agentWS.send(JSON.stringify({ type: "KeepAlive" })); } catch {}
      }
    }, 25000);

    // debug meters
    let meterMicBytes = 0, meterTtsBytes = 0;
    const meter = setInterval(() => {
      if (meterMicBytes || meterTtsBytes) {
        console.log("[web-demo] meter", { mic_bytes_per_s: meterMicBytes, tts_bytes_per_s: meterTtsBytes });
        meterMicBytes = 0; meterTtsBytes = 0;
      }
    }, 1000);

    function forwardTranscript(role, text, isFinal) {
      const payload = { type: "transcript", role: role === "agent" ? "Agent" : "User", text, partial: !isFinal };
      try { browserWS.send(JSON.stringify(payload)); } catch {}
    }

    // preroll buffer (frames queued before SettingsApplied)
    const preFrames = [];
    const MAX_PRE_FRAMES = 200; // ~4s

    agentWS.on("message", (data) => {
      const isBuf = Buffer.isBuffer(data);
      // JSON control / transcripts
      if (!isBuf || (isBuf && data.length && data[0] === 0x7b)) {
        let evt = null; try { evt = JSON.parse(isBuf ? data.toString("utf8") : data); } catch {}
        if (!evt) return;

        const role = String((evt.role || evt.speaker || evt.actor || "")).toLowerCase();
        const text = String(evt.content ?? evt.text ?? evt.transcript ?? evt.message ?? "").trim();
        const isFinal = evt.final === true || evt.is_final === true || evt.status === "final" || evt.type === "UserResponse";

        switch (evt.type) {
          case "Welcome":
            sendSettings();
            break;

          case "SettingsApplied":
            settingsApplied = true;
            // flush preroll
            if (preFrames.length) {
              try {
                for (const fr of preFrames) agentWS.send(fr);
              } catch {}
              preFrames.length = 0;
            }
            break;

          // grab a broad set of transcript events
          case "ConversationText":
          case "History":
          case "UserTranscript":
          case "UserResponse":
          case "Transcript":
          case "AddUserMessage":
          case "AddAssistantMessage":
          case "AgentTranscript":
          case "AgentResponse":
          case "PartialTranscript":
          case "AddPartialTranscript":
            if (!text) break;
            if (role.includes("agent") || role.includes("assistant")) {
              forwardTranscript("agent", text, isFinal);
            } else if (role.includes("user")) {
              forwardTranscript("user", text, isFinal);
            }
            break;

          case "AgentWarning":
            try { browserWS.send(JSON.stringify({ type: "status", text: `Agent warning: ${evt.message || "unknown"}` })); } catch {}
            break;

          case "AgentError":
          case "Error":
            try { browserWS.send(JSON.stringify({ type: "status", text: `Agent error: ${evt.description || evt.message || "unknown"}` })); } catch {}
            break;
        }
        return;
      }

      // Binary = DG TTS PCM16 @ 16k → forward to browser
      meterTtsBytes += data.length;
      try { browserWS.send(data, { binary: true }); } catch {}
    });

    agentWS.on("close", () => {
      clearInterval(keepalive); clearInterval(meter);
      try { browserWS.send(JSON.stringify({ type: "status", text: "Deepgram connection closed." })); } catch {}
      bus?.emit("status", "Web demo Deepgram closed.");
      safeClose();
    });

    agentWS.on("error", (e) => {
      try { browserWS.send(JSON.stringify({ type: "status", text: `Deepgram error: ${e?.message || e}` })); } catch {}
    });

    // ---- Browser mic → DG, 20 ms framing, queue until ready ----
    const FRAME_MS = 20, IN_RATE = 16000, BPS = 2;
    const BYTES_PER_FRAME = Math.round(IN_RATE * BPS * (FRAME_MS / 1000)); // 640

    let micBuf = Buffer.alloc(0);

    browserWS.on("message", (msg) => {
      // Ignore any JSON text messages from the browser (we only expect audio frames)
      if (typeof msg === "string") return;

      if (agentWS.readyState !== WebSocket.OPEN) return;
      const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
      meterMicBytes += buf.length;
      micBuf = Buffer.concat([micBuf, buf]);

      while (micBuf.length >= BYTES_PER_FRAME) {
        const frame = micBuf.subarray(0, BYTES_PER_FRAME);
        micBuf = micBuf.subarray(BYTES_PER_FRAME);
        if (!settingsSent || !settingsApplied) {
          preFrames.push(frame);
          if (preFrames.length > MAX_PRE_FRAMES) preFrames.shift();
        } else {
          try { agentWS.send(frame); } catch {}
        }
      }
    });

    browserWS.on("close", safeClose);
    browserWS.on("error", safeClose);

    function safeClose() {
      if (closed) return;
      closed = true;
      try { agentWS.close(1000); } catch {}
      try { browserWS.terminate?.(); } catch {}
    }
  });
}

module.exports = { setupWebDemoLive };
