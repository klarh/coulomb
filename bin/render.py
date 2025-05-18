#!/usr/bin/env -S pipx run
# /// script
# dependencies = ["cbor2", "pynacl", "jinja2"]
# ///

import argparse
import collections
import contextlib
import datetime
import hashlib
import os
import shutil
import sqlite3

import cbor2
import jinja2

parser = argparse.ArgumentParser(description='Rebuild indices for updated posts')
parser.add_argument('root', help='Root directory for posts')
parser.add_argument(
    '-c', '--cache-file', help='Cache file (sqlite3 db) for tracking smart rebuilds'
)
parser.add_argument('-x', '--hash-name', default='sha512', help='Hash function to use')
parser.add_argument('-t', '--template-dir', help='Template directory')
parser.add_argument('--change-log', help='Changelog file to write to')

LATEST_PAGE_NAME = 'pages/latest.html'

TEMPLATES = dict(
    post="""<!DOCTYPE html>
<html lang="en">
<head>
    <title>{{ text_config.get('user_post.page_title', 'Posts')|e }}</title>
    <link rel="stylesheet" type="text/css" href="{{root_path}}/static/global/style.css">
</head>
<body>
    <div class="center_column">
    {% for post in posts %}
        <div class="post">
            <p>{{ post.text|e }}</p>
            <div class="timestamp">
                <a href="{{ entries[loop.index0].direct_link }}">{{ post.time }}</a>
            </div>
        </div>
    {% endfor %}
    <div class="foot">
    {% if next_page %}
        <a href="{{ next_page }}"><div class="page_button">Next page</div></a>
    {% endif %}
    {% if previous_page %}
        <a href="{{ previous_page }}"><div class="page_button">Previous page</div></a>
    {% endif %}
    </div>
    </div>
</body>
    """,
)


class BuildCache:
    def __init__(self, root, filename, hash_name):
        self.root = root
        self.filename = filename
        self.hash_name = hash_name
        self.connection = sqlite3.connect(filename)

        self.init()

    def init(self):
        with self.connection as conn:
            conn.execute(
                'CREATE TABLE IF NOT EXISTS page_dependencies (target_path TEXT, source_file TEXT UNIQUE ON CONFLICT REPLACE)'
            )
            conn.execute(
                'CREATE TABLE IF NOT EXISTS last_build (path TEXT UNIQUE ON CONFLICT REPLACE, hash BLOB, hash_name TEXT)'
            )
            conn.execute(
                'CREATE TABLE IF NOT EXISTS pending_changes (path TEXT UNIQUE ON CONFLICT REPLACE, '
                'hash BLOB, hash_name TEXT, is_post INTEGER)'
            )
            conn.execute(
                'CREATE INDEX IF NOT EXISTS dependency_index ON page_dependencies (target_path, source_file)'
            )
            conn.execute(
                'CREATE INDEX IF NOT EXISTS dependency_source ON page_dependencies (source_file)'
            )
            conn.execute(
                'CREATE INDEX IF NOT EXISTS last_build_path ON last_build (path)'
            )
            conn.execute(
                'CREATE INDEX IF NOT EXISTS pending_change_path ON pending_changes (path)'
            )

    def stale_check(self, directory):
        with self.connection as conn:
            self.stale_check_(conn, directory)

    def stale_check_(self, curs, directory):
        recurse = True
        query = 'SELECT hash FROM last_build WHERE path = ? and hash_name = ?'
        index = os.path.join(directory, 'index.cbor')
        reldir = os.path.relpath(directory, self.root)
        with open(index, 'rb') as f:
            index = cbor2.load(f)
        for (last_hash,) in curs.execute(query, (reldir, self.hash_name)):
            recurse = index['self_hashes'][self.hash_name] != last_hash

        if recurse:
            query = 'INSERT INTO pending_changes VALUES (?, ?, ?, ?)'
            qval = (reldir, index['self_hashes'][self.hash_name], self.hash_name, 0)
            curs.execute(query, qval)

            for filename, hashval in index['child_hashes'][self.hash_name].items():
                if not filename.startswith('post.') or not filename.endswith('.cbor'):
                    continue
                qval = (os.path.join(reldir, filename), hashval, self.hash_name, 1)
                curs.execute(query, qval)

            for subdir in index['dirnames']:
                self.stale_check_(curs, os.path.join(directory, subdir))

    def repage(self, pagination=10):
        query = (
            'INSERT INTO page_dependencies (source_file) SELECT '
            'pending_changes.path FROM pending_changes LEFT JOIN '
            'page_dependencies ON page_dependencies.source_file = pending_changes.path '
            'WHERE page_dependencies.target_path IS NULL AND '
            'pending_changes.is_post ORDER BY pending_changes.path'
        )
        for _ in self.connection.execute(query):
            pass

        query = 'SELECT ROWID, source_file FROM page_dependencies WHERE target_path IS NULL ORDER BY source_file LIMIT ?'
        rows = pagination * [None]
        while len(rows) >= pagination:
            rows = list(self.connection.execute(query, (pagination,)))
            if len(rows) >= pagination:
                target_file = rows[-1][1]
                target_bits = target_file.split('/')
                target_bits[0] = 'pages'
                index = target_bits[-1].split('.')[1]
                target_bits[-1] = 'page.{}.html'.format(index)
                target_file = '/'.join(target_bits)

                for rowid, _ in rows:
                    insert_query = (
                        'UPDATE page_dependencies SET target_path = ? WHERE ROWID = ?'
                    )
                    insert_qargs = (target_file, rowid)
                    self.connection.execute(insert_query, insert_qargs)

        self.connection.execute('COMMIT')

    def get_pending_pages(self):
        prev_query = 'SELECT target_path FROM page_dependencies WHERE target_path < ? ORDER BY target_path LIMIT 1'
        next_query = 'SELECT target_path FROM page_dependencies WHERE target_path > ? ORDER BY target_path LIMIT 1'

        query = (
            'SELECT DISTINCT target_path FROM page_dependencies INNER JOIN pending_changes ON '
            'page_dependencies.source_file = pending_changes.path WHERE target_path NOT NULL'
        )
        paths = list(self.connection.execute(query))
        query = 'SELECT source_file FROM page_dependencies WHERE target_path = ? ORDER BY source_file DESC'

        description = {}
        groups = {}
        path = None
        for (path,) in paths:
            description = groups[path] = {}
            files = groups[path].setdefault('files', [])
            for (filename,) in self.connection.execute(query, (path,)):
                files.append(filename)

            for (nextpath,) in self.connection.execute(next_query, (path,)):
                description['next_page'] = nextpath
            for (prevpath,) in self.connection.execute(prev_query, (path,)):
                description['previous_page'] = prevpath

        description['next_page'] = LATEST_PAGE_NAME

        query = 'SELECT source_file FROM page_dependencies WHERE target_path IS NULL ORDER BY source_file DESC'
        description = groups[LATEST_PAGE_NAME] = {}
        if path is not None:
            description['previous_page'] = path
        files = groups[LATEST_PAGE_NAME].setdefault('files', [])
        for (filename,) in self.connection.execute(query):
            files.append(filename)
        if not files:
            groups[path].pop('next_page', None)
            description = groups[LATEST_PAGE_NAME] = dict(groups[path])

        return groups

    def update_built_files(self):
        query = (
            'INSERT INTO last_build (path, hash, hash_name) SELECT '
            'path, hash, hash_name FROM pending_changes'
        )
        self.connection.execute(query)
        self.connection.execute('DELETE FROM pending_changes')
        self.connection.execute('COMMIT')


