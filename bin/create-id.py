#!/usr/bin/env -S pipx run
# /// script
# dependencies = ["cbor2", "pynacl"]
# ///

import argparse
import re
import os

import cbor2
import nacl.public
import nacl.signing

parser = argparse.ArgumentParser(description='Create a new ID')
parser.add_argument('private', help='Private location for storage of private key')
parser.add_argument('public', help='Public root location for storage of public key')
parser.add_argument('-n', '--name', default='main', help='Name of identity to generate')


def main(private, public, name):
    enc_key = nacl.public.PrivateKey.generate()
    sign_key = nacl.signing.SigningKey.generate()
    private_keys = dict(
        encryption=bytes(enc_key),
        signing=bytes(sign_key),
        api='pynacl',
    )
    public_keys = dict(
        encryption=bytes(enc_key.public_key),
        signing=bytes(sign_key.verify_key),
        api='pynacl',
    )

    assert name.isidentifier(), 'Invalid name: "{}"'.format(name)
    assert not os.path.abspath(public).startswith(
        os.path.abspath(private)
    ), 'Private directory can\'t be a subdirectory of the public'

    public_id_dir = os.path.join(public, 'identities')
    public_id_fname = os.path.join(public_id_dir, '{}.cbor'.format(name))
    assert not os.path.exists(public_id_fname), 'Identities must have a unique name'
    private_fname = os.path.join(private, '{}.cbor'.format(name))
    assert not os.path.exists(private_fname), 'Private key already exists at {}'.format(
        private_fname
    )

    os.makedirs(private, exist_ok=True)
    os.makedirs(public_id_dir, exist_ok=True)
    with open(private_fname, 'wb') as f:
        cbor2.dump(private_keys, f, canonical=True)
    with open(public_id_fname, 'wb') as f:
        cbor2.dump(public_keys, f, canonical=True)


if __name__ == '__main__':
    main(**vars(parser.parse_args()))
