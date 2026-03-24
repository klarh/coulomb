const DB_NAME = 'coulomb-fs';
const DB_VERSION = 1;
const STORE_NAME = 'files';

let db = null;

async function openDB() {
  if (db) return db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE_NAME, { keyPath: 'path' });
      store.createIndex('dir', 'dir', { unique: false });
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

// Save the Pyodide virtual FS working directory to IndexedDB
export async function saveToIDB(pyodide, basePath = '/workspace') {
  const idb = await openDB();
  const files = listFilesRecursive(pyodide, basePath);
  const tx = idb.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);

  for (const filePath of files) {
    try {
      const data = pyodide.FS.readFile(filePath);
      const dir = filePath.substring(0, filePath.lastIndexOf('/')) || '/';
      store.put({ path: filePath, dir, data: data.buffer, mtime: Date.now() });
    } catch (e) {
      console.warn(`Failed to save ${filePath}:`, e);
    }
  }

  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// Restore files from IndexedDB into the Pyodide virtual FS
export async function restoreFromIDB(pyodide, basePath = '/workspace') {
  const idb = await openDB();
  const tx = idb.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const all = store.getAll();

  return new Promise((resolve, reject) => {
    all.onsuccess = () => {
      const files = all.result.filter(f => f.path.startsWith(basePath));
      for (const file of files) {
        try {
          ensureDir(pyodide, file.path.substring(0, file.path.lastIndexOf('/')));
          pyodide.FS.writeFile(file.path, new Uint8Array(file.data));
        } catch (e) {
          console.warn(`Failed to restore ${file.path}:`, e);
        }
      }
      resolve(files.length);
    };
    all.onerror = () => reject(all.error);
  });
}

// List all files in IDB under a prefix (for sync/publish)
export async function listIDBFiles(basePath = '/workspace') {
  const idb = await openDB();
  const tx = idb.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const all = store.getAll();

  return new Promise((resolve, reject) => {
    all.onsuccess = () => {
      resolve(all.result.filter(f => f.path.startsWith(basePath)));
    };
    all.onerror = () => reject(all.error);
  });
}

// Read a single file from IDB
export async function readIDBFile(path) {
  const idb = await openDB();
  const tx = idb.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const req = store.get(path);

  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result ? new Uint8Array(req.result.data) : null);
    req.onerror = () => reject(req.error);
  });
}

// Get the changelog (list of changed files since last publish)
export async function getChangelog(pyodide, basePath = '/workspace') {
  const changelogPath = `${basePath}/public/changelog`;
  try {
    const content = pyodide.FS.readFile(changelogPath, { encoding: 'utf8' });
    return content.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// Clear the changelog after a successful publish
export async function clearChangelog(pyodide, basePath = '/workspace') {
  const changelogPath = `${basePath}/public/changelog`;
  try {
    pyodide.FS.writeFile(changelogPath, '');
  } catch {
    // Changelog may not exist yet
  }
}

function listFilesRecursive(pyodide, dirPath) {
  const results = [];
  try {
    const entries = pyodide.FS.readdir(dirPath).filter(e => e !== '.' && e !== '..');
    for (const entry of entries) {
      const fullPath = `${dirPath}/${entry}`;
      const stat = pyodide.FS.stat(fullPath);
      if (pyodide.FS.isDir(stat.mode)) {
        results.push(...listFilesRecursive(pyodide, fullPath));
      } else {
        results.push(fullPath);
      }
    }
  } catch {
    // Directory doesn't exist yet
  }
  return results;
}

function ensureDir(pyodide, dirPath) {
  const parts = dirPath.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += '/' + part;
    try {
      pyodide.FS.stat(current);
    } catch {
      pyodide.FS.mkdir(current);
    }
  }
}
