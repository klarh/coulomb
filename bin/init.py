#!/usr/bin/env -S pipx run
# /// script
# dependencies = ["cbor2", "pynacl"]
# ///

import argparse
import contextlib
import os
import shutil


parser = argparse.ArgumentParser(description='Initialize a post repository')
parser.add_argument('root', help='Root directory for repository')
parser.add_argument('-s', '--source', help='Source template directory')
parser.add_argument('-c', '--change-log', help='Changelog file to append to')


def main(root, source, change_log):
    if source is None:
        script_dir = os.path.dirname(__file__)
        source = os.path.join(script_dir, '..', 'template')

    assert os.path.exists(source)

    with contextlib.ExitStack() as stack:
        if change_log is not None:
            change_log = stack.enter_context(open(change_log, 'a'))

        for dirpath, _, fnames in os.walk(source):
            reldir = os.path.relpath(dirpath, source)
            target_dir = os.path.join(root, reldir)
            os.makedirs(target_dir, exist_ok=True)
            for fname in fnames:
                shutil.copy(os.path.join(dirpath, fname), target_dir)
                if change_log is not None:
                    change_log.write('{}\n'.format(os.path.join(reldir, fname)))


if __name__ == '__main__':
    main(**vars(parser.parse_args()))
