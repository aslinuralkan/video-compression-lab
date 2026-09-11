import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { buildEncodeArgs, detectCapabilities, probeMedia, runCapture, spawnWithProgress } from "../src/ffmpeg.js";
import { encodeParallel, validateParallelOutput } from "../src/parallel.js";

const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";
const capabilities = await detectCapabilities(ffmpegPath, ffprobePath);
const canRun = capabilities.ffmpeg && capabilities.ffprobe && capabilities.libx264;

async function generateFixture(filePath, withAudio) {
  const args = ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30"];
  if (withAudio) args.push("-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000");
  args.push("-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p");
  if (withAudio) args.push("-c:a", "aac", "-b:a", "128k", "-shortest");
  else args.push("-an");
  args.push(filePath);
  const result = await runCapture(ffmpegPath, args);
  assert.equal(result.code, 0, result.stderr);
}

async function generateLongerFixture(filePath, withAudio) {
  const args = ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30"];
  if (withAudio) args.push("-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000");
  args.push("-t", "4", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p");
  if (withAudio) args.push("-c:a", "aac", "-b:a", "128k", "-shortest");
  else args.push("-an");
  args.push(filePath);
  const result = await runCapture(ffmpegPath, args);
  assert.equal(result.code, 0, result.stderr);
}

async function compressAndVerify(withAudio) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "video-lab-e2e-"));
  try {
    const sourcePath = path.join(directory, withAudio ? "source-audio.mp4" : "source-silent.mp4");
    const outputPath = path.join(directory, "output.mp4");
    await generateFixture(sourcePath, withAudio);
    const source = await probeMedia(sourcePath, ffprobePath);
    const args = buildEncodeArgs({
      inputPath: sourcePath,
      outputPath,
      config: { crf: 28, preset: "veryfast", resolution: "720", maxFps: "30", audioBitrate: "96k" },
      source
    });
    const result = await spawnWithProgress(ffmpegPath, args, { durationSeconds: source.durationSeconds });
    assert.equal(result.code, 0, result.stderr);
    assert.ok((await stat(outputPath)).size > 0);
    const output = await probeMedia(outputPath, ffprobePath);
    assert.equal(output.video.codec, "h264");
    assert.equal(output.formatName.includes("mp4"), true);
    assert.ok(Math.abs(output.durationSeconds - source.durationSeconds) < 0.25, `${source.durationSeconds} vs ${output.durationSeconds}`);
    if (withAudio) assert.equal(output.audio?.codec, "aac");
    else assert.equal(output.audio, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function compressParallelAndVerify(withAudio) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "video-lab-parallel-e2e-"));
  try {
    const sourcePath = path.join(directory, withAudio ? "source-audio.mp4" : "source-silent.mp4");
    const outputPath = path.join(directory, "output.mp4");
    const workDir = path.join(directory, "work");
    await mkdir(workDir);
    await generateLongerFixture(sourcePath, withAudio);
    const source = await probeMedia(sourcePath, ffprobePath);
    const config = { crf: 28, preset: "ultrafast", resolution: "720", maxFps: "25", audioBitrate: "96k" };
    const encoded = await encodeParallel({
      ffmpegPath,
      inputPath: sourcePath,
      outputPath,
      jobDir: workDir,
      config,
      source,
      plan: { workers: 2, threadsPerWorker: 2, logicalCpus: 4, parallel: true }
    });
    assert.ok(encoded.commands.length >= (withAudio ? 5 : 3));
    assert.ok((await stat(outputPath)).size > 0);
    const output = await probeMedia(outputPath, ffprobePath);
    const validation = validateParallelOutput(source, output, config);
    assert.equal(validation.valid, true, validation.errors.join("; "));
    assert.equal(output.video.codec, "h264");
    assert.equal(output.formatName.includes("mp4"), true);
    assert.ok(Math.abs(output.durationSeconds - source.durationSeconds) < 0.25, `${source.durationSeconds} vs ${output.durationSeconds}`);
    if (withAudio) assert.equal(output.audio?.codec, "aac");
    else assert.equal(output.audio, null);
    assert.deepEqual(await readdir(workDir), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("sesli sentetik videoyu oynatılabilir H.264 + AAC MP4 olarak sıkıştırır", { skip: canRun ? false : "FFmpeg/ffprobe/libx264 bu ortamda yok" }, async () => {
  await compressAndVerify(true);
});

test("sessiz videoyu hata vermeden H.264 MP4 olarak sıkıştırır", { skip: canRun ? false : "FFmpeg/ffprobe/libx264 bu ortamda yok" }, async () => {
  await compressAndVerify(false);
});

test("iki paralel parçayı kesintisiz AAC sesle geçerli MP4 olarak birleştirir", { skip: canRun ? false : "FFmpeg/ffprobe/libx264 bu ortamda yok" }, async () => {
  await compressParallelAndVerify(true);
});

test("iki paralel sessiz parçayı geçerli MP4 olarak birleştirir", { skip: canRun ? false : "FFmpeg/ffprobe/libx264 bu ortamda yok" }, async () => {
  await compressParallelAndVerify(false);
});
