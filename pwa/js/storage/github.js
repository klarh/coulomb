import { StorageBackend } from './adapter.js';

const GITHUB_API = 'https://api.github.com';

/**
 * GitHub Pages storage adapter.
 * Uses the Git Data API for efficient batch commits.
 */
export class GitHubPagesBackend extends StorageBackend {
  #token = null;
  #owner = '';
  #repo = '';
  #branch = 'main';
  #pathPrefix = '';
  #connected = false;

  get name() { return 'github'; }
  get connected() { return this.#connected; }

  async connect(credentials) {
    const { token, repo, branch, pathPrefix } = credentials;
    if (!token || !repo) {
      return { success: false, error: 'Token and repository are required' };
    }

    const [owner, repoName] = repo.split('/');
    if (!owner || !repoName) {
      return { success: false, error: 'Repository must be in owner/repo format' };
    }

    this.#token = token;
    this.#owner = owner;
    this.#repo = repoName;
    this.#branch = branch || 'main';
    this.#pathPrefix = pathPrefix ? pathPrefix.replace(/\/$/, '') + '/' : '';

    // Verify access
    try {
      const resp = await this.#api(`/repos/${this.#owner}/${this.#repo}`);
      if (!resp.ok) {
        const err = await resp.json();
        return { success: false, error: err.message || 'Failed to access repository' };
      }
      this.#connected = true;

      // Persist config (not the token) to localStorage
      localStorage.setItem('coulomb-github-config', JSON.stringify({
        owner: this.#owner,
        repo: this.#repo,
        branch: this.#branch,
        pathPrefix: this.#pathPrefix,
      }));

      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async disconnect() {
    this.#token = null;
    this.#connected = false;
    localStorage.removeItem('coulomb-github-config');
    // Token is stored separately so user must re-enter it
    sessionStorage.removeItem('coulomb-github-token');
  }

  async upload(path, content) {
    const fullPath = this.#pathPrefix + path;
    const base64 = uint8ToBase64(content);

    // Check if file exists to get its SHA (needed for updates)
    let sha;
    try {
      const existing = await this.#api(
        `/repos/${this.#owner}/${this.#repo}/contents/${fullPath}?ref=${this.#branch}`
      );
      if (existing.ok) {
        const data = await existing.json();
        sha = data.sha;
      }
    } catch { /* file doesn't exist yet */ }

    const body = {
      message: `coulomb: update ${path}`,
      content: base64,
      branch: this.#branch,
    };
    if (sha) body.sha = sha;

    const resp = await this.#api(
      `/repos/${this.#owner}/${this.#repo}/contents/${fullPath}`,
      { method: 'PUT', body: JSON.stringify(body) }
    );

    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(`Upload failed: ${err.message}`);
    }
  }

  async download(path) {
    const fullPath = this.#pathPrefix + path;
    const resp = await this.#api(
      `/repos/${this.#owner}/${this.#repo}/contents/${fullPath}?ref=${this.#branch}`
    );
    if (!resp.ok) return null;

