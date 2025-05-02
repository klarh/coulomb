#!/usr/bin/env -S pipx run
# /// script
# dependencies = ["cbor2"]
# ///

import argparse
import hashlib
import os

import cbor2

parser = argparse.ArgumentParser(description='Hash a directory structure')
parser.add_argument('directory', help='Directory to hash')
parser.add_argument(
    '--hashes', nargs='+', default=[], help='Additional hashes to compute'
)
parser.add_argument(
    '-s',
    '--max-size',
    type=int,
    default=1,
    help='Maximum number of entries to store in a given index',
)


def main(directory, hashes, max_size):
    hashes = set(hashes)
    hashes.add('sha512')

    hashfuns = [getattr(hashlib, h) for h in hashes]


if __name__ == '__main__':
    main(**vars(parser.parse_args()))
