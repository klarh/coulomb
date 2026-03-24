import { loadPyodideRuntime } from './pyodide-loader.js';
import { saveToIDB, restoreFromIDB, getChangelog, clearChangelog } from './fs-sync.js';
import {
  ensureWorkspace, isInitialized, initialize, getIdentityInfo,
  setDisplayName, createPost, listRecentPosts, getPendingFiles,
  readWorkspaceFile
} from './coulomb-bridge.js';
import { GitHubPagesBackend } from './storage/github.js';

// ── State ──
let pyodide = null;
let backend = new GitHubPagesBackend();
let currentView = 'compose';

// ── Service Worker Registration ──
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(console.error);
}

// ── Boot ──
document.addEventListener('DOMContentLoaded', boot);

async function boot() {
  const progress = document.getElementById('load-progress');
  const status = document.getElementById('load-status');

  try {
    pyodide = await loadPyodideRuntime((msg, pct) => {
      status.textContent = msg;
      progress.value = pct;
    });

    await ensureWorkspace();

    // Restore filesystem from IndexedDB
    status.textContent = 'Restoring data…';
    progress.value = 95;
    const restored = await restoreFromIDB(pyodide);
    if (restored > 0) {
      console.log(`Restored ${restored} files from IndexedDB`);
    }

    // Try restore GitHub connection
    backend.tryRestore();

    // Hide loading, show app
    document.getElementById('loading-screen').classList.add('hidden');
    showView('compose');

    // Wire up event handlers
    bindEvents();

    // Initial data load
    await refreshCurrentView();
  } catch (e) {
    status.textContent = `Error: ${e.message}`;
    console.error('Boot failed:', e);
  }
}

// ── Navigation ──
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

  document.getElementById(`view-${name}`).classList.remove('hidden');
  document.getElementById(`nav-${name}`).classList.add('active');
  currentView = name;
}

// ── Event Binding ──
function bindEvents() {
  // Navigation
  document.getElementById('nav-compose').addEventListener('click', async () => {
    showView('compose');
    await refreshCompose();
  });
  document.getElementById('nav-identity').addEventListener('click', async () => {
    showView('identity');
    await refreshIdentity();
  });
  document.getElementById('nav-sync').addEventListener('click', async () => {
    showView('sync');
    await refreshSync();
  });

  // Compose
  document.getElementById('btn-post').addEventListener('click', handlePost);
  document.getElementById('post-files').addEventListener('change', handleFileSelect);

  // Identity
  document.getElementById('btn-init').addEventListener('click', handleInit);
  document.getElementById('btn-set-name').addEventListener('click', handleSetName);

  // Sync
  document.getElementById('btn-github-connect').addEventListener('click', handleGitHubConnect);
  document.getElementById('btn-github-disconnect').addEventListener('click', handleGitHubDisconnect);
  document.getElementById('btn-publish').addEventListener('click', handlePublish);
}

