import os from "node:os";
import path from "node:path";
import { rm, stat, writeFile } from "node:fs/promises";
import { buildEncodeArgs, calculateTargetDimensions, formatCommand, spawnWithProgress } from "./ffmpeg.js";

export const MIN_PARALLEL_DURATION_SECONDS = 120;
const GIB = 1024 ** 3;

function tier(value, thresholds) {
  return thresholds.reduce((score, threshold) => score + Number(value >= threshold), 0);
}

function distributeThreads(logicalCpus, workers) {
  if (workers <= 1) return [0];
  const base = Math.floor(logicalCpus / workers);
  const remainder = logicalCpus % workers;
  return Array.from({ length: workers }, (_, index) => Math.max(1, base + Number(index < remainder)));
}

export function expectedOutputFps(source, config) {
  const sourceFps = source.video.fps;
  if (config.maxFps === "source" || !Number.isFinite(sourceFps)) return sourceFps;
  return Math.min(sourceFps, Number(config.maxFps));
}

export function buildChunkRanges(durationSeconds, workerCount, fps = 30) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  const safeWorkers = Math.max(1, Math.floor(workerCount));
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const totalFrames = Math.max(safeWorkers, Math.round(durationSeconds * safeFps));
  const baseFrames = Math.floor(totalFrames / safeWorkers);
  let remainder = totalFrames % safeWorkers;
  let firstFrame = 0;
  return Array.from({ length: safeWorkers }, (_, index) => {
    const frameCount = baseFrames + (remainder-- > 0 ? 1 : 0);
    const start = firstFrame / safeFps;
    const nominalEnd = (firstFrame + frameCount) / safeFps;
    const end = index === safeWorkers - 1 ? durationSeconds : nominalEnd;
    const range = {
      index,
      start,
      duration: end - start,
      frameCount
    };
    firstFrame += frameCount;
    return range;
  });
}

export function buildConcatList(chunkPaths) {
  const names = chunkPaths.map((chunkPath) => path.basename(chunkPath));
  if (names.some((name) => !/^chunk_\d{3}\.mp4$/.test(name))) {
    throw new Error("Güvensiz veya beklenmeyen chunk dosya adı");
  }
  return ["ffconcat version 1.0", ...names.map((name) => `file ${name}`), ""].join("\n");
}

export function createProgressAggregator(ranges, onProgress, options = {}) {
  const maximumFraction = options.maximumFraction ?? 0.92;
  const startedAt = options.startedAt ?? performance.now();
  const values = ranges.map(() => 0);
  const expected = ranges.reduce((sum, range) => sum + range.duration, 0);
  let lastFraction = 0;
  return {
    update(index, outTimeSeconds, now = performance.now()) {
      if (!ranges[index]) return { fraction: lastFraction, speed: null };
      values[index] = Math.min(ranges[index].duration, Math.max(values[index], outTimeSeconds ?? 0));
      const processed = values.reduce((sum, value) => sum + value, 0);
      const fraction = expected ? Math.min(maximumFraction, processed / expected * maximumFraction) : 0;
      lastFraction = Math.max(lastFraction, fraction);
      const elapsed = Math.max(0, (now - startedAt) / 1000);
      const update = { fraction: lastFraction, speed: elapsed > 0 ? processed / elapsed : null };
      onProgress?.(update);
      return update;
    },
    get fraction() { return lastFraction; }
  };
}

export async function terminateChildren(children, { graceMs = 5000 } = {}) {
  const running = [...children].filter((child) => child.exitCode === null && child.signalCode === null);
  await Promise.all(running.map((child) => new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    child.once("close", finish);
    child.kill("SIGTERM");
    if (!settled) {
      timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        finish();
      }, graceMs);
      timer.unref?.();
    }
  })));
}

