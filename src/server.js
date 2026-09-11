import http from "node:http";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat, statfs } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { buildEncodeArgs, detectCapabilities, formatCommand, measureQuality, probeMedia, spawnWithProgress } from "./ffmpeg.js";
import { calculateRealtimeSpeed, calculateSizeMetrics } from "./metrics.js";
import { chooseParallelPlan, encodeParallel, terminateChildren, validateParallelOutput } from "./parallel.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../public");
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 4317);
const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE_PATH = process.env.FFPROBE_PATH || "ffprobe";
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 8 * 1024 ** 3);
const FINISHED_TTL_MS = Number(process.env.FINISHED_TTL_MS || 6 * 60 * 60 * 1000);
const DOWNLOADED_TTL_MS = Number(process.env.DOWNLOADED_TTL_MS || 30 * 60 * 1000);
const UPLOAD_TTL_MS = Number(process.env.UPLOAD_TTL_MS || 2 * 60 * 60 * 1000);
const MIN_FREE_BYTES = Number(process.env.MIN_FREE_BYTES || 512 * 1024 ** 2);
const MAX_PARALLEL_WORKERS = Math.max(1, Math.min(4, Number(process.env.MAX_PARALLEL_WORKERS || 4)));

const ALLOWED = {
  presets: new Set(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium"]),
  resolutions: new Set(["source", "1080", "720"]),
  fps: new Set(["source", "30", "25"]),
  audio: new Set(["64k", "96k", "128k"]),
  quality: new Set(["sample", "full", "off"]),
  parallelism: new Set(["auto", "1", "2", "3", "4"])
};

function sendJson(response, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": data.length,
    "cache-control": "no-store"
  });
  response.end(data);
}

function readJson(request, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("İstek çok büyük"));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new Error("Geçersiz JSON")); }
    });
    request.on("error", reject);
  });
}

function validateConfig(input) {
  const crf = Number(input.crf ?? 23);
  const config = {
    crf,
    preset: input.preset ?? "ultrafast",
    resolution: input.resolution ?? "720",
    maxFps: input.maxFps ?? "30",
    audioBitrate: input.audioBitrate ?? "96k",
    qualityMode: input.qualityMode ?? "sample",
    parallelism: String(input.parallelism ?? "auto")
  };
  if (!Number.isInteger(crf) || crf < 18 || crf > 30) throw new Error("CRF 18–30 arasında olmalı");
  if (!ALLOWED.presets.has(config.preset)) throw new Error("Geçersiz preset");
  if (!ALLOWED.resolutions.has(config.resolution)) throw new Error("Geçersiz maksimum çözünürlük");
  if (!ALLOWED.fps.has(config.maxFps)) throw new Error("Geçersiz maksimum FPS");
  if (!ALLOWED.audio.has(config.audioBitrate)) throw new Error("Geçersiz ses bitrate değeri");
  if (!ALLOWED.quality.has(config.qualityMode)) throw new Error("Geçersiz kalite ölçümü seçimi");
  if (!ALLOWED.parallelism.has(config.parallelism)) throw new Error("Geçersiz paralel worker seçimi");
  return config;
}

function safeDisplayName(value) {
  return path.basename(String(value || "video")).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 240) || "video";
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    fileName: job.fileName,
    queuePosition: job.queuePosition,
    createdAt: job.createdAt,
    elapsedSeconds: (Date.now() - job.createdAt) / 1000,
    progress: job.progress,
    error: job.error,
    warnings: job.warnings,
    result: job.result,
    downloadUrl: job.status === "completed" ? `/api/jobs/${job.id}/download/${job.downloadToken}` : null
  };
}

class CountingTransform extends Transform {
  constructor(limit, onBytes) {
    super();
    this.limit = limit;
    this.onBytes = onBytes;
    this.bytes = 0;
  }
  _transform(chunk, encoding, callback) {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) return callback(new Error("Dosya izin verilen boyut sınırını aşıyor"));
    this.onBytes(this.bytes);
    callback(null, chunk);
  }
}

async function freeBytes(directory) {
  const info = await statfs(directory, { bigint: true });
  return Number(info.bavail * info.bsize);
}

