#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { buildEncodeArgs, buildVideoFilters, detectCapabilities, formatCommand, measureQuality, probeMedia, spawnWithProgress } from "../src/ffmpeg.js";
import { parseBenchmarkStats } from "../src/parsers.js";
import { encodeParallel } from "../src/parallel.js";

function option(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function usage() {
  console.log(`Usage:
  node scripts/benchmark.js --input /path/video.webm [--sample-seconds 180] [--full]

Options:
  --preset ultrafast|superfast|veryfast   Default: ultrafast
  --crf 18..30                            Default: 23
  --resolution source|1080|720            Default: 720
  --fps source|30|25                      Default: 25
  --audio-bitrate 64k|96k|128k            Default: 96k
  --sample-seconds N                      Default: 180; ignored with --full
  --quality off|sample|full                Default: off
  --ffmpeg /path/ffmpeg
  --ffprobe /path/ffprobe

The utility benchmarks decode-only, decode+filters, x264 thread configurations,
and 1/2/4-worker CPU-only parallel encoding against the same source segment.`);
}

const inputPath = option("input");
if (!inputPath) {
  usage();
  process.exitCode = 2;
} else {
  await main();
}

async function main() {
  const ffmpegPath = option("ffmpeg", process.env.FFMPEG_PATH || "ffmpeg");
  const ffprobePath = option("ffprobe", process.env.FFPROBE_PATH || "ffprobe");
  const capabilities = await detectCapabilities(ffmpegPath, ffprobePath);
  if (!capabilities.ffmpeg || !capabilities.ffprobe || !capabilities.libx264) {
    throw new Error(capabilities.errors.join("; "));
  }
  const source = await probeMedia(inputPath, ffprobePath);
  const requestedSample = Number(option("sample-seconds", "180"));
  const effectiveDuration = hasFlag("full") ? source.durationSeconds : Math.min(source.durationSeconds, requestedSample);
  const benchmarkSource = { ...source, durationSeconds: effectiveDuration };
  const config = {
    crf: Number(option("crf", "23")),
    preset: option("preset", "ultrafast"),
    resolution: option("resolution", "720"),
    maxFps: option("fps", "25"),
    audioBitrate: option("audio-bitrate", "96k"),
    qualityMode: option("quality", "off"),
    parallelism: "1"
  };
  const logicalCpus = os.cpus().length;
  const directory = await mkdtemp(path.join(os.tmpdir(), "video-lab-benchmark-"));
  const rows = [];
  let baseline = null;

  console.log(JSON.stringify({
    inputPath,
    sourceDurationSeconds: source.durationSeconds,
    benchmarkDurationSeconds: effectiveDuration,
    logicalCpus,
    sourceVideo: source.video,
    config
  }, null, 2));

  try {
    rows.push(await benchmarkNull("Decode only", null, 0));
    rows.push(await benchmarkNull("Decode + filters", buildVideoFilters(config, benchmarkSource).join(","), 0));

    const threadCandidates = [...new Set([0, Math.min(2, logicalCpus), Math.max(1, Math.floor(logicalCpus / 2)), logicalCpus])];
    for (const threads of threadCandidates) {
      const row = await benchmarkSingle(threads);
      rows.push(row);
      if (threads === 0) baseline = row;
    }

    for (const workers of [2, 3, 4]) {
      if (workers > Math.max(1, Math.floor(logicalCpus / 2))) continue;
      rows.push(await benchmarkParallel(workers));
    }

    for (const row of rows) {
      row.improvementPercent = baseline && row.kind === "encode"
        ? (1 - row.totalSeconds / baseline.totalSeconds) * 100
        : null;
    }

    console.log("\nBenchmark comparison");
    console.table(rows.map((row) => ({
      Mode: row.mode,
      Workers: row.workers,
      Threads: row.threads,
      "Wall s": fixed(row.totalSeconds),
      "Concat s": fixed(row.concatSeconds),
      Speed: row.speed ? `${fixed(row.speed)}x` : "—",
      CPU: row.cpuPercent ? `${fixed(row.cpuPercent)}%` : "—",
      Frames: row.frames ?? "—",
      Size: row.outputBytes ? `${fixed(row.outputBytes / 1024 ** 2)} MiB` : "—",
      Improvement: row.improvementPercent === null ? "—" : `${fixed(row.improvementPercent)}%`
    })));
    console.log("\nJSON_RESULT=" + JSON.stringify({ source, benchmarkDurationSeconds: effectiveDuration, logicalCpus, config, rows }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  async function benchmarkNull(mode, filters, threads) {
    const args = ["-hide_banner", "-y", "-benchmark"];
    if (threads !== 0) args.push("-filter_threads", String(threads));
    args.push("-threads", String(threads), "-i", inputPath, "-t", effectiveDuration.toFixed(6), "-map", "0:v:0");
    if (filters) args.push("-vf", filters);
    args.push("-an", "-f", "null", "-", "-progress", "pipe:1", "-nostats");
    const measured = await runMeasured(args, effectiveDuration);
    return {
      kind: "diagnostic", mode, workers: 1, threads: threads || "auto",
      totalSeconds: measured.wallSeconds, concatSeconds: 0, speed: measured.speed,
      cpuPercent: measured.cpu.cpuPercent, frames: measured.frames, outputBytes: null,
      sourceDurationSeconds: effectiveDuration, outputDurationSeconds: effectiveDuration
    };
  }

  async function benchmarkSingle(threads) {
    const outputPath = path.join(directory, `single-${threads}.mp4`);
    const args = buildEncodeArgs({
      inputPath,
      outputPath,
      config,
      source: benchmarkSource,
      threads,
      filterThreads: threads === 0 ? null : threads,
      timeRange: { start: 0, duration: effectiveDuration },
      benchmark: true
    });
    const measured = await runMeasured(args, effectiveDuration);
    if (measured.result.code !== 0) throw new Error(measured.result.stderr.slice(-1000));
    const output = await probeMedia(outputPath, ffprobePath);
    const outputBytes = (await stat(outputPath)).size;
    const quality = await optionalQuality(outputPath, output);
    return {
      kind: "encode", mode: threads === 0 ? "Single auto" : `Single threads=${threads}`,
      workers: 1, threads: threads || "auto", totalSeconds: measured.wallSeconds,
      encodeSeconds: measured.wallSeconds, concatSeconds: 0, speed: effectiveDuration / measured.wallSeconds,
      reportedSpeed: measured.speed, cpuPercent: measured.cpu.cpuPercent, frames: measured.frames,
      outputBytes, outputBitrate: output.video.bitrate, outputResolution: `${output.video.width}x${output.video.height}`,
      outputFps: output.video.fps, codec: output.video.codec, quality,
      sourceDurationSeconds: effectiveDuration, outputDurationSeconds: output.durationSeconds
    };
  }

  async function benchmarkParallel(workers) {
    const outputPath = path.join(directory, `parallel-${workers}.mp4`);
    const workerDirectory = path.join(directory, `parallel-${workers}-work`);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(workerDirectory);
    const baseThreads = Math.floor(logicalCpus / workers);
    const remainder = logicalCpus % workers;
    const workerThreads = Array.from({ length: workers }, (_, index) => Math.max(1, baseThreads + Number(index < remainder)));
    const threadsPerWorker = workerThreads[0];
    const measured = await encodeParallel({
      ffmpegPath,
      inputPath,
      outputPath,
      jobDir: workerDirectory,
      config,
      source: benchmarkSource,
      plan: { workers, threadsPerWorker, workerThreads, logicalCpus, parallel: true },
      benchmark: true
    });
    for (const command of measured.commands) console.log(`$ ${command}`);
    const output = await probeMedia(outputPath, ffprobePath);
    const outputBytes = (await stat(outputPath)).size;
    const cpuStats = measured.workerResults.map((result) => parseBenchmarkStats(result.stderr));
    const cpuSeconds = cpuStats.reduce((sum, item) => sum + (item.userSeconds ?? 0) + (item.systemSeconds ?? 0), 0);
    const quality = await optionalQuality(outputPath, output);
    return {
      kind: "encode", mode: `Parallel ${workers}`,
      workers, threads: workerThreads.join("+"), totalSeconds: measured.encodeElapsedSeconds,
      encodeSeconds: measured.chunkEncodeElapsedSeconds, concatSeconds: measured.concatElapsedSeconds,
      speed: effectiveDuration / measured.encodeElapsedSeconds,
      reportedSpeed: null, cpuPercent: measured.chunkEncodeElapsedSeconds > 0 ? cpuSeconds / measured.chunkEncodeElapsedSeconds * 100 : null,
      frames: Math.round(effectiveDuration * (output.video.fps ?? 0)), outputBytes,
      outputBitrate: output.video.bitrate, outputResolution: `${output.video.width}x${output.video.height}`,
      outputFps: output.video.fps, codec: output.video.codec, quality,
      sourceDurationSeconds: effectiveDuration, outputDurationSeconds: output.durationSeconds
    };
  }

  async function optionalQuality(outputPath, output) {
    if (config.qualityMode === "off") return null;
    return measureQuality({
      ffmpegPath,
      sourcePath: inputPath,
      outputPath,
      source: benchmarkSource,
      output,
      mode: config.qualityMode === "full" ? "full" : "sample",
      libvmaf: capabilities.libvmaf,
      jobDir: directory
    });
  }

  async function runMeasured(args, durationSeconds) {
    console.log(`$ ${formatCommand(ffmpegPath, args)}`);
    let speed = null;
    let frames = null;
    const started = performance.now();
    const result = await spawnWithProgress(ffmpegPath, args, {
      durationSeconds,
      onProgress: (progress) => {
        if (progress.speed !== null) speed = progress.speed;
        const frame = Number(progress.fields.frame);
        if (Number.isFinite(frame)) frames = frame;
      }
    });
    return {
      result,
      wallSeconds: (performance.now() - started) / 1000,
      speed,
      frames,
      cpu: parseBenchmarkStats(result.stderr)
    };
  }
}

function fixed(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}
