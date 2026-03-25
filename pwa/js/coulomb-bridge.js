import { loadPyodideRuntime, getPyodide } from './pyodide-loader.js';

const ACCOUNTS_ROOT = '/accounts';
const DEFAULT_ACCOUNT = 'default';

let activeAccount = DEFAULT_ACCOUNT;

function getWorkspace() { return `${ACCOUNTS_ROOT}/${activeAccount}`; }
function getPublic() { return `${getWorkspace()}/public`; }
function getPrivate() { return `${getWorkspace()}/private`; }
function getChangelog() { return `${getWorkspace()}/changelog`; }

/**
 * Bridge between the JS UI and coulomb Python code running in Pyodide.
 * Uses pyodide.globals to pass results since runPythonAsync (exec mode)
 * does not return expression values.
 */

async function runPy(code) {
  const pyodide = getPyodide();
  pyodide.runPython('_bridge_out = None');
  await pyodide.runPythonAsync(code);
  const out = pyodide.globals.get('_bridge_out');
  pyodide.runPython('_bridge_out = None');
  return out === undefined || out === null ? null : out;
}

// ── Accounts ──

export function getActiveAccount() { return activeAccount; }
export function getWorkspacePath() { return getWorkspace(); }

export async function listAccounts() {
  const pyodide = getPyodide();
  try {
    const entries = pyodide.FS.readdir(ACCOUNTS_ROOT).filter(e => e !== '.' && e !== '..');
    return entries;
  } catch {
    return [];
  }
}

export async function createAccount(name) {
  const pyodide = getPyodide();
  const path = `${ACCOUNTS_ROOT}/${name}`;
  try { pyodide.FS.stat(path); throw new Error(`Account "${name}" already exists`); } catch (e) {
    if (e.message?.includes('already exists')) throw e;
  }
  pyodide.FS.mkdir(path);
  return name;
}

export async function switchAccount(name) {
  const pyodide = getPyodide();
  const path = `${ACCOUNTS_ROOT}/${name}`;
  try { pyodide.FS.stat(path); } catch {
    throw new Error(`Account "${name}" not found`);
  }
  activeAccount = name;
  await ensureWorkspace();
}

export async function deleteAccount(name) {
  if (name === activeAccount) throw new Error('Cannot delete the active account');
  await runPy(`
import shutil, os
path = '${ACCOUNTS_ROOT}/${name}'
if os.path.exists(path):
    shutil.rmtree(path)
`);
}

// ── Workspace ──

export async function ensureWorkspace() {
  const pyodide = getPyodide();
  const ws = getWorkspace();
  const priv = getPrivate();
  await pyodide.runPythonAsync(`
import os
os.makedirs('${ACCOUNTS_ROOT}', exist_ok=True)
for d in ['${ws}', '${priv}']:
    os.makedirs(d, exist_ok=True)
os.chdir('${ws}')
`);
}

export async function isInitialized() {
  const result = await runPy(`
import os, glob
os.chdir('${getWorkspace()}')
identity_files = glob.glob('${getPublic()}/identity/*/latest.cbor')
_bridge_out = len(identity_files) > 0
`);
  return result;
}

export async function initialize() {
  const result = await runPy(`
import os, sys, io
os.chdir('${getWorkspace()}')

os.makedirs('${getPrivate()}', exist_ok=True)
if os.path.exists('${getPublic()}'):
    import shutil
    shutil.rmtree('${getPublic()}')

_capture = io.StringIO()
_old_stdout = sys.stdout
sys.stdout = _capture

from coulomb.init import main as coulomb_init
coulomb_init(
    public='${getPublic()}',
    private='${getPrivate()}',
    source=None,
    change_log='${getChangelog()}',
    print_='id'
)

sys.stdout = _old_stdout
_bridge_out = _capture.getvalue().strip()
`);
  return result;
}

// ── Identity ──

export async function getIdentityInfo() {
  const result = await runPy(`
import os, glob, json
os.chdir('${getWorkspace()}')

identity_files = glob.glob('${getPublic()}/identity/*/latest.cbor')
_bridge_out = None
if identity_files:
    import cbor2
    with open(identity_files[0], 'rb') as f:
        entry = cbor2.load(f)
    author = entry['content']['author']
    config = author.get('config', {})
    _bridge_out = json.dumps({
        'id': author['id'],
        'signing_keys': author.get('signing_keys', []),
        'encryption_keys': author.get('encryption_keys', []),
        'display_name': config.get('display_name', config.get('user.display_name', '')),
        'avatar_url': config.get('avatar_url', ''),
        'locations': author.get('locations', []),
        'config': config,
    })
`);
  return result ? JSON.parse(result) : null;
}

