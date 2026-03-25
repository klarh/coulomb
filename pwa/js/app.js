import { loadPyodideRuntime, getPyodide } from './pyodide-loader.js';
import { saveToIDB, restoreFromIDB, getChangelog, clearChangelog, exportWorkspace, importWorkspace } from './fs-sync.js';
import {
  ensureWorkspace, isInitialized, initialize, getIdentityInfo,
  setDisplayName, setAvatarUrl, setIdentityConfig,
  addLocation, removeLocation,
  createPost, listRecentPosts, getPendingFiles,
  readWorkspaceFile, renderSite, getRenderedPage, getRenderedFile, listRenderedPages,
  getSiteConfig, setSiteConfig,
  getActiveAccount, getWorkspacePath, listAccounts, createAccount, switchAccount, deleteAccount
} from './coulomb-bridge.js';
import { GitHubPagesBackend } from './storage/github.js';

// ── State ──
let pyodide = null;
let backend = new GitHubPagesBackend();
let currentView = 'compose';
let replyTarget = null; // { path, text, author_id }

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

    // Migrate from old /workspace path if it exists
    status.textContent = 'Restoring data…';
    progress.value = 90;
    const oldRestored = await restoreFromIDB(pyodide, '/workspace');
    if (oldRestored > 0) {
      // Migrate old data to default account
      await pyodide.runPythonAsync(`
import os, shutil
old = '/workspace'
new = '${getWorkspacePath()}'
for item in os.listdir(old):
    src = os.path.join(old, item)
    dst = os.path.join(new, item)
    if not os.path.exists(dst):
        if os.path.isdir(src):
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
`);
      console.log(`Migrated ${oldRestored} files from legacy /workspace`);
    }

    progress.value = 95;
    const restored = await restoreFromIDB(pyodide, getWorkspacePath());
    if (restored > 0) {
      console.log(`Restored ${restored} files from IndexedDB`);
    }

    backend.tryRestore();

    document.getElementById('loading-screen').classList.add('hidden');
    showView('compose');
    bindEvents();

    // Check for key import via URL fragment
    await checkKeyImport();

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
    showView('compose'); await refreshCompose();
  });
  document.getElementById('nav-preview').addEventListener('click', async () => {
    showView('preview'); await refreshPreview();
  });
  document.getElementById('nav-identity').addEventListener('click', async () => {
    showView('identity'); await refreshIdentity();
  });
  document.getElementById('nav-sync').addEventListener('click', async () => {
    showView('sync'); await refreshSync();
  });

  // Compose
  document.getElementById('btn-post').addEventListener('click', handlePost);
  document.getElementById('post-files').addEventListener('change', handleFileSelect);
  document.getElementById('btn-cancel-reply').addEventListener('click', cancelReply);

  // Preview
  document.getElementById('btn-render').addEventListener('click', handleRender);
  document.getElementById('btn-preview-back').addEventListener('click', () => {
    previewPath = 'pages/latest.html';
    refreshPreview();
  });

  // Identity
  document.getElementById('btn-init').addEventListener('click', handleInit);
  document.getElementById('btn-save-profile').addEventListener('click', handleSaveProfile);
  document.getElementById('btn-add-config').addEventListener('click', handleAddConfig);
  document.getElementById('btn-add-location').addEventListener('click', handleAddLocation);
  document.getElementById('btn-save-site-config').addEventListener('click', handleSaveSiteConfig);

  // Sync
  document.getElementById('btn-github-connect').addEventListener('click', handleGitHubConnect);
  document.getElementById('btn-github-disconnect').addEventListener('click', handleGitHubDisconnect);
  document.getElementById('btn-publish').addEventListener('click', handlePublish);

  // Accounts
  document.getElementById('btn-create-account').addEventListener('click', handleCreateAccount);

  // Data portability
  document.getElementById('btn-export').addEventListener('click', handleExport);
  document.getElementById('btn-import').addEventListener('click', () => document.getElementById('import-file').click());
  document.getElementById('import-file').addEventListener('change', handleImport);

  // Device provisioning
  document.getElementById('btn-request-key').addEventListener('click', handleRequestKey);
  document.getElementById('btn-provision-send').addEventListener('click', handleProvisionSend);
  document.getElementById('btn-provision-receive').addEventListener('click', handleProvisionReceive);
}