// ── Compose ──
async function handlePost() {
  const textEl = document.getElementById('post-text');
  const text = textEl.value.trim();
  if (!text) return;

  const btn = document.getElementById('btn-post');
  const statusEl = document.getElementById('post-status');

  btn.disabled = true;
  btn.textContent = 'Posting…';

  try {
    const initialized = await isInitialized();
    if (!initialized) {
      showStatus(statusEl, 'No identity found. Go to Identity tab to initialize.', 'error');
      return;
    }

    await createPost(text);
    await saveToIDB(pyodide);

    textEl.value = '';
    showStatus(statusEl, 'Post created!', 'success');
    await refreshCompose();
  } catch (e) {
    showStatus(statusEl, `Error: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Post';
  }
}

function handleFileSelect(e) {
  const files = Array.from(e.target.files);
  const el = document.getElementById('attached-files');
  el.textContent = files.length > 0
    ? files.map(f => f.name).join(', ')
    : '';
}

async function refreshCompose() {
  try {
    const posts = await listRecentPosts(10);
    const listEl = document.getElementById('posts-list');
    if (posts.length === 0) {
      listEl.innerHTML = '<p style="color: var(--text-muted)">No posts yet</p>';
      return;
    }
    listEl.innerHTML = posts.map(p => `
      <div class="post-card">
        <div class="post-time">${p.time || 'Unknown time'}</div>
        <div class="post-body">${escapeHtml(p.text)}</div>
      </div>
    `).join('');
  } catch (e) {
    console.error('Failed to load posts:', e);
  }
}

// ── Identity ──
async function handleInit() {
  const btn = document.getElementById('btn-init');
  const statusEl = document.getElementById('identity-status');

  btn.disabled = true;
  btn.textContent = 'Initializing…';

  try {
    const keyId = await initialize();
    await saveToIDB(pyodide);
    showStatus(statusEl, `Identity created! Key: ${keyId.slice(0, 16)}…`, 'success');
    await refreshIdentity();
  } catch (e) {
    showStatus(statusEl, `Error: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Initialize Identity';
  }
}

async function handleSetName() {
  const nameEl = document.getElementById('display-name');
  const name = nameEl.value.trim();
  if (!name) return;

  const statusEl = document.getElementById('identity-status');

  try {
    await setDisplayName(name);
    await saveToIDB(pyodide);
    showStatus(statusEl, 'Display name updated!', 'success');
    await refreshIdentity();
  } catch (e) {
    showStatus(statusEl, `Error: ${e.message}`, 'error');
  }
}

async function refreshIdentity() {
  const infoSection = document.getElementById('identity-info');
  const initSection = document.getElementById('identity-init');
  const statusEl = document.getElementById('identity-status');

  try {
    const info = await getIdentityInfo();

    if (info) {
      infoSection.classList.remove('hidden');
      initSection.classList.add('hidden');
      document.getElementById('identity-details').innerHTML = `
        <div><strong>Key ID:</strong> ${info.id}</div>
        <div><strong>Display Name:</strong> ${info.display_name || '<not set>'}</div>
        <div><strong>Signing Keys:</strong> ${info.signing_keys.length}</div>
      `;
      document.getElementById('display-name').value = info.display_name || '';
    } else {
      infoSection.classList.add('hidden');
      initSection.classList.remove('hidden');
    }
  } catch (e) {
    console.error('Failed to load identity:', e);
    // On error, show the init section so the user can at least try to initialize
    infoSection.classList.add('hidden');
    initSection.classList.remove('hidden');
    showStatus(statusEl, `Error loading identity: ${e.message}`, 'error');
  }
}

// ── Sync ──
async function handleGitHubConnect() {
  const token = document.getElementById('github-token').value.trim();
  const repo = document.getElementById('github-repo').value.trim();
  const branch = document.getElementById('github-branch').value.trim() || 'main';
  const pathPrefix = document.getElementById('github-path-prefix').value.trim();

  const statusEl = document.getElementById('github-auth-status');

  const result = await backend.connect({ token, repo, branch, pathPrefix });
  if (result.success) {
    backend.saveToken(token);
    showStatus(statusEl, 'Connected!', 'success');
    await refreshSync();
  } else {
    showStatus(statusEl, `Connection failed: ${result.error}`, 'error');
  }
}

async function handleGitHubDisconnect() {
  await backend.disconnect();
  await refreshSync();
}

async function handlePublish() {
  const btn = document.getElementById('btn-publish');
  const statusEl = document.getElementById('sync-status');

  btn.disabled = true;
  btn.textContent = 'Publishing…';

  try {
    const pendingPaths = await getPendingFiles();
    if (pendingPaths.length === 0) {
      showStatus(statusEl, 'Nothing to publish', 'success');
      return;
    }

    // Read file contents from Pyodide FS
    const files = [];
    for (const relPath of pendingPaths) {
      const content = readWorkspaceFile(relPath);
      if (content) {
        files.push({ path: relPath, content });
      }
    }

    const result = await backend.publish(files, `coulomb: publish ${files.length} file(s)`);

    if (result.success) {
      // Clear changelog after successful publish
      const pyodide = (await import('./pyodide-loader.js')).getPyodide();
      await clearChangelog(pyodide);
      await saveToIDB(pyodide);
      showStatus(statusEl,
        `Published ${result.filesPublished} file(s)! ${result.url ? `View at ${result.url}` : ''}`,
        'success'
      );
    } else {
      showStatus(statusEl, `Publish failed: ${result.error}`, 'error');
    }

    await refreshSync();
  } catch (e) {
    showStatus(statusEl, `Error: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Publish Changes';
  }
}

async function refreshSync() {
  // GitHub connection status
  const notConnected = document.getElementById('github-not-connected');
  const connected = document.getElementById('github-connected');

  if (backend.connected) {
    notConnected.classList.add('hidden');
    connected.classList.remove('hidden');
    document.getElementById('github-repo-display').textContent =
      `Connected to ${backend.repoDisplay}`;
  } else {
    notConnected.classList.remove('hidden');
    connected.classList.add('hidden');
  }

  // Pending changes
  try {
    const pending = await getPendingFiles();
    const pendingEl = document.getElementById('pending-changes');
    const publishBtn = document.getElementById('btn-publish');

    if (pending.length > 0) {
      pendingEl.textContent = `${pending.length} file(s) ready to publish`;
      publishBtn.disabled = !backend.connected;
    } else {
      pendingEl.textContent = 'No pending changes';
      publishBtn.disabled = true;
    }
  } catch (e) {
    console.error('Failed to check pending files:', e);
  }
}

async function refreshCurrentView() {
  switch (currentView) {
    case 'compose': return refreshCompose();
    case 'identity': return refreshIdentity();
    case 'sync': return refreshSync();
  }
}

// ── Helpers ──
function showStatus(el, msg, type) {
  el.textContent = msg;
  el.className = `status-msg ${type}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 5000);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
