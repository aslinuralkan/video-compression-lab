import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import {
  buildChunkRanges,
  buildConcatList,
  chooseParallelPlan,
  createProgressAggregator,
  encodeParallel,
  terminateChildren,
  validateParallelOutput
} from "../src/parallel.js";

const longSource = {
  durationSeconds: 3600,
  sizeBytes: 7.3 * 1024 ** 3,
  video: { width: 2560, height: 1440, fps: 60 },
  audio: { codec: "opus" }
};
const config = { resolution: "720", maxFps: "25", parallelism: "auto" };

test("chunk aralıkları FPS gridinde bitişik ve çakışmasızdır", () => {
  const ranges = buildChunkRanges(3861.18, 4, 25);
  assert.equal(ranges.length, 4);
  assert.equal(ranges[0].start, 0);
  for (let index = 1; index < ranges.length; index += 1) {
    assert.ok(Math.abs(ranges[index].start - (ranges[index - 1].start + ranges[index - 1].duration)) < 1e-9);
  }
  const total = ranges.reduce((sum, range) => sum + range.duration, 0);
  assert.ok(Math.abs(total - 3861.18) < 1e-9);
  assert.equal(ranges.reduce((sum, range) => sum + range.frameCount, 0), Math.round(3861.18 * 25));
});

test("adaptif plan uzun 1440p60 kaynakta dört worker seçer", () => {
  const plan = chooseParallelPlan(longSource, config, { logicalCpus: 8, maxWorkers: 4 });
  assert.equal(plan.workers, 4);
  assert.equal(plan.threadsPerWorker, 2);
  assert.deepEqual(plan.workerThreads, [2, 2, 2, 2]);
  assert.equal(plan.parallel, true);
});

test("akıllı plan kaynak yüküne göre bir, iki ve üç worker seçebilir", () => {
  const one = chooseParallelPlan({
    durationSeconds: 240,
    sizeBytes: 200 * 1024 ** 2,
    video: { width: 640, height: 360, fps: 25 }
  }, config, { logicalCpus: 8, maxWorkers: 4 });
  const two = chooseParallelPlan({
    durationSeconds: 600,
    sizeBytes: 500 * 1024 ** 2,
    video: { width: 1280, height: 720, fps: 30 }
  }, config, { logicalCpus: 8, maxWorkers: 4 });
  const three = chooseParallelPlan({
    durationSeconds: 1200,
    sizeBytes: 1.5 * 1024 ** 3,
    video: { width: 1920, height: 1080, fps: 30 }
  }, config, { logicalCpus: 8, maxWorkers: 4 });
  assert.equal(one.workers, 1);
  assert.equal(two.workers, 2);
  assert.equal(three.workers, 3);
  assert.deepEqual(three.workerThreads, [3, 3, 2]);
});

test("otomatik worker sayısı CPU ve yapılandırılmış üst sınıra uyar", () => {
  assert.equal(chooseParallelPlan(longSource, config, { logicalCpus: 6, maxWorkers: 4 }).workers, 3);
  assert.equal(chooseParallelPlan(longSource, config, { logicalCpus: 12, maxWorkers: 2 }).workers, 2);
});

test("elle seçilen üç worker CPU threadlerini taşırmadan dağıtır", () => {
  const plan = chooseParallelPlan(longSource, { ...config, parallelism: "3" }, { logicalCpus: 8, maxWorkers: 4 });
  assert.equal(plan.workers, 3);
  assert.deepEqual(plan.workerThreads, [3, 3, 2]);
  assert.equal(plan.workerThreads.reduce((sum, value) => sum + value, 0), 8);
});

test("çok kısa videoda zorlanmış worker seçimini tek sürece indirir", () => {
  const plan = chooseParallelPlan({ ...longSource, durationSeconds: 30 }, { ...config, parallelism: "4" }, { logicalCpus: 8 });
  assert.equal(plan.workers, 1);
  assert.equal(plan.parallel, false);
});

test("paralel çıktı codec, geometri, FPS, süre ve ses açısından doğrulanır", () => {
  const output = {
    durationSeconds: 3600.02,
    video: { codec: "h264", width: 1280, height: 720, fps: 25 },
    audio: { codec: "aac" }
  };
  assert.deepEqual(validateParallelOutput(longSource, output, config).errors, []);
  const invalid = validateParallelOutput(longSource, { ...output, durationSeconds: 3590, audio: null }, config);
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join(" "), /süre|ses/);
});

