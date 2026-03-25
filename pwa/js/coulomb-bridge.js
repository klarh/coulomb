import { getPyodide } from './pyodide-loader.js';

const WORKSPACE = '/workspace';
const PUBLIC = `${WORKSPACE}/public`;
const PRIVATE = `${WORKSPACE}/private`;
const CHANGELOG = `${WORKSPACE}/changelog`;

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

export async function ensureWorkspace() {
  const pyodide = getPyodide();
  await pyodide.runPythonAsync(`
import os
for d in ['${WORKSPACE}', '${PRIVATE}']:
    os.makedirs(d, exist_ok=True)
os.chdir('${WORKSPACE}')
`);
}

export async function isInitialized() {
  const result = await runPy(`
import os, glob
os.chdir('${WORKSPACE}')
identity_files = glob.glob('${PUBLIC}/identity/*/latest.cbor')
_bridge_out = len(identity_files) > 0
`);
  return result;
}

export async function initialize() {
  const result = await runPy(`
import os, sys, io
os.chdir('${WORKSPACE}')

os.makedirs('${PRIVATE}', exist_ok=True)
# init.main asserts public dir does NOT exist (it creates it)
if os.path.exists('${PUBLIC}'):
    import shutil
    shutil.rmtree('${PUBLIC}')

# init.main prints the key_id to stdout instead of returning it
_capture = io.StringIO()
_old_stdout = sys.stdout
sys.stdout = _capture

from coulomb.init import main as coulomb_init
coulomb_init(
    public='${PUBLIC}',
    private='${PRIVATE}',
    source=None,
    change_log='${CHANGELOG}',
    print_='id'
)

sys.stdout = _old_stdout
_bridge_out = _capture.getvalue().strip()
`);
  return result;
}

export async function getIdentityInfo() {
  const result = await runPy(`
import os, glob, json
os.chdir('${WORKSPACE}')

identity_files = glob.glob('${PUBLIC}/identity/*/latest.cbor')
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
        'display_name': config.get('display_name', config.get('user.display_name', '')),
        'avatar_url': config.get('avatar_url', ''),
        'locations': author.get('locations', []),
    })
`);
  return result ? JSON.parse(result) : null;
}

export async function setDisplayName(name) {
  return setIdentityConfig([['display_name', name]]);
}

export async function setAvatarUrl(url) {
  return setIdentityConfig([['avatar_url', url]]);
}

async function setIdentityConfig(textPairs) {
  const pyodide = getPyodide();
  const pairsJson = JSON.stringify(textPairs);
  await pyodide.runPythonAsync(`
import os, glob, json
os.chdir('${WORKSPACE}')

identity_files = glob.glob('${PUBLIC}/identity/*/latest.cbor')
if not identity_files:
    raise RuntimeError("No identity found. Run init first.")

import cbor2
with open(identity_files[0], 'rb') as f:
    entry = cbor2.load(f)
author = entry['content']['author']
key_id = author['id']

private_key_files = glob.glob('${PRIVATE}/private_identity.*.cbor') + glob.glob('${PRIVATE}/signing.*.cbor')

_pairs = json.loads(${JSON.stringify(pairsJson)})

from coulomb.identity import set_config
with open('${CHANGELOG}', 'a') as _cl:
    set_config(
        identity='${PUBLIC}/identity/' + key_id,
        change_log=_cl,
        signatures=private_key_files,
        text=_pairs
    )
`);
}

export async function createPost(text, replyTo = null) {
  const result = await runPy(`
import os, glob, json
os.chdir('${WORKSPACE}')

identity_files = glob.glob('${PUBLIC}/identity/*/latest.cbor')
if not identity_files:
    raise RuntimeError("No identity found. Run init first.")

private_key_files = glob.glob('${PRIVATE}/private_identity.*.cbor') + glob.glob('${PRIVATE}/signing.*.cbor')

from coulomb.post import main as coulomb_post
_post_result = coulomb_post(
    root='${PUBLIC}',
    author=identity_files[0],
    text=${JSON.stringify(text)},
    files=[],
    signatures=private_key_files,
    changelogs=['${CHANGELOG}'],
    reply=${replyTo ? JSON.stringify(replyTo) : 'None'}
)
_bridge_out = json.dumps({'post_path': str(_post_result) if _post_result else None})
`);
  return JSON.parse(result);
}

export async function listRecentPosts(limit = 20) {
  const result = await runPy(`
import os, glob, json
os.chdir('${WORKSPACE}')

import cbor2

post_files = sorted(glob.glob('${PUBLIC}/posts/**/*.cbor', recursive=True), reverse=True)[:${limit}]

posts = []
for pf in post_files:
    try:
        with open(pf, 'rb') as f:
            entry = cbor2.load(f)
        content = entry['content']
        posts.append({
            'path': pf.replace('${PUBLIC}/', ''),
            'text': content.get('text', ''),
            'time': content.get('time', ''),
            'author_id': content.get('author', {}).get('id', content.get('author', '')),
        })
    except Exception as e:
        pass

_bridge_out = json.dumps(posts)
`);
  return JSON.parse(result);
}

export async function getPendingFiles() {
  const result = await runPy(`
import os, json
os.chdir('${WORKSPACE}')
changelog_path = '${CHANGELOG}'
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
  const fullPath = `${PUBLIC}/${relativePath}`;
  try {
    return pyodide.FS.readFile(fullPath);
  } catch {
    return null;
  }
}

export async function renderSite() {
  await runPy(`
import os, shutil, glob
os.chdir('${WORKSPACE}')

# Render in a staging copy so original post CBOR files stay untouched
# (originals preserve signatures for future cryptographic verification)
RENDER_ROOT = '${WORKSPACE}/render_staging'
if os.path.exists(RENDER_ROOT):
    shutil.rmtree(RENDER_ROOT)
shutil.copytree('${PUBLIC}', RENDER_ROOT)

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
    cache_file='${PRIVATE}/render_cache.sqlite',
    hash_name='sha512',
    template_dir=None,
    change_log=None,
    post_dirs=['posts'],
    html_dir='pages',
)

# Copy rendered pages + updated static assets back to workspace public
for subdir in ['pages', 'static']:
    src = os.path.join(RENDER_ROOT, subdir)
    dst = os.path.join('${PUBLIC}', subdir)
    if os.path.exists(src):
        if os.path.exists(dst):
            shutil.rmtree(dst)
        shutil.copytree(src, dst)
`);
}

export function getRenderedPage(pageName) {
  const pyodide = getPyodide();
  try {
    return pyodide.FS.readFile(`${PUBLIC}/pages/${pageName}`, { encoding: 'utf8' });
  } catch {
    return null;
  }
}

export function getRenderedFile(relPath) {
  const pyodide = getPyodide();
  try {
    return pyodide.FS.readFile(`${PUBLIC}/${relPath}`, { encoding: 'utf8' });
  } catch {
    return null;
  }
}

export function listRenderedPages() {
  const pyodide = getPyodide();
  try {
    const files = pyodide.FS.readdir(`${PUBLIC}/pages`);
    return files.filter(f => f.endsWith('.html')).sort();
  } catch {
    return [];
  }
}
