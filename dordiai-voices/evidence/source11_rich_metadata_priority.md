# Actual source11 RichEdit language-priority evidence

Run45035639199 used the immutable source11 add-on and the reviewed tool-only metadata flag change. The real RichEdit ITextFont language IDs were1049/1058, and TextInfo exposed all alternating ru_RU/uk_UA ranges with detectFormatAfterCursor enabled only in the private metadata cases. Allsix genuine reads produced nonzero captured PCM and restored private preferences; physical device output was not tested.

The unmarked100-source-form file still failed:71 lexical pieces had the wrong route, including all30 Russian-only occurrences being read as Ukrainian. The original high-level default LangChangeCommand(None) became a concrete Ukrainian command before delivery. Source11 is not fixed by this probe.

The genuine opposite-locale RichEdit6 case passed allroutes, as did forcedUkrainian metadata6. ForcedUkrainian/plain12 and Russian-disabled/plain12 passed. Thus authored explicit locales must remain authoritative in the forthcoming provenance fix.

Russian-disabled RichEdit6 produced no wrong-locale source pieces, but the strict source-content auditor failed because NVDA itself inserted three "Russian (not supported)" announcements before synth delivery (nine additional lexical words). This is visible in original high-level speech inputs; it is separate from the unmarked-text provenance defect. No auditor expectation was relaxed or source word discarded.

Exact nvda-probe.json Git blob:334317a44a252b888440a798bd7809b3aad5f3e5.
Exact complete engineering-bundle gzip Git blob:79c73903ac8a1942bee794c38f1563106bb63792.
