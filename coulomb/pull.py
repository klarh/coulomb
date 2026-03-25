import datetime
import os
import sqlite3
from posixpath import join as urljoin

import cbor2

from .cmd import register_subcommand
from .TimeArchive import TimeArchive


@register_subcommand('pull', help='Import external post repositories')
def add_parser_args(parser):
    parser.add_argument('root', help='Root (target) directory for posts')
    parser.add_argument(
        'cache_file', help='Cache file (sqlite3 db) for tracking smart updates'
    )
    parser.add_argument(
        'sources', nargs='+', help='Source locations to draw additional posts'
    )
    parser.add_argument(
        '-x', '--hash-name', default='sha512', help='Hash function to use'
    )
    parser.add_argument('--change-log', help='Changelog file to write to')


class Queries:
    create_sources = ' '.join(
        [
            'CREATE TABLE IF NOT EXISTS sources',
            '(location TEXT UNIQUE ON CONFLICT IGNORE)',
        ]
    )
    create_hashes = ' '.join(
        [
            'CREATE TABLE IF NOT EXISTS source_hashes (',
            'source_id INTEGER, path TEXT, hash BLOB, hash_name TEXT,',
            'UNIQUE(source_id, path) ON CONFLICT REPLACE)',
        ]
    )
    create_remaps = ' '.join(
        [
            'CREATE TABLE IF NOT EXISTS remaps (',
            'source_id INTEGER, source_path TEXT, dest_path TEXT,',
            'UNIQUE(source_id, source_path) ON CONFLICT IGNORE)',
        ]
    )

    init = ';'.join([create_sources, create_hashes, create_remaps])

    select_hash = ' '.join(
        [
            'SELECT hash FROM source_hashes',
            'WHERE source_id = ?',
            'AND source_hashes.path = ?',
            'AND source_hashes.hash_name = ?',
        ]
    )

    insert_location = 'INSERT INTO sources VALUES (?)'

    lookup_location = 'SELECT ROWID from sources WHERE location = ?'

    insert_hash = 'INSERT INTO source_hashes VALUES (?, ?, ?, ?)'

    get_hash = ' '.join(
        [
            'SELECT hash FROM source_hashes WHERE',
            'source_id = ? AND path = ? AND hash_name = ?',
        ]
    )

    get_remap = ' '.join(
        ['SELECT dest_path FROM remaps WHERE', 'source_id = ? AND source_path = ?']
    )

    set_remap = 'INSERT INTO remaps VALUES (?, ?, ?)'


def _url_fetcher(location):
    import urllib.request
    with urllib.request.urlopen(location) as f:
        return f.read()


def _local_fetcher(location):
    with open(location, 'rb') as f:
        return f.read()


