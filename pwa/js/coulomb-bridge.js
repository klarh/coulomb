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
    _bridge_out = json.dumps({
        'id': author['id'],
        'signing_keys': author.get('signing_keys', []),
        'display_name': author.get('config', {}).get('display_name', ''),
        'locations': author.get('locations', []),
    })
`);
  return result ? JSON.parse(result) : null;
}

export async function setDisplayName(name) {
  const pyodide = getPyodide();
  await pyodide.runPythonAsync(`
import os, glob
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

from coulomb.identity import set_config
with open('${CHANGELOG}', 'a') as _cl:
    set_config(
        identity='${PUBLIC}/identity/' + key_id,
        change_log=_cl,
        signatures=private_key_files,
        text=[('display_name', ${JSON.stringify(name)})]
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
