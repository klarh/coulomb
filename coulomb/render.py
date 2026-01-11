import argparse
import collections
import contextlib
import datetime
import enum
import hashlib
import os
import shutil
import sqlite3

import cbor2
import jinja2

from .cmd import register_subcommand


@register_subcommand('render', help='Render HTML views of posts')
def add_parser_args(parser):
    parser.add_argument('root', help='Root directory for posts')
    parser.add_argument(
        '-c', '--cache-file', help='Cache file (sqlite3 db) for tracking smart rebuilds'
    )
    parser.add_argument(
        '-x', '--hash-name', default='sha512', help='Hash function to use'
    )
    parser.add_argument('-t', '--template-dir', help='Template directory')
    parser.add_argument('--change-log', help='Changelog file to write to')
    parser.add_argument(
        '-p',
        '--post-dirs',
        nargs='*',
        default=['posts'],
        help='Subdirectories containing post content',
    )
    parser.add_argument(
        '--html-dir', default='pages', help='Subdirectory for rendered HTML'
    )


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
            <div class="author">{{ post.author.get('config', {}).get('user.display_name', 'User {}'.format(post.author.id))|e }}</div>
            <p class="post_text">{{ post.text|e }}</p>
            <div class="timestamp">
                <a href="{{ entries[loop.index0].direct_link }}">{{ post.time }}</a>
            </div>
        {% for reply in post.get('replies', []) %}
            <div class="post">
                <div class="author">{{ reply.author.get('config', {}).get('user.display_name', 'User {}'.format(reply.author.id))|e }}</div>
                <p class="post_text">{{ reply.text|e }}</p>
                <div class="timestamp">
                    <a href="{{ entries[loop.index0].direct_link }}">{{ reply.time }}</a>
                </div>
            </div>
        {% endfor %}
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


class EntryType(enum.Enum):
    directory = 0
    post = 1
    reply = 2


