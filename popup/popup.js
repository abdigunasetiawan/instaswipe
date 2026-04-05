/**
 * InstaSwipe - Popup Script
 * Handles UI interactions, settings, and communication with content script
 */

(function () {
  "use strict";

  const LIKES_URL =
    "https://www.instagram.com/your_activity/interactions/likes";

  // ====== DOM Elements ======
  const el = {
    batchSize: document.getElementById("batchSize"),
    delay: document.getElementById("delay"),
    btnStart: document.getElementById("btnStart"),
    btnPause: document.getElementById("btnPause"),
    btnStop: document.getElementById("btnStop"),
    btnExportJSON: document.getElementById("btnExportJSON"),
    btnExportHTML: document.getElementById("btnExportHTML"),
    statusIndicator: document.getElementById("statusIndicator"),
    statusText: document.getElementById("statusText"),
    statusDot: document.querySelector(".status-dot"),
    pageStatus: document.getElementById("pageStatus"),
    statUnliked: document.getElementById("statUnliked"),
    statBatches: document.getElementById("statBatches"),
    statSelected: document.getElementById("statSelected"),
    logCount: document.getElementById("logCount"),
    activityLog: document.getElementById("activityLog"),
    progressContainer: document.getElementById("progressContainer"),
    progressFill: document.getElementById("progressFill"),
    progressText: document.getElementById("progressText"),
  };

  // ====== State ======
  let currentStatus = "idle";
  let logData = [];
  let likesTabId = null;

  // ====== Init ======
  async function init() {
    await loadSettings();
    await checkPageStatus();
    setupEventListeners();
    // Sinkronisasi state dari content script (jika proses masih berjalan)
    await syncStateFromContentScript();
  }

  // ====== Settings ======
  async function loadSettings() {
    try {
      const data = await chrome.storage.local.get([
        "batchSize",
        "delay",
        "logData",
        "stats",
        "processStatus",
      ]);
      if (data.batchSize) el.batchSize.value = data.batchSize;
      if (data.delay) el.delay.value = data.delay;
      if (data.logData) {
        logData = data.logData;
        updateLogCount();
        updateExportButtons();
      }
      if (data.stats) {
        updateStats(data.stats);
      }
      // Restore process status dari storage sebagai fallback awal
      if (data.processStatus && data.processStatus !== "idle") {
        setStatus(data.processStatus);
      }
    } catch (e) {
      console.error("Error loading settings:", e);
    }
  }

  async function saveSettings() {
    try {
      await chrome.storage.local.set({
        batchSize: parseInt(el.batchSize.value),
        delay: parseInt(el.delay.value),
      });
    } catch (e) {
      console.error("Error saving settings:", e);
    }
  }

  // ====== Page Status ======
  async function checkPageStatus() {
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (
        tab &&
        tab.url &&
        tab.url.includes("instagram.com/your_activity/interactions/likes")
      ) {
        el.pageStatus.textContent = "✓ Halaman Likes terdeteksi";
        el.pageStatus.style.color = "#00d68f";
        likesTabId = tab.id;
      } else {
        el.pageStatus.textContent = "✗ Bukan halaman Likes";
        el.pageStatus.style.color = "#ff4757";
        likesTabId = null;
      }
    } catch (e) {
      el.pageStatus.textContent = "—";
    }
  }

  /**
   * Sinkronisasi state dari content script yang sedang berjalan.
   * Popup akan mengirim 'getState' ke content script,
   * jika content script merespons maka UI akan diperbarui.
   * Jika tidak merespons (misal tab sudah ditutup), fallback ke storage.
   */
  async function syncStateFromContentScript() {
    try {
      // Cari tab Instagram Likes yang mungkin masih menjalankan proses
      const tabs = await chrome.tabs.query({
        url: "*://www.instagram.com/your_activity/interactions/likes*",
      });

      if (tabs.length === 0) {
        // Tidak ada tab Likes terbuka → reset status ke idle jika stored status bukan finished/stopped
        const data = await chrome.storage.local.get(["processStatus"]);
        if (
          data.processStatus === "running" ||
          data.processStatus === "paused"
        ) {
          // Proses seharusnya berjalan tapi tab sudah ditutup → tandai stopped
          setStatus("stopped");
          await chrome.storage.local.set({ processStatus: "stopped" });
          addLog("Tab Instagram Likes sudah ditutup. Proses terhenti.", "warn");
        } else {
          addLog("Extension siap. Klik Start untuk memulai.", "info");
        }
        return;
      }

      likesTabId = tabs[0].id;

      // Coba ping content script untuk mendapatkan state real-time
      try {
        const response = await chrome.tabs.sendMessage(tabs[0].id, {
          action: "getState",
        });

        if (response && response.status) {
          setStatus(response.status);

          if (response.stats) {
            updateStats(response.stats);
          }

          // Tampilkan log sesuai status
          switch (response.status) {
            case "running":
              addLog("Proses sedang berjalan...", "info");
              break;
            case "paused":
              addLog(
                "Proses sedang dijeda. Klik Resume untuk melanjutkan.",
                "warn",
              );
              break;
            case "stopped":
              addLog("Proses telah dihentikan.", "warn");
              break;
            case "finished":
              addLog("Proses telah selesai.", "success");
              break;
            default:
              addLog("Extension siap. Klik Start untuk memulai.", "info");
          }
          return;
        }
      } catch (e) {
        // Content script tidak merespons (mungkin belum di-inject atau tab di-reload)
        console.log("Content script tidak merespons:", e.message);
      }

      // Fallback: gunakan status dari storage
      const data = await chrome.storage.local.get(["processStatus"]);
      if (data.processStatus && data.processStatus !== "idle") {
        // Content script tidak merespons tapi status tersimpan aktif → mungkin tab di-reload
        if (
          data.processStatus === "running" ||
          data.processStatus === "paused"
        ) {
          setStatus("stopped");
          await chrome.storage.local.set({ processStatus: "stopped" });
          addLog(
            "Proses terhenti karena halaman di-reload. Klik Start untuk memulai ulang.",
            "warn",
          );
        } else {
          addLog("Extension siap. Klik Start untuk memulai.", "info");
        }
      } else {
        addLog("Extension siap. Klik Start untuk memulai.", "info");
      }
    } catch (e) {
      console.error("Error syncing state:", e);
      addLog("Extension siap. Klik Start untuk memulai.", "info");
    }
  }

  // ====== Event Listeners ======
  function setupEventListeners() {
    el.batchSize.addEventListener("change", saveSettings);
    el.delay.addEventListener("change", saveSettings);

    el.btnStart.addEventListener("click", handleStart);
    el.btnPause.addEventListener("click", handlePause);
    el.btnStop.addEventListener("click", handleStop);

    el.btnExportJSON.addEventListener("click", () => exportData("json"));
    el.btnExportHTML.addEventListener("click", () => exportData("html"));

    // Listen for messages from content script
    chrome.runtime.onMessage.addListener(handleMessage);
  }

  // ====== Command Handlers ======

  /**
   * Pastikan halaman Instagram Likes terbuka.
   * - Jika sudah ada tab Likes → aktifkan tab itu
   * - Jika tab aktif adalah instagram.com → redirect URL di tab yang sama
   * - Jika bukan instagram → redirect URL di tab aktif
   */
  async function ensureLikesTab() {
    // Cek 1: Apakah sudah ada tab Instagram Likes?
    const existingTabs = await chrome.tabs.query({
      url: "*://www.instagram.com/your_activity/interactions/likes*",
    });
    if (existingTabs.length > 0) {
      await chrome.tabs.update(existingTabs[0].id, { active: true });
      likesTabId = existingTabs[0].id;
      el.pageStatus.textContent = "✓ Halaman Likes terdeteksi";
      el.pageStatus.style.color = "#00d68f";
      return existingTabs[0].id;
    }

    // Cek 2: Tab saat ini — ubah URL-nya langsung (jangan buat tab baru)
    const [currentTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    addLog("Membuka halaman Instagram Likes...", "info");
    el.pageStatus.textContent = "⏳ Membuka halaman Likes...";
    el.pageStatus.style.color = "#fcb045";

    // Redirect tab aktif ke halaman Likes
    await chrome.tabs.update(currentTab.id, { url: LIKES_URL });
    likesTabId = currentTab.id;

    // Tunggu halaman selesai loading
    await new Promise((resolve) => {
      function onUpdated(tabId, changeInfo) {
        if (tabId === currentTab.id && changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
    });

    // Beri waktu agar content script ter-inject
    await new Promise((r) => setTimeout(r, 2000));

    el.pageStatus.textContent = "✓ Halaman Likes terdeteksi";
    el.pageStatus.style.color = "#00d68f";

    return currentTab.id;
  }

  /**
   * Dapatkan ID tab Likes yang aktif
   */
  async function getActiveLikesTabId() {
    // Cek likesTabId yang tersimpan masih valid
    if (likesTabId) {
      try {
        const tab = await chrome.tabs.get(likesTabId);
        if (
          tab &&
          tab.url &&
          tab.url.includes("instagram.com/your_activity/interactions/likes")
        ) {
          return likesTabId;
        }
      } catch (e) {
        // Tab mungkin sudah ditutup
      }
    }

    // Cari tab Likes yang ada
    const tabs = await chrome.tabs.query({
      url: "*://www.instagram.com/your_activity/interactions/likes*",
    });
    if (tabs.length > 0) {
      likesTabId = tabs[0].id;
      return tabs[0].id;
    }

    // Fallback: tab aktif saat ini
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (activeTab) {
      likesTabId = activeTab.id;
      return activeTab.id;
    }

    return null;
  }

  async function handleStart() {
    const batchSize = parseInt(el.batchSize.value);
    const delay = parseInt(el.delay.value);

    if (batchSize < 10 || batchSize > 100) {
      addLog("Batch size harus antara 10-100", "error");
      return;
    }
    if (delay < 1 || delay > 10) {
      addLog("Delay harus antara 1-10 detik", "error");
      return;
    }

    try {
      // Reset status di storage saat mulai proses baru
      await chrome.storage.local.set({ processStatus: "running" });

      const tabId = await ensureLikesTab();

      await chrome.tabs.sendMessage(tabId, {
        action: "start",
        settings: { batchSize, delay },
      });

      setStatus("running");
      addLog(
        `Memulai proses unlike (batch: ${batchSize}, delay: ${delay}s)`,
        "info",
      );
    } catch (e) {
      addLog(
        "Gagal mengirim perintah. Coba reload halaman dan klik Start lagi.",
        "error",
      );
      console.error(e);
    }
  }

  async function handlePause() {
    try {
      const tabId = await getActiveLikesTabId();
      if (tabId) {
        await chrome.tabs.sendMessage(tabId, { action: "pause" });
        if (currentStatus === "paused") {
          setStatus("running");
          addLog("Melanjutkan proses...", "info");
        } else {
          setStatus("paused");
          addLog("Proses dijeda", "warn");
        }
      } else {
        addLog("Tidak dapat menemukan tab Instagram Likes", "error");
      }
    } catch (e) {
      addLog("Gagal mengirim perintah pause", "error");
    }
  }

  async function handleStop() {
    try {
      const tabId = await getActiveLikesTabId();
      if (tabId) {
        await chrome.tabs.sendMessage(tabId, { action: "stop" });
        setStatus("stopped");
        addLog("Proses dihentikan oleh user", "warn");
      } else {
        addLog("Tidak dapat menemukan tab Instagram Likes", "error");
      }
    } catch (e) {
      addLog("Gagal mengirim perintah stop", "error");
    }
  }

  // ====== Message Handler ======
  function handleMessage(message, sender, sendResponse) {
    switch (message.type) {
      case "stats_update":
        updateStats(message.data);
        chrome.storage.local.set({ stats: message.data });
        break;

      case "log":
        addLog(message.text, message.level || "info");
        break;

      case "log_data":
        if (message.data && Array.isArray(message.data)) {
          logData = [...logData, ...message.data];
          chrome.storage.local.set({ logData });
          updateLogCount();
          updateExportButtons();
        }
        break;

      case "status_change":
        setStatus(message.status);
        // Simpan likesTabId dari content script
        if (sender && sender.tab) {
          likesTabId = sender.tab.id;
        }
        break;

      case "p rogress":
        updateProgress(message.current, message.total);
        break;
    }
    sendResponse({ received: true });
    return true;
  }

  // ====== UI Updates ======
  function setStatus(status) {
    currentStatus = status;
    el.statusText.textContent =
      status.charAt(0).toUpperCase() + status.slice(1);

    el.statusDot.className = "status-dot";
    if (status !== "idle") {
      el.statusDot.classList.add(status);
    }

    // Helper: update label teks tombol (text node setelah SVG icon)
    function setBtnLabel(btn, label) {
      for (const node of btn.childNodes) {
        if (
          node.nodeType === Node.TEXT_NODE &&
          node.textContent.trim().length > 0
        ) {
          node.textContent = `\n          ${label}\n        `;
          return;
        }
      }
    }

    switch (status) {
      case "running":
        el.btnStart.disabled = true;
        el.btnPause.disabled = false;
        el.btnStop.disabled = false;
        el.batchSize.disabled = true;
        el.delay.disabled = true;
        setBtnLabel(el.btnPause, "Pause");
        break;
      case "paused":
        el.btnStart.disabled = true;
        el.btnPause.disabled = false;
        el.btnStop.disabled = false;
        setBtnLabel(el.btnPause, "Resume");
        break;
      case "stopped":
      case "finished":
      case "idle":
        el.btnStart.disabled = false;
        el.btnPause.disabled = true;
        el.btnStop.disabled = true;
        el.batchSize.disabled = false;
        el.delay.disabled = false;
        setBtnLabel(el.btnPause, "Pause");
        break;
    }
  }

  function updateStats(data) {
    if (data.unliked !== undefined) el.statUnliked.textContent = data.unliked;
    if (data.batches !== undefined) el.statBatches.textContent = data.batches;
    if (data.selected !== undefined)
      el.statSelected.textContent = data.selected;
  }

  function updateProgress(current, total) {
    if (total > 0) {
      el.progressContainer.style.display = "flex";
      const pct = Math.round((current / total) * 100);
      el.progressFill.style.width = `${pct}%`;
      el.progressText.textContent = `${pct}%`;
    } else {
      el.progressContainer.style.display = "none";
    }
  }

  function updateLogCount() {
    el.logCount.textContent = `${logData.length} postingan tercatat`;
  }

  function updateExportButtons() {
    const hasData = logData.length > 0;
    el.btnExportJSON.disabled = !hasData;
    el.btnExportHTML.disabled = !hasData;
  }

  // ====== Activity Log ======
  function addLog(text, level = "info") {
    const entry = document.createElement("div");
    entry.className = `log-entry log-${level === "info" ? "info-entry" : level === "success" ? "success" : level === "error" ? "error" : "warn"}`;

    const time = new Date().toLocaleTimeString("id-ID", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    entry.textContent = `[${time}] ${text}`;

    el.activityLog.appendChild(entry);
    el.activityLog.scrollTop = el.activityLog.scrollHeight;

    while (el.activityLog.children.length > 100) {
      el.activityLog.removeChild(el.activityLog.firstChild);
    }
  }

  // ====== Export ======
  async function exportData(format) {
    if (logData.length === 0) {
      addLog("Tidak ada data untuk di-export", "warn");
      return;
    }

    try {
      let content, mimeType, filename;
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, 19);
      const exportedAt = new Date().toISOString();
      const exportedAtLocal = new Date().toLocaleString("id-ID");

      if (format === "json") {
        const exportObj = {
          exported_at: exportedAt,
          exported_at_local: exportedAtLocal,
          app: "InstaSwipe",
          version: "1.0.0",
          total_posts: logData.length,
          summary: {
            total: logData.length,
            reels: logData.filter((p) => p.type === "reel").length,
            posts: logData.filter((p) => p.type === "post").length,
            carousels: logData.filter((p) => p.type === "carousel").length,
            with_url: logData.filter((p) => p.url).length,
            with_thumbnail: logData.filter((p) => p.thumbnail).length,
          },
          posts: logData.map((post, i) => ({
            index: i + 1,
            url: post.url || null,
            shortcode: post.shortcode || null,
            type: post.type || "unknown",
            thumbnail: post.thumbnail || null,
            media_id: post.media_id || null,
            unliked_at: post.unliked_at || null,
            unliked_at_local: post.unliked_at
              ? new Date(post.unliked_at).toLocaleString("id-ID")
              : null,
          })),
        };
        content = JSON.stringify(exportObj, null, 2);
        mimeType = "application/json";
        filename = `instaswipe-log-${timestamp}.json`;
      } else {
        content = generateHTML(logData, timestamp, exportedAtLocal);
        mimeType = "text/html";
        filename = `instaswipe-log-${timestamp}.html`;
      }

      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);

      await chrome.downloads.download({
        url: url,
        filename: filename,
        saveAs: true,
      });

      addLog(
        `Data berhasil di-export sebagai ${format.toUpperCase()}`,
        "success",
      );
    } catch (e) {
      addLog(`Gagal export: ${e.message}`, "error");
    }
  }

  function generateHTML(data, timestamp, exportedAtLocal) {
    const reelCount = data.filter((p) => p.type === "reel").length;
    const postCount = data.filter((p) => p.type === "post").length;
    const urlCount = data.filter((p) => p.url).length;
    const thumbCount = data.filter((p) => p.thumbnail).length;

    const cardItems = data
      .map((post, i) => {
        const dateStr = post.unliked_at
          ? new Date(post.unliked_at).toLocaleString("id-ID")
          : "—";
        const typeLabel =
          post.type === "reel"
            ? "🎬 Reel"
            : post.type === "carousel"
              ? "📸 Carousel"
              : "🖼️ Post";
        const typeClass =
          post.type === "reel"
            ? "type-reel"
            : post.type === "carousel"
              ? "type-carousel"
              : "type-post";
        const hasUrl = post.url && post.url !== "unknown";

        // Card wrapper: jika punya URL, bungkus dengan <a>
        const openTag = hasUrl
          ? `<a href="${post.url}" target="_blank" rel="noopener" class="card-link" title="Buka di Instagram">`
          : `<div class="card-link">`;
        const closeTag = hasUrl ? `</a>` : `</div>`;

        return `
    ${openTag}
      <div class="card">
        <div class="card-thumb">
          ${
            post.thumbnail
              ? `<img src="${post.thumbnail}" alt="Post #${i + 1}" loading="lazy" referrerpolicy="no-referrer" crossorigin="anonymous" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
              : ""
          }
          <div class="thumb-placeholder" ${post.thumbnail ? 'style="display:none"' : ""}>#${i + 1}</div>
        </div>
        <div class="card-body">
          <div class="card-header">
            <span class="card-num">#${i + 1}</span>
            <span class="card-type ${typeClass}">${typeLabel}</span>
          </div>
          ${hasUrl ? `<div class="card-url">${post.url.replace("https://www.instagram.com", "")}</div>` : ""}
          ${post.shortcode ? `<div class="card-id">Shortcode: <code>${post.shortcode}</code></div>` : ""}
          <div class="card-date">🗑️ Unliked: ${dateStr}</div>
        </div>
      </div>
    ${closeTag}`;
      })
      .join("");

    return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <title>InstaSwipe Log — ${timestamp}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0f;
      color: #e8e8f0;
      min-height: 100vh;
      padding: 40px 20px;
    }
    .header {
      max-width: 1200px;
      margin: 0 auto 32px;
    }
    h1 {
      font-size: 2rem;
      font-weight: 800;
      background: linear-gradient(135deg, #833ab4, #fd1d1d, #fcb045);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 8px;
    }
    .meta { color: #8888a0; font-size: 14px; line-height: 1.6; }
    .summary {
      display: flex; gap: 12px; flex-wrap: wrap; margin-top: 16px;
    }
    .summary-chip {
      background: #16161f;
      border: 1px solid #2a2a3f;
      border-radius: 99px;
      padding: 6px 14px;
      font-size: 13px;
      color: #b0b0cc;
    }
    .summary-chip strong { color: #fcb045; }
    .grid {
      max-width: 1200px;
      margin: 0 auto;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 14px;
    }
    .card-link {
      text-decoration: none;
      color: inherit;
      display: block;
    }
    .card {
      background: #13131c;
      border: 1px solid #1e1e2e;
      border-radius: 14px;
      overflow: hidden;
      transition: transform .2s, border-color .2s, box-shadow .2s;
      cursor: pointer;
    }
    .card:hover {
      transform: translateY(-3px);
      border-color: #833ab4;
      box-shadow: 0 8px 24px rgba(131, 58, 180, 0.15);
    }
    .card-thumb {
      width: 100%;
      aspect-ratio: 1;
      background: #0d0d14;
      overflow: hidden;
      position: relative;
    }
    .card-thumb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .thumb-placeholder {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.6rem;
      font-weight: 700;
      color: #3a3a55;
      background: linear-gradient(135deg, #0d0d14, #1a1a2e);
    }
    .card-body { padding: 10px 12px; }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
    }
    .card-num { font-size: 11px; color: #5a5a78; }
    .card-type {
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 99px;
      font-weight: 600;
    }
    .type-reel { background: #2a1a3a; color: #c87bff; }
    .type-post { background: #1a2a3a; color: #7bb8ff; }
    .type-carousel { background: #3a2a1a; color: #ffb87b; }
    .card-url {
      font-size: 11px;
      color: #fcb045;
      margin-bottom: 4px;
      word-break: break-all;
      line-height: 1.3;
    }
    .card-id {
      font-size: 10px;
      color: #6a6a88;
      margin-bottom: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .card-id code {
      background: #1e1e30;
      padding: 1px 5px;
      border-radius: 4px;
      font-family: 'Courier New', monospace;
      font-size: 9px;
    }
    .card-date { font-size: 11px; color: #5a5a78; }
    footer {
      text-align: center;
      color: #3a3a50;
      font-size: 12px;
      margin-top: 48px;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>⚡ InstaSwipe — Unlike Log</h1>
    <div class="meta">
      <div>Diekspor: ${exportedAtLocal}</div>
      <div class="summary">
        <div class="summary-chip">Total: <strong>${data.length}</strong></div>
        <div class="summary-chip">🖼️ Post: <strong>${postCount}</strong></div>
        <div class="summary-chip">🎬 Reel: <strong>${reelCount}</strong></div>
        <div class="summary-chip">🔗 URL: <strong>${urlCount}</strong></div>
        <div class="summary-chip">📷 Thumbnail: <strong>${thumbCount}</strong></div>
      </div>
    </div>
  </div>
  <div class="grid">
    ${cardItems}
  </div>
  <footer>InstaSwipe v1.0.0 — Generated at ${exportedAtLocal}</footer>
</body>
</html>`;
  }

  // ====== Start ======
  init();
})();