export function chooseParallelPlan(source, config, options = {}) {
  const logicalCpus = Math.max(1, options.logicalCpus ?? os.cpus().length);
  const configuredMax = Math.max(1, Math.min(4, options.maxWorkers ?? 4));
  const duration = source.durationSeconds ?? 0;
  const pixels = (source.video.width ?? 0) * (source.video.height ?? 0);
  const fps = source.video.fps ?? 0;
  const pixelRate = pixels * fps;
  const sizeGiB = Math.max(0, (source.sizeBytes ?? 0) / GIB);
  const requested = String(config.parallelism ?? "auto");
  const cpuLimit = Math.max(1, Math.min(configuredMax, Math.floor(logicalCpus / 2)));

  // Daha ağır decode akışlarında kısa chunk'lar bile başlangıç maliyetini amorti eder.
  const minimumChunkSeconds = pixelRate >= 1920 * 1080 * 30 ? 60
    : pixelRate >= 1280 * 720 * 30 ? 90
      : 120;
  const durationLimit = Math.max(1, Math.floor(duration / minimumChunkSeconds));
  const usableLimit = Math.max(1, Math.min(cpuLimit, durationLimit));

  const durationTier = tier(duration, [300, 900, 2700]);
  const sizeTier = tier(sizeGiB, [1, 2, 4]);
  const decodeTier = tier(pixelRate, [1280 * 720 * 30, 1920 * 1080 * 30, 2560 * 1440 * 50]);
  const pressure = durationTier + sizeTier + decodeTier;

  let workers = 1;
  let reason = "Tek süreç seçildi";
  if (duration < MIN_PARALLEL_DURATION_SECONDS) {
    reason = `Video ${MIN_PARALLEL_DURATION_SECONDS} saniyeden kısa; chunk başlangıç maliyeti önlendi`;
  } else if (requested === "1") {
    reason = "Kullanıcı tek süreç seçti";
  } else if (["2", "3", "4"].includes(requested)) {
    workers = Math.min(Number(requested), usableLimit);
    reason = workers === Number(requested)
      ? `Kullanıcı ${requested} worker seçti`
      : `İstenen ${requested} worker, CPU ve minimum chunk süresine göre ${workers} ile sınırlandı`;
  } else {
    const desiredWorkers = pressure >= 7 ? 4 : pressure >= 4 ? 3 : pressure >= 2 ? 2 : 1;
    workers = Math.min(desiredWorkers, usableLimit);
    reason = workers > 1
      ? `Akıllı otomatik seçim: ${workers} worker (yük skoru ${pressure}; ${logicalCpus} CPU, ${sizeGiB.toFixed(1)} GiB, ${Math.round(duration)} sn)`
      : `Akıllı otomatik seçim: tek süreç (yük skoru ${pressure}; paralel başlangıç maliyeti baskın)`;
  }

  workers = Math.max(1, Math.min(workers, logicalCpus));
  const workerThreads = distributeThreads(logicalCpus, workers);
  const threadsPerWorker = workerThreads[0];
  return {
    workers,
    threadsPerWorker,
    workerThreads,
    logicalCpus,
    reason,
    parallel: workers > 1,
    pressure,
    minimumChunkSeconds
  };
}

export function validateParallelOutput(source, output, config) {
  const errors = [];
  const target = calculateTargetDimensions(source.video.width, source.video.height, config.resolution);
  const expectedFps = expectedOutputFps(source, config);
  const durationTolerance = Math.max(0.75, expectedFps ? 2 / expectedFps : 0.75);
  if (output.video.codec !== "h264") errors.push(`Beklenen video codec h264, bulunan ${output.video.codec ?? "yok"}`);
  if (target && (output.video.width !== target.width || output.video.height !== target.height)) {
    errors.push(`Beklenen çözünürlük ${target.width}x${target.height}, bulunan ${output.video.width}x${output.video.height}`);
  }
  if (Number.isFinite(expectedFps) && (!Number.isFinite(output.video.fps) || Math.abs(output.video.fps - expectedFps) > 0.02)) {
    errors.push(`Beklenen FPS ${expectedFps}, bulunan ${output.video.fps ?? "yok"}`);
  }
  if (!Number.isFinite(output.durationSeconds) || Math.abs(output.durationSeconds - source.durationSeconds) > durationTolerance) {
    errors.push(`Çıktı süresi kaynakla eşleşmiyor (${output.durationSeconds ?? "yok"} / ${source.durationSeconds})`);
  }
  if (Boolean(source.audio) !== Boolean(output.audio)) errors.push("Çıktının ses varlığı kaynakla eşleşmiyor");
  if (source.audio && output.audio?.codec !== "aac") errors.push(`Beklenen ses codec aac, bulunan ${output.audio?.codec ?? "yok"}`);
  return { valid: errors.length === 0, errors, expectedFps, target, durationTolerance };
}