export async function setIdentityConfig(textPairs) {
  const pyodide = getPyodide();
  const pairsJson = JSON.stringify(textPairs);
  await pyodide.runPythonAsync(`
import os, glob, json
os.chdir('${getWorkspace()}')

identity_files = glob.glob('${getPublic()}/identity/*/latest.cbor')
if not identity_files:
    raise RuntimeError("No identity found. Run init first.")

import cbor2
with open(identity_files[0], 'rb') as f:
    entry = cbor2.load(f)
author = entry['content']['author']
key_id = author['id']

private_key_files = glob.glob('${getPrivate()}/private_identity.*.cbor') + glob.glob('${getPrivate()}/signing.*.cbor')

_pairs = json.loads(${JSON.stringify(pairsJson)})

from coulomb.identity import set_config
with open('${getChangelog()}', 'a') as _cl:
    set_config(
        identity='${getPublic()}/identity/' + key_id,
        change_log=_cl,
        signatures=private_key_files,
        text=_pairs
    )
`);
}

export async function setDisplayName(name) {
  return setIdentityConfig([['display_name', name]]);
}

export async function setAvatarUrl(url) {
  return setIdentityConfig([['avatar_url', url]]);
}

export async function addLocation(url, index = null) {
  const indexPy = index !== null ? index : 'None';
  await runPy(`
import os, glob
os.chdir('${getWorkspace()}')

identity_files = glob.glob('${getPublic()}/identity/*/latest.cbor')
if not identity_files:
    raise RuntimeError("No identity found. Run init first.")

import cbor2
with open(identity_files[0], 'rb') as f:
    entry = cbor2.load(f)
key_id = entry['content']['author']['id']

private_key_files = glob.glob('${getPrivate()}/private_identity.*.cbor') + glob.glob('${getPrivate()}/signing.*.cbor')

from coulomb.identity import add_location
with open('${getChangelog()}', 'a') as _cl:
    add_location(
        identity='${getPublic()}/identity/' + key_id,
        change_log=_cl,
        signatures=private_key_files,
        location=${JSON.stringify(url)},
        index=${indexPy}
    )
`);
}

export async function removeLocation(url) {
  await runPy(`
import os, glob
os.chdir('${getWorkspace()}')

identity_files = glob.glob('${getPublic()}/identity/*/latest.cbor')
if not identity_files:
    raise RuntimeError("No identity found. Run init first.")

import cbor2
with open(identity_files[0], 'rb') as f:
    entry = cbor2.load(f)
key_id = entry['content']['author']['id']

private_key_files = glob.glob('${getPrivate()}/private_identity.*.cbor') + glob.glob('${getPrivate()}/signing.*.cbor')

from coulomb.identity import rm_location
with open('${getChangelog()}', 'a') as _cl:
    rm_location(
        identity='${getPublic()}/identity/' + key_id,
        change_log=_cl,
        signatures=private_key_files,
        location=${JSON.stringify(url)}
    )
`);
}

// ── Posts ──

export async function createPost(text, files = [], replyTo = null) {
  // Write attached files to Pyodide FS so post.main can read them
  const pyodide = getPyodide();
  const filePaths = [];
  for (const file of files) {
    const buffer = await file.arrayBuffer();
    const data = new Uint8Array(buffer);
    const tmpPath = `/tmp/attach_${file.name}`;
    pyodide.FS.writeFile(tmpPath, data);
    filePaths.push(tmpPath);
  }

  const filePathsJson = JSON.stringify(filePaths);
  const result = await runPy(`
import os, glob, json
os.chdir('${getWorkspace()}')

identity_files = glob.glob('${getPublic()}/identity/*/latest.cbor')
if not identity_files:
    raise RuntimeError("No identity found. Run init first.")

private_key_files = glob.glob('${getPrivate()}/private_identity.*.cbor') + glob.glob('${getPrivate()}/signing.*.cbor')

_file_paths = json.loads(${JSON.stringify(filePathsJson)})

from coulomb.post import main as coulomb_post
_post_result = coulomb_post(
    root='${getPublic()}',
    author=identity_files[0],
    text=${JSON.stringify(text)},
    files=_file_paths,
    signatures=private_key_files,
    changelogs=['${getChangelog()}'],
    reply=${replyTo ? JSON.stringify(replyTo) : 'None'}
)
_bridge_out = json.dumps({'post_path': str(_post_result) if _post_result else None})
`);
  return JSON.parse(result);
}

