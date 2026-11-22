# Actual source11 plain-file language provenance failure

The complete owned Windows/NVDA probe ran in workflow 45034918498, job 137246417004, commit 07b9a76b48ee5eaa724d1fa80ffedcf6a1a63c62, against the immutable source11 archive SHA256 223e5ea7b29d0f9d16f3ca653711e8ced281c0fc7d5bd2fb891018a73926eceb. No production source or model was modified.

The earlier 1024-character native current-line limit was avoided through a genuine POSITION_ALL EditTextInfo and NVDA's public speakTextInfo API. All 1137 input characters, 100 original source forms and 102 lexical pieces were present and preserved. The case emitted 2,374,354 nonzero PCM bytes after the actual request, with no driver error. This is functional/predevice output evidence, not physical sound or pronunciation acceptance.

The actual provenance chain is unambiguous:
- The plain-file TextInfo had no language fields.
- The observed original high-level speech sequence contained LangChangeCommand(None).
- NVDA delivered LangChangeCommand("uk") to the real synthesizer.
- Every actual planned text route used Ukrainian.
- The dictionary-backed workload therefore had 71 wrong-locale lexical pieces across 69 original source forms. This includes all 30 Russian-only finite-source occurrences. Shared forms are policy tests of current-language inheritance, not proof of an author's intended language.

The source11 adapter treats every nonempty delivered locale as explicitly selected. NVDA normally resolves its default-language None to a concrete locale before delivery, so the adapter loses the distinction between default fallback and an authored/typed explicit locale. The compact dictionary and installed wrappers were verified separately; this failure shows their automatic word routing was bypassed in the genuine plain-file pipeline.

Controls:
- Forced-Ukrainian 12-word current-line case passed, preserving the complete input.
- Russian-disabled 12-word current-line case passed, preserving the complete input.
- All 3 native RichEdit metadata cases were BLOCKED BEFORE SPEECH: the actual authored TOM LCIDs alternated 1049/1058, but the isolated NVDA setting detectFormatAfterCursor was false and only the first ru_RU field surfaced. This is a probe configuration limitation, not evidence of a metadata-priority product failure.
- Cleanup had no errors and restored the isolated configuration.

The next probe enables and records the genuine detectFormatAfterCursor setting for metadata cases and restores its exact prior value. Product source12 needs a documented, Dordiai-scoped language-origin bridge that preserves authored/typed, forced, disabled and direct-caller semantics; source11 remains immutable. No threshold, model or dictionary label is changed by this diagnosis.

Durable evidence:
- Exact raw nvda-probe.json Git blob ddfc8d36050775346c913bb42e2c118a400bf848.
- Exact complete engineering JSON-bundle gzip Git blob b0bc803163e7ab7a6834294411cf575425905027.
- Bundle JSON SHA256 eb429e1140e989cc6e078a74dbb5b0b3b982e119925510376c14431aafaac60e; 507,563 bytes.
- Bundle gzip SHA256 d32380a1ac15faa0af39a97259ab8a7fc8dd3e5ee27db38ae4ff4f87c3600e98, reconstructed from all 4 log chunks and CRC/length checked.
- Original Windows artifact 14759505805, 925,576 bytes.
