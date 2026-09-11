import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseFfprobeJson, parseProgressBlock, parsePsnrStats, parseSsimStats, parseVmafJson } from "./parsers.js";

const MAX_CAPTURE = 8 * 1024 * 1024;

export function runCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { registerChild, unregisterChild, onSpawn, ...spawnOptions } = options;
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...spawnOptions });
    registerChild?.(child);
    onSpawn?.(child);
    const stdout = [];
    const stderr = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    child.stdout.on("data", (chunk) => {
      stdoutSize += chunk.length;
      if (stdoutSize <= MAX_CAPTURE) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrSize += chunk.length;
      if (stderrSize <= MAX_CAPTURE) stderr.push(chunk);
    });
    child.once("error", (error) => {
      unregisterChild?.(child);
      reject(error);
    });
    child.once("close", (code, signal) => {
      unregisterChild?.(child);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

export async function detectCapabilities(ffmpegPath = "ffmpeg", ffprobePath = "ffprobe") {
  const capabilities = {
    ffmpeg: false,
    ffprobe: false,
    libx264: false,
    libvmaf: false,
    errors: []
  };
  try {
    const result = await runCapture(ffmpegPath, ["-hide_banner", "-version"]);
    capabilities.ffmpeg = result.code === 0;
    if (!capabilities.ffmpeg) capabilities.errors.push("FFmpeg kurulu değil");
  } catch {
    capabilities.errors.push("FFmpeg kurulu değil");
  }
  try {
    const result = await runCapture(ffprobePath, ["-hide_banner", "-version"]);
    capabilities.ffprobe = result.code === 0;
    if (!capabilities.ffprobe) capabilities.errors.push("ffprobe kurulu değil");
  } catch {
    capabilities.errors.push("ffprobe kurulu değil");
  }
  if (capabilities.ffmpeg) {
    const encoders = await runCapture(ffmpegPath, ["-hide_banner", "-encoders"]);
    capabilities.libx264 = encoders.code === 0 && /\blibx264\b/.test(encoders.stdout + encoders.stderr);
    if (!capabilities.libx264) capabilities.errors.push("libx264 desteklenmiyor");
    const filters = await runCapture(ffmpegPath, ["-hide_banner", "-filters"]);
    capabilities.libvmaf = filters.code === 0 && /\blibvmaf\b/.test(filters.stdout + filters.stderr);
  }
  return capabilities;
}

export async function probeMedia(filePath, ffprobePath = "ffprobe", lifecycle = {}) {
  let result;
  try {
    result = await runCapture(ffprobePath, [
      "-v", "error",
      "-show_format",
      "-show_streams",
      "-of", "json",
      filePath
    ], lifecycle);
  } catch (error) {
    throw new Error(error.code === "ENOENT" ? "ffprobe kurulu değil" : "Dosya video değil veya ffprobe okuyamıyor");
  }
  if (result.code !== 0) throw new Error("Dosya video değil veya ffprobe okuyamıyor");
  try {
    return parseFfprobeJson(result.stdout);
  } catch (error) {
    if (error.message.includes("Dosya video değil")) throw error;
    throw new Error("Dosya video değil veya ffprobe okuyamıyor");
  }
}

function evenFloor(value) {
  return Math.max(2, Math.floor(value / 2) * 2);
}

export function calculateTargetDimensions(width, height, resolution) {
  if (!width || !height) return null;
  const limits = resolution === "1080" ? [1920, 1080] : resolution === "720" ? [1280, 720] : null;
  let scale = 1;
  if (limits) scale = Math.min(1, limits[0] / width, limits[1] / height);
  const targetWidth = evenFloor(width * scale);
  const targetHeight = evenFloor(height * scale);
  return { width: targetWidth, height: targetHeight, changed: targetWidth !== width || targetHeight !== height };
}

export function buildVideoFilters(config, source, { resetTimestamps = false } = {}) {
  const filters = [];
  const target = calculateTargetDimensions(source.video.width, source.video.height, config.resolution);
  if (config.maxFps !== "source" && source.video.fps > Number(config.maxFps) + 0.001) {
    filters.push(`fps=${Number(config.maxFps)}`);
  }
  if (target?.changed) filters.push(`scale=${target.width}:${target.height}:flags=fast_bilinear`);
  if (resetTimestamps) filters.push("setpts=PTS-STARTPTS");
  return filters;
}

export function buildEncodeArgs({
  inputPath,
  outputPath,
  config,
  source,
  threads = 0,
  filterThreads = null,
  timeRange = null,
  videoOnly = false,
  benchmark = false
}) {
  const filters = buildVideoFilters(config, source, { resetTimestamps: Boolean(timeRange) });

  const args = [
    "-hide_banner", "-y"
  ];
  if (benchmark) args.push("-benchmark");
  if (filterThreads !== null) args.push("-filter_threads", String(filterThreads));
  if (timeRange?.start > 0) args.push("-ss", timeRange.start.toFixed(6));
  if (timeRange?.duration > 0) args.push("-t", timeRange.duration.toFixed(6));
  args.push(
    "-threads", String(threads),
    "-i", inputPath,
    "-map", "0:v:0"
  );
  if (!videoOnly) args.push("-map", "0:a:0?");
  args.push(
    "-map_metadata", "-1"
  );
  if (filters.length) args.push("-vf", filters.join(","));
  args.push(
    "-c:v", "libx264",
    "-preset", config.preset,
    "-crf", String(config.crf),
    "-pix_fmt", "yuv420p",
    "-threads", String(threads)
  );
  if (videoOnly) {
    args.push("-an");
  } else {
    args.push(
      "-c:a", "aac",
      "-b:a", config.audioBitrate,
      "-ac", "2",
      "-ar", "48000"
    );
  }
  args.push(
    "-movflags", "+faststart",
    "-progress", "pipe:1",
    "-nostats",
    outputPath
  );
  return args;
}

export function formatCommand(command, args) {
  const quote = (value) => /^[A-Za-z0-9_./:+-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
  return [command, ...args].map((part) => quote(String(part))).join(" ");
}

export function spawnWithProgress(command, args, { durationSeconds, onProgress, onSpawn, registerChild, unregisterChild }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    registerChild?.(child);
    onSpawn?.(child);
    let stderr = "";
    let block = "";
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      block += `${line}\n`;
      if (line.startsWith("progress=")) {
        const parsed = parseProgressBlock(block);
        const fraction = durationSeconds > 0 && parsed.outTimeSeconds !== null
          ? Math.min(1, Math.max(0, parsed.outTimeSeconds / durationSeconds))
          : null;
        onProgress?.({ ...parsed, fraction });
        block = "";
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-128 * 1024);
    });
    child.once("error", (error) => {
      unregisterChild?.(child);
      reject(error);
    });
    child.once("close", (code, signal) => {
      unregisterChild?.(child);
      resolve({ code, signal, stderr });
    });
  });
}

