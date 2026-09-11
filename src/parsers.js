import { percentile } from "./metrics.js";

export function parseFraction(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (!value || value === "0/0" || value === "N/A") return null;
  const [numerator, denominator] = String(value).split("/").map(Number);
  if (!Number.isFinite(numerator)) return null;
  if (denominator === undefined) return numerator;
  return denominator ? numerator / denominator : null;
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseFfprobeJson(input) {
  const data = typeof input === "string" ? JSON.parse(input) : input;
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  if (!video) throw new Error("Dosya video değil veya ffprobe okuyamıyor");
  const audio = streams.find((stream) => stream.codec_type === "audio") ?? null;
  const duration = numeric(data.format?.duration) ?? numeric(video.duration);
  const formatBitrate = numeric(data.format?.bit_rate);

  return {
    formatName: data.format?.format_name ?? null,
    durationSeconds: duration,
    sizeBytes: numeric(data.format?.size),
    video: {
      codec: video.codec_name ?? null,
      width: numeric(video.width),
      height: numeric(video.height),
      fps: parseFraction(video.avg_frame_rate) ?? parseFraction(video.r_frame_rate),
      bitrate: numeric(video.bit_rate) ?? (audio ? null : formatBitrate),
      pixelFormat: video.pix_fmt ?? null
    },
    audio: audio
      ? {
          codec: audio.codec_name ?? null,
          bitrate: numeric(audio.bit_rate),
          channels: numeric(audio.channels),
          sampleRate: numeric(audio.sample_rate)
        }
      : null
  };
}

export function parseClock(value) {
  if (!value || value === "N/A") return null;
  const match = String(value).match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export function parseProgressBlock(text) {
  const fields = {};
  for (const line of String(text).trim().split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index > 0) fields[line.slice(0, index)] = line.slice(index + 1);
  }
  const outTimeSeconds = parseClock(fields.out_time)
    ?? (Number.isFinite(Number(fields.out_time_us)) ? Number(fields.out_time_us) / 1_000_000 : null)
    ?? (Number.isFinite(Number(fields.out_time_ms)) ? Number(fields.out_time_ms) / 1_000_000 : null);
  const speedMatch = fields.speed?.match(/^([\d.]+)x$/);
  return {
    fields,
    outTimeSeconds,
    speed: speedMatch ? Number(speedMatch[1]) : null,
    ended: fields.progress === "end"
  };
}

export function parseVmafJson(input) {
  const data = typeof input === "string" ? JSON.parse(input) : input;
  const scores = (data.frames ?? [])
    .map((frame) => Number(frame.metrics?.vmaf))
    .filter(Number.isFinite);
  const pooledMean = Number(data.pooled_metrics?.vmaf?.mean);
  const mean = Number.isFinite(pooledMean)
    ? pooledMean
    : scores.length
      ? scores.reduce((sum, score) => sum + score, 0) / scores.length
      : null;
  return { mean, percentile5: percentile(scores, 0.05), frameScores: scores };
}

export function parseSsimStats(text) {
  return String(text).split(/\r?\n/).map((line) => {
    const match = line.match(/\bAll:([\d.]+)/);
    return match ? Number(match[1]) : null;
  }).filter(Number.isFinite);
}

export function parsePsnrStats(text) {
  return String(text).split(/\r?\n/).map((line) => {
    const match = line.match(/\bpsnr_avg:([\d.]+|inf)/);
    if (!match) return null;
    return match[1] === "inf" ? 100 : Number(match[1]);
  }).filter(Number.isFinite);
}

export function parseBenchmarkStats(text) {
  const matches = [...String(text).matchAll(/bench:\s+utime=([\d.]+)s\s+stime=([\d.]+)s\s+rtime=([\d.]+)s/g)];
  if (!matches.length) return { userSeconds: null, systemSeconds: null, realSeconds: null, cpuPercent: null };
  const [, user, system, real] = matches.at(-1);
  const userSeconds = Number(user);
  const systemSeconds = Number(system);
  const realSeconds = Number(real);
  return {
    userSeconds,
    systemSeconds,
    realSeconds,
    cpuPercent: realSeconds > 0 ? (userSeconds + systemSeconds) / realSeconds * 100 : null
  };
}
