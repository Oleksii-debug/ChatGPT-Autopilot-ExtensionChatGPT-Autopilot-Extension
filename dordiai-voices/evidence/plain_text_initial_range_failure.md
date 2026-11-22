# Source11 first real plain-file probe: native line range limit

This records a probe setup failure before the speech request. It is not evidence that automatic language routing passed or failed.

The actual owned Windows/NVDA run was [45034220666](https://github.com/Oleksii-debug/ChatGPT-Autopilot-ExtensionChatGPT-Autopilot-Extension/actions/runs/45034220666), job 137244258854, commit bfd676903835ed8abcc08eba5feb0866034d2c48. The unchanged source11 archive SHA256 was 223e5ea7b29d0f9d16f3ca653711e8ced281c0fc7d5bd2fb891018a73926eceb.

The probe loaded the complete UTF8 file into an actual owned standard Windows Edit control. Its value matched all 100 requested words, covering all 96 authenticated source samples plus 4 repeats. The input contained 1,137 characters. Genuine NVDA EditTextInfo expanded with UNIT_LINE returned exactly 1,024 characters and stopped inside the source form “термосифонною” after “тер”. This actual observation is retained as a native/current-line range limitation, rather than inferred as a visual wrapping problem.

The real focus object was Dynamic_IAccessibleEditWindowNVDAObject, native class Edit, with owned HWND verification. TextInfo was EditTextInfo. The observed format field had no language value. The script's complete-input guard correctly stopped before invoking the read command.

Consequently:
- high-level speech inputs: empty;
- queued speech sequences: empty;
- driver speech sequences: empty;
- planned routes: empty;
- no actual 100-word speech or language-routing acceptance was measured;
- cleanup reported no errors and restored the isolated configuration.

The next probe version keeps every source word. For the 100-word case it obtains a genuine native POSITION_ALL TextInfo and uses NVDA's public speakTextInfo API after verifying that the full input range is present. Smaller policy and native-metadata cases retain the actual current-line ScriptHandler path. It does not invent TextInfo, insert language commands, change product code or claim that this first run proves a locale-provenance defect.

Durable exact evidence:
- Raw actual nvda-probe.json Git blob: 2210d113951738b0a6f6f4f41e11fa12ea5f46a8.
- Exact complete engineering JSON bundle gzip Git blob: 2054883f4e37236b9f36f0c8e9d8989ba003b6a1.
- Bundle JSON SHA256: d6ee0cb155c979cb2b6502474bd13ad3753c517844b792efc5efb99f8179b5a6; 231,285 bytes.
- Bundle gzip SHA256: 2eb14b59bf9ef28c91542254412ed1b92774822a28bc074faf5a5fb987eec310; recovered from both log chunks and CRC/length checked.
- Original complete Windows artifact: 14759090735, 40,746 bytes.
