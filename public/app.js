const $ = (selector) => document.querySelector(selector);
const elements = {
  form: $("#compressionForm"), file: $("#fileInput"), dropzone: $("#dropzone"),
  filePrimary: $("#filePrimary"), fileSecondary: $("#fileSecondary"), crf: $("#crf"), crfOutput: $("#crfOutput"),
  start: $("#startButton"), cancel: $("#cancelButton"), download: $("#downloadButton"), clear: $("#clearButton"),
  systemBadge: $("#systemBadge"), systemMessage: $("#systemMessage"), error: $("#errorMessage"),
  progressPanel: $("#progressPanel"), resultPanel: $("#resultPanel"), stage: $("#currentStage"), speed: $("#speed"), elapsed: $("#elapsed"),
  uploadProgress: $("#uploadProgress"), encodeProgress: $("#encodeProgress"), qualityProgress: $("#qualityProgress"),
  uploadValue: $("#uploadValue"), encodeValue: $("#encodeValue"), qualityValue: $("#qualityValue"),
  resultSummary: $("#resultSummary"), resultWarnings: $("#resultWarnings"), headline: $("#headlineMetrics"), comparison: $("#comparison"),
  details: $("#detailMetrics"), quality: $("#qualityResult"), command: $("#command")
};

let currentJobId = null;
let currentXhr = null;
let pollTimer = null;
let timer = null;
let startedAt = null;
let systemReady = false;

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  const signed = bytes < 0 ? "−" : "";
  return `${signed}${value.toLocaleString("tr-TR", { maximumFractionDigits: unit ? 2 : 0 })} ${units[unit]}`;
};
const formatNumber = (value, digits = 2) => Number.isFinite(value) ? value.toLocaleString("tr-TR", { maximumFractionDigits: digits }) : "—";
const formatBitrate = (value) => Number.isFinite(value) ? `${formatNumber(value / 1000, 0)} kb/sn` : "—";
const formatDuration = (seconds) => {
  if (!Number.isFinite(seconds)) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds % 3600 / 60);
  const s = Math.floor(seconds % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
};
const escapeHtml = (value) => String(value ?? "—").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);

function showError(message) {
  elements.error.textContent = message;
  elements.error.classList.toggle("hidden", !message);
}

function updateFile(file) {
  if (!file) return;
  elements.filePrimary.textContent = file.name;
  elements.fileSecondary.textContent = `${formatBytes(file.size)} · Yükleme sırasında belleğe alınmayacak`;
}

function setProgress(name, value) {
  const bounded = Math.min(100, Math.max(0, Number(value) || 0));
  elements[`${name}Progress`].value = bounded;
  elements[`${name}Value`].textContent = `${bounded.toFixed(bounded < 10 && bounded > 0 ? 1 : 0)}%`;
}

function setBusy(busy) {
  elements.start.disabled = busy || !systemReady;
  elements.file.disabled = busy;
  elements.cancel.disabled = !busy;
  elements.clear.disabled = busy || !currentJobId;
  for (const select of elements.form.querySelectorAll("select,input[type=range]")) select.disabled = busy;
}

function startClock() {
  clearInterval(timer);
  startedAt = Date.now();
  const tick = () => { elements.elapsed.textContent = formatDuration((Date.now() - startedAt) / 1000).padStart(5, "0"); };
  tick();
  timer = setInterval(tick, 1000);
}

async function api(url, options) {
  const response = await fetch(url, options);
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
  return body;
}

async function checkSystem() {
  try {
    const health = await api("/api/health");
    const missing = [];
    if (!health.capabilities.ffmpeg) missing.push("FFmpeg kurulu değil");
    if (!health.capabilities.ffprobe) missing.push("ffprobe kurulu değil");
    if (health.capabilities.ffmpeg && !health.capabilities.libx264) missing.push("libx264 desteklenmiyor");
    systemReady = missing.length === 0;
    elements.systemBadge.className = `system-badge ${systemReady ? "" : "error"}`;
    elements.systemBadge.innerHTML = `<span></span>${systemReady ? "Sistem hazır" : "Kurulum gerekli"}`;
    const notes = [...missing];
    if (systemReady && !health.capabilities.libvmaf) notes.push("Bu FFmpeg kurulumu libvmaf desteklemiyor. Kalite ölçümünde SSIM ve PSNR fallback kullanılacak.");
    elements.systemMessage.textContent = notes.join(" · ");
    elements.systemMessage.classList.toggle("hidden", notes.length === 0);
    elements.start.disabled = !systemReady;
  } catch (error) {
    elements.systemBadge.className = "system-badge error";
    elements.systemBadge.innerHTML = "<span></span>Backend erişilemiyor";
    elements.systemMessage.textContent = error.message;
    elements.systemMessage.classList.remove("hidden");
  }
}

