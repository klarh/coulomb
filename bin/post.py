#!/usr/bin/env -S pipx run
# /// script
# dependencies = ["cbor2", "pynacl"]
# ///

import argparse
import datetime
import os
import shutil

import cbor2
import nacl.signing

parser = argparse.ArgumentParser(description='Make a post')
parser.add_argument('root', help='Root directory for posts')
parser.add_argument('-t', '--text', help='Text content of message')
parser.add_argument(
    '-f', '--files', nargs='+', default=[], help='Additional files to store and link'
)
parser.add_argument(
    '-s', '--signatures', nargs='*', default=[], help='Keys to use to sign'
)
parser.add_argument(
    '-c',
    '--changelogs',
    nargs='*',
    default=[],
    help='Changelog file to record changes to',
)
parser.add_argument(
    '-l',
    '--locations',
    nargs='*',
    default=[],
    help='Canonical locations to embed within posts',
)


def main(root, text, files, signatures, changelogs, locations):
    sign_keys = {}
    for s in signatures:
        with open(s, 'rb') as f:
            name = os.path.basename(s)
            key = cbor2.load(f)['signing']
            key = nacl.signing.SigningKey(key)
            sign_keys[name] = key

    filenames = files
    assert not any(
        os.path.basename(f) == 'index.cbor' for f in filenames
    ), 'Can not link a file named index.cbor'
    assert len({os.path.basename(f) for f in filenames}) == len(
        filenames
    ), 'Files must have unique names'
    files = []

    for name in sorted(set(filenames)):
        target_name = os.path.basename(name)
        entry = dict(name=target_name)
        assert os.path.isfile(name)
        with open(name, 'rb') as f:
            b = f.read()
        entry['signatures'] = {k: s.sign(b).signature for k, s in sign_keys.items()}
        files.append(entry)

    done = False
    while not done:
        current_time = datetime.datetime.now(datetime.timezone.utc)
        post_id = current_time.strftime('%Y%m%d%H%M%S%f')

        post = dict(
            files=files,
            id=post_id,
            locations=locations,
            text=text,
            time=current_time.isoformat(),
        )

        post_enc = cbor2.dumps(post, canonical=True)
        entry = dict(
            content=post,
            signatures={k: s.sign(post_enc).signature for k, s in sign_keys.items()},
        )

        time_subdir = current_time.strftime('%Y/%m%d/%H%M')
        target_dir = os.path.join(root, 'content', time_subdir)

        post_fname = os.path.join(target_dir, 'post.{}.cbor'.format(post_id))
        if os.path.exists(post_fname):
            continue

        changed_files = [post_fname]

        if files:
            media_dir = os.path.join(target_dir, post_id)
            os.makedirs(media_dir)
            for fname in filenames:
                shutil.copy(fname, media_dir)

                changed_files.append(os.path.join(media_dir, os.path.basename(fname)))

        os.makedirs(target_dir, exist_ok=True)
        with open(post_fname, 'wb') as f:
            cbor2.dump(entry, f, canonical=True)

        done = True

    for logname in changelogs:
        with open(logname, 'a') as f:
            for filename in changed_files:
                filename = os.path.relpath(filename, root)
                f.write('{}\n'.format(filename))


if __name__ == '__main__':
    main(**vars(parser.parse_args()))
