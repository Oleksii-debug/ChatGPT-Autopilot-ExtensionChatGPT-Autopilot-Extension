"""Exact offline membership in a finite primary morphological lexicon.

Format DMLX0001 stores sorted UTF-8 words in independent front-coded zlib
blocks. A language bitset preserves every recorded membership, including
homographs. Unknown means absent from these finite sources, never a proven
language or an instruction to synthesize a fallback voice.

Only Python's standard library is used. File data are mapped read-only and
the decoded block cache is explicitly bounded. This module is not wired into
a driver; callers must supply the trusted artifact SHA256 and own its lifetime.
"""
from __future__ import annotations

from bisect import bisect_left, bisect_right
from collections import OrderedDict
import hashlib
import json
import mmap
import os
from pathlib import Path
import re
import stat
import struct
from threading import RLock
import unicodedata
import zlib

MAGIC = b"DMLX0001"
NORMALIZATION = "nfc-casefold-cyrillic-acute-apostrophes-v1"
HEADER = struct.Struct("<8sIII")
KEY_LENGTH = struct.Struct("<H")
INDEX_ITEM = struct.Struct("<QIIH")
WORD_ITEM = struct.Struct("<HH")
MAX_CODES = 1024
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_META_BYTES = 1024 * 1024
MAX_INDEX_BYTES = 16 * 1024 * 1024
MAX_BLOCKS = 262144
MAX_BLOCK_WORDS = 256
MAX_RAW_BLOCK_BYTES = 65536
MAX_KEY_BYTES = 384
DEFAULT_CACHE_BYTES = 4 * 1024 * 1024
DEFAULT_CACHE_BLOCKS = 32


class LexiconError(ValueError):
    pass


class StaleLexiconError(LexiconError):
    pass


class LexiconCancelled(InterruptedError):
    pass


def _check_cancel(cancelled):
    if cancelled is not None and cancelled():
        raise LexiconCancelled("Native lexical lookup was cancelled")


def normalize_word(value):
    value = unicodedata.normalize("NFC", value.casefold().translate(
        str.maketrans({"’": "'", "‘": "'", "ʼ": "'"})))
    output = []
    for char in value:
        if char == "\u0301" and output and unicodedata.name(output[-1], "").startswith("CYRILLIC"):
            continue
        output.append(char)
    return "".join(output)


def valid_word(value):
    return (1 <= len(value) <= 96 and value[0] not in "'-" and value[-1] not in "'-" and
            any(char.isalpha() for char in value) and
            all(char.isalpha() or unicodedata.category(char).startswith("M") or char in "'-" for char in value))


def _signature(info):
    return (info.st_mode, info.st_dev, info.st_ino, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns)


