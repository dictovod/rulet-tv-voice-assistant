class RutvCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.chunkSize = options.processorOptions.chunkSize;
    this.chunk = new Float32Array(this.chunkSize);
    this.offset = 0;
  }

  process(inputs, outputs) {
    for (const channel of outputs[0] || []) channel.fill(0);
    const input = inputs[0] && inputs[0][0];
    if (input) {
      for (let i = 0; i < input.length; i++) {
        this.chunk[this.offset++] = input[i];
        if (this.offset === this.chunkSize) {
          const chunk = this.chunk;
          this.port.postMessage(chunk.buffer, [chunk.buffer]);
          this.chunk = new Float32Array(this.chunkSize);
          this.offset = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('rutv-capture', RutvCaptureProcessor);
