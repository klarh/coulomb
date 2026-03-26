const PYODIDE_VERSION = '0.27.4';
const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

let pyodideInstance = null;
let _sqlite3Loaded = false;
let _jinja2Loaded = false;

export async function loadPyodideRuntime(onProgress) {
  if (pyodideInstance) return pyodideInstance;

  onProgress?.('Loading Pyodide runtime…', 10);

  // Dynamically load the Pyodide loader script
  if (!window.loadPyodide) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `${PYODIDE_CDN}pyodide.js`;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  onProgress?.('Initializing Python…', 30);

  pyodideInstance = await window.loadPyodide({
    indexURL: PYODIDE_CDN,
  });

  onProgress?.('Installing packages…', 50);

  // Install micropip, then batch-install essential packages in parallel
  await pyodideInstance.loadPackage('micropip');
  const micropip = pyodideInstance.pyimport('micropip');

  // cbor2 is needed immediately; pynacl may fail and needs a fallback
  const naclP = micropip.install('pynacl').catch(async () => {
    console.warn('PyNaCl not available via micropip, installing fallback shim');
    await installNaclShim(pyodideInstance);
  });
  await Promise.all([micropip.install('cbor2'), naclP]);

  onProgress?.('Loading Coulomb…', 75);

  // Fetch all coulomb source files in parallel
  await loadCoulombSource(pyodideInstance);

  onProgress?.('Ready', 100);

  return pyodideInstance;
}

/**
 * Ensure sqlite3 is loaded (needed for pull cache and render cache).
 */
export async function ensureSqlite3() {
  if (_sqlite3Loaded) return;
  await pyodideInstance.loadPackage('sqlite3');
  _sqlite3Loaded = true;
}

/**
 * Load packages only needed for rendering (jinja2, sqlite3).
 * Called lazily on first renderSite() to keep boot fast.
 */
export async function ensureRenderPackages() {
  const loads = [];
  if (!_jinja2Loaded) {
    const micropip = pyodideInstance.pyimport('micropip');
    loads.push(micropip.install('jinja2').then(() => { _jinja2Loaded = true; }));
  }
  if (!_sqlite3Loaded) loads.push(ensureSqlite3());
  if (loads.length) await Promise.all(loads);
}