function audioEncodeArgs(inputPath, outputPath, config, threads, durationSeconds, benchmark) {
  const args = [
    "-hide_banner", "-y"
  ];
  if (benchmark) args.push("-benchmark");
  args.push(
    "-t", durationSeconds.toFixed(6),
    "-threads", String(threads),
    "-i", inputPath,
    "-map", "0:a:0",
    "-map_metadata", "-1",
    "-vn",
    "-c:a", "aac",
    "-b:a", config.audioBitrate,
    "-ac", "2",
    "-ar", "48000",
    "-progress", "pipe:1",
    "-nostats",
    outputPath
  );
  return args;
}

function concatArgs(listPath, outputPath) {
  return [
    "-hide_banner", "-y",
    "-f", "concat",
    "-safe", "1",
    "-i", listPath,
    "-map", "0:v:0",
    "-c", "copy",
    "-an",
    "-movflags", "+faststart",
    "-progress", "pipe:1",
    "-nostats",
    outputPath
  ];
}

function muxArgs(videoPath, audioPath, outputPath) {
  return [
    "-hide_banner", "-y",
    "-i", videoPath,
    "-i", audioPath,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c", "copy",
    "-shortest",
    "-movflags", "+faststart",
    "-progress", "pipe:1",
    "-nostats",
    outputPath
  ];
}

async function removeFiles(paths) {
  await Promise.all(paths.map((filePath) => rm(filePath, { force: true }).catch(() => {})));
}

