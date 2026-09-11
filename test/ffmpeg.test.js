import test from "node:test";
import assert from "node:assert/strict";
import { buildEncodeArgs, buildSampleSegments, calculateTargetDimensions } from "../src/ffmpeg.js";

const config = { crf: 23, preset: "veryfast", resolution: "720", maxFps: "30", audioBitrate: "96k" };

test("çözünürlüğü büyütmeden en-boy oranını koruyup çift sayıya indirir", () => {
  assert.deepEqual(calculateTargetDimensions(1920, 1080, "720"), { width: 1280, height: 720, changed: true });
  assert.deepEqual(calculateTargetDimensions(641, 359, "720"), { width: 640, height: 358, changed: true });
  assert.deepEqual(calculateTargetDimensions(640, 360, "720"), { width: 640, height: 360, changed: false });
});

test("yalnız gerektiğinde scale ve fps filtresi üretir", () => {
  const high = buildEncodeArgs({ inputPath: "/tmp/in", outputPath: "/tmp/out.mp4", config, source: { video: { width: 1920, height: 1080, fps: 60 } } });
  const filter = high[high.indexOf("-vf") + 1];
  assert.match(filter, /scale=1280:720/);
  assert.match(filter, /fps=30/);
  assert.equal(filter, "fps=30,scale=1280:720:flags=fast_bilinear");
  assert.deepEqual(high.slice(2, 6), ["-threads", "0", "-i", "/tmp/in"]);
  const low = buildEncodeArgs({ inputPath: "/tmp/in", outputPath: "/tmp/out.mp4", config, source: { video: { width: 640, height: 360, fps: 25 } } });
  assert.equal(low.includes("-vf"), false);
  assert.ok(low.includes("0:a:0?"));
  assert.ok(low.includes("libx264"));
  assert.ok(low.includes("+faststart"));
});

test("kısa videolarda örnekleme bölümleri çakışmaz", () => {
  const segments = buildSampleSegments(18, "sample");
  assert.equal(segments.length, 3);
  for (let i = 1; i < segments.length; i += 1) {
    assert.ok(segments[i - 1].start + segments[i - 1].duration <= segments[i].start + 1e-9);
  }
  assert.ok(Math.abs(segments.reduce((sum, item) => sum + item.duration, 0) - 18) < 1e-9);
});

test("chunk encode doğru seek, thread, video-only ve timestamp seçeneklerini üretir", () => {
  const args = buildEncodeArgs({
    inputPath: "/tmp/in", outputPath: "/tmp/chunk_000.mp4", config,
    source: { video: { width: 1920, height: 1080, fps: 60 } },
    threads: 2, filterThreads: 2, timeRange: { start: 10, duration: 20 }, videoOnly: true
  });
  assert.deepEqual(args.slice(2, 12), ["-filter_threads", "2", "-ss", "10.000000", "-t", "20.000000", "-threads", "2", "-i", "/tmp/in"]);
  assert.equal(args[args.indexOf("-vf") + 1], "fps=30,scale=1280:720:flags=fast_bilinear,setpts=PTS-STARTPTS");
  assert.ok(args.includes("-an"));
  assert.equal(args.includes("-c:a"), false);
});