class PullCache:
    def __init__(self, root, filename, hash_name, fetcher=None, change_log=None):
        self.root = root
        self.filename = filename
        self.hash_name = hash_name
        self.connection = sqlite3.connect(filename)
        self._fetcher = fetcher or _url_fetcher
        self.change_log = change_log
        self.imported_count = 0

        self.init()

    def init(self):
        with self.connection as conn:
            conn.executescript(Queries.init)

    def get(self, location):
        return self._fetcher(location)

    def _log_change(self, relpath):
        if self.change_log:
            self.change_log.write(relpath + '\n')

    def stale_check(self, location):
        location_id = None
        with self.connection as conn:
            conn.execute(Queries.insert_location, (location,))
            for (location_id,) in conn.execute(Queries.lookup_location, (location,)):
                pass

        self._walk(location, location_id, '.')

    def _walk(self, location, remote_id, remote_subdir):
        recurse = True
        index_bytes = self.get(urljoin(location, remote_subdir, 'index.cbor'))
        index = cbor2.loads(index_bytes)

        with self.connection as conn:
            for (last_hash,) in conn.execute(
                Queries.select_hash, (remote_id, remote_subdir, self.hash_name)
            ):
                recurse = index['self_hashes'][self.hash_name] != last_hash

        if not recurse:
            return

        # Import post/reply entries and identity files from this directory
        for filename, hashval in index['child_hashes'][self.hash_name].items():
            bits = filename.split('.')
            if not filename.endswith('cbor') or len(bits) < 3:
                continue

            entry_type = bits[0]
            entry_id = bits[1]

            if entry_type in ('post', 'reply'):
                sub_filename = urljoin(remote_subdir, filename)
                self._import_post(
                    location, remote_id, sub_filename, hashval, entry_type, entry_id
                )
            elif entry_type == 'identity':
                sub_filename = urljoin(remote_subdir, filename)
                self._import_identity(
                    location, remote_id, sub_filename, hashval, remote_subdir
                )

        # Also import latest.cbor in identity directories
        if 'latest.cbor' in index.get('filenames', []):
            latest_path = urljoin(remote_subdir, 'latest.cbor')
            latest_hash = index['child_hashes'][self.hash_name].get('latest.cbor')
            if latest_hash:
                self._import_identity(
                    location, remote_id, latest_path, latest_hash, remote_subdir
                )

        # Recurse into subdirectories
        for subdir in index.get('dirnames', []):
            if subdir == '.':
                continue
            self._walk(location, remote_id, urljoin(remote_subdir, subdir))

        # Update cached hash for this directory
        qval = (
            remote_id,
            remote_subdir,
            index['self_hashes'][self.hash_name],
            self.hash_name,
        )
        with self.connection as conn:
            conn.execute(Queries.insert_hash, qval)

    def _import_post(self, location, remote_id, filename, hashval, entry_type, entry_id):
        with self.connection as conn:
            last_hash = None
            for (last_hash,) in conn.execute(
                Queries.get_hash, (remote_id, filename, self.hash_name)
            ):
                pass

            if last_hash == hashval:
                return

            dest_path = None
            for (dest_path,) in conn.execute(Queries.get_remap, (remote_id, filename)):
                pass

            if not dest_path:
                dest_path = self._remap_post(
                    conn, remote_id, location, filename, entry_type, entry_id
                )

            # Update hash after successful import
            conn.execute(Queries.insert_hash, (
                remote_id, filename, hashval, self.hash_name
            ))

    def _remap_post(self, conn, remote_id, location, filename, entry_type, entry_id):
        archive_kwargs = dict(prefix='posts')

        entry_bytes = self.get(urljoin(location, filename))
        entry = cbor2.loads(entry_bytes)
        timestamp = datetime.datetime.fromisoformat(entry['content']['time'])

        if entry_type == 'reply':
            reply_target_timestamp = datetime.datetime.fromisoformat(
                entry['content']['reply_to']['post_id']
            )
            target_archive = TimeArchive(prefix='posts')
            target_path = target_archive.get_path(reply_target_timestamp)
            reply_subdir = os.path.join(target_path.subdirectory, 'replies')
            archive_kwargs['subdir_format'] = reply_subdir
        else:
            archive_kwargs['prefix'] = 'posts'

        bump = 0
        while True:
            if entry_type == 'reply':
                archive_kwargs['entry_format'] = 'reply.{{id}}.{}.cbor'.format(bump)
            else:
                archive_kwargs['entry_format'] = 'post.{{id}}.{}.cbor'.format(bump)

            dest_archive = TimeArchive(**archive_kwargs)
            dest_path = dest_archive.get_path(timestamp)
            full_dest = os.path.join(self.root, dest_path.path)

            if not os.path.exists(full_dest):
                break

            bump += 1

        conn.execute(Queries.set_remap, (remote_id, filename, dest_path.path))

        os.makedirs(os.path.dirname(full_dest), exist_ok=True)
        with open(full_dest, 'wb') as f:
            f.write(entry_bytes)
        self._log_change(dest_path.path)
        self.imported_count += 1
        return dest_path.path

    def _import_identity(self, location, remote_id, filename, hashval, remote_subdir):
        with self.connection as conn:
            last_hash = None
            for (last_hash,) in conn.execute(
                Queries.get_hash, (remote_id, filename, self.hash_name)
            ):
                pass

            if last_hash == hashval:
                return

        entry_bytes = self.get(urljoin(location, filename))

        # Preserve the identity directory structure: identity/<key_id>/...
        dest_path = filename
        full_dest = os.path.join(self.root, dest_path)

        os.makedirs(os.path.dirname(full_dest), exist_ok=True)
        with open(full_dest, 'wb') as f:
            f.write(entry_bytes)
        self._log_change(dest_path)
        self.imported_count += 1

        with self.connection as conn:
            conn.execute(Queries.insert_hash, (
                remote_id, filename, hashval, self.hash_name
            ))


def main(root, cache_file, sources, hash_name, change_log, fetcher=None):
    import contextlib

    change_log_fh = None
    if isinstance(change_log, str):
        change_log_fh = open(change_log, 'a')
    elif change_log is not None:
        change_log_fh = change_log

    cache = PullCache(
        root, cache_file, hash_name,
        fetcher=fetcher, change_log=change_log_fh
    )

    try:
        for src in sources:
            cache.stale_check(src)
    finally:
        if isinstance(change_log, str) and change_log_fh:
            change_log_fh.close()

    return cache.imported_count