class BuildCache:
    class Queries:
        create_page_dependencies = ' '.join(
            [
                'CREATE TABLE IF NOT EXISTS page_dependencies (',
                'target_path TEXT,',
                'source_file TEXT UNIQUE ON CONFLICT REPLACE,',
                'timestamp TEXT)',
            ]
        )
        create_last_build = ' '.join(
            [
                'CREATE TABLE IF NOT EXISTS last_build (',
                'path TEXT UNIQUE ON CONFLICT REPLACE,',
                'hash BLOB, hash_name TEXT)',
            ]
        )
        create_pending_changes = ' '.join(
            [
                'CREATE TABLE IF NOT EXISTS pending_changes (',
                'path TEXT UNIQUE ON CONFLICT REPLACE,',
                'hash BLOB, hash_name TEXT, entry_type INTEGER,',
                'timestamp TEXT)',
            ]
        )
        create_reply = ' '.join(
            [
                'CREATE TABLE IF NOT EXISTS replies (',
                'target_user TEXT, target_id TEXT,',
                'source_file TEXT UNIQUE ON CONFLICT IGNORE,',
                'target_post_pattern TEXT)',
            ]
        )
        create_dependency_index = ' '.join(
            [
                'CREATE INDEX IF NOT EXISTS dependency_index ON',
                'page_dependencies (target_path, source_file)',
            ]
        )
        create_dependency_source = ' '.join(
            [
                'CREATE INDEX IF NOT EXISTS dependency_source ON',
                'page_dependencies (source_file)',
            ]
        )
        create_dependency_pathtime = ' '.join(
            [
                'CREATE INDEX IF NOT EXISTS dependency_path_time ON',
                'page_dependencies (target_path, timestamp)',
            ]
        )
        create_pending_entrytime = ' '.join(
            [
                'CREATE INDEX IF NOT EXISTS pending_type_time ON',
                'pending_changes (entry_type, timestamp)',
            ]
        )
        create_replies_target = ' '.join(
            [
                'CREATE INDEX IF NOT EXISTS replies_target ON',
                'replies (target_user, target_id)',
            ]
        )
        create_replies_pattern = ' '.join(
            [
                'CREATE INDEX IF NOT EXISTS replies_pattern ON',
                'replies (target_post_pattern)',
            ]
        )
        create_pending_path = ' '.join(
            [
                'CREATE INDEX IF NOT EXISTS pending_path ON',
                'pending_changes (path)',
            ]
        )
        create_last_build_lookup = ' '.join(
            [
                'CREATE INDEX IF NOT EXISTS last_build_lookup ON',
                'last_build (path, hash_name)',
            ]
        )
        create_dependency_target_nonnull = ' '.join(
            [
                'CREATE INDEX IF NOT EXISTS dependency_target_nonnull ON',
                'page_dependencies (target_path) WHERE target_path IS NOT NULL',
            ]
        )

        init = ';'.join(
            [
                create_page_dependencies,
                create_last_build,
                create_pending_changes,
                create_reply,
                create_dependency_index,
                create_dependency_source,
                create_dependency_pathtime,
                create_pending_entrytime,
                create_replies_target,
                create_replies_pattern,
                create_pending_path,
                create_last_build_lookup,
                create_dependency_target_nonnull,
            ]
        )

        select_stale_hash = (
            'SELECT hash FROM last_build WHERE path = ? and hash_name = ?'
        )

        insert_stale_check = 'INSERT INTO pending_changes VALUES (?, ?, ?, ?, ?)'

        insert_reply = 'INSERT INTO replies VALUES (?, ?, ?, ?)'

        insert_repage = ' '.join(
            [
                'INSERT INTO page_dependencies (source_file, timestamp)',
                'SELECT pending_changes.path, pending_changes.timestamp',
                'FROM pending_changes LEFT JOIN page_dependencies ON ',
                'page_dependencies.source_file = pending_changes.path ',
                'WHERE page_dependencies.target_path IS NULL AND '
                f'pending_changes.entry_type = {EntryType.post.value}',
                'ORDER BY pending_changes.timestamp',
            ]
        )

        select_repage = ' '.join(
            [
                'SELECT ROWID, source_file FROM page_dependencies WHERE',
                'target_path IS NULL ORDER BY timestamp LIMIT ?',
            ]
        )

        update_repage = 'UPDATE page_dependencies SET target_path = ? WHERE ROWID = ?'

        insert_replies_repage = ' '.join(
            [
                'INSERT INTO page_dependencies (target_path, source_file, timestamp)',
                'SELECT parent.target_path, pending.path, pending.timestamp',
                'FROM pending_changes AS pending',
                'JOIN replies ON replies.source_file = pending.path',
                'JOIN page_dependencies AS parent ON ',
                'parent.source_file = replies.target_post_pattern',
                f'WHERE pending.entry_type = {EntryType.reply.value}',
                'AND parent.target_path IS NOT NULL',
            ]
        )

        select_prev_page = ' '.join(
            [
                'SELECT target_path FROM page_dependencies WHERE',
                'target_path < ? AND target_path IS NOT NULL',
                'ORDER BY target_path DESC LIMIT 1',
            ]
        )

        select_next_page = ' '.join(
            [
                'SELECT target_path FROM page_dependencies WHERE',
                'target_path > ? AND target_path IS NOT NULL',
                'ORDER BY target_path LIMIT 1',
            ]
        )

        select_pending_dependencies = ' '.join(
            [
                'SELECT DISTINCT target_path FROM page_dependencies',
                'INNER JOIN pending_changes ON',
                'page_dependencies.source_file = pending_changes.path',
                'WHERE target_path IS NOT NULL',
            ]
        )

        select_source_pending = ' '.join(
            [
                'SELECT source_file FROM page_dependencies',
                'WHERE target_path = ? ORDER BY timestamp DESC',
            ]
        )

        select_null_dependency = ' '.join(
            [
                'WITH latest_posts AS (',
                '  SELECT source_file FROM page_dependencies WHERE target_path IS NULL',
                ')',
                'SELECT source_file FROM latest_posts',
                'UNION ALL',
                'SELECT p.path FROM pending_changes p',
                'JOIN replies r ON r.source_file = p.path',
                'JOIN latest_posts lp ON lp.source_file = r.target_post_pattern',
                f'WHERE p.entry_type = {EntryType.reply.value}',
            ]
        )

        select_prev_page_nonnull = ' '.join(
            [
                'SELECT target_path FROM page_dependencies',
                'WHERE target_path IS NOT NULL ORDER BY target_path DESC LIMIT 1',
            ]
        )

        insert_build_update = ' '.join(
            [
                'INSERT INTO last_build (path, hash, hash_name) SELECT',
                'path, hash, hash_name FROM pending_changes',
            ]
        )

        delete_after_update = ' '.join(
            [
                'DELETE FROM pending_changes WHERE EXISTS (',
                '  SELECT 1 FROM page_dependencies WHERE',
                '  page_dependencies.source_file = pending_changes.path)',
            ]
        )

    def __init__(self, root, filename, hash_name, subdir):
        self.root = root
        self.filename = filename
        self.hash_name = hash_name
        self.subdir = subdir
        self.connection = sqlite3.connect(filename)

        self.init()

    def init(self):
        with self.connection as conn:
            conn.executescript(self.Queries.init)

    def stale_check(self, directory):
        with self.connection as conn:
            self.stale_check_(conn, directory)

    def stale_check_(self, curs, directory):
        recurse = True
        query = self.Queries.select_stale_hash
        index = os.path.join(directory, 'index.cbor')
        reldir = os.path.relpath(directory, self.root)
        with open(index, 'rb') as f:
            index = cbor2.load(f)
        for (last_hash,) in curs.execute(query, (reldir, self.hash_name)):
            recurse = index['self_hashes'][self.hash_name] != last_hash

        if recurse:
            query = self.Queries.insert_stale_check
            qval = (
                reldir,
                index['self_hashes'][self.hash_name],
                self.hash_name,
                EntryType.directory.value,
                None,
            )
            curs.execute(query, qval)

            for filename, hashval in index['child_hashes'][self.hash_name].items():
                bits = filename.split('.')
                if len(bits) < 3 or not filename.endswith('cbor'):
                    continue
                entry_type = bits[0]
                if entry_type not in ('post', 'reply'):
                    continue
                timestamp = filename.split('.')[-2]
                relpath = os.path.join(reldir, filename)
                qval = (
                    relpath,
                    hashval,
                    self.hash_name,
                    EntryType[entry_type].value,
                    timestamp,
                )
                curs.execute(query, qval)

                if entry_type == 'reply':
                    self.parse_reply(curs, relpath)

            for subdir in index['dirnames']:
                self.stale_check_(curs, os.path.join(directory, subdir))

    def parse_reply(self, curs, relpath):
        bits = relpath.split('/')
        try:
            target_author = bits[-3]
            target_id = bits[-2]
        except IndexError:
            return None

        if not target_author.isalnum():
            return None
        elif not target_id.isalnum():
            return None

        # Directly build reply target filename to avoid dynamic LIKE matches
        target_post_pattern = f'posts/{target_author}/{target_id}/post.{target_id}.cbor'

        query = self.Queries.insert_reply
        return curs.execute(
            query, (target_author, target_id, relpath, target_post_pattern)
        )

    def repage(self, pagination=10):
        # place all pending changes posts into page_dependencies
        for _ in self.connection.execute(self.Queries.insert_repage):
            pass

        # assign page targets if a page's worth of unpaged posts exist
        select_query = self.Queries.select_repage
        insert_query = self.Queries.update_repage
        rows = pagination * [None]
        while len(rows) >= pagination:
            rows = list(self.connection.execute(select_query, (pagination,)))
            if len(rows) >= pagination:
                target_file = rows[-1][1]
                target_bits = target_file.split('/')
                target_bits[0] = self.subdir
                index = target_bits[-1].split('.')[1]
                target_bits[-1] = 'page.{}.html'.format(index)
                target_file = '/'.join(target_bits)

                for rowid, _ in rows:
                    insert_qargs = (target_file, rowid)
                    self.connection.execute(insert_query, insert_qargs)

        # add replies to the dependency graph of any pages that exist
        for _ in self.connection.execute(self.Queries.insert_replies_repage):
            pass

        self.connection.commit()

    def get_pending_pages(self):
        prev_query = self.Queries.select_prev_page
        next_query = self.Queries.select_next_page

        query = self.Queries.select_pending_dependencies
        paths = list(self.connection.execute(query))
        query = self.Queries.select_source_pending

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

        latest_page_name = os.path.join(self.subdir, 'latest.html')
        description['next_page'] = latest_page_name

        description = groups[latest_page_name] = {}
        prev_query = self.Queries.select_prev_page_nonnull
        for (prevpath,) in self.connection.execute(prev_query):
            description['previous_page'] = prevpath
        files = groups[latest_page_name].setdefault('files', [])
        query = self.Queries.select_null_dependency
        for (filename,) in self.connection.execute(query):
            files.append(filename)
        if not files:
            groups[path].pop('next_page', None)
            description = groups[latest_page_name] = dict(groups[path])

        return groups

    def update_built_files(self):
        self.connection.execute(self.Queries.insert_build_update)
        self.connection.execute(self.Queries.delete_after_update)
        self.connection.commit()


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
    selected_posts = [entry['content'] for entry in entries]

    make_key = lambda p: (p['author']['id'], p['id'])
    post_index = {}
    roots = {}
    posts = []
    pending = []
    for p in selected_posts:
        key = make_key(p)
        post_index[key] = p
        if 'reply_to' in p:
            key = (p['reply_to']['author'], p['reply_to']['post_id'])
            pending.append((key, p))
        else:
            posts.append(p)
            roots[key] = p

    while pending:
        progress = False
        pending.sort(key=lambda x: x[0] in roots)
        while pending and pending[-1][0] in roots:
            progress = True
            parent_key, child = pending.pop()
            roots[make_key(child)] = roots[parent_key]
        if not progress:
            print('WARNING: child graph traversal issue')
            break

    for k, root_post in roots.items():
        # skip root-level posts
        if k == make_key(root_post):
            continue

        root_post.setdefault('replies', []).append(post_index[k])

    for p in post_index.values():
        if 'replies' in p:
            p['replies'].sort(key=lambda x: x['time'])

    posts.sort(key=lambda x: x['time'], reverse=True)

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


def main(root, cache_file, hash_name, template_dir, change_log, post_dirs, html_dir):
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

    cache = BuildCache(root, cache_file, hash_name, html_dir)
    for post_dir in post_dirs:
        cache.stale_check(os.path.join(root, post_dir))
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
    parser = argparse.ArgumentParser()
    add_parser_args(parser)
    main(**vars(parser.parse_args()))
