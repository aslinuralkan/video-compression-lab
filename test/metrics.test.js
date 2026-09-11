import test from "node:test";
import assert from "node:assert/strict";
import { calculateRealtimeSpeed, calculateSizeMetrics, percentile } from "../src/metrics.js";

test("boyut ve sıkıştırma oranlarını doğru hesaplar", () => {
  const result = calculateSizeMetrics(1000, 250);
  assert.equal(result.reductionBytes, 750);
  assert.equal(result.reductionPercent, 75);
  assert.equal(result.compressionRatio, 4);
});

test("çıktı daha büyük olduğunda negatif küçülmeyi korur", () => {
  const result = calculateSizeMetrics(1000, 1250);
  assert.equal(result.reductionBytes, -250);
  assert.equal(result.reductionPercent, -25);
  assert.equal(result.compressionRatio, 0.8);
});

test("realtime hızını sürelerden hesaplar", () => {
  assert.equal(calculateRealtimeSpeed(120, 50), 2.4);
  assert.equal(calculateRealtimeSpeed(120, 0), null);
});

test("yüzdelik doğrusal interpolasyon kullanır", () => {
  assert.equal(percentile([0, 100], 0.05), 5);
  assert.equal(percentile([], 0.05), null);
});
