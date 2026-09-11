import test from "node:test";
import assert from "node:assert/strict";
import { parseBenchmarkStats, parseFfprobeJson, parseProgressBlock, parseVmafJson } from "../src/parsers.js";

test("ffprobe JSON içinden video ve ses özelliklerini okur", () => {
  const parsed = parseFfprobeJson({
    streams: [
      { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30000/1001", bit_rate: "4200000", pix_fmt: "yuv420p" },
      { codec_type: "audio", codec_name: "aac", bit_rate: "96000", channels: 2, sample_rate: "48000" }
    ],
    format: { format_name: "mov,mp4", duration: "12.345", size: "7000000", bit_rate: "4500000" }
  });
  assert.equal(parsed.video.codec, "h264");
  assert.equal(parsed.video.width, 1920);
  assert.ok(Math.abs(parsed.video.fps - 29.97003) < 0.0001);
  assert.equal(parsed.audio.codec, "aac");
  assert.equal(parsed.audio.bitrate, 96000);
  assert.equal(parsed.durationSeconds, 12.345);
});

test("sessiz video ffprobe çıktısını kabul eder", () => {
  const parsed = parseFfprobeJson({
    streams: [{ codec_type: "video", codec_name: "vp9", width: 640, height: 360, r_frame_rate: "25/1" }],
    format: { duration: "2.0", size: "1234", bit_rate: "50000" }
  });
  assert.equal(parsed.audio, null);
  assert.equal(parsed.video.bitrate, 50000);
  assert.equal(parsed.video.fps, 25);
});

test("video stream olmayan ffprobe çıktısını reddeder", () => {
  assert.throws(() => parseFfprobeJson({ streams: [{ codec_type: "audio" }] }), /Dosya video değil/);
});

test("FFmpeg progress bloğunda out_time ve speed okur", () => {
  const parsed = parseProgressBlock("frame=120\nout_time=00:00:04.500000\nspeed=2.4x\nprogress=continue\n");
  assert.equal(parsed.outTimeSeconds, 4.5);
  assert.equal(parsed.speed, 2.4);
  assert.equal(parsed.ended, false);
});

test("FFmpeg progress out_time_us fallback değerini okur", () => {
  const parsed = parseProgressBlock("out_time_us=2750000\nspeed=N/A\nprogress=end\n");
  assert.equal(parsed.outTimeSeconds, 2.75);
  assert.equal(parsed.speed, null);
  assert.equal(parsed.ended, true);
});

test("VMAF JSON mean ve frame skorlarından 5. yüzdelik okur", () => {
  const parsed = parseVmafJson({
    frames: [0, 100, 80].map((vmaf) => ({ metrics: { vmaf } })),
    pooled_metrics: { vmaf: { mean: 60 } }
  });
  assert.equal(parsed.mean, 60);
  assert.equal(parsed.percentile5, 8);
  assert.deepEqual(parsed.frameScores, [0, 100, 80]);
});

test("FFmpeg benchmark çıktısından CPU kullanımını hesaplar", () => {
  const parsed = parseBenchmarkStats("bench: utime=4.000s stime=1.000s rtime=2.000s\nbench: maxrss=1KiB");
  assert.deepEqual(parsed, { userSeconds: 4, systemSeconds: 1, realSeconds: 2, cpuPercent: 250 });
});