test("concat listesi yalnız güvenli deterministik chunk adlarını kabul eder", () => {
  assert.equal(
    buildConcatList(["/private/job/chunk_000.mp4", "/private/job/chunk_001.mp4"]),
    "ffconcat version 1.0\nfile chunk_000.mp4\nfile chunk_001.mp4\n"
  );
  assert.throws(() => buildConcatList(["/private/job/../outside.mp4"]), /Güvensiz/);
});

test("paralel ilerleme monoton, sınırlı ve toplam süreye göre birleşiktir", () => {
  const ranges = buildChunkRanges(100, 2, 25);
  const updates = [];
  const aggregator = createProgressAggregator(ranges, (value) => updates.push(value), { startedAt: 0 });
  aggregator.update(0, 20, 10_000);
  aggregator.update(1, 10, 10_000);
  aggregator.update(0, 5, 11_000);
  aggregator.update(0, 999, 12_000);
  aggregator.update(1, 999, 12_000);
  assert.deepEqual(updates.map((item) => Number(item.fraction.toFixed(3))), [0.184, 0.276, 0.276, 0.552, 0.92]);
  assert.ok(updates.every((item) => item.fraction >= 0 && item.fraction <= 0.92));
  assert.equal(updates[0].speed, 2);
});

test("iptal bütün çalışan child processleri sonlandırıp kapanmalarını bekler", async () => {
  const children = Array.from({ length: 4 }, () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.signals = [];
    child.kill = (signal) => {
      child.signals.push(signal);
      child.signalCode = signal;
      process.nextTick(() => child.emit("close", null, signal));
      return true;
    };
    return child;
  });
  await terminateChildren(new Set(children), { graceMs: 20 });
  assert.deepEqual(children.map((child) => child.signals), [["SIGTERM"], ["SIGTERM"], ["SIGTERM"], ["SIGTERM"]]);
});

test("başarısız worker bütün kısmi chunk dosyalarını temizler", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "video-lab-worker-failure-"));
  try {
    await Promise.all([
      writeFile(path.join(directory, "chunk_000.mp4"), "partial"),
      writeFile(path.join(directory, "chunk_001.mp4"), "partial"),
      writeFile(path.join(directory, "output.mp4"), "partial")
    ]);
    await assert.rejects(() => encodeParallel({
      ffmpegPath: "ffmpeg",
      inputPath: path.join(directory, "source.upload"),
      outputPath: path.join(directory, "output.mp4"),
      jobDir: directory,
      config: { ...config, crf: 23, preset: "ultrafast", audioBitrate: "96k" },
      source: { ...longSource, durationSeconds: 600, audio: null },
      plan: { workers: 2, threadsPerWorker: 2 },
      runProcess: async () => ({ code: 1, signal: null, stderr: "synthetic worker failure" })
    }), /worker başarısız/);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("başarısız concat indirmeye açık çıktı bırakmaz ve geçicileri temizler", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "video-lab-concat-failure-"));
  try {
    let activeWorkers = 0;
    let maximumActiveWorkers = 0;
    const runProcess = async (_command, args) => {
      if (args.includes("concat")) return { code: 1, signal: null, stderr: "synthetic concat failure" };
      activeWorkers += 1;
      maximumActiveWorkers = Math.max(maximumActiveWorkers, activeWorkers);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeWorkers -= 1;
      return { code: 0, signal: null, stderr: "" };
    };
    await assert.rejects(() => encodeParallel({
      ffmpegPath: "ffmpeg",
      inputPath: path.join(directory, "source.upload"),
      outputPath: path.join(directory, "output.mp4"),
      jobDir: directory,
      config: { ...config, crf: 23, preset: "ultrafast", audioBitrate: "96k" },
      source: { ...longSource, durationSeconds: 600, audio: null },
      plan: { workers: 2, threadsPerWorker: 2 },
      runProcess
    }), /concat başarısız/);
    assert.equal(maximumActiveWorkers, 2);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