export async function encodeParallel({
  ffmpegPath,
  inputPath,
  outputPath,
  jobDir,
  config,
  source,
  plan,
  onProgress,
  onStage,
  registerChild,
  unregisterChild,
  onWorkerFailure,
  isCancelled = () => false,
  benchmark = false,
  runProcess = spawnWithProgress
}) {
  const fps = expectedOutputFps(source, config) ?? 30;
  const ranges = buildChunkRanges(source.durationSeconds, plan.workers, fps);
  const chunkPaths = ranges.map((range) => path.join(jobDir, `chunk_${String(range.index).padStart(3, "0")}.mp4`));
  const audioPath = path.join(jobDir, "parallel_audio.m4a");
  const joinedVideoPath = source.audio ? path.join(jobDir, "joined_video.mp4") : outputPath;
  const listPath = path.join(jobDir, "chunks.ffconcat");
  const commands = [];
  const encodeStarted = performance.now();
  let lastFraction = 0;
  const progressAggregator = createProgressAggregator(ranges, (update) => {
    lastFraction = Math.max(lastFraction, update.fraction);
    onProgress?.(update);
  }, { startedAt: encodeStarted });
  const internalPaths = [...chunkPaths, listPath, audioPath, ...(joinedVideoPath === outputPath ? [] : [joinedVideoPath])];

  try {
    const threadPlan = plan.workerThreads ?? Array(plan.workers).fill(plan.threadsPerWorker);
    onStage?.(`Paralel sıkıştırma (${plan.workers} worker · thread dağılımı ${threadPlan.join("+")})`);
    const videoPromises = ranges.map((range, index) => {
      const workerThreadCount = threadPlan[index] ?? plan.threadsPerWorker;
      const args = buildEncodeArgs({
        inputPath,
        outputPath: chunkPaths[index],
        config,
        source,
        threads: workerThreadCount,
        filterThreads: workerThreadCount,
        timeRange: range,
        videoOnly: true,
        benchmark
      });
      commands.push(formatCommand(ffmpegPath, args));
      return runProcess(ffmpegPath, args, {
        durationSeconds: range.duration,
        registerChild,
        unregisterChild,
        onProgress: ({ outTimeSeconds }) => {
          progressAggregator.update(index, outTimeSeconds);
        }
      }).then((result) => {
        if (result.code !== 0 && !isCancelled()) onWorkerFailure?.();
        return result;
      });
    });

    let audioPromise = null;
    if (source.audio) {
      const args = audioEncodeArgs(inputPath, audioPath, config, 1, source.durationSeconds, benchmark);
      commands.push(formatCommand(ffmpegPath, args));
      audioPromise = runProcess(ffmpegPath, args, {
        durationSeconds: source.durationSeconds,
        registerChild,
        unregisterChild
      }).then((result) => {
        if (result.code !== 0 && !isCancelled()) onWorkerFailure?.();
        return result;
      });
    }

    const results = await Promise.all(audioPromise ? [...videoPromises, audioPromise] : videoPromises);
    if (isCancelled()) throw new Error("Kullanıcı işlemi iptal etti");
    const failed = results.find((result) => result.code !== 0 || result.signal);
    if (failed) throw new Error(`Paralel FFmpeg worker başarısız: ${failed.stderr.slice(-800)}`);
    const chunkEncodeElapsedSeconds = (performance.now() - encodeStarted) / 1000;

    const concatText = buildConcatList(chunkPaths);
    await writeFile(listPath, concatText, { encoding: "utf8", mode: 0o600 });
    onStage?.("Video parçaları birleştiriliyor");
    const concatStarted = performance.now();
    const concatCommand = concatArgs(listPath, joinedVideoPath);
    commands.push(formatCommand(ffmpegPath, concatCommand));
    const concatResult = await runProcess(ffmpegPath, concatCommand, {
      durationSeconds: source.durationSeconds,
      registerChild,
      unregisterChild,
      onProgress: ({ fraction }) => {
        const value = 0.92 + (fraction ?? 0) * 0.04;
        lastFraction = Math.max(lastFraction, Math.min(0.96, value));
        onProgress?.({ fraction: lastFraction, speed: null });
      }
    });
    if (isCancelled()) throw new Error("Kullanıcı işlemi iptal etti");
    if (concatResult.code !== 0) throw new Error(`FFmpeg concat başarısız: ${concatResult.stderr.slice(-800)}`);

    if (source.audio) {
      onStage?.("Kesintisiz ses akışı birleştiriliyor");
      const muxCommand = muxArgs(joinedVideoPath, audioPath, outputPath);
      commands.push(formatCommand(ffmpegPath, muxCommand));
      const muxResult = await runProcess(ffmpegPath, muxCommand, {
        durationSeconds: source.durationSeconds,
        registerChild,
        unregisterChild,
        onProgress: ({ fraction }) => {
          const value = 0.96 + (fraction ?? 0) * 0.02;
          lastFraction = Math.max(lastFraction, Math.min(0.98, value));
          onProgress?.({ fraction: lastFraction, speed: null });
        }
      });
      if (isCancelled()) throw new Error("Kullanıcı işlemi iptal etti");
      if (muxResult.code !== 0) throw new Error(`FFmpeg ses mux başarısız: ${muxResult.stderr.slice(-800)}`);
    }

    const concatElapsedSeconds = (performance.now() - concatStarted) / 1000;
    const outputStat = await stat(outputPath);
    if (!outputStat.size) throw new Error("Çıktı dosyası oluşmadı");
    await removeFiles(internalPaths);
    onProgress?.({ fraction: 0.98, speed: null });
    return {
      commands,
      ranges,
      chunkEncodeElapsedSeconds,
      concatElapsedSeconds,
      encodeElapsedSeconds: (performance.now() - encodeStarted) / 1000,
      outputBytes: outputStat.size,
      workerResults: results.slice(0, ranges.length)
    };
  } catch (error) {
    await removeFiles([...internalPaths, outputPath]);
    throw error;
  }
}