export async function createLabServer(options = {}) {
  const tempRoot = options.tempRoot || path.join(os.tmpdir(), "video-compression-lab");
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  const capabilities = await detectCapabilities(options.ffmpegPath || FFMPEG_PATH, options.ffprobePath || FFPROBE_PATH);
  const ffmpegPath = options.ffmpegPath || FFMPEG_PATH;
  const ffprobePath = options.ffprobePath || FFPROBE_PATH;
  const jobs = new Map();
  const queue = [];
  const children = new Set();
  let activeJob = null;
  let shuttingDown = false;

  function lifecycleFor(job) {
    return {
      registerChild: (child) => {
        children.add(child);
        job.runningChildren.add(child);
      },
      unregisterChild: (child) => {
        children.delete(child);
        job.runningChildren.delete(child);
      }
    };
  }

  async function removeJobFiles(job) {
    if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
    await rm(job.dir, { recursive: true, force: true }).catch(() => {});
  }

  function scheduleCleanup(job, delay = FINISHED_TTL_MS) {
    if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
    job.expiresAt = Date.now() + delay;
    job.cleanupTimer = setTimeout(async () => {
      await removeJobFiles(job);
      jobs.delete(job.id);
    }, delay);
    job.cleanupTimer.unref?.();
  }

  async function terminateJob(job) {
    await terminateChildren(job.runningChildren);
  }

  function refreshQueuePositions() {
    queue.forEach((job, index) => { job.queuePosition = index + 1; });
  }

  async function failJob(job, message, status = "failed") {
    job.status = status;
    job.stage = status === "cancelled" ? "İptal edildi" : "Hata";
    job.error = message;
    job.progress.speed = null;
    await removeJobFiles(job);
  }

  async function processJob(job) {
    activeJob = job;
    job.queuePosition = 0;
    job.status = "probing";
    job.stage = "Kaynak analiz ediliyor";
    try {
      if (job.cancelRequested) throw new Error("Kullanıcı işlemi iptal etti");
      const lifecycle = lifecycleFor(job);
      const source = await probeMedia(job.sourcePath, ffprobePath, lifecycle);
      const sourceStat = await stat(job.sourcePath);
      source.sizeBytes = sourceStat.size;
      if (!source.durationSeconds || source.durationSeconds <= 0) throw new Error("Dosya video değil veya ffprobe okuyamıyor");
      const available = await freeBytes(tempRoot);
      const required = Math.max(MIN_FREE_BYTES, sourceStat.size * 1.1);
      if (available < required) throw new Error(`Disk alanı yetersiz (gerekli yaklaşık ${Math.ceil(required / 1024 ** 3)} GB)`);

      const parallelPlan = chooseParallelPlan(source, job.config, { maxWorkers: MAX_PARALLEL_WORKERS });
      job.parallelPlan = parallelPlan;
      job.status = "encoding";
      job.encodeStartedAt = performance.now();
      let encodeElapsedSeconds;
      let concatElapsedSeconds = 0;
      let chunkEncodeElapsedSeconds = null;
      if (parallelPlan.parallel) {
        const encoded = await encodeParallel({
          ffmpegPath,
          inputPath: job.sourcePath,
          outputPath: job.outputPath,
          jobDir: job.dir,
          config: job.config,
          source,
          plan: parallelPlan,
          ...lifecycle,
          isCancelled: () => job.cancelRequested,
          onWorkerFailure: () => void terminateJob(job),
          onStage: (stage) => { job.stage = stage; },
          onProgress: ({ fraction, speed }) => {
            job.progress.encode = Math.max(job.progress.encode, Math.min(98, fraction * 100));
            job.progress.speed = speed;
          }
        });
        encodeElapsedSeconds = encoded.encodeElapsedSeconds;
        concatElapsedSeconds = encoded.concatElapsedSeconds;
        chunkEncodeElapsedSeconds = encoded.chunkEncodeElapsedSeconds;
        job.command = encoded.commands.join("\n\n");
      } else {
        job.stage = "Video sıkıştırılıyor (tek süreç)";
        const args = buildEncodeArgs({ inputPath: job.sourcePath, outputPath: job.outputPath, config: job.config, source });
        job.command = formatCommand(ffmpegPath, args);
        const encode = await spawnWithProgress(ffmpegPath, args, {
          durationSeconds: source.durationSeconds,
          ...lifecycle,
          onProgress: ({ fraction, speed }) => {
            if (fraction !== null) job.progress.encode = fraction * 100;
            job.progress.speed = speed;
          }
        });
        encodeElapsedSeconds = (performance.now() - job.encodeStartedAt) / 1000;
        if (job.cancelRequested || encode.signal) throw new Error("Kullanıcı işlemi iptal etti");
        if (encode.code !== 0) throw new Error(`FFmpeg beklenmeyen kodla kapandı (${encode.code}): ${encode.stderr.slice(-800)}`);
      }
      if (job.cancelRequested) throw new Error("Kullanıcı işlemi iptal etti");
      let outputStat;
      try { outputStat = await stat(job.outputPath); }
      catch { throw new Error("Çıktı dosyası oluşmadı"); }
      if (!outputStat.size) throw new Error("Çıktı dosyası oluşmadı");
      if (parallelPlan.parallel) {
        job.stage = "Birleştirilmiş çıktı doğrulanıyor";
        job.progress.encode = Math.max(job.progress.encode, 99);
      }
      const output = await probeMedia(job.outputPath, ffprobePath, lifecycle);
      if (parallelPlan.parallel) {
        const validation = validateParallelOutput(source, output, job.config);
        if (!validation.valid) throw new Error(`Paralel çıktı doğrulaması başarısız: ${validation.errors.join("; ")}`);
      }
      output.sizeBytes = outputStat.size;
      const sizeMetrics = calculateSizeMetrics(sourceStat.size, outputStat.size);
      const warnings = [];
      if (outputStat.size > sourceStat.size) {
        warnings.push("Bu ayarlarla sıkıştırılmış dosya orijinalden daha büyük oldu. Orijinal dosyayı korumanızı öneririz.");
      }

      let quality = null;
      if (job.config.qualityMode !== "off") {
        job.status = "quality";
        job.stage = capabilities.libvmaf ? "Uçtan uca VMAF ölçülüyor" : "SSIM / PSNR fallback ölçülüyor";
        if (!capabilities.libvmaf) warnings.push("Bu FFmpeg kurulumu libvmaf desteklemiyor");
        try {
          quality = await measureQuality({
            ffmpegPath,
            sourcePath: job.sourcePath,
            outputPath: job.outputPath,
            source,
            output,
            mode: job.config.qualityMode === "full" ? "full" : "sample",
            libvmaf: capabilities.libvmaf,
            jobDir: job.dir,
            ...lifecycle,
            onProgress: ({ fraction, speed }) => {
              job.progress.quality = Math.min(100, Math.max(0, fraction * 100));
              job.progress.speed = speed;
            }
          });
          if (quality.type === "fallback" && capabilities.libvmaf) warnings.push(quality.message);
        } catch (error) {
          warnings.push(`Kalite analizi tamamlanamadı: ${error.message}`);
        }
      }

      await rm(job.sourcePath, { force: true }).catch(() => {});
      job.progress.encode = 100;
      if (job.config.qualityMode !== "off" && quality) job.progress.quality = 100;
      job.progress.speed = null;
      job.status = "completed";
      job.stage = "Tamamlandı";
      job.warnings = warnings;
      job.result = {
        originalBytes: sourceStat.size,
        outputBytes: outputStat.size,
        ...sizeMetrics,
        source,
        output,
        durationSeconds: source.durationSeconds,
        encodeElapsedSeconds,
        chunkEncodeElapsedSeconds,
        concatElapsedSeconds,
        realtimeSpeed: calculateRealtimeSpeed(source.durationSeconds, encodeElapsedSeconds),
        encodeMode: parallelPlan.parallel ? "parallel" : "single",
        workerCount: parallelPlan.workers,
        threadsPerWorker: parallelPlan.threadsPerWorker,
        workerThreads: parallelPlan.workerThreads,
        parallelReason: parallelPlan.reason,
        command: job.command,
        quality
      };
      scheduleCleanup(job);
    } catch (error) {
      const cancelled = job.cancelRequested || error.message === "Kullanıcı işlemi iptal etti";
      await failJob(job, cancelled ? "Kullanıcı işlemi iptal etti" : error.message, cancelled ? "cancelled" : "failed");
    } finally {
      activeJob = null;
      void processQueue();
    }
  }

  async function processQueue() {
    if (activeJob || shuttingDown) return;
    const job = queue.shift();
    refreshQueuePositions();
    if (job) await processJob(job);
  }

  const staticFiles = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
    ["/styles.css", ["styles.css", "text/css; charset=utf-8"]]
  ]);

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        return sendJson(response, 200, { capabilities, maxUploadBytes: MAX_UPLOAD_BYTES, concurrency: 1, maxParallelWorkers: MAX_PARALLEL_WORKERS });
      }

      if (request.method === "POST" && url.pathname === "/api/jobs") {
        if (!capabilities.ffmpeg) return sendJson(response, 503, { error: "FFmpeg kurulu değil" });
        if (!capabilities.ffprobe) return sendJson(response, 503, { error: "ffprobe kurulu değil" });
        if (!capabilities.libx264) return sendJson(response, 503, { error: "libx264 desteklenmiyor" });
        const config = validateConfig(await readJson(request));
        const id = randomUUID();
        const dir = path.join(tempRoot, id);
        await mkdir(dir, { mode: 0o700 });
        const job = {
          id, dir, config,
          sourcePath: path.join(dir, "source.upload"),
          outputPath: path.join(dir, "output.mp4"),
          downloadToken: randomBytes(24).toString("base64url"),
          createdAt: Date.now(),
          status: "awaiting_upload",
          stage: "Dosya yükleniyor",
          queuePosition: 0,
          fileName: null,
          expectedBytes: 0,
          uploadedBytes: 0,
          cancelRequested: false,
          progress: { upload: 0, encode: 0, quality: 0, speed: null },
          error: null,
          warnings: [],
          result: null,
          runningChildren: new Set(),
          uploadRequest: null,
          cleanupTimer: null
        };
        jobs.set(id, job);
        scheduleCleanup(job, UPLOAD_TTL_MS);
        return sendJson(response, 201, {
          id,
          uploadUrl: `/api/jobs/${id}/upload`,
          statusUrl: `/api/jobs/${id}`
        });
      }

      let match = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)\/upload$/);
      if (request.method === "PUT" && match) {
        const job = jobs.get(match[1]);
        if (!job) return sendJson(response, 404, { error: "İş bulunamadı" });
        if (job.status !== "awaiting_upload") return sendJson(response, 409, { error: "Bu iş yükleme kabul etmiyor" });
        const length = Number(request.headers["content-length"]);
        if (!Number.isFinite(length) || length <= 0) return sendJson(response, 411, { error: "Dosya boyutu bilinmiyor" });
        if (length > MAX_UPLOAD_BYTES) return sendJson(response, 413, { error: "Dosya izin verilen boyut sınırını aşıyor" });
        const available = await freeBytes(tempRoot);
        const required = length * 2 + MIN_FREE_BYTES;
        if (available < required) return sendJson(response, 507, { error: `Disk alanı yetersiz (yükleme ve çıktı için yaklaşık ${Math.ceil(required / 1024 ** 3)} GB gerekli)` });
        job.expectedBytes = length;
        job.fileName = safeDisplayName(decodeURIComponent(String(request.headers["x-file-name"] || "video")));
        const counter = new CountingTransform(MAX_UPLOAD_BYTES, (bytes) => {
          job.uploadedBytes = bytes;
          job.progress.upload = Math.min(100, bytes / length * 100);
        });
        try {
          job.uploadRequest = request;
          await pipeline(request, counter, createWriteStream(job.sourcePath, { flags: "wx", mode: 0o600 }));
          job.uploadRequest = null;
          if (job.cancelRequested) throw new Error("Kullanıcı işlemi iptal etti");
          job.progress.upload = 100;
          clearTimeout(job.cleanupTimer);
          job.cleanupTimer = null;
          job.status = "queued";
          job.stage = "Sırada bekliyor";
          queue.push(job);
          refreshQueuePositions();
          sendJson(response, 202, publicJob(job));
          void processQueue();
          return;
        } catch (error) {
          job.uploadRequest = null;
          await failJob(job, job.cancelRequested ? "Kullanıcı işlemi iptal etti" : `Yükleme başarısız: ${error.message}`, job.cancelRequested ? "cancelled" : "failed");
          if (!response.headersSent) return sendJson(response, job.cancelRequested ? 409 : 500, { error: job.error });
          return;
        }
      }

      match = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)$/);
      if (request.method === "GET" && match) {
        const job = jobs.get(match[1]);
        return job ? sendJson(response, 200, publicJob(job)) : sendJson(response, 404, { error: "İş bulunamadı" });
      }

      if (request.method === "POST" && (match = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)\/cancel$/))) {
        const job = jobs.get(match[1]);
        if (!job) return sendJson(response, 404, { error: "İş bulunamadı" });
        if (["completed", "failed", "cancelled"].includes(job.status)) return sendJson(response, 409, { error: "İş zaten sona erdi" });
        job.cancelRequested = true;
        const queueIndex = queue.indexOf(job);
        if (queueIndex >= 0) {
          queue.splice(queueIndex, 1);
          refreshQueuePositions();
          await failJob(job, "Kullanıcı işlemi iptal etti", "cancelled");
        } else if (job.status === "awaiting_upload") {
          job.uploadRequest?.destroy();
          await failJob(job, "Kullanıcı işlemi iptal etti", "cancelled");
        } else await terminateJob(job);
        return sendJson(response, 202, publicJob(job));
      }

      if (request.method === "DELETE" && match) {
        const job = jobs.get(match[1]);
        if (!job) return sendJson(response, 404, { error: "İş bulunamadı" });
        if (activeJob === job) return sendJson(response, 409, { error: "Devam eden işi önce iptal edin" });
        const queueIndex = queue.indexOf(job);
        if (queueIndex >= 0) queue.splice(queueIndex, 1);
        await removeJobFiles(job);
        jobs.delete(job.id);
        response.writeHead(204);
        return response.end();
      }

      match = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)\/download\/([A-Za-z0-9_-]+)$/);
      if (request.method === "GET" && match) {
        const job = jobs.get(match[1]);
        if (!job || job.downloadToken !== match[2] || job.status !== "completed") return sendJson(response, 404, { error: "Dosya bulunamadı" });
        const outputStat = await stat(job.outputPath);
        response.writeHead(200, {
          "content-type": "video/mp4",
          "content-length": outputStat.size,
          "content-disposition": `attachment; filename="compressed-${job.id}.mp4"`,
          "cache-control": "private, no-store"
        });
        scheduleCleanup(job, Math.min(DOWNLOADED_TTL_MS, job.expiresAt ? job.expiresAt - Date.now() : DOWNLOADED_TTL_MS));
        return createReadStream(job.outputPath).pipe(response);
      }

      if (request.method === "GET" && staticFiles.has(url.pathname)) {
        const [name, contentType] = staticFiles.get(url.pathname);
        response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
        return createReadStream(path.join(PUBLIC_DIR, name)).pipe(response);
      }
      sendJson(response, 404, { error: "Bulunamadı" });
    } catch (error) {
      if (!response.headersSent) sendJson(response, 400, { error: error.message || "Beklenmeyen hata" });
      else response.destroy();
    }
  });

  async function close() {
    shuttingDown = true;
    for (const job of jobs.values()) job.uploadRequest?.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await terminateChildren(children, { graceMs: 3000 });
    await Promise.all([...jobs.values()].map(removeJobFiles));
    jobs.clear();
  }

  return { server, close, capabilities, jobs, tempRoot };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const lab = await createLabServer();
  lab.server.listen(PORT, HOST, () => {
    console.log(`Video Compression Lab: http://${HOST}:${PORT}`);
    if (lab.capabilities.errors.length) console.warn(lab.capabilities.errors.join("; "));
    if (lab.capabilities.ffmpeg && !lab.capabilities.libvmaf) console.warn("Bu FFmpeg kurulumu libvmaf desteklemiyor; SSIM/PSNR fallback kullanılacak.");
  });
  let shutdownPromise = null;
  const shutdown = () => {
    shutdownPromise ??= lab.close();
    return shutdownPromise;
  };
  process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));
}
