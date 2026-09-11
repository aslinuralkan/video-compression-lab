export function calculateSizeMetrics(originalBytes, outputBytes) {
  if (!Number.isFinite(originalBytes) || originalBytes <= 0) {
    throw new TypeError("originalBytes must be greater than zero");
  }
  if (!Number.isFinite(outputBytes) || outputBytes < 0) {
    throw new TypeError("outputBytes must be zero or greater");
  }

  const reductionBytes = originalBytes - outputBytes;
  const reductionPercent = (1 - outputBytes / originalBytes) * 100;
  const compressionRatio = outputBytes === 0 ? Infinity : originalBytes / outputBytes;
  return { reductionBytes, reductionPercent, compressionRatio };
}

export function calculateRealtimeSpeed(videoDurationSeconds, encodeElapsedSeconds) {
  if (!Number.isFinite(videoDurationSeconds) || videoDurationSeconds < 0) return null;
  if (!Number.isFinite(encodeElapsedSeconds) || encodeElapsedSeconds <= 0) return null;
  return videoDurationSeconds / encodeElapsedSeconds;
}

export function percentile(values, percent) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  if (finite.length === 1) return finite[0];
  const position = (finite.length - 1) * percent;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return finite[lower];
  return finite[lower] + (finite[upper] - finite[lower]) * (position - lower);
}