export function buildSampleSegments(durationSeconds, mode) {
  if (mode === "full") return [{ start: 0, duration: durationSeconds }];
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  if (durationSeconds <= 30) {
    const duration = durationSeconds / 3;
    return [0, duration, duration * 2].map((start) => ({ start, duration }));
  }
  return [0.1, 0.5, 0.9].map((position) => ({
    start: Math.max(0, Math.min(durationSeconds - 10, durationSeconds * position - 5)),
    duration: 10
  }));
}

function filterEscape(filePath) {
  return filePath.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'");
}

function evaluationGeometry(source) {
  return calculateTargetDimensions(source.video.width, source.video.height, "1080");
}

function alignedFilter(label, geometry, fps) {
  return `[${label}:v]settb=AVTB,setpts=PTS-STARTPTS,fps=${fps},scale=${geometry.width}:${geometry.height}:flags=lanczos,format=yuv420p`;
}

function segmentInputArgs(segment, inputPath) {
  const args = [];
  if (segment.start > 0) args.push("-ss", segment.start.toFixed(3));
  if (segment.duration > 0) args.push("-t", segment.duration.toFixed(3));
  args.push("-i", inputPath);
  return args;
}

async function runQualityProcess({ ffmpegPath, args, duration, onProgress, registerChild, unregisterChild, onSpawn }) {
  return spawnWithProgress(ffmpegPath, args, {
    durationSeconds: duration,
    onProgress,
    registerChild,
    unregisterChild,
    onSpawn
  });
}

