// public/worklets/pcm-player.js
// Receives Float32 PCM at ctx.sampleRate via port, plays with a small FIFO.

class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.readIndex = 0;
    this.port.onmessage = (e) => {
      const buf = e.data;
      const f32 = new Float32Array(buf);
      this.queue.push(f32);
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0]; // mono
    let written = 0;

    while (written < out.length) {
      if (!this.queue.length) {
        // underrun -> silence
        out.fill(0, written);
        return true;
      }
      const cur = this.queue[0];
      const remaining = cur.length - this.readIndex;
      const needed = out.length - written;
      const toCopy = Math.min(remaining, needed);
      out.set(cur.subarray(this.readIndex, this.readIndex + toCopy), written);
      this.readIndex += toCopy;
      written += toCopy;

      if (this.readIndex >= cur.length) {
        this.queue.shift();
        this.readIndex = 0;
      }
    }

    return true;
  }
}

registerProcessor('pcm-player', PcmPlayer);
