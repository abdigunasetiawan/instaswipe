/**
 * InstaSwipe - Popup Script
 * Handles UI interactions, settings, and communication with content script
 */

(function () {
  'use strict';

  // ====== DOM Elements ======
  const el = {
    batchSize: document.getElementById('batchSize'),
    delay: document.getElementById('delay'),
    btnStart: document.getElementById('btnStart'),
    btnPause: document.getElementById('btnPause'),
    btnStop: document.getElementById('btnStop'),
    btnExportJSON: document.getElementById('btnExportJSON'),
    btnExportHTML: document.getElementById('btnExportHTML'),
    statusIndicator: document.getElementById('statusIndicator'),
    statusText: document.getElementById('statusText'),
    statusDot: document.querySelector('.status-dot'),
    pageStatus: document.getElementById('pageStatus'),
    statUnliked: document.getElementById('statUnliked'),
    statBatches: document.getElementById('statBatches'),
    statSelected: document.getElementById('statSelected'),
    logCount: document.getElementById('logCount'),
    activityLog: document.getElementById('activityLog'),
    progressContainer: document.getElementById('progressContainer'),
    progressFill: document.getElementById('progressFill'),
    progressText: document.getElementById('progressText'),
  };

  // ====== State ======
  let currentStatus = 'idle'; // idle, running, paused, stopped, finished
  let logData = [];

  // ====== Init ======
  async function init() {
    await loadSettings();
    await checkPageStatus();
    setupEventListeners();
    addLog('Extension siap. Buka halaman Instagram Likes dan klik Start.', 'info');
  }

  // ====== Settings ======
  async function loadSettings() {
    try {
      const data = await chrome.storage.local.get(['batchSize', 'delay', 'logData', 'stats']);
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
    } catch (e) {
      console.error('Error loading settings:', e);
    }
  }

  async function saveSettings() {
    try {
      await chrome.storage.local.set({
        batchSize: parseInt(el.batchSize.value),
        delay: parseInt(el.delay.value),
      });
    } catch (e) {
      console.error('Error saving settings:', e);
    }
  }

  // ====== Page Status ======
  async function checkPageStatus() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url && tab.url.includes('instagram.com/your_activity/interactions/likes')) {
        el.pageStatus.textContent = '✓ Halaman Likes terdeteksi';
        el.pageStatus.style.color = '#00d68f';
      } else {
        el.pageStatus.textContent = '✗ Bukan halaman Likes';
        el.pageStatus.style.color = '#ff4757';
      }
    } catch (e) {
      el.pageStatus.textContent = '—';
    }
  }

  // ====== Event Listeners ======
  function setupEventListeners() {
    el.batchSize.addEventListener('change', saveSettings);
    el.delay.addEventListener('change', saveSettings);

    el.btnStart.addEventListener('click', handleStart);
    el.btnPause.addEventListener('click', handlePause);
    el.btnStop.addEventListener('click', handleStop);

    el.btnExportJSON.addEventListener('click', () => exportData('json'));
    el.btnExportHTML.addEventListener('click', () => exportData('html'));

    // Listen for messages from content script
    chrome.runtime.onMessage.addListener(handleMessage);
  }

  // ====== Command Handlers ======
  async function handleStart() {
    const batchSize = parseInt(el.batchSize.value);
    const delay = parseInt(el.delay.value);

    if (batchSize < 10 || batchSize > 100) {
      addLog('Batch size harus antara 10-100', 'error');
      return;
    }
    if (delay < 1 || delay > 10) {
      addLog('Delay harus antara 1-10 detik', 'error');
      return;
    }

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) {
        addLog('Tidak dapat menemukan tab aktif', 'error');
        return;
      }

      if (!tab.url || !tab.url.includes('instagram.com/your_activity/interactions/likes')) {
        addLog('Silakan buka halaman Instagram Likes terlebih dahulu', 'error');
        return;
      }

      await chrome.tabs.sendMessage(tab.id, {
        action: 'start',
        settings: { batchSize, delay },
      });

      setStatus('running');
      addLog(`Memulai proses unlike (batch: ${batchSize}, delay: ${delay}s)`, 'info');
    } catch (e) {
      addLog('Gagal mengirim perintah. Pastikan halaman Instagram Likes sudah terbuka.', 'error');
      console.error(e);
    }
  }

  async function handlePause() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        await chrome.tabs.sendMessage(tab.id, { action: 'pause' });
        if (currentStatus === 'paused') {
          setStatus('running');
          addLog('Melanjutkan proses...', 'info');
        } else {
          setStatus('paused');
          addLog('Proses dijeda', 'warn');
        }
      }
    } catch (e) {
      addLog('Gagal mengirim perintah pause', 'error');
    }
  }

  async function handleStop() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        await chrome.tabs.sendMessage(tab.id, { action: 'stop' });
        setStatus('stopped');
        addLog('Proses dihentikan oleh user', 'warn');
      }
    } catch (e) {
      addLog('Gagal mengirim perintah stop', 'error');
    }
  }

  // ====== Message Handler ======
  function handleMessage(message, sender, sendResponse) {
    switch (message.type) {
      case 'stats_update':
        updateStats(message.data);
        chrome.storage.local.set({ stats: message.data });
        break;

      case 'log':
        addLog(message.text, message.level || 'info');
        break;

      case 'log_data':
        if (message.data && Array.isArray(message.data)) {
          logData = [...logData, ...message.data];
          chrome.storage.local.set({ logData });
          updateLogCount();
          updateExportButtons();
        }
        break;

      case 'status_change':
        setStatus(message.status);
        break;

      case 'progress':
        updateProgress(message.current, message.total);
        break;
    }
    sendResponse({ received: true });
    return true;
  }

  // ====== UI Updates ======
  function setStatus(status) {
    currentStatus = status;
    el.statusText.textContent = status.charAt(0).toUpperCase() + status.slice(1);

    // Reset dot classes
    el.statusDot.className = 'status-dot';
    if (status !== 'idle') {
      el.statusDot.classList.add(status);
    }

    // Update button states
    switch (status) {
      case 'running':
        el.btnStart.disabled = true;
        el.btnPause.disabled = false;
        el.btnStop.disabled = false;
        el.batchSize.disabled = true;
        el.delay.disabled = true;
        break;
      case 'paused':
        el.btnStart.disabled = true;
        el.btnPause.disabled = false;
        el.btnStop.disabled = false;
        break;
      case 'stopped':
      case 'finished':
      case 'idle':
        el.btnStart.disabled = false;
        el.btnPause.disabled = true;
        el.btnStop.disabled = true;
        el.batchSize.disabled = false;
        el.delay.disabled = false;
        break;
    }
  }

  function updateStats(data) {
    if (data.unliked !== undefined) el.statUnliked.textContent = data.unliked;
    if (data.batches !== undefined) el.statBatches.textContent = data.batches;
    if (data.selected !== undefined) el.statSelected.textContent = data.selected;
  }

  function updateProgress(current, total) {
    if (total > 0) {
      el.progressContainer.style.display = 'flex';
      const pct = Math.round((current / total) * 100);
      el.progressFill.style.width = `${pct}%`;
      el.progressText.textContent = `${pct}%`;
    } else {
      el.progressContainer.style.display = 'none';
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
  function addLog(text, level = 'info') {
    const entry = document.createElement('div');
    entry.className = `log-entry log-${level === 'info' ? 'info-entry' : level === 'success' ? 'success' : level === 'error' ? 'error' : 'warn'}`;

    const time = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    entry.textContent = `[${time}] ${text}`;

    el.activityLog.appendChild(entry);
    el.activityLog.scrollTop = el.activityLog.scrollHeight;

    // Limit log entries
    while (el.activityLog.children.length > 100) {
      el.activityLog.removeChild(el.activityLog.firstChild);
    }
  }

  // ====== Export ======
  async function exportData(format) {
    if (logData.length === 0) {
      addLog('Tidak ada data untuk di-export', 'warn');
      return;
    }

    try {
      let content, mimeType, filename;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

      if (format === 'json') {
        content = JSON.stringify({
          exported_at: new Date().toISOString(),
          total_posts: logData.length,
          posts: logData,
        }, null, 2);
        mimeType = 'application/json';
        filename = `instaswipe-log-${timestamp}.json`;
      } else {
        content = generateHTML(logData, timestamp);
        mimeType = 'text/html';
        filename = `instaswipe-log-${timestamp}.html`;
      }

      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);

      await chrome.downloads.download({
        url: url,
        filename: filename,
        saveAs: true,
      });

      addLog(`Data berhasil di-export sebagai ${format.toUpperCase()}`, 'success');
    } catch (e) {
      addLog(`Gagal export: ${e.message}`, 'error');
    }
  }

  function generateHTML(data, timestamp) {
    return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <title>InstaSwipe Log - ${timestamp}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0f; color: #e8e8f0; padding: 40px; max-width: 800px; margin: 0 auto; }
    h1 { background: linear-gradient(135deg, #833ab4, #fd1d1d, #fcb045); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .meta { color: #8888a0; margin-bottom: 24px; }
    .post { padding: 12px 16px; margin: 4px 0; background: #16161f; border-radius: 8px; border-left: 3px solid #833ab4; }
    .post a { color: #fcb045; text-decoration: none; }
    .post a:hover { text-decoration: underline; }
    .post .date { color: #5a5a70; font-size: 12px; }
  </style>
</head>
<body>
  <h1>InstaSwipe - Unlike Log</h1>
  <p class="meta">Exported: ${new Date().toLocaleString('id-ID')} | Total: ${data.length} posts</p>
  ${data.map((post, i) => `
  <div class="post">
    <span>#${i + 1}</span>
    <a href="${post.url}" target="_blank" rel="noopener">${post.url}</a>
    ${post.unliked_at ? `<span class="date"> — ${new Date(post.unliked_at).toLocaleString('id-ID')}</span>` : ''}
  </div>`).join('')}
</body>
</html>`;
  }

  // ====== Start ======
  init();
})();
