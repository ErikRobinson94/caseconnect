// public/worklets/pcm-processor.js
// Mic frames -> PCM16 @ 16k, 20 ms. Sends ArrayBuffer via port.

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inRate = sampleRate; // ctx rate, usually 48000
    this.outRate = 16000;
    this.buffer = [];
    this.accum = [];
    this.ratio = this.inRate / this.outRate;
    this.cursor = 0;
    this.samplesPerFrame = Math.round(0.02 * this.outRate); // 20ms -> 320 samples @ 16k
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || !input[0].length) return true;
    const chan = input[0];

    // Resample to 16k (linear)
    for (let i = 0; i < chan.length; i++) {
      this.accum.push(chan[i]);
    }

    // Downsample using linear interpolation
    const out = [];
    let pos = this.cursor;
    const step = this.ratio;
    while (pos < this.accum.length) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const s0 = this.accum[i0] ?? this.accum[this.accum.length - 1] ?? 0;
      const s1 = this.accum[i0 + 1] ?? s0;
      out.push(s0 + (s1 - s0) * frac);
      pos += step;
    }
    // Keep leftover source samples
    const keepFrom = Math.max(0, Math.floor(pos));
    this.accum = this.accum.slice(keepFrom);
    this.cursor = pos - keepFrom;

    // Chunk to 20ms frames and send as Int16
    while (out.length >= this.samplesPerFrame) {
      const frame = out.splice(0, this.samplesPerFrame);
      const pcm16 = new Int16Array(frame.length);
      for (let i = 0; i < frame.length; i++) {
        let s = frame[i];
        if (s > 1) s = 1;
        if (s < -1) s = -1;
        pcm16[i] = s * 0x7fff;
      }
      this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    }

    return true;
  }
}

registerProcessor('pcm-processor', PcmProcessor);
