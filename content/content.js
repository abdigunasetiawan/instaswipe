/**
 * InstaSwipe - Content Script
 * Core logic untuk bulk unlike postingan Instagram
 * Bekerja pada halaman: instagram.com/your_activity/interactions/likes
 */

(function () {
  'use strict';

  // ====== State ======
  const state = {
    isRunning: false,
    isPaused: false,
    isStopped: false,
    settings: { batchSize: 100, delay: 3 },
    stats: { unliked: 0, batches: 0, selected: 0 },
    logData: [],
    selectedPosts: new Set(),
  };

  // ====== Utility Functions ======

  /**
   * Delay helper with pause support
   */
  function wait(ms) {
    return new Promise((resolve) => {
      const checkInterval = 200;
      let elapsed = 0;
      const timer = setInterval(() => {
        if (state.isStopped) {
          clearInterval(timer);
          resolve(false);
          return;
        }
        if (!state.isPaused) {
          elapsed += checkInterval;
        }
        if (elapsed >= ms) {
          clearInterval(timer);
          resolve(true);
        }
      }, checkInterval);
    });
  }

  /**
   * Wait for an element to appear in the DOM
   */
  function waitForElement(findFn, timeout = 10000, retries = 3) {
    return new Promise((resolve) => {
      let attempt = 0;

      function tryFind() {
        const el = findFn();
        if (el) {
          resolve(el);
          return;
        }

        attempt++;
        if (attempt > retries) {
          const observer = new MutationObserver(() => {
            const el = findFn();
            if (el) {
              observer.disconnect();
              resolve(el);
            }
          });

          observer.observe(document.body, {
            childList: true,
            subtree: true,
          });

          setTimeout(() => {
            observer.disconnect();
            resolve(null);
          }, timeout);
        } else {
          setTimeout(tryFind, 1000);
        }
      }

      tryFind();
    });
  }

  /**
   * Find button by text content
   */
  function findButtonByText(text) {
    const textLower = text.toLowerCase();
    
    // Strategy 1: Find span or text block with the exact text
    const textElements = document.querySelectorAll('span, div[data-bloks-name*="Text"]');
    for (const el of textElements) {
      if (el.textContent.trim().toLowerCase() === textLower) {
        const clickableParent = el.closest('[role="button"], button');
        if (clickableParent) return clickableParent;
        return el;
      }
    }

    // Strategy 2: Direct button search
    const buttons = document.querySelectorAll('button, [role="button"]');
    for (const btn of buttons) {
      if (btn.textContent.trim().toLowerCase().includes(textLower)) {
        return btn;
      }
    }

    return null;
  }

  /**
   * Simulate a human-like click
   */
  function simulateClick(element) {
    if (!element) return false;
    try {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });

      const events = ['mousedown', 'mouseup', 'click'];
      for (const eventType of events) {
        const event = new MouseEvent(eventType, {
          bubbles: true,
          cancelable: true,
          view: window,
        });
        element.dispatchEvent(event);
      }
      return true;
    } catch (e) {
      log(`Error saat klik: ${e.message}`, 'error');
      return false;
    }
  }

  /**
   * Scroll down to load more content
   */
  function scrollDown() {
    return new Promise((resolve) => {
      const scrollAmount = window.innerHeight * 0.8;
      window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
      setTimeout(resolve, 1500);
    });
  }

  /**
   * Send message to popup
   */
  function sendToPopup(message) {
    try {
      chrome.runtime.sendMessage(message);
    } catch (e) {
      // Popup might be closed, ignore
    }
  }

  function log(text, level = 'info') {
    console.log(`[InstaSwipe] [${level.toUpperCase()}] ${text}`);
    sendToPopup({ type: 'log', text, level });
  }

  function updateStats() {
    sendToPopup({ type: 'stats_update', data: { ...state.stats } });
    // Persist stats ke storage
    chrome.storage.local.set({ stats: { ...state.stats } });
  }

  function updateProgress(current, total) {
    sendToPopup({ type: 'progress', current, total });
  }

  /**
   * Simpan status proses ke storage agar popup bisa membacanya saat dibuka ulang
   */
  function setStatus(status) {
    sendToPopup({ type: 'status_change', status });
    // Persist process status ke storage
    chrome.storage.local.set({ 
      processStatus: status,
      processState: {
        isRunning: state.isRunning,
        isPaused: state.isPaused,
        isStopped: state.isStopped,
      }
    });
  }

  // ====== Core Logic ======

  /**
   * Step 1: Click "Select" button
   */
  async function clickSelectButton() {
    log('Mencari tombol Select...');

    const selectBtn = await waitForElement(() => {
      return findButtonByText('Select') || findButtonByText('Pilih');
    });

    if (!selectBtn) {
      log('Tombol Select tidak ditemukan. Pastikan Anda berada di halaman Likes.', 'error');
      return false;
    }

    await wait(500);
    const clicked = simulateClick(selectBtn);
    if (!clicked) {
      log('Gagal klik tombol Select', 'error');
      return false;
    }

    log('Tombol Select diklik', 'success');
    await wait(1000);
    return true;
  }

  /**
   * Step 2: Select posts
   */
  async function selectPosts(maxCount) {
    log(`Memilih postingan (maks: ${maxCount})...`);
    let selectedCount = 0;
    let noNewPostsCount = 0;
    const maxNoNewPosts = 3;
    let previousPostCount = 0;

    while (selectedCount < maxCount && !state.isStopped) {
      if (state.isPaused) {
        await wait(500);
        continue;
      }

      const postItems = findSelectableItems();

      if (postItems.length === 0) {
        log('Tidak ada post yang bisa dipilih. Mencoba scroll...', 'warn');
        await scrollDown();
        await wait(1000);
        noNewPostsCount++;
        if (noNewPostsCount >= maxNoNewPosts) {
          log('Tidak ada post baru setelah beberapa kali scroll', 'warn');
          break;
        }
        continue;
      }

      for (const item of postItems) {
        if (selectedCount >= maxCount || state.isStopped) break;
        
        // Tunggu sampai resume jika sedang di-pause (jangan skip item)
        while (state.isPaused && !state.isStopped) {
          await wait(500);
        }
        if (state.isStopped) break;

        const postKey = getPostKey(item);
        if (state.selectedPosts.has(postKey)) continue;

        if (isAlreadySelected(item)) {
          state.selectedPosts.add(postKey);
          continue;
        }

        const clicked = simulateClick(item);
        if (clicked) {
          state.selectedPosts.add(postKey);
          selectedCount++;
          state.stats.selected = selectedCount;
          updateStats();
          updateProgress(selectedCount, maxCount);

          // Collect post data (thumbnail, type)
          collectPostData(item);

          await wait(150 + Math.random() * 200);
        }
      }

      if (selectedCount < maxCount) {
        const currentPostCount = findSelectableItems().length;
        if (currentPostCount === previousPostCount) {
          noNewPostsCount++;
          if (noNewPostsCount >= maxNoNewPosts) {
            log(`Tidak ada post baru. Total terpilih: ${selectedCount}`, 'warn');
            break;
          }
        } else {
          noNewPostsCount = 0;
        }
        previousPostCount = currentPostCount;

        log('Melakukan scroll untuk memuat lebih banyak post...');
        await scrollDown();
        await wait(state.settings.delay * 500);
      }
    }

    log(`${selectedCount} postingan terpilih`, selectedCount > 0 ? 'success' : 'warn');
    return selectedCount;
  }

  /**
   * Find selectable items - berdasarkan DOM bloks Instagram
   * Setiap post punya div[data-testid="bulk_action_checkbox"]
   * Target klik = parent container yang punya pointer-events: auto + role="button"
   */
  function findSelectableItems() {
    const items = [];

    // Strategy A: Bloks checkbox (paling akurat berdasarkan DOM user)
    const bulkCheckboxes = document.querySelectorAll('div[data-testid="bulk_action_checkbox"]');
    if (bulkCheckboxes.length > 0) {
      for (const cb of bulkCheckboxes) {
        // Naik ke container clickable (role="button" dengan aria-label="Image with button" atau "Gambar Postingan")
        // Dari DOM: checkbox -> parent -> parent -> ... -> div[role="button"][aria-label="Image with button"]
        let clickTarget = cb.closest('div[role="button"][aria-label]');
        if (!clickTarget) {
          // Fallback: naik ke parent yang punya cursor pointer
          clickTarget = cb.closest('div[style*="cursor: pointer"]');
        }
        if (!clickTarget) {
          // Fallback lagi: parent dari checkbox langsung
          clickTarget = cb.parentElement;
        }
        if (clickTarget && !items.includes(clickTarget)) {
          items.push(clickTarget);
        }
      }
    }

    if (items.length > 0) return items;

    // Strategy B: Find images in content area with clickable parent
    const allButtons = document.querySelectorAll('div[role="button"]');
    for (const btn of allButtons) {
      const img = btn.querySelector('img');
      if (img && isInContentArea(btn)) {
        items.push(btn);
      }
    }

    return items;
  }

  /**
   * Check if element is in the main content area
   */
  function isInContentArea(el) {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.top > 50 && rect.bottom < window.innerHeight + 500;
  }

  /**
   * Generate unique key for a post element
   */
  function getPostKey(element) {
    const img = element.querySelector('img');
    if (img && img.src) return img.src;
    const rect = element.getBoundingClientRect();
    return `${rect.left}-${rect.top}-${rect.width}`;
  }

  /**
   * Check if a post is already selected
   * Berdasarkan DOM: selected = circle-check__filled (biru), unselected = circle__outline
   */
  function isAlreadySelected(element) {
    // Cek mask-image di dalam checkbox area (bukan seluruh outerHTML yang terlalu besar)
    const checkbox = element.querySelector('div[data-testid="bulk_action_checkbox"]') || element;
    const icons = checkbox.querySelectorAll('div[data-bloks-name="ig.components.Icon"]');
    for (const icon of icons) {
      const maskImage = icon.style.maskImage || icon.style.webkitMaskImage || '';
      if (maskImage.includes('circle-check__filled') || maskImage.includes('circle__check')) {
        // Cek juga warna biru (selected state)
        const bgColor = icon.style.backgroundColor || '';
        if (bgColor.includes('74, 93, 249') || bgColor.includes('0, 149, 246')) {
          return true;
        }
        return true;
      }
      if (maskImage.includes('circle__outline')) {
        return false;
      }
    }

    // Fallback: cek background color biru pada child elements
    const blueElements = element.querySelectorAll('[style*="background-color: rgb(0, 149, 246)"], [style*="background-color: rgb(74, 93, 249)"]');
    if (blueElements.length > 0) return true;

    return false;
  }

  /**
   * Konversi media ID numerik ke shortcode Instagram
   * Instagram menggunakan base64 custom dengan 64 karakter alphabet
   */
  function mediaIdToShortcode(mediaIdStr) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let id = BigInt(mediaIdStr);
    let shortcode = '';
    while (id > 0n) {
      shortcode = alphabet[Number(id % 64n)] + shortcode;
      id = id / 64n;
    }
    return shortcode;
  }

  /**
   * Ekstrak media ID dari ig_cache_key di URL thumbnail
   * ig_cache_key berisi base64-encoded media ID
   * Contoh: ig_cache_key=Mzg1OTI2NTQ0OTA3NTA3Nzk4NA%3D%3D.3-ccb7-5
   *   → base64 decode → "3859265449075077984"
   *   → shortcode → URL post
   */
  function extractMediaIdFromUrl(thumbnailUrl) {
    if (!thumbnailUrl) return null;
    
    try {
      // Cari ig_cache_key di URL
      const match = thumbnailUrl.match(/ig_cache_key=([^&]+)/);
      if (!match) return null;
      
      // URL-decode value
      let cacheKey = decodeURIComponent(match[1]);
      
      // Ambil bagian sebelum titik (base64 part)
      const dotIndex = cacheKey.indexOf('.');
      if (dotIndex > 0) {
        cacheKey = cacheKey.substring(0, dotIndex);
      }
      
      // Base64 decode → media ID string
      const mediaIdStr = atob(cacheKey);
      
      // Validasi: harus berupa angka
      if (/^\d+$/.test(mediaIdStr)) {
        return mediaIdStr;
      }
    } catch (e) {
      console.log('[InstaSwipe] Error extracting media ID:', e);
    }
    
    return null;
  }

  /**
   * Collect post data for logging
   * Dari DOM bloks: thumbnail ada di img[data-bloks-name="bk.components.Image"]
   * Tipe konten (reel/post) dapat dari icon mask-image "reels__filled"
   * URL post dihasilkan dari media ID → shortcode
   */
  function collectPostData(element) {
    try {
      // element adalah clickTarget (seringkali hanya merujuk ke elemen label/checkbox)
      // Karena struktur DOM bloks Instagram, img & icon mungkin tidak ada di dalam element secara langsung.
      // Kita perlu naik beberapa level dan mencari img dari kontainer parent yang lebih luas (grid cell).
      let searchContext = element;
      let img = searchContext.querySelector('img[data-bloks-name="bk.components.Image"]') || searchContext.querySelector('img');

      // Jika img tidak ditemukan, naik level parent (max 6 level)
      if (!img) {
        let parent = element.parentElement;
        for (let i = 0; i < 6; i++) {
          if (!parent) break;
          img = parent.querySelector('img[data-bloks-name="bk.components.Image"]') || parent.querySelector('img');
          if (img) {
            searchContext = parent;
            break;
          }
          parent = parent.parentElement;
        }
      }
      
      // Deteksi tipe: reel atau post menggunakan searchContext
      let type = 'post';
      const icons = searchContext.querySelectorAll('div[data-bloks-name="ig.components.Icon"]');
      for (const icon of icons) {
        const maskImage = icon.style.maskImage || icon.style.webkitMaskImage || '';
        if (maskImage.includes('reels__filled') || maskImage.includes('reels')) {
          type = 'reel';
          break;
        }
        if (maskImage.includes('carousel') || maskImage.includes('gallery')) {
          type = 'carousel';
          break;
        }
      }

      // Ambil thumbnail URL
      let thumbnailUrl = img ? img.src : null;
      
      // Ekstrak media ID dari ig_cache_key → konversi ke shortcode → buat URL
      let url = null;
      let mediaId = null;
      let shortcode = null;
      
      mediaId = extractMediaIdFromUrl(thumbnailUrl);
      if (mediaId) {
        shortcode = mediaIdToShortcode(mediaId);
        if (shortcode) {
          // Reel → /reel/SHORTCODE/, Post → /p/SHORTCODE/
          const urlPath = type === 'reel' ? 'reel' : 'p';
          url = `https://www.instagram.com/${urlPath}/${shortcode}/`;
        }
      }

      const postData = {
        url: url,
        shortcode: shortcode,
        thumbnail: thumbnailUrl,
        type: type,
        media_id: mediaId,
        unliked_at: new Date().toISOString(),
      };

      log(`Post data: ${type} | ${shortcode || 'no-shortcode'} | ${url || 'no-url'}`, 'info');
      state.logData.push(postData);
    } catch (e) {
      // Silently fail
      state.logData.push({
        url: null,
        shortcode: null,
        thumbnail: null,
        type: 'unknown',
        media_id: null,
        unliked_at: new Date().toISOString(),
      });
    }
  }

  /**
   * Step 3: Click Unlike/Remove button
   */
  async function clickUnlikeButton() {
    log('Mencari tombol Unlike...');

    const unlikeBtn = await waitForElement(() => {
      return findButtonByText('Unlike') || 
             findButtonByText('Remove') || 
             findButtonByText('Hapus') ||
             findButtonByText('Batal Suka');
    });

    if (!unlikeBtn) {
      log('Tombol Unlike tidak ditemukan', 'error');
      return false;
    }

    await wait(state.settings.delay * 1000);
    const clicked = simulateClick(unlikeBtn);

    if (!clicked) {
      log('Gagal klik tombol Unlike', 'error');
      return false;
    }

    log('Tombol "Batal suka" diklik', 'info');

    await wait(1000);

    // Cari tombol konfirmasi di popup/modal
    const confirmBtn = await waitForElement(() => {
      const texts = ['unlike', 'remove', 'hapus', 'batal suka', 'confirm', 'konfirmasi'];
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      
      for (let i = buttons.length - 1; i >= 0; i--) {
        const btn = buttons[i];
        const btnText = btn.textContent.trim().toLowerCase();
        
        if (texts.some(t => btnText === t || btnText.includes(t)) && btn !== unlikeBtn) {
          if (btn.tagName === 'BUTTON') return btn;
          return btn;
        }
      }
      return null;
    }, 3000, 2);

    if (confirmBtn && confirmBtn !== unlikeBtn) {
      await wait(500);
      simulateClick(confirmBtn);
      log('Konfirmasi popup berhasil diklik', 'success');
    }

    await wait(2000);
    return true;
  }

  /**
   * Cek apakah halaman menunjukkan state KOSONG
   * Mengecek berbagai indikator empty state dari DOM bloks Instagram
   */
  function isPageEmpty() {
    // Cek 1: aria-label "Tidak ada hasil" / "No results" (paling akurat)
    const allLabeled = document.querySelectorAll('[aria-label]');
    for (const el of allLabeled) {
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('tidak ada hasil') || label.includes('no results')) {
        log('Empty: terdeteksi aria-label "Tidak ada hasil"', 'info');
        return true;
      }
    }

    // Cek 2: Teks "Tidak ada hasil" di semua span (termasuk non-bloks)
    const allSpans = document.querySelectorAll('span');
    for (const span of allSpans) {
      const text = span.textContent.trim();
      if (text === 'Tidak ada hasil' || text === 'No results') {
        log('Empty: terdeteksi teks "Tidak ada hasil"', 'info');
        return true;
      }
    }

    // Cek 3: Icon error__outline (ikon besar 96px saat kosong)
    const allIcons = document.querySelectorAll('div[data-bloks-name="ig.components.Icon"]');
    for (const icon of allIcons) {
      const mask = icon.style.maskImage || icon.style.webkitMaskImage || '';
      if (mask.includes('error__outline')) {
        log('Empty: terdeteksi icon error__outline', 'info');
        return true;
      }
    }

    // Cek 4: "0 dipilih" text + tidak ada checkbox (mode Select tapi kosong)
    const checkboxes = document.querySelectorAll('div[data-testid="bulk_action_checkbox"]');
    if (checkboxes.length === 0) {
      for (const span of allSpans) {
        const text = span.textContent.trim();
        if (text === '0 dipilih' || text === '0 selected') {
          log('Empty: terdeteksi "0 dipilih" tanpa checkbox', 'info');
          return true;
        }
      }
    }

    // Cek 5: Teks "Kami tidak dapat menemukan aktivitas"
    for (const span of allSpans) {
      const text = span.textContent.trim().toLowerCase();
      if (text.includes('tidak dapat menemukan aktivitas') || text.includes('cannot find activity')) {
        log('Empty: terdeteksi teks aktivitas kosong', 'info');
        return true;
      }
    }

    return false;
  }

  /**
   * Hitung jumlah postingan yang terlihat di halaman
   * Prioritaskan pengecekan bulk_action_checkbox (paling akurat)
   */
  function countVisiblePosts() {
    // Cek empty state dulu
    if (isPageEmpty()) return 0;

    // Paling akurat: hitung bulk_action_checkbox (hanya ada di grid postingan)
    const checkboxes = document.querySelectorAll('div[data-testid="bulk_action_checkbox"]');
    if (checkboxes.length > 0) return checkboxes.length;

    // Hitung thumbnail postingan (harus punya src CDN Instagram/Facebook)
    const images = document.querySelectorAll('img[data-bloks-name="bk.components.Image"]');
    let count = 0;
    for (const img of images) {
      // Hanya hitung jika src mengandung CDN dan cache key (pasti thumbnail postingan)
      if (img.src && (img.src.includes('fbcdn.net') || img.src.includes('cdninstagram')) && img.src.includes('_nc_')) {
        count++;
      }
    }
    return count;
  }

  /**
   * Cek apakah tombol Select/Pilih masih ada
   */
  function isSelectButtonAvailable() {
    return !!(findButtonByText('Select') || findButtonByText('Pilih'));
  }

  /**
   * Main process: run one batch
   * Returns: true (lanjut), 'empty' (postingan habis), false (error/stopped)
   */
  async function runBatch() {
    const batchSize = state.settings.batchSize;

    log(`=== Batch ${state.stats.batches + 1} dimulai ===`, 'info');

    // === CEK AWAL ===
    await wait(1500);
    
    if (isPageEmpty()) {
      log('Halaman kosong (empty state terdeteksi). Proses selesai!', 'success');
      return 'empty';
    }

    const visiblePosts = countVisiblePosts();
    const selectAvailable = isSelectButtonAvailable();
    const existingCheckboxes = document.querySelectorAll('div[data-testid="bulk_action_checkbox"]').length;
    
    log(`Postingan: ${visiblePosts}, Tombol Select: ${selectAvailable ? 'ada' : 'tidak'}, Checkbox: ${existingCheckboxes}`, 'info');
    
    if (visiblePosts === 0 && !selectAvailable && existingCheckboxes === 0) {
      log('Tidak ada postingan dan tombol Select. Proses selesai!', 'success');
      return 'empty';
    }

    // === CEK APAKAH SUDAH DALAM SELECT MODE ===
    // Jika checkbox sudah ada tapi tombol Select tidak ada → halaman sudah dalam select mode
    // Ini terjadi jika batch sebelumnya terinterupsi (misal: pause/resume)
    let alreadyInSelectMode = false;
    if (!selectAvailable && existingCheckboxes > 0) {
      log('Sudah dalam mode Select (dari batch sebelumnya). Skip klik Select.', 'info');
      alreadyInSelectMode = true;
    }

    if (!alreadyInSelectMode) {
      // Step 1: Click Select
      const selectClicked = await clickSelectButton();
      if (!selectClicked) {
        if (state.isStopped) return false;
        log('Tombol Select tidak ditemukan. Mungkin postingan sudah habis.', 'warn');
        return 'empty';
      }
      if (state.isStopped) return false;

      await wait(state.settings.delay * 1000);
      if (state.isStopped) return false;
    }

    // === CEK SETELAH MASUK MODE SELECT ===
    // Ini yang paling penting: jika tidak ada bulk_action_checkbox → pasti kosong
    const checkboxCount = document.querySelectorAll('div[data-testid="bulk_action_checkbox"]').length;
    log(`Checkbox terdeteksi setelah Select: ${checkboxCount}`, 'info');
    
    if (checkboxCount === 0) {
      log('Tidak ada checkbox postingan setelah masuk mode Select. Halaman kosong!', 'success');
      // Klik Batalkan untuk keluar select mode
      const cancelBtn = findButtonByText('Batalkan') || findButtonByText('Cancel');
      if (cancelBtn) simulateClick(cancelBtn);
      return 'empty';
    }

    if (isPageEmpty()) {
      log('Setelah Select, halaman terdeteksi kosong.', 'success');
      return 'empty';
    }

    // Step 2: Select posts
    const selectedCount = await selectPosts(batchSize);
    if (state.isStopped) return false;
    if (selectedCount === 0) {
      log('Tidak ada postingan yang berhasil dipilih. Postingan mungkin sudah habis.', 'warn');
      return 'empty';
    }

    await wait(state.settings.delay * 1000);
    if (state.isStopped) return false;

    // Step 3: Click Unlike
    const unlikeClicked = await clickUnlikeButton();
    if (!unlikeClicked) {
      if (state.isStopped) return false;
      // Jika unlike gagal, cek apakah halaman sebenarnya kosong
      if (isPageEmpty()) {
        log('Unlike gagal dan halaman terdeteksi kosong.', 'success');
        return 'empty';
      }
      log('Unlike gagal.', 'error');
      return false;
    }
    if (state.isStopped) return false;

    // Update stats
    state.stats.unliked += selectedCount;
    state.stats.batches++;
    state.stats.selected = 0;
    state.selectedPosts.clear();
    updateStats();
    updateProgress(0, 0);

    // Send log data to popup
    if (state.logData.length > 0) {
      sendToPopup({ type: 'log_data', data: [...state.logData] });
      state.logData = [];
    }

    log(`=== Batch ${state.stats.batches} selesai: ${selectedCount} post di-unlike ===`, 'success');

    // === CEK SETELAH UNLIKE ===
    await wait(2500);
    
    if (isPageEmpty()) {
      log('Setelah unlike, halaman kosong. Semua sudah di-unlike!', 'success');
      return 'empty';
    }

    const remaining = countVisiblePosts();
    log(`Postingan tersisa: ${remaining}`, 'info');
    
    if (remaining === 0) {
      log('Mencoba scroll untuk cek postingan baru...', 'info');
      await scrollDown();
      await wait(2500);
      
      if (isPageEmpty()) {
        log('Setelah scroll, halaman kosong. Semua sudah di-unlike!', 'success');
        return 'empty';
      }
      
      const afterScroll = countVisiblePosts();
      if (afterScroll === 0) {
        log('Tidak ada postingan baru. Semua sudah di-unlike!', 'success');
        return 'empty';
      }
      log(`Ditemukan ${afterScroll} postingan baru setelah scroll.`, 'info');
    }

    return true;
  }

  /**
   * Main entry point
   */
  async function startProcess(settings) {
    if (state.isRunning) {
      log('Proses sudah berjalan', 'warn');
      return;
    }

    // Reset state
    state.isRunning = true;
    state.isPaused = false;
    state.isStopped = false;
    state.settings = { ...state.settings, ...settings };
    state.stats = { unliked: 0, batches: 0, selected: 0 };
    state.logData = [];
    state.selectedPosts.clear();

    setStatus('running');
    updateStats();
    log('Proses InstaSwipe dimulai!', 'info');

    // Run batches
    let batchResult = true;
    while (batchResult === true && !state.isStopped) {
      if (state.isPaused) {
        await wait(500);
        continue;
      }

      batchResult = await runBatch();

      if (batchResult === 'empty') {
        break;
      }

      if (batchResult === true && !state.isStopped) {
        log(`Menunggu ${state.settings.delay * 2} detik sebelum batch berikutnya...`);
        const waited = await wait(state.settings.delay * 2000);
        if (!waited) break;

        window.scrollTo({ top: 0, behavior: 'smooth' });
        await wait(1500);
      }
    }

    // Finish
    state.isRunning = false;
    if (state.isStopped) {
      setStatus('stopped');
      log(`Proses dihentikan. Total: ${state.stats.unliked} post di-unlike dalam ${state.stats.batches} batch.`, 'warn');
    } else if (batchResult === 'empty') {
      setStatus('finished');
      log(`✅ Semua postingan yang disukai sudah berhasil di-unlike! Total: ${state.stats.unliked} post dalam ${state.stats.batches} batch.`, 'success');
    } else {
      setStatus('finished');
      log(`Proses selesai! Total: ${state.stats.unliked} post di-unlike dalam ${state.stats.batches} batch.`, 'success');
    }

    // Kirim sisa log data terakhir
    if (state.logData.length > 0) {
      sendToPopup({ type: 'log_data', data: [...state.logData] });
      state.logData = [];
    }

    updateStats();
  }

  // ====== Message Handler ======
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
      case 'start':
        startProcess(message.settings);
        sendResponse({ status: 'started' });
        break;

      case 'pause':
        state.isPaused = !state.isPaused;
        if (state.isPaused) {
          setStatus('paused');
          log('Proses dijeda', 'warn');
        } else {
          setStatus('running');
          log('Proses dilanjutkan', 'info');
        }
        sendResponse({ status: state.isPaused ? 'paused' : 'running' });
        break;

      case 'stop':
        state.isStopped = true;
        state.isPaused = false;
        log('Menghentikan proses...', 'warn');
        sendResponse({ status: 'stopped' });
        break;

      case 'ping':
        sendResponse({ 
          status: 'alive', 
          isRunning: state.isRunning,
          isPaused: state.isPaused,
          isStopped: state.isStopped,
          stats: { ...state.stats },
        });
        break;

      case 'getState':
        // Mengembalikan state lengkap untuk sinkronisasi popup
        let currentStatus = 'idle';
        if (state.isRunning && !state.isPaused) currentStatus = 'running';
        else if (state.isRunning && state.isPaused) currentStatus = 'paused';
        else if (state.isStopped) currentStatus = 'stopped';
        
        sendResponse({
          status: currentStatus,
          isRunning: state.isRunning,
          isPaused: state.isPaused,
          isStopped: state.isStopped,
          stats: { ...state.stats },
        });
        break;
    }
    return true;
  });

  // ====== Init ======
  log('InstaSwipe content script loaded pada halaman Likes');

})();