export async function listRecentPosts(limit = 20) {
  const result = await runPy(`
import os, glob, json
os.chdir('${getWorkspace()}')

import cbor2

# Build latest identity config map (author_id → config dict)
_latest_configs = {}
for _id_file in glob.glob('${getPublic()}/identity/*/latest.cbor'):
    try:
        with open(_id_file, 'rb') as f:
            _id_author = cbor2.load(f)['content']['author']
        _latest_configs[_id_author['id']] = _id_author.get('config', {})
    except Exception:
        pass

post_files = sorted(glob.glob('${getPublic()}/posts/**/*.cbor', recursive=True), reverse=True)[:${limit}]

posts = []
for pf in post_files:
    if os.path.basename(pf) == 'index.cbor':
        continue
    try:
        with open(pf, 'rb') as f:
            entry = cbor2.load(f)
        content = entry['content']
        author = content.get('author', {})
        author_id = author.get('id', '')
        # Use latest identity config for display, fall back to per-post snapshot
        config = _latest_configs.get(author_id, author.get('config', {}))
        file_list = content.get('files', [])
        reply_to = content.get('reply_to', None)
        posts.append({
            'path': pf,
            'rel_path': pf.replace('${getPublic()}/', ''),
            'text': content.get('text', ''),
            'time': content.get('time', ''),
            'author_id': author_id,
            'display_name': config.get('display_name', ''),
            'files': [f.get('name', '') for f in file_list],
            'file_count': len(file_list),
            'reply_to': reply_to,
            'sig_count': len(entry.get('signatures', {})),
        })
    except Exception:
        pass

posts.sort(key=lambda p: p['time'], reverse=True)
_bridge_out = json.dumps(posts)
`);
  return JSON.parse(result);
}

/**
 * Verify the cryptographic signatures on a post.
 * Returns { valid: bool, detail: string, signatures: [{key_id, ok}] }
 */
export async function verifyPost(postPath) {
  const result = await runPy(`
import json, cbor2, nacl.signing

with open(${JSON.stringify(postPath)}, 'rb') as f:
    entry = cbor2.load(f)

content = entry['content']
author = content.get('author', {})
signing_keys = set(author.get('signing_keys', []))
sigs = entry.get('signatures', {})
content_bytes = cbor2.dumps(content, canonical=True)

results = []
endorsed_ok = 0
for key_id, signature in sigs.items():
    endorsed = key_id in signing_keys
    try:
        key = nacl.signing.VerifyKey(bytes.fromhex(key_id))
        key.verify(content_bytes, signature)
        results.append({'key_id': key_id, 'ok': True, 'endorsed': endorsed})
        if endorsed:
            endorsed_ok += 1
    except Exception as e:
        results.append({'key_id': key_id, 'ok': False, 'endorsed': endorsed, 'error': str(e)})

if len(sigs) == 0:
    detail = 'No signatures'
    valid = False
elif endorsed_ok == 0:
    detail = f'{len(sigs)} signature(s), none from endorsed keys'
    valid = False
else:
    detail = f'{endorsed_ok}/{len(sigs)} valid endorsed signature(s)'
    valid = True

_bridge_out = json.dumps({'valid': valid, 'detail': detail, 'signatures': results})
`);
  return JSON.parse(result);
}

// ── Site Config ──

export async function getSiteConfig() {
  const result = await runPy(`
import os, json
os.chdir('${getWorkspace()}')

config_path = '${getPublic()}/config.cbor'
_bridge_out = '{}'
if os.path.exists(config_path):
    import cbor2
    with open(config_path, 'rb') as f:
        config = cbor2.load(f)
    _bridge_out = json.dumps(config.get('config', {}).get('text_values', {}))
`);
  return JSON.parse(result);
}

export async function setSiteConfig(key, value) {
  await runPy(`
import os
os.chdir('${getWorkspace()}')

import cbor2

config_path = '${getPublic()}/config.cbor'
config = {}
if os.path.exists(config_path):
    with open(config_path, 'rb') as f:
        config = cbor2.load(f)

config.setdefault('config', {}).setdefault('text_values', {})[${JSON.stringify(key)}] = ${JSON.stringify(value)}

with open(config_path, 'wb') as f:
    cbor2.dump(config, f, canonical=True)

with open('${getChangelog()}', 'a') as _cl:
    _cl.write('config.cbor\\n')
`);
}

