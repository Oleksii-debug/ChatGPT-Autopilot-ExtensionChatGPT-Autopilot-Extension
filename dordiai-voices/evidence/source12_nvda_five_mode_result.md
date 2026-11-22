# Actual source12 NVDA integration: functional gates passed

Run 45041853551 tested all five isolated modes against the exact source12 core: 1,992,944,744 bytes, SHA256 908a9825a8f3e1574d9d0a370ac0e35e1e1683eb04b998a937c312f0ce3ec573. Every receipt identifies genuine NVDA 2026.3.1 from the checksum-verified official installer. All five jobs passed, with no failed functional checks.

The previously failing unmarked file is fixed. The original 100 authenticated forms and 102 lexical pieces retain their order with zero routing mismatches; source11 produced 71 mismatches on this same workload. NVDA still converts the default locale from None to Ukrainian, but the independently transported origin flag remains false, allowing automatic routing. Shared spellings follow the agreed current-language policy. This proves a bounded finite-dictionary result, not perfect language or author-intent detection. The active profile here was Adam.

All seven plain-file cases passed: automatic 100 words, forced and disabled plain text, genuine opposite-locale RichEdit metadata, forced and disabled metadata, and the additional compound case. The installed dictionary verified the whole compound as Russian-only while both components were shared. The content auditor was unchanged. The private NVDA unsupported-language reporting option was set to OFF to isolate routing from generated announcements; its original value, "speech", and other private settings were restored with zero cleanup errors.

All nine genuine typed-key cases passed, including letter names, punctuation and the Russian word echo. There were no driver errors. Keyboard configuration, layout and speech mode were restored.

The normal mode completed 176 first-pass glyph requests and 100 requests each for warm letters, language switches and cancellation, with no errors or timeouts. Its sampled languages were Ukrainian, English and Russian. Internal recording-boundary P95 values were 1.6685 ms for warm letters, 1.9159 ms for switches and 0.0071 ms for cancellation calls. These are not physical or acoustic latency.

Both genuine resource faults recovered through actual built-in eSpeak with nonzero captured notice PCM. They preserved the configured synth and closed the old driver/thread. The missing RuAccent file was restored byte-identically. Descriptor corruption produced the registered resource error despite the enabled cache, released the reader/mapping, and restored the exact 558-byte descriptor.

The reports deliberately remain partial. No output endpoint was present, so they used explicit recording PCM sink doubles. Physical audio, WavePlayer acceptance, acoustic timing, uninterrupted playback, pronunciation, all 45 voices and all 135 languages are not established; product readiness remains false. No production correction is needed for the proven default-locale provenance defect.

The companion JSON receipt lists the exact raw report blobs, complete compressed engineering bundles, hashes, artifact IDs and scope flags.