// ── Compose ──
async function handlePost() {
  const textEl = document.getElementById('post-text');
  const text = textEl.value.trim();
  if (!text) return;

  const btn = document.getElementById('btn-post');
  const statusEl = document.getElementById('post-status');
  const fileInput = document.getElementById('post-files');

  btn.disabled = true;
  btn.textContent = 'Posting…';

  try {
    const initialized = await isInitialized();
    if (!initialized) {
      showStatus(statusEl, 'No identity found. Go to Identity tab to initialize.', 'error');
      return;
    }

    const files = Array.from(fileInput.files || []);
    const replyPath = replyTarget ? replyTarget.path : null;

    await createPost(text, files, replyPath);
    await saveToIDB(pyodide, getWorkspacePath());

    textEl.value = '';
    fileInput.value = '';
    document.getElementById('attached-files').textContent = '';
    cancelReply();
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
    ? files.map(f => `${f.name} (${formatSize(f.size)})`).join(', ')
    : '';
}

function setReplyTarget(post) {
  replyTarget = post;
  const ctx = document.getElementById('reply-context');
  const label = document.getElementById('reply-label');
  label.textContent = `Replying to: "${truncate(post.text, 60)}"`;
  ctx.classList.remove('hidden');
  document.getElementById('post-text').focus();
}

function cancelReply() {
  replyTarget = null;
  document.getElementById('reply-context').classList.add('hidden');
}

async function refreshCompose() {
  try {
    const posts = await listRecentPosts(10);
    const listEl = document.getElementById('posts-list');
    if (posts.length === 0) {
      listEl.innerHTML = '<p style="color: var(--text-muted)">No posts yet</p>';
      return;
    }
    listEl.innerHTML = posts.map(p => {
      const replyInfo = p.reply_to
        ? `<div class="post-reply-badge">↩ Reply to ${p.reply_to.author.slice(0, 8)}…</div>`
        : '';
      const fileInfo = p.file_count > 0
        ? `<div class="post-files-badge">📎 ${p.file_count} file(s): ${p.files.join(', ')}</div>`
        : '';
      return `
        <div class="post-card">
          <div class="post-time">${p.time || 'Unknown time'}</div>
          ${replyInfo}
          <div class="post-body">${escapeHtml(p.text)}</div>
          ${fileInfo}
          <div class="post-actions">
            <button class="reply-btn" data-path="${escapeHtml(p.path)}" data-text="${escapeAttr(p.text)}" data-author="${escapeHtml(p.author_id)}">↩ Reply</button>
          </div>
        </div>
      `;
    }).join('');

    // Wire reply buttons
    listEl.querySelectorAll('.reply-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        setReplyTarget({
          path: btn.dataset.path,
          text: btn.dataset.text,
          author_id: btn.dataset.author,
        });
      });
    });
  } catch (e) {
    console.error('Failed to load posts:', e);
  }
}