export async function getPendingFiles() {
  const result = await runPy(`
import os, json
os.chdir('${getWorkspace()}')
changelog_path = '${getChangelog()}'
files = []
if os.path.exists(changelog_path):
    with open(changelog_path) as f:
        files = [line.strip() for line in f if line.strip()]
_bridge_out = json.dumps(files)
`);
  return JSON.parse(result);
}

export function readWorkspaceFile(relativePath) {
  const pyodide = getPyodide();
  const fullPath = `${getPublic()}/${relativePath}`;
  try {
    return pyodide.FS.readFile(fullPath);
  } catch {
    return null;
  }
}

// ── QR Code ──

let segnoLoaded = false;

export async function generateQRCodeSVG(text) {
  if (!segnoLoaded) {
    const pyodide = getPyodide();
    await pyodide.runPythonAsync(`
import micropip
await micropip.install('segno')
`);
    segnoLoaded = true;
  }

  const result = await runPy(`
import segno, io

qr = segno.make(${JSON.stringify(text)})
buf = io.BytesIO()
qr.save(buf, kind='svg', scale=4, border=2, dark='#e94560', light='#16213e')
_bridge_out = buf.getvalue().decode()
`);
  return result;
}

export async function renderSite() {
  await runPy(`
import os, shutil, glob
os.chdir('${getWorkspace()}')

# Render in a staging copy so original post CBOR files stay untouched
# (originals preserve signatures for future cryptographic verification)
RENDER_ROOT = '${getWorkspace()}/render_staging'
if os.path.exists(RENDER_ROOT):
    shutil.rmtree(RENDER_ROOT)
shutil.copytree('${getPublic()}', RENDER_ROOT)

# Update template CSS (may be stale from initial init)
_src = '/coulomb/template/static/global/style.css'
_dst = os.path.join(RENDER_ROOT, 'static/global/style.css')
if os.path.exists(_src):
    os.makedirs(os.path.dirname(_dst), exist_ok=True)
    shutil.copy(_src, _dst)

# Patch staging post files with latest identity config so re-renders
# pick up display name / avatar changes
import cbor2
identity_files = glob.glob(os.path.join(RENDER_ROOT, 'identity/*/latest.cbor'))
if identity_files:
    with open(identity_files[0], 'rb') as f:
        _latest_author = cbor2.load(f)['content']['author']

    for pf in glob.glob(os.path.join(RENDER_ROOT, 'posts/**/*.cbor'), recursive=True):
        if os.path.basename(pf) == 'index.cbor':
            continue
        try:
            with open(pf, 'rb') as f:
                entry = cbor2.load(f)
            post_author = entry['content']['author']
            if post_author['id'] == _latest_author['id']:
                post_author['config'] = _latest_author.get('config', {})
                with open(pf, 'wb') as f:
                    cbor2.dump(entry, f, canonical=True)
        except Exception:
            pass

from coulomb.rebuild_index import main as rebuild_index
rebuild_index(
    root=RENDER_ROOT,
    hashes=['sha512'],
    changelog=None,
    filter_=None,
)

from coulomb.render import main as coulomb_render
coulomb_render(
    root=RENDER_ROOT,
    cache_file='${getPrivate()}/render_cache.sqlite',
    hash_name='sha512',
    template_dir=None,
    change_log=None,
    post_dirs=['posts'],
    html_dir='pages',
)

# Copy rendered pages + updated static assets back to workspace public
for subdir in ['pages', 'static']:
    src = os.path.join(RENDER_ROOT, subdir)
    dst = os.path.join('${getPublic()}', subdir)
    if os.path.exists(src):
        if os.path.exists(dst):
            shutil.rmtree(dst)
        shutil.copytree(src, dst)
`);
}

export function getRenderedPage(pageName) {
  const pyodide = getPyodide();
  try {
    return pyodide.FS.readFile(`${getPublic()}/pages/${pageName}`, { encoding: 'utf8' });
  } catch {
    return null;
  }
}

export function getRenderedFile(relPath) {
  const pyodide = getPyodide();
  try {
    return pyodide.FS.readFile(`${getPublic()}/${relPath}`, { encoding: 'utf8' });
  } catch {
    return null;
  }
}

export function listRenderedPages() {
  const pyodide = getPyodide();
  try {
    const files = pyodide.FS.readdir(`${getPublic()}/pages`);
    return files.filter(f => f.endsWith('.html')).sort();
  } catch {
    return [];
  }
}