def _unique_json(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise LexiconError("Duplicate native lexicon metadata key")
        result[key] = value
    return result


class MembershipLexicon:
    """Thread-safe read-only exact lookup; no model, DLL, network or guessing."""

    def __init__(self, path, expected_sha256, *, cache_blocks=DEFAULT_CACHE_BLOCKS,
                 cache_bytes=DEFAULT_CACHE_BYTES, cancelled=None):
        if not isinstance(expected_sha256, str) or not re.fullmatch("[a-f0-9]{64}", expected_sha256):
            raise LexiconError("A full trusted lowercase lexicon SHA256 is required")
        if type(cache_blocks) is not int or not 0 <= cache_blocks <= 128:
            raise LexiconError("Decoded block count must be bounded")
        if type(cache_bytes) is not int or not 0 <= cache_bytes <= 16 * 1024 * 1024:
            raise LexiconError("Decoded cache byte limit must be bounded")
        self.path = Path(path)
        self.dataset_sha256 = expected_sha256
        self._lock = RLock()
        self._stream, self._map = None, None
        self._closed = False
        self._cache, self._cached_bytes = OrderedDict(), 0
        self._cache_blocks, self._cache_limit = cache_blocks, cache_bytes
        self.codes, self.word_count, self.metadata = (), 0, {}
        try:
            self._stream = self.path.open("rb")
            path_info, fd_info = self.path.stat(), os.fstat(self._stream.fileno())
            if (not stat.S_ISREG(fd_info.st_mode) or not os.path.samestat(path_info, fd_info)
                    or not HEADER.size < fd_info.st_size <= MAX_FILE_BYTES):
                raise LexiconError("Native lexicon file identity or size is invalid")
            # On Windows path stat and descriptor fstat can have distinct ctime
            # semantics. Keep each full snapshot and compare like with like.
            self._path_signature, self._fd_signature = _signature(path_info), _signature(fd_info)
            digest_state = hashlib.sha256()
            while True:
                _check_cancel(cancelled)
                chunk = self._stream.read(1024*1024)
                if not chunk:
                    break
                digest_state.update(chunk)
            _check_cancel(cancelled)
            digest = digest_state.hexdigest()
            if digest != expected_sha256:
                raise LexiconError("Native lexicon SHA256 differs from its trusted receipt")
            self._map = mmap.mmap(self._stream.fileno(), 0, access=mmap.ACCESS_READ)
            self._read_index(cancelled)
            self._check_current()
            _check_cancel(cancelled)
        except BaseException:
            self.close()
            raise

    def _read_index(self, cancelled=None):
        _check_cancel(cancelled)
        magic, metadata_size, index_size, block_count = HEADER.unpack_from(self._map, 0)
        if (magic != MAGIC or not 0 < metadata_size <= MAX_META_BYTES or
                not 0 < index_size <= MAX_INDEX_BYTES or not 0 < block_count <= MAX_BLOCKS):
            raise LexiconError("Native lexicon header exceeds format bounds")
        self._payload_start = HEADER.size + metadata_size + index_size
        if self._payload_start >= len(self._map):
            raise LexiconError("Native lexicon index extends outside the file")
        metadata = json.loads(self._map[HEADER.size:HEADER.size+metadata_size].decode("utf-8"),
                              object_pairs_hook=_unique_json)
        if not isinstance(metadata, dict):
            raise LexiconError("Native lexicon metadata must be an object")
        codes = metadata.get("codes")
        if (metadata.get("format") != "dordiai-native-word-membership" or
                type(metadata.get("format_version")) is not int or metadata["format_version"] != 1 or
                metadata.get("normalization") != NORMALIZATION or
                not isinstance(codes, list) or not 1 <= len(codes) <= MAX_CODES or
                any(not isinstance(code, str) or
                not re.fullmatch("[a-z]{2,3}(?:-[a-z0-9]{2,8})*", code) for code in codes) or
                len(set(codes)) != len(codes) or
                type(metadata.get("word_count")) is not int or metadata["word_count"] <= 0):
            raise LexiconError("Native lexicon metadata is incompatible")
        self._mask_bytes = (len(codes)+7)//8
        if type(metadata.get("membership_mask_bytes")) is not int or metadata["membership_mask_bytes"] != self._mask_bytes:
            raise LexiconError("Native lexicon mask width differs from its language table")
        first_keys, entries = [], []
        cursor, index_end = HEADER.size + metadata_size, self._payload_start
        expected_offset, total_words = 0, 0
        for number in range(block_count):
            if number % 256 == 0:
                _check_cancel(cancelled)
            if cursor + KEY_LENGTH.size > index_end:
                raise LexiconError("Native lexicon index is truncated")
            length = KEY_LENGTH.unpack_from(self._map, cursor)[0]
            cursor += KEY_LENGTH.size
            if not 0 < length <= MAX_KEY_BYTES or cursor+length+INDEX_ITEM.size > index_end:
                raise LexiconError("Native lexicon first key exceeds bounds")
            first = bytes(self._map[cursor:cursor+length])
            cursor += length
            offset, compressed, raw_size, word_count = INDEX_ITEM.unpack_from(self._map, cursor)
            cursor += INDEX_ITEM.size
            if (first_keys and first <= first_keys[-1]) or (offset != expected_offset):
                raise LexiconError("Native lexicon block order is invalid")
            if (not 0 < word_count <= MAX_BLOCK_WORDS or
                    not (WORD_ITEM.size+self._mask_bytes)*word_count <= raw_size <= MAX_RAW_BLOCK_BYTES or
                    not 0 < compressed <= MAX_RAW_BLOCK_BYTES+1024 or
                    self._payload_start+offset+compressed > len(self._map)):
                raise LexiconError("Native lexicon block dimensions exceed bounds")
            first.decode("utf-8")
            first_keys.append(first)
            entries.append((offset, compressed, raw_size, word_count))
            expected_offset += compressed
            total_words += word_count
        if (cursor != index_end or self._payload_start+expected_offset != len(self._map)
                or total_words != metadata["word_count"]):
            raise LexiconError("Native lexicon index count or payload length differs")
        _check_cancel(cancelled)
        self._first_keys, self._entries = tuple(first_keys), tuple(entries)
        self.codes, self.word_count, self.metadata = tuple(codes), total_words, metadata

    def _check_current(self):
        if self._closed:
            raise LexiconError("Native lexicon is closed")
        try:
            current_path = self.path.stat()
            current_fd = os.fstat(self._stream.fileno())
        except OSError as error:
            raise StaleLexiconError("Native lexicon resource is no longer available") from error
        if (_signature(current_path) != self._path_signature or
                _signature(current_fd) != self._fd_signature or
                not os.path.samestat(current_path, current_fd)):
            raise StaleLexiconError("Native lexicon resource changed; close and reload it")

    def _block(self, number, cancelled=None):
        _check_cancel(cancelled)
        if number in self._cache:
            value = self._cache.pop(number)
            self._cache[number] = value
            return value[0], value[1]
        offset, compressed, raw_size, count = self._entries[number]
        start = self._payload_start + offset
        inflater = zlib.decompressobj()
        try:
            raw = inflater.decompress(self._map[start:start+compressed], raw_size+1)
        except zlib.error as error:
            raise LexiconError("Native lexicon compressed data are invalid") from error
        if (len(raw) != raw_size or not inflater.eof or inflater.unconsumed_tail or inflater.unused_data):
            raise LexiconError("Native lexicon compressed block is malformed or oversized")
        cursor, previous = 0, b""
        keys, masks = [], []
        allowed_mask = (1 << len(self.codes)) - 1
        for item in range(count):
            if item % 32 == 0:
                _check_cancel(cancelled)
            if cursor+WORD_ITEM.size+self._mask_bytes > len(raw):
                raise LexiconError("Native lexicon word header is truncated")
            prefix, suffix = WORD_ITEM.unpack_from(raw, cursor)
            cursor += WORD_ITEM.size
            mask = int.from_bytes(raw[cursor:cursor+self._mask_bytes], "little")
            cursor += self._mask_bytes
            if prefix > len(previous) or cursor+suffix > len(raw):
                raise LexiconError("Native lexicon word prefix or suffix is invalid")
            key = previous[:prefix]+raw[cursor:cursor+suffix]
            cursor += suffix
            if (not 0 < len(key) <= MAX_KEY_BYTES or not mask or mask & ~allowed_mask
                    or (previous and key <= previous)):
                raise LexiconError("Native lexicon spelling or membership mask is invalid")
            text = key.decode("utf-8")
            if normalize_word(text) != text or not valid_word(text):
                raise LexiconError("Native lexicon spelling is not canonically normalized")
            keys.append(key)
            masks.append(mask)
            previous = key
        if (cursor != len(raw) or keys[0] != self._first_keys[number] or
                (number+1 < len(self._entries) and keys[-1] >= self._first_keys[number+1])):
            raise LexiconError("Native lexicon decoded block order differs from its index")
        keys, masks = tuple(keys), tuple(masks)
        _check_cancel(cancelled)
        # Conservatively charge Python key/int/tuple overhead, not just raw data.
        charge = len(raw) + sum(map(len, keys)) + count*192 + 128
        if self._cache_blocks and charge <= self._cache_limit:
            while self._cache and (len(self._cache) >= self._cache_blocks or
                                   self._cached_bytes+charge > self._cache_limit):
                _, removed = self._cache.popitem(last=False)
                self._cached_bytes -= removed[2]
            self._cache[number] = (keys, masks, charge)
            self._cached_bytes += charge
        return keys, masks

    def candidates(self, word, *, cancelled=None):
        if not isinstance(word, str):
            raise TypeError("Native lexical membership requires a word string")
        with self._lock:
            _check_cancel(cancelled)
            self._check_current()
            if len(word) > MAX_KEY_BYTES:
                return frozenset()
            token = normalize_word(word)
            if not valid_word(token):
                return frozenset()
            key = token.encode("utf-8")
            if len(key) > MAX_KEY_BYTES:
                return frozenset()
            number = bisect_right(self._first_keys, key)-1
            if number < 0:
                return frozenset()
            keys, masks = self._block(number, cancelled)
            _check_cancel(cancelled)
            self._check_current()
            position = bisect_left(keys, key)
            if position == len(keys) or keys[position] != key:
                return frozenset()
            mask = masks[position]
            return frozenset(code for index, code in enumerate(self.codes) if mask & (1 << index))

    lookup = candidates

    def validate_all(self, *, cancelled=None):
        """Bounded full semantic scan for build/package audit, never implicit per word."""
        with self._lock:
            self._check_current()
            words = 0
            for number in range(len(self._entries)):
                _check_cancel(cancelled)
                keys, masks = self._block(number, cancelled)
                words += len(keys)
            self._check_current()
            return {"validated_blocks":len(self._entries),"validated_words":words,
                    "dataset_sha256":self.dataset_sha256}

    def verify_current(self):
        with self._lock:
            self._check_current()
            return True

    def statistics(self):
        with self._lock:
            return {"closed": self._closed, "codes": self.codes, "word_count": self.word_count,
                    "blocks": len(getattr(self, "_entries", ())), "cached_blocks": len(self._cache),
                    "cache_bytes_charged": self._cached_bytes, "cache_byte_limit": self._cache_limit,
                    "cache_block_limit": self._cache_blocks, "dataset_sha256": self.dataset_sha256,
                    "max_raw_block_bytes": MAX_RAW_BLOCK_BYTES, "max_block_words": MAX_BLOCK_WORDS,
                    "membership_mask_bytes": getattr(self,"_mask_bytes",None), "language_table_limit": MAX_CODES,
                    "scope": "finite exact dictionary memberships; unknown and shared spellings remain unresolved"}

    def close(self):
        with self._lock:
            self._cache.clear()
            self._cached_bytes = 0
            self._first_keys, self._entries = (), ()
            if self._map is not None:
                self._map.close()
                self._map = None
            if self._stream is not None:
                self._stream.close()
                self._stream = None
            self._closed = True

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()
