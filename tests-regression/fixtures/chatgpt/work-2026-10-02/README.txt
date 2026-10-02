Offline regression fixtures derived from the four Work HTML snapshots supplied on 2026-10-02.
Private account identifiers, conversation content, scripts, styles, and network resources were removed; prompts and turn IDs were replaced with synthetic values. provenance.json records source hashes and redaction metadata. No original HTML or user prompt is packaged.

Run browser qualification with:
  CHROMIUM_BIN=/path/to/chromium AUTOPILOT_PLAYWRIGHT_MODULE=/path/to/playwright node scripts/work-dom-qualification.cjs
All document and external requests are intercepted/blocked; app acknowledgements are modeled.
