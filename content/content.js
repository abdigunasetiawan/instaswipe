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

  // ====== Selector Strategies ======
  // Instagram uses obfuscated class names. We use multiple strategies:
  // 1. aria-label / role attributes
  // 2. Text content matching
  // 3. Relative DOM traversal
  const SELECTORS = {
    // "Select" button to enter multi-select mode
    selectButton: [
      'button:has(> div:not(:empty))',  // generic fallback
    ],
    // Post checkboxes / clickable post items in select mode
    postCheckbox: [
      'div[role="button"][tabindex="0"]',
      'div[role="checkbox"]',
    ],
    // "Unlike" or "Remove" confirmation button  
    unlikeButton: [
      'button[type="button"]',
    ],
    // Post grid container
    postGrid: [
      'div[style*="flex-direction: column"]',
    ],
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
          // Use MutationObserver as final attempt
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
   * Find element by text content (case-insensitive)
   */
  function findByText(tagName, text, container = document) {
    const elements = container.querySelectorAll(tagName);
    const textLower = text.toLowerCase();
    for (const el of elements) {
      const elText = el.textContent.trim().toLowerCase();
      if (elText === textLower || elText.includes(textLower)) {
        return el;
      }
    }
    return null;
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
        return el; // fallback
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

      // Dispatch mouse events to simulate real click
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

  /**
   * Send log to popup
   */
  function log(text, level = 'info') {
    console.log(`[InstaSwipe] [${level.toUpperCase()}] ${text}`);
    sendToPopup({ type: 'log', text, level });
  }

  /**
   * Update stats in popup
   */
  function updateStats() {
    sendToPopup({ type: 'stats_update', data: { ...state.stats } });
  }

  /**
   * Update progress in popup
   */
  function updateProgress(current, total) {
    sendToPopup({ type: 'progress', current, total });
  }

  /**
   * Change status
   */
  function setStatus(status) {
    sendToPopup({ type: 'status_change', status });
  }

  // ====== Core Logic ======

  /**
   * Step 1: Find and click the "Select" button
   */
  async function clickSelectButton() {
    log('Mencari tombol Select...');

    const selectBtn = await waitForElement(() => {
      // Try "Select" text
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
   * Step 2: Find selectable posts and select them
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

      // Find selectable post items
      // In Instagram's multi-select mode, posts become clickable checkboxes
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

      // Select unselected posts
      for (const item of postItems) {
        if (selectedCount >= maxCount || state.isStopped) break;
        if (state.isPaused) {
          await wait(500);
          continue;
        }

        // Generate a unique key for this post
        const postKey = getPostKey(item);
        if (state.selectedPosts.has(postKey)) continue;

        // Check if already selected (has blue checkmark/selected state)
        if (isAlreadySelected(item)) {
          state.selectedPosts.add(postKey);
          continue;
        }

        // Click to select
        const clicked = simulateClick(item);
        if (clicked) {
          state.selectedPosts.add(postKey);
          selectedCount++;
          state.stats.selected = selectedCount;
          updateStats();
          updateProgress(selectedCount, maxCount);

          // Collect post URL if possible
          collectPostData(item);

          // Small delay between selections (human-like)
          await wait(150 + Math.random() * 200);
        }
      }

      // Check if we need more posts
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
   * Find selectable items in the post grid
   */
  function findSelectableItems() {
    const items = [];

    // Strategy A: Instagram bloks checkbox
    const bulkCheckboxes = document.querySelectorAll('div[data-testid="bulk_action_checkbox"]');
    if (bulkCheckboxes.length > 0) {
      for (const cb of bulkCheckboxes) {
        // use parent if possible because of pointer-events:none
        let target = cb.parentElement && cb.parentElement.tagName === 'DIV' ? cb.parentElement : cb;
        if (isInContentArea(target)) items.push(target);
      }
    }

    if (items.length > 0) return items;

    // Strategy 1: Find all images/posts in the likes grid that are clickable
    // In select mode, Instagram wraps posts in clickable containers
    const allButtons = document.querySelectorAll('div[role="button"]');
    for (const btn of allButtons) {
      // Filter: should contain an image and be within the content area
      const img = btn.querySelector('img');
      if (img && isInContentArea(btn)) {
        items.push(btn);
      }
    }

    if (items.length > 0) return items;

    // Strategy 2: Look for checkbox-like elements
    const checkboxes = document.querySelectorAll('div[role="checkbox"], input[type="checkbox"]');
    for (const cb of checkboxes) {
      if (isInContentArea(cb)) {
        items.push(cb);
      }
    }

    if (items.length > 0) return items;

    // Strategy 3: Find grid items with images
    const images = document.querySelectorAll('img[src*="instagram"]');
    for (const img of images) {
      const clickable = img.closest('div[role="button"], button, a');
      if (clickable && isInContentArea(clickable) && !items.includes(clickable)) {
        items.push(clickable);
      }
    }

    return items;
  }

  /**
   * Check if element is in the main content area (not header/nav)
   */
  function isInContentArea(el) {
    const rect = el.getBoundingClientRect();
    // Must be visible and in the main content area
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
   */
  function isAlreadySelected(element) {
    // bloks UI specific: check if outerHTML contains "circle__check" or DOES NOT contain "circle__outline"
    if (element.outerHTML && element.outerHTML.includes('circle__outline')) {
      return false;
    } else if (element.outerHTML && element.outerHTML.includes('circle__check')) {
      return true;
    }

    // Instagram shows a blue circle/checkmark when selected
    const svgCheck = element.querySelector('svg circle, svg path[fill*="blue"], svg[aria-label*="check"]');
    if (svgCheck) return true;

    // Check for aria-checked
    if (element.getAttribute('aria-checked') === 'true') return true;

    // Check for selected visual state (blue overlay / border)
    const computed = window.getComputedStyle(element);
    if (computed.borderColor && computed.borderColor.includes('rgb(0, 149, 246)')) return true;

    // Check for the blue checkmark circle overlay
    const blueElements = element.querySelectorAll('[style*="background-color: rgb(0, 149, 246)"], [style*="background: rgb(0, 149, 246)"]');
    if (blueElements.length > 0) return true;

    return false;
  }

  /**
   * Collect post data for logging
   */
  function collectPostData(element) {
    try {
      const link = element.querySelector('a[href*="/p/"], a[href*="/reel/"]');
      const img = element.querySelector('img');
      
      const postData = {
        url: link ? `https://www.instagram.com${link.getAttribute('href')}` : 'unknown',
        thumbnail: img ? img.src : null,
        unliked_at: new Date().toISOString(),
      };

      state.logData.push(postData);
    } catch (e) {
      // Silently fail for individual post data collection
    }
  }

  /**
   * Step 3: Click the Unlike/Remove button
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

    log('Tombol "Batal suka" di bagian bawah diklik', 'info');

    // Wait for confirmation dialog if any
    await wait(1000);

    // Instagram modal popup biasanya di-append di akhir `<body>` dan strukturnya berbeda (pakai <button>)
    // Kita cari semua button dari bawah ke atas (karena modal di akhir DOM) yang tesknya konfirmasi
    const confirmBtn = await waitForElement(() => {
      const texts = ['unlike', 'remove', 'hapus', 'batal suka', 'confirm', 'konfirmasi'];
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      
      // Iterasi dari elemen paling baru/bawah
      for (let i = buttons.length - 1; i >= 0; i--) {
        const btn = buttons[i];
        const btnText = btn.textContent.trim().toLowerCase();
        
        // Memastikan tombol modal konfirmasi (bukan tombol pertama tadi)
        if (texts.some(t => btnText === t || btnText.includes(t)) && btn !== unlikeBtn) {
          // Tombol konfirmasi popup biasanya berjenis Tipe Button asli 
          if (btn.tagName === 'BUTTON') {
             return btn;
          }
          // Kembalikan asalkan dia beda dengan awal (fallback jika div)
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

    await wait(2000); // Tunggu proses API selesai
    return true;
  }

  /**
   * Main process: run one batch
   */
  async function runBatch() {
    const batchSize = state.settings.batchSize;

    log(`=== Batch ${state.stats.batches + 1} dimulai ===`, 'info');

    // Step 1: Click Select
    const selectClicked = await clickSelectButton();
    if (!selectClicked || state.isStopped) return false;

    await wait(state.settings.delay * 1000);

    // Step 2: Select posts
    const selectedCount = await selectPosts(batchSize);
    if (selectedCount === 0 || state.isStopped) {
      if (selectedCount === 0) {
        log('Tidak ada postingan yang dipilih. Proses selesai.', 'warn');
      }
      return false;
    }

    await wait(state.settings.delay * 1000);

    // Step 3: Click Unlike
    const unlikeClicked = await clickUnlikeButton();
    if (!unlikeClicked || state.isStopped) return false;

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
    let continueProcessing = true;
    while (continueProcessing && !state.isStopped) {
      if (state.isPaused) {
        await wait(500);
        continue;
      }

      continueProcessing = await runBatch();

      if (continueProcessing && !state.isStopped) {
        log(`Menunggu ${state.settings.delay * 2} detik sebelum batch berikutnya...`);
        const waited = await wait(state.settings.delay * 2000);
        if (!waited) break; // stopped during wait

        // Scroll to top for next batch
        window.scrollTo({ top: 0, behavior: 'smooth' });
        await wait(1500);
      }
    }

    // Finish
    state.isRunning = false;
    if (state.isStopped) {
      setStatus('stopped');
      log(`Proses dihentikan. Total: ${state.stats.unliked} post di-unlike dalam ${state.stats.batches} batch.`, 'warn');
    } else {
      setStatus('finished');
      log(`Proses selesai! Total: ${state.stats.unliked} post di-unlike dalam ${state.stats.batches} batch.`, 'success');
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
        sendResponse({ status: 'stopped' });
        break;

      case 'ping':
        sendResponse({ status: 'alive', isRunning: state.isRunning });
        break;
    }
    return true;
  });

  // ====== Init ======
  log('InstaSwipe content script loaded pada halaman Likes');

})();
