// Plays scrcpy's H.264 stream (see server/src/lib/scrcpy.ts) with WebCodecs.

/** The WebCodecs codec string (`avc1.PPCCLL`) from the SPS in a config packet. */
export function avcCodec(config: Uint8Array): string | undefined {
  for (let i = 0; i + 6 < config.length; i++) {
    // A start code, then a NAL header of type 7 (SPS): profile, constraint flags and level follow it.
    if (config[i] === 0 && config[i + 1] === 0 && config[i + 2] === 1 && (config[i + 3] & 0x1f) === 7)
      return "avc1." + [config[i + 4], config[i + 5], config[i + 6]].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return undefined;
}

/**
 * Decodes scrcpy's packets (12-byte header, then H.264 in Annex B) and hands each picture to `draw`. A config packet
 * (SPS and PPS) goes in front of the key frame after it, which is how the decoder takes them without a description.
 */
export function h264Player(draw: (frame: VideoFrame) => void, onError: (message: string) => void) {
  let decoder: VideoDecoder | undefined;
  let config: Uint8Array | undefined;
  let waitingForKey = true;
  return {
    packet(data: ArrayBuffer) {
      const bytes = new Uint8Array(data);
      // A session packet: a new size (after a rotation), and a new config follows.
      if (bytes.length < 12 || bytes[0] & 0x80) return;
      const view = new DataView(data);
      const hi = view.getUint32(0);
      const payload = bytes.subarray(12);
      if (hi & 0x40000000) {
        config = payload.slice();
        return;
      }
      let chunk = payload;
      if (config) {
        const codec = avcCodec(config);
        if (!codec) return onError("The device sent a video config without an SPS");
        if (!decoder || decoder.state === "closed")
          decoder = new VideoDecoder({
            output: draw,
            error: (e) => {
              decoder = undefined;
              waitingForKey = true;
              onError(`Couldn't decode the video: ${e.message}`);
            },
          });
        try {
          decoder.configure({ codec, optimizeForLatency: true });
        } catch (e) {
          return onError(`This browser can't decode ${codec}: ${(e as Error).message}`);
        }
        chunk = new Uint8Array(config.length + payload.length);
        chunk.set(config);
        chunk.set(payload, config.length);
        config = undefined;
        waitingForKey = true;
      }
      const key = (hi & 0x20000000) !== 0;
      if (!decoder || decoder.state !== "configured" || (waitingForKey && !key)) return;
      waitingForKey = false;
      // The PTS (µs) is the low 61 bits.
      const pts = (hi & 0x1fffffff) * 2 ** 32 + view.getUint32(4);
      decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: pts, data: chunk }));
    },
    close() {
      if (decoder && decoder.state !== "closed") decoder.close();
    },
  };
}