    const data = await resp.json();
    return base64ToUint8(data.content);
  }

  async list(prefix) {
    const fullPath = this.#pathPrefix + prefix;
    const results = [];
    await this.#listRecursive(fullPath, results);
    return results.map(p => {
      if (this.#pathPrefix && p.startsWith(this.#pathPrefix)) {
        return p.slice(this.#pathPrefix.length);
      }
      return p;
    });
  }

  async delete(path) {
    const fullPath = this.#pathPrefix + path;
    const existing = await this.#api(
      `/repos/${this.#owner}/${this.#repo}/contents/${fullPath}?ref=${this.#branch}`
    );
    if (!existing.ok) return;

    const data = await existing.json();
    await this.#api(
      `/repos/${this.#owner}/${this.#repo}/contents/${fullPath}`,
      {
        method: 'DELETE',
        body: JSON.stringify({
          message: `coulomb: delete ${path}`,
          sha: data.sha,
          branch: this.#branch,
        }),
      }
    );
  }

  /**
   * Publish multiple files in a single git commit using the Git Data API.
   * Much more efficient than individual file uploads.
   */
  async publish(files, message = 'coulomb: publish') {
    if (!this.#connected) {
      return { success: false, error: 'Not connected to GitHub' };
    }

    if (files.length === 0) {
      return { success: true, url: this.#pagesUrl() };
    }

    try {
      // 1. Get the current commit SHA for the branch
      const refResp = await this.#api(
        `/repos/${this.#owner}/${this.#repo}/git/ref/heads/${this.#branch}`
      );
      if (!refResp.ok) throw new Error('Failed to get branch ref');
      const refData = await refResp.json();
      const latestCommitSha = refData.object.sha;

      // 2. Get the tree SHA from the latest commit
      const commitResp = await this.#api(
        `/repos/${this.#owner}/${this.#repo}/git/commits/${latestCommitSha}`
      );
      if (!commitResp.ok) throw new Error('Failed to get commit');
      const commitData = await commitResp.json();
      const baseTreeSha = commitData.tree.sha;

      // 3. Create blobs for each file
      const treeEntries = [];
      for (const file of files) {
        const blobResp = await this.#api(
          `/repos/${this.#owner}/${this.#repo}/git/blobs`,
          {
            method: 'POST',
            body: JSON.stringify({
              content: uint8ToBase64(file.content),
              encoding: 'base64',
            }),
          }
        );
        if (!blobResp.ok) throw new Error(`Failed to create blob for ${file.path}`);
        const blobData = await blobResp.json();

        treeEntries.push({
          path: this.#pathPrefix + file.path,
          mode: '100644',
          type: 'blob',
          sha: blobData.sha,
        });
      }

      // 4. Create a new tree
      const treeResp = await this.#api(
        `/repos/${this.#owner}/${this.#repo}/git/trees`,
        {
          method: 'POST',
          body: JSON.stringify({
            base_tree: baseTreeSha,
            tree: treeEntries,
          }),
        }
      );
      if (!treeResp.ok) throw new Error('Failed to create tree');
      const treeData = await treeResp.json();

      // 5. Create a new commit
      const newCommitResp = await this.#api(
        `/repos/${this.#owner}/${this.#repo}/git/commits`,
        {
          method: 'POST',
          body: JSON.stringify({
            message,
            tree: treeData.sha,
            parents: [latestCommitSha],
          }),
        }
      );
      if (!newCommitResp.ok) throw new Error('Failed to create commit');
      const newCommitData = await newCommitResp.json();

      // 6. Update the branch ref
      const updateRefResp = await this.#api(
        `/repos/${this.#owner}/${this.#repo}/git/refs/heads/${this.#branch}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ sha: newCommitData.sha }),
        }
      );
      if (!updateRefResp.ok) throw new Error('Failed to update ref');

      return {
        success: true,
        url: this.#pagesUrl(),
        commitSha: newCommitData.sha,
        filesPublished: files.length,
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // Restore connection from saved config + session token
  tryRestore() {
    const configStr = localStorage.getItem('coulomb-github-config');
    const token = sessionStorage.getItem('coulomb-github-token');
    if (configStr && token) {
      const config = JSON.parse(configStr);
      this.#owner = config.owner;
      this.#repo = config.repo;
      this.#branch = config.branch;
      this.#pathPrefix = config.pathPrefix;
      this.#token = token;
      this.#connected = true;
      return true;
    }
    return false;
  }

  // Save token to session storage (not localStorage for security)
  saveToken(token) {
    sessionStorage.setItem('coulomb-github-token', token);
  }

  get repoDisplay() {
    return `${this.#owner}/${this.#repo} (${this.#branch})`;
  }

  #pagesUrl() {
    return `https://${this.#owner}.github.io/${this.#repo}/`;
  }

  async #api(path, options = {}) {
    return fetch(`${GITHUB_API}${path}`, {
      ...options,
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${this.#token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
  }

  async #listRecursive(path, results) {
    const resp = await this.#api(
      `/repos/${this.#owner}/${this.#repo}/contents/${path}?ref=${this.#branch}`
    );
    if (!resp.ok) return;

    const items = await resp.json();
    if (!Array.isArray(items)) return;

    for (const item of items) {
      if (item.type === 'file') {
        results.push(item.path);
      } else if (item.type === 'dir') {
        await this.#listRecursive(item.path, results);
      }
    }
  }

  toJSON() {
    return {
      type: 'github',
      config: {
        owner: this.#owner,
        repo: this.#repo,
        branch: this.#branch,
        pathPrefix: this.#pathPrefix,
      },
    };
  }
}

function uint8ToBase64(uint8) {
  let binary = '';
  for (let i = 0; i < uint8.length; i++) {
    binary += String.fromCharCode(uint8[i]);
  }
  return btoa(binary);
}

function base64ToUint8(base64) {
  const clean = base64.replace(/\s/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
