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

parser = argparse.ArgumentParser(
    description='Create or edit a repository configuration'
)
parser.add_argument('root', help='Root directory for posts')
parser.add_argument(
    '-s', '--signatures', nargs='*', default=[], help='Keys to use to sign'
)
parser.add_argument('--add-identity', help='Additional identity to embed')
parser.add_argument(
    '-t',
    '--text',
    nargs=2,
    action='append',
    help='(key, value) pair of text quantities to set',
)
parser.add_argument(
    '-c',
    '--changelogs',
    nargs='*',
    default=[],
    help='Changelog file to record changes to',
)


def main(root, signatures, add_identity, text, changelogs):
    sign_keys = {}
    for s in signatures:
        with open(s, 'rb') as f:
            name = os.path.basename(s)
            key = cbor2.load(f)['signing']
            key = nacl.signing.SigningKey(key)
            sign_keys[name] = key

    config_fname = os.path.join(root, 'config.cbor')
    try:
        with open(config_fname, 'rb') as f:
            entry = cbor2.load(f)
            config = entry.setdefault('config', {})
    except FileNotFoundError:
        config = {}
        entry = dict(config=config)

    if add_identity:
        ident_keys = config.setdefault('identities', {})
        fname = os.path.join(root, 'identities', '{}.cbor'.format(add_identity))
        with open(fname, 'rb') as f:
            identity = cbor2.load(f)
        ident_keys[add_identity] = identity

    if text:
        texts = config.setdefault('text_values', {})
        for k, v in text:
            texts[k] = v

    config_enc = cbor2.dumps(config, canonical=True)
    entry['signatures'] = {
        k: s.sign(config_enc).signature for k, s in sign_keys.items()
    }

    with open(config_fname, 'wb') as f:
        cbor2.dump(entry, f, canonical=True)

    for logname in changelogs:
        with open(logname, 'a') as f:
            f.write('config.cbor\n')


if __name__ == '__main__':
    main(**vars(parser.parse_args()))
