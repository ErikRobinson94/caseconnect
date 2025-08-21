const VOICES = [
  { id: 1, name: "Voice 1", src: "/images/voice-m1.png", scale: 1.12 },
  { id: 2, name: "Voice 2", src: "/images/voice-f1.png" },
  { id: 3, name: "Voice 3", src: "/images/voice-m2.png" },
];

let selected = 2;
let ws = null;
let audioCtx = null;
let micNode = null;
let playerNode = null;
let srcNode = null;
let statusEl = document.getElementById("status");
let logEl = document.getElementById("log");

function addBubble(role, text, cls) {
  const div = document.createElement("div");
  div.className = `bbl ${cls || (role === "Agent" ? "agent" : role === "User" ? "user" : "sys")}`;
  div.textContent = (role ? `${role}: ` : "") + text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}
function setStatus(t) { statusEl.textContent = t; }

function getWSBase() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/web-demo/ws`;
}

async function ensureAudio() {
  if (audioCtx) return audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  audioCtx = new Ctx();
  if (audioCtx.state === "suspended") { try { await audioCtx.resume(); } catch {} }
  await audioCtx.audioWorklet.addModule("/worklets/pcm-processor.js");
  await audioCtx.audioWorklet.addModule("/worklets/pcm-player.js");
  return audioCtx;
}

async function start() {
  try {
    logEl.innerHTML = "";
    setStatus("Connecting…");

    const url = `${getWSBase()}?voiceId=${selected}`;
    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => setStatus("Connected.");
    ws.onclose = () => setStatus("Stopped.");
    ws.onerror = () => setStatus("Error.");

    ws.onmessage = async (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        // Binary = PCM16 @16k from server (DG TTS) → convert to Float32 & push to player worklet
        const pcm16 = new Int16Array(ev.data);
        const f32 = new Float32Array(pcm16.length);
        for (let i = 0; i < pcm16.length; i++) f32[i] = Math.max(-1, Math.min(1, pcm16[i] / 0x8000));
        // resample in the worklet graph (player just buffers Float32 already at ctx rate)
        playerNode.port.postMessage(f32.buffer, [f32.buffer]);
        return;
      }
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "transcript") {
          if (msg.partial) {
            // show as lightweight italics but don't replace history
            const div = document.createElement("div");
            div.className = `bbl ${msg.role === "Agent" ? "agent" : "user"} italic`;
            div.textContent = `${msg.role}: ${msg.text}`;
            // replace any existing last partial of same role
            const prev = logEl.querySelector(`.bbl.${msg.role === "Agent" ? "agent" : "user"}.italic:last-of-type`);
            if (prev) prev.remove();
            logEl.appendChild(div);
            logEl.scrollTop = logEl.scrollHeight;
          } else {
            // remove any partial(s) of that role and append final
            const partials = logEl.querySelectorAll(`.bbl.${msg.role === "Agent" ? "agent" : "user"}.italic`);
            partials.forEach((n) => n.remove());
            addBubble(msg.role, msg.text);
          }
        } else if (msg.type === "status") {
          addBubble("System", msg.text, "sys");
        } else if (msg.type === "settings") {
          addBubble("System", `Settings: STT=${msg.sttModel}, TTS=${msg.ttsVoice}, LLM=${msg.llmModel} (T=${msg.temperature}). Greeting="${msg.greeting}". Prompt chars=${msg.prompt_len}.`, "sys");
        }
      } catch {}
    };

    const ctx = await ensureAudio();
    const player = new AudioWorkletNode(ctx, "pcm-player");
    player.connect(ctx.destination);
    playerNode = player;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    srcNode = ctx.createMediaStreamSource(stream);

    micNode = new AudioWorkletNode(ctx, "pcm-processor"); // emits Int16 @16k, 20ms frames
    // keep mic graph connected but silent to avoid feedback
    const silence = ctx.createGain(); silence.gain.value = 0;
    micNode.connect(silence).connect(ctx.destination);

    micNode.port.onmessage = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(e.data); // raw ArrayBuffer (PCM16 @16k, 20ms)
    };

    srcNode.connect(micNode);
    addBubble("System", `Voice selected: ${selected}`, "sys");
  } catch (e) {
    setStatus("Failed to start.");
    addBubble("System", `Error: ${e?.message || e}`, "sys");
  }
}

function stop() {
  try { ws && ws.close(); } catch {}
  ws = null;
  try { micNode && micNode.port && micNode.port.close && micNode.port.close(); } catch {}
  try { playerNode && playerNode.disconnect(); } catch {}
  try { srcNode && srcNode.disconnect(); } catch {}
  try { audioCtx && audioCtx.close(); } catch {}
  micNode = null; playerNode = null; srcNode = null; audioCtx = null;
  setStatus("Stopped.");
}

document.getElementById("btnStart").addEventListener("click", start);
document.getElementById("start").addEventListener("click", start);
document.getElementById("btnStop").addEventListener("click", stop);

// voice grid
const voicesEl = document.getElementById("voices");
function renderVoices(){
  voicesEl.innerHTML = "";
  VOICES.forEach(v => {
    const btn = document.createElement("button");
    btn.className = "voice" + (v.id === selected ? " sel" : "");
    btn.onclick = () => { selected = v.id; renderVoices(); };
    btn.innerHTML = `
      <div class="imgbox"><img src="${v.src}" alt="${v.name}" style="transform:scale(${v.scale||1})"/></div>
      <div style="text-align:center; margin-top:6px; font-size:12px; font-weight:600; color:${v.id===selected?'#fbbf24':'#d4d4d4'}">${v.name}</div>
    `;
    voicesEl.appendChild(btn);
  });
}
renderVoices();