async function installNaclShim(pyodide) {
  // Load libsodium-wrappers from CDN for real Ed25519 + X25519 crypto.
  // The Python shims call into libsodium.js via Pyodide's JS interop.
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/libsodium-wrappers@0.7.15/dist/modules/libsodium-wrappers.js';
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
  await window.sodium.ready;

  pyodide.FS.mkdirTree('/lib/python/nacl');
  pyodide.FS.writeFile('/lib/python/nacl/__init__.py', '');

  pyodide.FS.writeFile('/lib/python/nacl/signing.py', `
"""nacl.signing shim backed by libsodium.js via Pyodide JS interop."""
from js import sodium


class VerifyKey:
    def __init__(self, key_bytes):
        if isinstance(key_bytes, (bytes, bytearray)) and len(key_bytes) == 32:
            self._key = bytes(key_bytes)
        else:
            raise ValueError("VerifyKey must be 32 bytes")

    def __bytes__(self):
        return self._key

    def verify(self, message, signature):
        from pyodide.ffi import to_js
        ok = sodium.crypto_sign_verify_detached(
            to_js(signature), to_js(message), to_js(self._key)
        )
        if not ok:
            raise Exception("Signature was forged or corrupt")
        return message


class SignedMessage(bytes):
    signature = b''
    message = b''

    def __new__(cls, signature, message):
        obj = super().__new__(cls, signature + message)
        obj.signature = signature
        obj.message = message
        return obj


class SigningKey:
    def __init__(self, seed=None):
        from pyodide.ffi import to_js
        if seed is not None:
            if len(seed) != 32:
                raise ValueError("Seed must be 32 bytes")
            self._seed = bytes(seed)
            kp = sodium.crypto_sign_seed_keypair(to_js(self._seed))
            self._pk = bytes(kp.publicKey.to_py())
            self._sk = bytes(kp.privateKey.to_py())
        else:
            raise ValueError("Seed required")
        self.verify_key = VerifyKey(self._pk)

    @classmethod
    def generate(cls):
        import secrets
        return cls(secrets.token_bytes(32))

    def __bytes__(self):
        return self._seed

    def sign(self, message):
        from pyodide.ffi import to_js
        sig = bytes(sodium.crypto_sign_detached(to_js(message), to_js(self._sk)).to_py())
        return SignedMessage(sig, message)
`);

  pyodide.FS.writeFile('/lib/python/nacl/public.py', `
"""nacl.public shim backed by libsodium.js via Pyodide JS interop."""
from pyodide.ffi import to_js
from js import sodium


class PublicKey:
    def __init__(self, public_key):
        if isinstance(public_key, (bytes, bytearray)) and len(public_key) == 32:
            self._key = bytes(public_key)
        else:
            raise ValueError("PublicKey must be 32 bytes")

    def __bytes__(self):
        return self._key


class PrivateKey:
    def __init__(self, private_key=None):
        if private_key is not None:
            if len(private_key) != 32:
                raise ValueError("PrivateKey must be 32 bytes")
            self._key = bytes(private_key)
        else:
            import secrets
            self._key = secrets.token_bytes(32)
        pk_bytes = bytes(sodium.crypto_scalarmult_base(to_js(self._key)).to_py())
        self.public_key = PublicKey(pk_bytes)

    @classmethod
    def generate(cls):
        return cls()

    def __bytes__(self):
        return self._key


class SealedBox:
    """Anonymous public-key encryption (crypto_box_seal)."""
    def __init__(self, key):
        if isinstance(key, PublicKey):
            self._pk = key._key
            self._sk = None
        elif isinstance(key, PrivateKey):
            self._pk = bytes(key.public_key)
            self._sk = key._key
        else:
            raise TypeError("SealedBox requires a PublicKey or PrivateKey")

    def encrypt(self, plaintext):
        return bytes(sodium.crypto_box_seal(to_js(plaintext), to_js(self._pk)).to_py())

    def decrypt(self, ciphertext):
        if self._sk is None:
            raise TypeError("Cannot decrypt with a public key")
        return bytes(sodium.crypto_box_seal_open(
            to_js(ciphertext), to_js(self._pk), to_js(self._sk)
        ).to_py())
`);

  pyodide.FS.writeFile('/lib/python/nacl/secret.py', `
"""nacl.secret shim backed by libsodium.js via Pyodide JS interop."""
from pyodide.ffi import to_js
from js import sodium

KEY_SIZE = 32
NONCE_SIZE = 24
MACBYTES = 16


class SecretBox:
    def __init__(self, key):
        if len(key) != KEY_SIZE:
            raise ValueError(f"Key must be {KEY_SIZE} bytes")
        self._key = bytes(key)

    def encrypt(self, plaintext, nonce=None):
        if nonce is None:
            nonce = bytes(sodium.randombytes_buf(NONCE_SIZE).to_py())
        ct = bytes(sodium.crypto_secretbox_easy(
            to_js(plaintext), to_js(nonce), to_js(self._key)
        ).to_py())
        return nonce + ct

    def decrypt(self, ciphertext, nonce=None):
        if nonce is None:
            nonce = ciphertext[:NONCE_SIZE]
            ciphertext = ciphertext[NONCE_SIZE:]
        return bytes(sodium.crypto_secretbox_open_easy(
            to_js(ciphertext), to_js(nonce), to_js(self._key)
        ).to_py())
`);

  pyodide.FS.writeFile('/lib/python/nacl/utils.py', `
"""nacl.utils shim."""
from js import sodium

def random(size):
    return bytes(sodium.randombytes_buf(size).to_py())
`);

  // Add to Python path
  await pyodide.runPythonAsync(`
import sys
if '/lib/python' not in sys.path:
    sys.path.insert(0, '/lib/python')
`);
}

async function loadCoulombSource(pyodide) {
  // Fetch coulomb Python source files and write them to the virtual FS
  const coulombFiles = [
    '__init__.py',
    '__main__.py',
    'cmd.py',
    'config.py',
    'init.py',
    'post.py',
    'create_key.py',
    'identity.py',
    'pull.py',
    'index_walker.py',
    'render.py',
    'rebuild_index.py',
    'verify.py',
    'TimeArchive.py',
    'util.py',
  ];

  pyodide.FS.mkdirTree('/coulomb/coulomb');
  pyodide.FS.mkdirTree('/coulomb/template/static/global');

  // Fetch all source files in parallel
  const fetches = [
    ...coulombFiles.map(fname =>
      fetch(`../coulomb/${fname}`).then(r => r.ok ? r.text() : null)
        .then(text => text && { path: `/coulomb/coulomb/${fname}`, text })
        .catch(() => null)
    ),
    fetch('../template/static/global/style.css').then(r => r.ok ? r.text() : null)
      .then(text => text && { path: '/coulomb/template/static/global/style.css', text })
      .catch(() => null),
  ];

  const results = await Promise.all(fetches);
  for (const file of results) {
    if (file) pyodide.FS.writeFile(file.path, file.text);
  }

  await pyodide.runPythonAsync(`
import sys
if '/coulomb' not in sys.path:
    sys.path.insert(0, '/coulomb')
`);
}

export function getPyodide() {
  return pyodideInstance;
}