def write_page_html(
    templates, root, target_filename, description, change_log, text_config
):
    print('writing', description, 'to', target_filename)
    target_filename = os.path.join(root, target_filename)
    dirname = os.path.dirname(target_filename)

    entries = []
    for fname in description['files']:
        full_fname = os.path.join(root, fname)
        with open(full_fname, 'rb') as f:
            entries.append(cbor2.load(f))

        post_bits = fname.split('/')
        post_bits[0] = 'posts'
        index = post_bits[-1].split('.')[1]
        post_bits[-1] = 'post.{}.html'.format(index)
        post_file = '/'.join(post_bits)
        post_file = os.path.join(root, post_file)
        post_dir = os.path.dirname(post_file)

        template_args = dict(
            entries=entries[-1:],
            posts=[entries[-1]['content']],
            root_path=os.path.relpath(root, post_dir),
            parent_path=os.path.relpath(target_filename, os.path.dirname(post_file)),
            text_config=text_config,
        )
        os.makedirs(post_dir, exist_ok=True)
        with open(post_file, 'w') as f:
            f.write(templates['post'].render(**template_args))
        entries[-1]['direct_link'] = os.path.relpath(post_file, dirname)
        if change_log is not None:
            change_log.write('{}\n'.format(os.path.relpath(post_file, root)))

    os.makedirs(dirname, exist_ok=True)
    for name in ('next_page', 'previous_page'):
        if name in description:
            description[name] = os.path.relpath(
                os.path.join(root, description[name]), dirname
            )
    posts = [entry['content'] for entry in entries]
    template_args = dict(
        entries=entries,
        posts=posts,
        **description,
        root_path=os.path.relpath(root, dirname),
        text_config=text_config,
    )

    with open(target_filename, 'w') as f:
        f.write(templates['post'].render(**template_args))
    if change_log is not None:
        change_log.write('{}\n'.format(os.path.relpath(target_filename, root)))


def main(root, cache_file, hash_name, template_dir, change_log):
    env = jinja2.Environment()
    templates = {}
    if template_dir:
        with open(os.path.join(template_dir, 'post.jinja'), 'r') as f:
            templates['post'] = env.from_string(f.read())
    else:
        for k, v in TEMPLATES.items():
            templates[k] = env.from_string(v)

    try:
        with open(os.path.join(root, 'config.cbor'), 'rb') as f:
            config = cbor2.load(f).get('config', {})
            text_config = config['text_values']
    except FileNotFoundError:
        text_config = {}

    cache = BuildCache(root, cache_file, hash_name)
    cache.stale_check(os.path.join(root, 'content'))
    cache.repage()
    file_groups = cache.get_pending_pages()

    with contextlib.ExitStack() as stack:
        if change_log is not None:
            change_log = stack.enter_context(open(change_log, 'a'))

        for target_html, description in file_groups.items():
            write_page_html(
                templates, root, target_html, description, change_log, text_config
            )

    cache.update_built_files()


if __name__ == '__main__':
    main(**vars(parser.parse_args()))