export async function measureQuality({
  ffmpegPath,
  sourcePath,
  outputPath,
  source,
  output,
  mode,
  libvmaf,
  jobDir,
  onProgress,
  registerChild,
  unregisterChild,
  onSpawn
}) {
  const segments = buildSampleSegments(source.durationSeconds, mode);
  const totalDuration = segments.reduce((sum, segment) => sum + segment.duration, 0);
  const geometry = evaluationGeometry(source);
  const fps = Math.max(1, Math.min(source.video.fps ?? 30, output.video.fps ?? source.video.fps ?? 30));
  const started = performance.now();
  let completedDuration = 0;
  const vmafScores = [];
  const ssimScores = [];
  const psnrScores = [];
  let useVmaf = libvmaf;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const common = [
      "-hide_banner", "-y",
      ...segmentInputArgs(segment, sourcePath),
      ...segmentInputArgs(segment, outputPath)
    ];
    const progressHandler = ({ outTimeSeconds, speed }) => {
      const current = Math.min(segment.duration, outTimeSeconds ?? 0);
      onProgress?.({ fraction: totalDuration ? (completedDuration + current) / totalDuration : 0, speed });
    };

    if (useVmaf) {
      const logPath = path.join(jobDir, `vmaf-${index}.json`);
      const graph = `${alignedFilter(0, geometry, fps)}[ref];${alignedFilter(1, geometry, fps)}[dist];[dist][ref]libvmaf=log_fmt=json:log_path='${filterEscape(logPath)}'[vmaf]`;
      const args = [...common, "-filter_complex", graph, "-map", "[vmaf]", "-f", "null", "-", "-progress", "pipe:1", "-nostats"];
      const result = await runQualityProcess({ ffmpegPath, args, duration: segment.duration, onProgress: progressHandler, registerChild, unregisterChild, onSpawn });
      if (result.code === 0) {
        const parsed = parseVmafJson(await readFile(logPath, "utf8"));
        vmafScores.push(...parsed.frameScores);
      } else {
        useVmaf = false;
        vmafScores.length = 0;
        completedDuration = 0;
        index = -1;
        continue;
      }
    } else {
      const ssimPath = path.join(jobDir, `ssim-${index}.log`);
      const psnrPath = path.join(jobDir, `psnr-${index}.log`);
      await writeFile(ssimPath, "");
      await writeFile(psnrPath, "");
      const graph = `${alignedFilter(0, geometry, fps)},split=2[ref_s][ref_p];${alignedFilter(1, geometry, fps)},split=2[dist_s][dist_p];[dist_s][ref_s]ssim=stats_file='${filterEscape(ssimPath)}'[ssim];[dist_p][ref_p]psnr=stats_file='${filterEscape(psnrPath)}'[psnr]`;
      const args = [...common, "-filter_complex", graph, "-map", "[ssim]", "-map", "[psnr]", "-f", "null", "-", "-progress", "pipe:1", "-nostats"];
      const result = await runQualityProcess({ ffmpegPath, args, duration: segment.duration, onProgress: progressHandler, registerChild, unregisterChild, onSpawn });
      if (result.code !== 0) throw new Error(`Kalite analizi başarısız: ${result.stderr.slice(-600)}`);
      ssimScores.push(...parseSsimStats(await readFile(ssimPath, "utf8")));
      psnrScores.push(...parsePsnrStats(await readFile(psnrPath, "utf8")));
    }
    completedDuration += segment.duration;
    onProgress?.({ fraction: totalDuration ? completedDuration / totalDuration : 1, speed: null });
  }

  const elapsedSeconds = (performance.now() - started) / 1000;
  if (useVmaf && vmafScores.length) {
    const parsed = parseVmafJson({ frames: vmafScores.map((score) => ({ metrics: { vmaf: score } })) });
    return { type: "vmaf", label: "Uçtan uca VMAF", mean: parsed.mean, percentile5: parsed.percentile5, elapsedSeconds };
  }
  const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  return {
    type: "fallback",
    label: "SSIM / PSNR (fallback)",
    message: libvmaf ? "VMAF analizi başarısız oldu; SSIM ve PSNR fallback olarak hesaplandı" : "Bu FFmpeg kurulumu libvmaf desteklemiyor",
    ssim: average(ssimScores),
    psnr: average(psnrScores),
    elapsedSeconds
  };
}