function uploadFile(url, file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    currentXhr = xhr;
    xhr.open("PUT", url);
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) setProgress("upload", event.loaded / event.total * 100);
    };
    xhr.onload = () => {
      currentXhr = null;
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body.error || `Yükleme başarısız (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => { currentXhr = null; reject(new Error("Yükleme sırasında ağ hatası")); };
    xhr.onabort = () => { currentXhr = null; reject(new Error("Kullanıcı işlemi iptal etti")); };
    xhr.send(file);
  });
}

function updateFromJob(job) {
  elements.stage.textContent = job.queuePosition ? `${job.stage} · ${job.queuePosition}. sıra` : job.stage;
  elements.speed.textContent = Number.isFinite(job.progress.speed) ? `${formatNumber(job.progress.speed, 2)}x speed` : "—";
  setProgress("upload", job.progress.upload);
  setProgress("encode", job.progress.encode);
  setProgress("quality", job.progress.quality);
}

function metric(value, label) {
  return `<div class="metric"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`;
}

function renderResult(job) {
  const r = job.result;
  elements.resultPanel.classList.remove("hidden");
  elements.resultSummary.textContent = r.outputBytes <= r.originalBytes ? "Sıkıştırma tamamlandı" : "Çıktı kaynak dosyadan büyük";
  elements.resultWarnings.innerHTML = (job.warnings || []).map((warning) => `<div class="result-warning">${escapeHtml(warning)}</div>`).join("");
  elements.headline.innerHTML = [
    metric(formatBytes(r.originalBytes), "Kaynak boyutu"),
    metric(formatBytes(r.outputBytes), "Çıktı boyutu"),
    metric(formatBytes(r.reductionBytes), "Kazanılan alan"),
    metric(`${formatNumber(r.reductionPercent, 1)}%`, "Küçülme"),
  ].join("");
  const rows = [
    ["", "Kaynak", "Çıktı"],
    ["Codec", r.source.video.codec, r.output.video.codec],
    ["Çözünürlük", `${r.source.video.width} × ${r.source.video.height}`, `${r.output.video.width} × ${r.output.video.height}`],
    ["FPS", formatNumber(r.source.video.fps, 3), formatNumber(r.output.video.fps, 3)],
    ["Video bitrate", formatBitrate(r.source.video.bitrate), formatBitrate(r.output.video.bitrate)],
    ["Ses codec", r.source.audio?.codec || "Ses yok", r.output.audio?.codec || "Ses yok"],
    ["Ses bitrate", formatBitrate(r.source.audio?.bitrate), formatBitrate(r.output.audio?.bitrate)]
  ];
  elements.comparison.innerHTML = rows.map((row) => `<div class="compare-row">${row.map((cell) => `<div>${escapeHtml(cell)}</div>`).join("")}</div>`).join("");
  elements.details.innerHTML = [
    metric(`${formatNumber(r.compressionRatio, 2)}:1`, "Sıkıştırma oranı"),
    metric(formatDuration(r.durationSeconds), "Video süresi"),
    metric(formatDuration(r.encodeElapsedSeconds), "Encode işlem süresi"),
    metric(`${formatNumber(r.realtimeSpeed, 2)}x`, "Ortalama encode hızı"),
    metric(r.encodeMode === "parallel" ? `${r.workerCount} worker · ${(r.workerThreads || [r.threadsPerWorker]).join("+")} thread` : "Tek süreç", "Encode çalışma biçimi"),
    metric(r.parallelReason, "Worker seçim nedeni"),
    ...(r.encodeMode === "parallel" ? [
      metric(formatDuration(r.concatElapsedSeconds), "Concat / mux süresi")
    ] : [])
  ].join("");
  if (!r.quality) {
    elements.quality.innerHTML = `<div class="quality-card"><h3>Kalite ölçümü kapalı</h3><p>Bu iş için VMAF, SSIM veya PSNR hesaplanmadı.</p></div>`;
  } else if (r.quality.type === "vmaf") {
    elements.quality.innerHTML = `<div class="quality-card"><h3>Uçtan uca VMAF</h3><div class="quality-values"><div><strong>${formatNumber(r.quality.mean, 2)}</strong><span>Ortalama VMAF</span></div><div><strong>${formatNumber(r.quality.percentile5, 2)}</strong><span>5. yüzdelik</span></div><div><strong>${formatDuration(r.quality.elapsedSeconds)}</strong><span>VMAF ölçüm süresi</span></div></div></div>`;
  } else {
    elements.quality.innerHTML = `<div class="quality-card"><h3>SSIM / PSNR (fallback)</h3><div class="quality-values"><div><strong>${formatNumber(r.quality.ssim, 4)}</strong><span>SSIM</span></div><div><strong>${formatNumber(r.quality.psnr, 2)} dB</strong><span>PSNR</span></div><div><strong>${formatDuration(r.quality.elapsedSeconds)}</strong><span>Kalite ölçüm süresi</span></div></div><p>${escapeHtml(r.quality.message)}</p></div>`;
  }
  elements.command.textContent = r.command;
  elements.download.href = job.downloadUrl;
  elements.download.classList.remove("disabled");
  elements.download.setAttribute("aria-disabled", "false");
}

async function pollJob() {
  clearTimeout(pollTimer);
  if (!currentJobId) return;
  try {
    const job = await api(`/api/jobs/${currentJobId}`);
    updateFromJob(job);
    if (job.status === "completed") {
      clearInterval(timer);
      setBusy(false);
      elements.cancel.disabled = true;
      elements.clear.disabled = false;
      renderResult(job);
      return;
    }
    if (["failed", "cancelled"].includes(job.status)) {
      clearInterval(timer);
      setBusy(false);
      elements.cancel.disabled = true;
      elements.clear.disabled = false;
      showError(job.error);
      return;
    }
    pollTimer = setTimeout(pollJob, 800);
  } catch (error) {
    showError(error.message);
    pollTimer = setTimeout(pollJob, 1800);
  }
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = elements.file.files[0];
  if (!file) return showError("Önce bir video dosyası seçin");
  showError("");
  elements.resultPanel.classList.add("hidden");
  elements.progressPanel.classList.remove("hidden");
  setProgress("upload", 0); setProgress("encode", 0); setProgress("quality", 0);
  elements.stage.textContent = "İş oluşturuluyor";
  elements.download.classList.add("disabled");
  elements.download.removeAttribute("href");
  setBusy(true);
  startClock();
  try {
    const created = await api("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        crf: Number(elements.crf.value), preset: $("#preset").value, resolution: $("#resolution").value,
        maxFps: $("#maxFps").value, audioBitrate: $("#audioBitrate").value, qualityMode: $("#qualityMode").value,
        parallelism: $("#parallelism").value
      })
    });
    currentJobId = created.id;
    elements.stage.textContent = "Dosya diske yükleniyor";
    await uploadFile(created.uploadUrl, file);
    await pollJob();
  } catch (error) {
    clearInterval(timer);
    setBusy(false);
    elements.clear.disabled = !currentJobId;
    showError(error.message);
  }
});

elements.cancel.addEventListener("click", async () => {
  elements.stage.textContent = "İptal ediliyor";
  currentXhr?.abort();
  if (currentJobId) {
    try { await api(`/api/jobs/${currentJobId}/cancel`, { method: "POST" }); } catch (error) { if (!/zaten sona erdi/.test(error.message)) showError(error.message); }
  }
  void pollJob();
});

elements.clear.addEventListener("click", async () => {
  clearTimeout(pollTimer); clearInterval(timer);
  if (currentJobId) await api(`/api/jobs/${currentJobId}`, { method: "DELETE" }).catch(() => {});
  currentJobId = null;
  elements.resultPanel.classList.add("hidden");
  elements.progressPanel.classList.add("hidden");
  elements.error.classList.add("hidden");
  elements.download.classList.add("disabled");
  elements.download.removeAttribute("href");
  elements.clear.disabled = true;
  elements.file.value = "";
  elements.filePrimary.textContent = "Video seçin veya buraya sürükleyin";
  elements.fileSecondary.textContent = "Dosya belleğe alınmadan doğrudan diske aktarılır · 4 GB destekli";
});

elements.file.addEventListener("change", () => updateFile(elements.file.files[0]));
elements.crf.addEventListener("input", () => { elements.crfOutput.textContent = elements.crf.value; });
for (const type of ["dragenter", "dragover"]) elements.dropzone.addEventListener(type, (event) => { event.preventDefault(); elements.dropzone.classList.add("dragging"); });
for (const type of ["dragleave", "drop"]) elements.dropzone.addEventListener(type, (event) => { event.preventDefault(); elements.dropzone.classList.remove("dragging"); });
elements.dropzone.addEventListener("drop", (event) => {
  const file = event.dataTransfer.files[0];
  if (!file) return;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  elements.file.files = transfer.files;
  updateFile(file);
});

void checkSystem();