// ── Preview ──
async function handleRender() {
  const btn = document.getElementById('btn-render');
  const statusEl = document.getElementById('render-status');

  btn.disabled = true;
  btn.textContent = 'Rendering…';

  try {
    const initialized = await isInitialized();
    if (!initialized) {
      showStatus(statusEl, 'No identity found. Initialize first.', 'error');
      return;
    }

    await renderSite();
    await refreshPreview();
    showStatus(statusEl, 'Rendered!', 'success');
  } catch (e) {
    showStatus(statusEl, `Error: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Render';
  }
}

let previewPath = 'pages/latest.html';

function inlinePreviewAssets(html, currentDir) {
  let css = '';
  const cssBytes = readWorkspaceFile('static/global/style.css');
  if (cssBytes) css = new TextDecoder().decode(cssBytes);
  if (css) {
    html = html.replace(/<link[^>]*style\.css[^>]*>/, `<style>${css}</style>`);
  }
  const navScript = `<script>
document.addEventListener('click', function(e) {
  var a = e.target.closest('a');
  if (!a) return;
  e.preventDefault();
  var href = a.getAttribute('href');
  if (href) window.parent.postMessage({type:'preview-nav', href:href, from:'${currentDir}'}, '*');
});
<\/script>`;
  html = html.replace('</body>', navScript + '</body>');
  return html;
}

function loadPreviewPage(relPath) {
  const frame = document.getElementById('preview-frame');
  const html = getRenderedFile(relPath);
  if (html) {
    const dir = relPath.substring(0, relPath.lastIndexOf('/') + 1);
    frame.srcdoc = inlinePreviewAssets(html, dir);
    previewPath = relPath;
  } else {
    frame.srcdoc = `<body style="background:#1a1a2e;color:#aaa;font-family:sans-serif;padding:2rem;text-align:center"><p>Page not found: ${relPath}</p></body>`;
  }
}

window.addEventListener('message', (e) => {
  if (e.data?.type !== 'preview-nav') return;
  const href = e.data.href;
  const fromDir = e.data.from;
  const combined = fromDir + href;
  const parts = combined.split('/');
  const resolved = [];
  for (const p of parts) {
    if (p === '..') { if (resolved.length) resolved.pop(); }
    else if (p && p !== '.') resolved.push(p);
  }
  loadPreviewPage(resolved.join('/'));
});

async function refreshPreview() {
  const html = getRenderedFile(previewPath);
  if (html) {
    loadPreviewPage(previewPath);
  } else {
    const frame = document.getElementById('preview-frame');
    frame.srcdoc = '<body style="background:#1a1a2e;color:#aaa;font-family:sans-serif;padding:2rem;text-align:center"><p>No rendered pages yet. Click <b>Render</b> to generate.</p></body>';
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
    await saveToIDB(pyodide, getWorkspacePath());
    showStatus(statusEl, `Identity created! Key: ${keyId.slice(0, 16)}…`, 'success');
    await refreshIdentity();
  } catch (e) {
    showStatus(statusEl, `Error: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Initialize Identity';
  }
}

async function handleSaveProfile() {
  const name = document.getElementById('display-name').value.trim();
  const avatar = document.getElementById('avatar-url').value.trim();
  const statusEl = document.getElementById('identity-status');

  const pairs = [];
  if (name) pairs.push(['display_name', name]);
  if (avatar) pairs.push(['avatar_url', avatar]);
  if (pairs.length === 0) return;

  try {
    await setIdentityConfig(pairs);
    await saveToIDB(pyodide, getWorkspacePath());
    showStatus(statusEl, 'Profile updated!', 'success');
    await refreshIdentity();
  } catch (e) {
    showStatus(statusEl, `Error: ${e.message}`, 'error');
  }
}

async function handleAddConfig() {
  const keyEl = document.getElementById('config-new-key');
  const valEl = document.getElementById('config-new-value');
  const key = keyEl.value.trim();
  const value = valEl.value.trim();
  if (!key || !value) return;

  const statusEl = document.getElementById('identity-status');

  try {
    await setIdentityConfig([[key, value]]);
    await saveToIDB(pyodide, getWorkspacePath());
    keyEl.value = '';
    valEl.value = '';
    showStatus(statusEl, `Config "${key}" set!`, 'success');
    await refreshIdentity();
  } catch (e) {
    showStatus(statusEl, `Error: ${e.message}`, 'error');
  }
}

async function handleRemoveConfig(key) {
  const statusEl = document.getElementById('identity-status');
  try {
    await setIdentityConfig([[key, '']]);
    await saveToIDB(pyodide, getWorkspacePath());
    showStatus(statusEl, `Config "${key}" removed!`, 'success');
    await refreshIdentity();
  } catch (e) {
    showStatus(statusEl, `Error: ${e.message}`, 'error');
  }
}

async function handleAddLocation() {
  const urlEl = document.getElementById('location-new-url');
  const url = urlEl.value.trim();
  if (!url) return;

  const statusEl = document.getElementById('identity-status');

  try {
    await addLocation(url);
    await saveToIDB(pyodide, getWorkspacePath());
    urlEl.value = '';
    showStatus(statusEl, 'Location added!', 'success');
    await refreshIdentity();
  } catch (e) {
    showStatus(statusEl, `Error: ${e.message}`, 'error');
  }
}

async function handleRemoveLocation(url) {
  const statusEl = document.getElementById('identity-status');
  try {
    await removeLocation(url);
    await saveToIDB(pyodide, getWorkspacePath());
    showStatus(statusEl, 'Location removed!', 'success');
    await refreshIdentity();
  } catch (e) {
    showStatus(statusEl, `Error: ${e.message}`, 'error');
  }
}

async function handleSaveSiteConfig() {
  const title = document.getElementById('site-title').value.trim();
  const statusEl = document.getElementById('identity-status');

  try {
    if (title) await setSiteConfig('user_post.page_title', title);
    await saveToIDB(pyodide, getWorkspacePath());
    showStatus(statusEl, 'Site settings saved!', 'success');
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

      // Identity summary
      const avatarHtml = info.avatar_url
        ? `<img src="${escapeHtml(info.avatar_url)}" style="width:48px;height:48px;border-radius:50%;object-fit:cover">`
        : '';
      document.getElementById('identity-details').innerHTML = `
        ${avatarHtml}
        <div><strong>Key ID:</strong> <code>${info.id}</code></div>
        <div><strong>Display Name:</strong> ${info.display_name || '<em>not set</em>'}</div>
      `;

      // Profile fields
      document.getElementById('display-name').value = info.display_name || '';
      document.getElementById('avatar-url').value = info.avatar_url || '';

      // Custom config
      const configEl = document.getElementById('config-fields');
      const reserved = new Set(['display_name', 'user.display_name', 'avatar_url']);
      const customKeys = Object.entries(info.config || {}).filter(([k]) => !reserved.has(k));
      if (customKeys.length > 0) {
        configEl.innerHTML = customKeys.map(([k, v]) =>
          `<div class="config-row">
            <span class="config-key">${escapeHtml(k)}</span>
            <span class="config-value">${escapeHtml(v)}</span>
            <button class="remove-btn" data-config-key="${escapeAttr(k)}">✕</button>
          </div>`
        ).join('');
        configEl.querySelectorAll('.remove-btn[data-config-key]').forEach(btn => {
          btn.addEventListener('click', () => handleRemoveConfig(btn.dataset.configKey));
        });
      } else {
        configEl.innerHTML = '<p style="color:var(--text-muted)">No custom config set</p>';
      }

      // Locations
      const locsEl = document.getElementById('locations-list');
      if (info.locations.length > 0) {
        locsEl.innerHTML = info.locations.map(loc =>
          `<div class="location-row">
            <a href="${escapeHtml(loc)}" target="_blank" rel="noopener">${escapeHtml(loc)}</a>
            <button class="remove-btn" data-location="${escapeAttr(loc)}">✕</button>
          </div>`
        ).join('');
        locsEl.querySelectorAll('.remove-btn[data-location]').forEach(btn => {
          btn.addEventListener('click', () => handleRemoveLocation(btn.dataset.location));
        });
      } else {
        locsEl.innerHTML = '<p style="color:var(--text-muted)">No locations set</p>';
      }

      // Keys
      const keysEl = document.getElementById('keys-list');
      const signingKeys = info.signing_keys || [];
      const encKeys = info.encryption_keys || [];
      let keysHtml = '';
      if (signingKeys.length > 0) {
        keysHtml += '<div><strong>Signing:</strong></div>';
        keysHtml += signingKeys.map(k => `<div class="key-row"><code>${k}</code></div>`).join('');
      }
      if (encKeys.length > 0) {
        keysHtml += '<div><strong>Encryption:</strong></div>';
        keysHtml += encKeys.map(k => `<div class="key-row"><code>${k}</code></div>`).join('');
      }
      keysEl.innerHTML = keysHtml || '<p style="color:var(--text-muted)">Default signing key only</p>';

      // Site config
      try {
        const siteConfig = await getSiteConfig();
        document.getElementById('site-title').value = siteConfig['user_post.page_title'] || '';
      } catch {
        // ignore
      }
    } else {
      infoSection.classList.add('hidden');
      initSection.classList.remove('hidden');
    }
  } catch (e) {
    console.error('Failed to load identity:', e);
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
      await saveToIDB(pyodide, getWorkspacePath());
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

    // Check if Pages URL is in identity locations
    const hintEl = document.getElementById('pages-location-hint');
    try {
      const info = await getIdentityInfo();
      const pagesBase = backend.pagesUrl;
      if (info && info.locations && !info.locations.some(loc => loc.startsWith(pagesBase))) {
        const pagesUrl = pagesBase + 'public';
        hintEl.innerHTML =
          `<p class="hint-banner">⚠️ <strong>${escapeHtml(pagesUrl)}</strong> is not in your published locations.
           <button id="btn-add-pages-loc" class="link-btn">Add it</button></p>`;
        hintEl.classList.remove('hidden');
        document.getElementById('btn-add-pages-loc').addEventListener('click', async (e) => {
          e.target.disabled = true;
          e.target.textContent = 'Adding…';
          await addLocation(pagesUrl);
          await saveToIDB(getPyodide(), getWorkspacePath());
          hintEl.innerHTML = '<p class="hint-banner">✓ Location added!</p>';
          setTimeout(() => hintEl.classList.add('hidden'), 3000);
        });
      } else {
        hintEl.classList.add('hidden');
      }
    } catch { hintEl.classList.add('hidden'); }
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

  // Accounts
  try {
    const accounts = await listAccounts();
    const active = getActiveAccount();
    document.getElementById('account-current').innerHTML =
      `<p>Active: <strong>${escapeHtml(active)}</strong></p>`;

    const listEl = document.getElementById('accounts-list');
    if (accounts.length > 1) {
      listEl.innerHTML = accounts.map(name => {
        const isActive = name === active;
        return `<div class="account-row ${isActive ? 'active' : ''}">
          <span>${escapeHtml(name)}</span>
          ${isActive ? '<em>(active)</em>' : `
            <button class="secondary-btn switch-account-btn" data-account="${escapeAttr(name)}">Switch</button>
            <button class="remove-btn delete-account-btn" data-account="${escapeAttr(name)}">✕</button>
          `}
        </div>`;
      }).join('');
      listEl.querySelectorAll('.switch-account-btn').forEach(btn => {
        btn.addEventListener('click', () => handleSwitchAccount(btn.dataset.account));
      });
      listEl.querySelectorAll('.delete-account-btn').forEach(btn => {
        btn.addEventListener('click', () => handleDeleteAccount(btn.dataset.account));
      });
    } else {
      listEl.innerHTML = '';
    }
  } catch (e) {
    console.error('Failed to list accounts:', e);
  }
}

async function refreshCurrentView() {
  switch (currentView) {
    case 'compose': return refreshCompose();
    case 'preview': return refreshPreview();
    case 'identity': return refreshIdentity();
    case 'sync': return refreshSync();
  }
}

// ── Accounts ──

async function handleCreateAccount() {
  const nameEl = document.getElementById('account-new-name');
  const name = nameEl.value.trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (!name) return;

  const statusEl = document.getElementById('data-status');
  try {
    await createAccount(name);
    await switchAccount(name);
    await restoreFromIDB(getPyodide(), getWorkspacePath());
    nameEl.value = '';
    showStatus(statusEl, `Switched to account "${name}"`, 'success');
    await refreshSync();
    await refreshCurrentView();
  } catch (e) {
    showStatus(statusEl, `Error: ${e.message}`, 'error');
  }
}

async function handleSwitchAccount(name) {
  const statusEl = document.getElementById('data-status');
  try {
    await switchAccount(name);
    await restoreFromIDB(getPyodide(), getWorkspacePath());
    showStatus(statusEl, `Switched to "${name}"`, 'success');
    await refreshSync();
    await refreshCurrentView();
  } catch (e) {
    showStatus(statusEl, `Error: ${e.message}`, 'error');
  }
}

async function handleDeleteAccount(name) {
  if (!confirm(`Delete account "${name}"? This cannot be undone.`)) return;
  const statusEl = document.getElementById('data-status');
  try {
    await deleteAccount(name);
    showStatus(statusEl, `Account "${name}" deleted`, 'success');
    await refreshSync();
  } catch (e) {
    showStatus(statusEl, `Error: ${e.message}`, 'error');
  }
}

// ── Data Portability ──

async function handleExport() {
  const statusEl = document.getElementById('data-status');
  const includeKeys = document.getElementById('export-include-keys').checked;

  try {
    showStatus(statusEl, 'Exporting…', 'success');
    const blob = await exportWorkspace(getPyodide(), getWorkspacePath(), { includePrivate: includeKeys });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const date = new Date().toISOString().slice(0, 10);
    a.download = `coulomb-${getActiveAccount()}-${date}.tar.gz`;
    a.click();
    URL.revokeObjectURL(url);
    showStatus(statusEl, 'Export downloaded!', 'success');
  } catch (e) {
    showStatus(statusEl, `Export failed: ${e.message}`, 'error');
  }
}

async function handleImport(e) {
  const file = e.target.files[0];
  if (!file) return;

  const statusEl = document.getElementById('data-status');
  if (!confirm('Import will replace the current workspace. Continue?')) {
    e.target.value = '';
    return;
  }

  try {
    showStatus(statusEl, 'Importing…', 'success');
    await importWorkspace(getPyodide(), file, getWorkspacePath());
    await saveToIDB(getPyodide(), getWorkspacePath(), { force: true });
    showStatus(statusEl, 'Import complete!', 'success');
    await refreshCurrentView();
  } catch (err) {
    showStatus(statusEl, `Import failed: ${err.message}`, 'error');
  }
  e.target.value = '';
}

// ── Device Provisioning ──

// ── Device Provisioning (ephemeral key exchange) ──

// Step 1: New device generates ephemeral X25519 keypair, shows public key as QR/URL
async function handleRequestKey() {
  const statusEl = document.getElementById('request-status');
  const resultEl = document.getElementById('request-key-result');

  try {
    showStatus(statusEl, 'Generating request…', 'success');

    const result = await runPy(`
import json, base64
import nacl.public

# Generate ephemeral Curve25519 keypair
ephemeral = nacl.public.PrivateKey.generate()
ephemeral_pub = bytes(ephemeral.public_key)
ephemeral_priv = bytes(ephemeral)

_bridge_out = json.dumps({
    'pub': base64.urlsafe_b64encode(ephemeral_pub).decode(),
    'priv': base64.urlsafe_b64encode(ephemeral_priv).decode(),
})
`);

    const data = JSON.parse(result);

    // Store ephemeral private key in sessionStorage for step 3
    sessionStorage.setItem('coulomb-provision-ephemeral', data.priv);

    const requestUrl = `${location.origin}${location.pathname}#provision/request/${data.pub}`;

    resultEl.classList.remove('hidden');
    try {
      const qrSvg = await generateQRCodeSVG(requestUrl);
      document.getElementById('request-qr').innerHTML =
        `<p class="help-text">Show this to the source device:</p>${qrSvg}`;
    } catch (e) {
      document.getElementById('request-qr').innerHTML =
        `<p class="help-text">QR generation failed. Use the link below.</p>`;
    }

    document.getElementById('request-url-display').innerHTML =
      `<p class="help-text">Or copy this link:</p>
       <code class="provision-url" id="request-url">${escapeHtml(requestUrl)}</code>`;
    document.getElementById('request-url').addEventListener('click', () => {
      navigator.clipboard.writeText(requestUrl);
      showStatus(statusEl, 'Link copied!', 'success');
    });

    showStatus(statusEl, 'Waiting for source device…', 'success');
  } catch (e) {
    showStatus(statusEl, `Error: ${e.message}`, 'error');
  }
}

// Step 2: Source device encrypts signing key to the new device's ephemeral public key
async function handleProvisionSend() {
  const statusEl = document.getElementById('provision-status');
  const resultEl = document.getElementById('provision-result');
  const input = document.getElementById('provision-request-input').value.trim();

  // Extract ephemeral public key from URL or raw base64
  let ephemeralPub;
  const match = input.match(/#provision\/request\/([A-Za-z0-9_-]+={0,2})/);
  if (match) {
    ephemeralPub = match[1];
  } else if (input.match(/^[A-Za-z0-9_-]+={0,2}$/)) {
    ephemeralPub = input;
  } else {
    showStatus(statusEl, 'Paste the request link from the new device', 'error');
    return;
  }

  try {
    showStatus(statusEl, 'Generating and encrypting key…', 'success');

    const result = await runPy(`
import os, glob, json, base64
import nacl.signing, nacl.public, cbor2

os.chdir('${getWorkspacePath()}')

# Decode the new device's ephemeral public key
target_pub_bytes = base64.urlsafe_b64decode(${JSON.stringify(ephemeralPub)})
target_pub = nacl.public.PublicKey(target_pub_bytes)

# Generate new signing key
key = nacl.signing.SigningKey.generate()
key_id = bytes(key.verify_key).hex()
seed = bytes(key)  # 32 bytes

# Save signing key locally
private_key = dict(id=key_id, signing=seed, api='pynacl')
key_path = '${getWorkspacePath()}/private/signing.' + key_id + '.cbor'
with open(key_path, 'wb') as f:
    cbor2.dump(private_key, f, canonical=True)

# Add to identity
identity_files = glob.glob('${getWorkspacePath()}/public/identity/*/latest.cbor')
if not identity_files:
    raise RuntimeError("No identity found. Initialize first.")

with open(identity_files[0], 'rb') as f:
    entry = cbor2.load(f)
author_id = entry['content']['author']['id']

all_sig_files = glob.glob('${getWorkspacePath()}/private/private_identity.*.cbor') + glob.glob('${getWorkspacePath()}/private/signing.*.cbor')

from coulomb.identity import add_key
with open('${getWorkspacePath()}/changelog', 'a') as _cl:
    add_key(
        identity='${getWorkspacePath()}/public/identity/' + author_id,
        change_log=_cl,
        signatures=all_sig_files,
        key_files=[key_path]
    )

# Encrypt seed using NaCl SealedBox (anonymous encryption to target's public key)
sealed_box = nacl.public.SealedBox(target_pub)
encrypted = sealed_box.encrypt(seed)

payload = base64.urlsafe_b64encode(encrypted).decode()

_bridge_out = json.dumps({
    'key_id': key_id,
    'payload': payload,
})
`);

    const data = JSON.parse(result);
    await saveToIDB(getPyodide(), getWorkspacePath());

    const responseUrl = `${location.origin}${location.pathname}#provision/respond/${data.payload}`;

    resultEl.classList.remove('hidden');

    document.getElementById('provision-url-display').innerHTML =
      `<p class="help-text">Or copy this link:</p>
       <code class="provision-url" id="provision-url">${escapeHtml(responseUrl)}</code>`;
    document.getElementById('provision-url').addEventListener('click', () => {
      navigator.clipboard.writeText(responseUrl);
      showStatus(statusEl, 'Link copied!', 'success');
    });

    showStatus(statusEl, `Key ${data.key_id.slice(0, 12)}… created. Transfer to new device.`, 'success');
  } catch (e) {
    showStatus(statusEl, `Error: ${e.message}`, 'error');
  }
}

// Step 3: New device decrypts the signing key using its ephemeral private key
async function handleProvisionReceive(payloadOverride) {
  const statusEl = document.getElementById('receive-status');
  let payload;

  if (typeof payloadOverride === 'string') {
    payload = payloadOverride;
  } else {
    const input = document.getElementById('provision-response-input').value.trim();
    const match = input.match(/#provision\/respond\/([A-Za-z0-9_-]+={0,2})/);
    if (match) {
      payload = match[1];
    } else if (input.match(/^[A-Za-z0-9_-]+={0,2}$/)) {
      payload = input;
    } else {
      showStatus(statusEl, 'Paste the response link from the source device', 'error');
      return;
    }
  }

  const ephemeralPriv = sessionStorage.getItem('coulomb-provision-ephemeral');
  if (!ephemeralPriv) {
    showStatus(statusEl, 'No pending key request. Run Step 1 first on this device.', 'error');
    return;
  }

  try {
    showStatus(statusEl, 'Decrypting key…', 'success');

    await runPy(`
import base64, json, os
import nacl.public, nacl.signing, cbor2

# Recover ephemeral private key
ephemeral_priv_bytes = base64.urlsafe_b64decode(${JSON.stringify(ephemeralPriv)})
ephemeral_priv = nacl.public.PrivateKey(ephemeral_priv_bytes)

# Decrypt sealed box
encrypted = base64.urlsafe_b64decode(${JSON.stringify(payload)})
unseal = nacl.public.SealedBox(ephemeral_priv)
seed = unseal.decrypt(encrypted)

# Reconstruct signing key
key = nacl.signing.SigningKey(seed)
key_id = bytes(key.verify_key).hex()

# Save to private directory
os.makedirs('${getWorkspacePath()}/private', exist_ok=True)
private_key = dict(id=key_id, signing=bytes(key), api='pynacl')
key_path = '${getWorkspacePath()}/private/signing.' + key_id + '.cbor'
with open(key_path, 'wb') as f:
    cbor2.dump(private_key, f, canonical=True)

_bridge_out = json.dumps({'key_id': key_id})
`);

    await saveToIDB(getPyodide(), getWorkspacePath());
    sessionStorage.removeItem('coulomb-provision-ephemeral');
    location.hash = '';

    showStatus(statusEl, 'Key imported successfully! You can now sign posts.', 'success');
  } catch (e) {
    showStatus(statusEl, `Import failed: ${e.message}`, 'error');
  }
}

// Check for provisioning URL fragments at boot
async function checkKeyImport() {
  const hash = location.hash;

  if (hash.startsWith('#provision/respond/')) {
    const payload = hash.slice('#provision/respond/'.length);
    // Auto-fill step 3 input and attempt import if ephemeral key exists
    const input = document.getElementById('provision-response-input');
    if (input) input.value = location.href;
    if (sessionStorage.getItem('coulomb-provision-ephemeral')) {
      await handleProvisionReceive(payload);
    }
    return true;
  }

  if (hash.startsWith('#provision/request/')) {
    // Auto-fill step 2 input on source device
    const input = document.getElementById('provision-request-input');
    if (input) input.value = location.href;
    return true;
  }

  // Legacy: handle old #import/ URLs gracefully
  if (hash.startsWith('#import/')) {
    alert('This import link uses an older format that is no longer supported. Please use the new provisioning flow.');
    location.hash = '';
    return false;
  }

  return false;
}

// Need runPy accessible for provisioning
async function runPy(code) {
  const pyodide = getPyodide();
  pyodide.runPython('_bridge_out = None');
  await pyodide.runPythonAsync(code);
  const out = pyodide.globals.get('_bridge_out');
  pyodide.runPython('_bridge_out = None');
  return out === undefined || out === null ? null : out;
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

function escapeAttr(text) {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(str, maxLen) {
  return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
