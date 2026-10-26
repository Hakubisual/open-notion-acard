// Browser re-encode of a video before upload (acard-upload-100mb). Bundled with mediabunny (MPL-2.0, unmodified) into
// the lazy chunk /lazy/video-encode.js by scripts/build-editor-next.ts; nothing loads it until a video is dropped.
//
// Output: MP4, H.264 Main profile (avc1.4D..; iOS Safari and every Android plays it) at most 1080 px on the long side,
// ~30 fps, a bitrate that fits the size, and AAC audio (the source audio is copied when it already is AAC). Rotation
// from the source metadata is kept as MP4 rotation metadata. encode() rejects (and the editor uploads the original) when
// WebCodecs, an H.264 or AAC encoder is missing, the source is HDR, the conversion would drop the sound, it fails, runs
// out of memory or time, or is cancelled.
import { BlobSource, BufferTarget, Conversion, CustomVideoEncoder, EncodedPacket, Input, MP4, Mp4OutputFormat, Output, QTFF, WEBM, canEncodeAudio, registerEncoder } from "mediabunny";

var LONG_SIDE = 1080;
var MAX_FPS = 30;

// mediabunny always asks the browser for High profile; this wraps the platform encoder and asks for Main instead,
// keeping the level mediabunny picked for the size.
function mainProfile(codec) {
  return /^avc1\.[0-9a-f]{6}$/i.test(codec) ? "avc1.4d00" + codec.slice(9) : codec;
}
class MainProfileEncoder extends CustomVideoEncoder {
  static supports(codec, config) { return codec === "avc" && typeof VideoEncoder !== "undefined"; }
  init() {
    var self = this;
    var config = Object.assign({}, this.config, { codec: mainProfile(this.config.codec), avc: { format: "avc" } });
    this.encoder = new VideoEncoder({
      output: function (chunk, meta) { self.onPacket(EncodedPacket.fromEncodedChunk(chunk), meta); },
      error: function (error) { self.onError(error); },
    });
    return VideoEncoder.isConfigSupported(config).then(function (support) {
      if (!support.supported) throw new Error("H.264 Main profile is not supported here");
      self.encoder.configure(config);
    });
  }
  encode(sample, options) {
    var frame = sample.toVideoFrame();
    try { this.encoder.encode(frame, options); } finally { frame.close(); }
    if (this.encoder.encodeQueueSize > 8) {
      var encoder = this.encoder;
      return new Promise(function (resolve) { encoder.addEventListener("dequeue", function wait() { if (encoder.encodeQueueSize <= 4) { encoder.removeEventListener("dequeue", wait); resolve(); } }); });
    }
  }
  flush() { return this.encoder.flush(); }
  close() { if (this.encoder && this.encoder.state !== "closed") this.encoder.close(); }
}
registerEncoder(MainProfileEncoder);

function even(n) { return Math.max(2, Math.round(n / 2) * 2); }

// Target size: the long side capped at 1080 and ~0.1 bits per pixel per frame (1080p30 ~ 6 Mbit/s, 720p30 ~ 2.8 Mbit/s).
function plan(width, height, fps) {
  var scale = Math.min(1, LONG_SIDE / Math.max(width, height));
  var w = even(width * scale), h = even(height * scale);
  var rate = Math.min(MAX_FPS, fps > 0 ? fps : MAX_FPS);
  return { width: w, height: h, fps: rate, bitrate: Math.round(Math.min(8e6, Math.max(1.2e6, w * h * rate * 0.1))) };
}

function supported() {
  return typeof VideoEncoder === "function" && typeof VideoDecoder === "function" && typeof AudioEncoder === "function";
}

// file: a File/Blob. options: { onProgress(fraction), signal (AbortSignal), timeoutMs }. Resolves { file, width, height,
// bitrate } with an mp4 File, or rejects with an Error whose .reason says why (unsupported, hdr, audio, failed, timeout,
// cancelled).
function encode(file, options) {
  options = options || {};
  var fail = function (reason, cause) { var e = new Error(reason + (cause ? ": " + (cause.message || cause) : "")); e.reason = reason; return e; };
  if (!supported()) return Promise.reject(fail("unsupported"));
  var input = new Input({ source: new BlobSource(file), formats: [MP4, QTFF, WEBM] });
  var conversion = null, timer = null, stopped = null;
  var cleanup = function () { clearTimeout(timer); if (options.signal) options.signal.removeEventListener("abort", onAbort); try { input.dispose(); } catch (e) { void e; } };
  var stop = function (reason) { if (stopped) return; stopped = reason; if (conversion) conversion.cancel().catch(function () {}); };
  var onAbort = function () { stop("cancelled"); };
  if (options.signal) { if (options.signal.aborted) return Promise.reject(fail("cancelled")); options.signal.addEventListener("abort", onAbort); }
  return input.getPrimaryVideoTrack().then(function (video) {
    if (!video) throw fail("unsupported");
    return Promise.all([video.getDisplayWidth(), video.getDisplayHeight(), video.hasHighDynamicRange(), video.computePacketStats(120), input.getAudioTracks()]).then(function (got) {
      if (got[2]) throw fail("hdr");
      var target = plan(got[0], got[1], got[3].averagePacketRate);
      var audio = got[4][0] || null;
      return (audio ? canEncodeAudio("aac", { bitrate: 128e3 }) : Promise.resolve(true)).then(function (aac) {
        if (!aac) throw fail("audio");
        var output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
        return Conversion.init({
          input: input,
          output: output,
          tracks: "primary",
          showWarnings: false,
          video: { codec: "avc", width: target.width, height: target.height, fit: "contain", frameRate: target.fps, bitrate: target.bitrate, forceTranscode: true, keyFrameInterval: 2 },
          audio: { codec: "aac", bitrate: 128e3 },
        }).then(function (made) {
          conversion = made;
          if (stopped) throw fail(stopped);
          if (!made.isValid) throw fail("unsupported");
          if (audio && !made.utilizedTracks.some(function (t) { return t.isAudioTrack(); })) throw fail("audio");
          made.onProgress = function (p) { if (options.onProgress) options.onProgress(Math.max(0, Math.min(1, p))); };
          if (options.timeoutMs) timer = setTimeout(function () { stop("timeout"); }, options.timeoutMs);
          return made.execute().then(function () {
            if (stopped) throw fail(stopped);
            var name = String(file.name || "video").replace(/\.[^.]+$/, "") + ".mp4";
            return { file: new File([output.target.buffer], name, { type: "video/mp4" }), width: target.width, height: target.height, bitrate: target.bitrate };
          });
        });
      });
    });
  }).catch(function (error) {
    if (error && error.reason) throw error;
    if (stopped) throw fail(stopped);
    throw fail(/memory|allocat/i.test(String(error && error.message)) ? "memory" : "failed", error);
  }).finally(cleanup);
}

if (window.AcardEditor) window.AcardEditor.provide("video-encode", { encode: encode, supported: supported, plan: plan });
