ROLE: integrated UI/Core configuration finisher
STATUS: implementation in progress
BASE: 9049ade235dc4b2dd3a2a6493319c6874c90baeb
BRANCH: ui/portable-config-bulk-stability-v01

Scope:
- break read-only STATUS_CHANGED feedback loop suspected in options-page/NVDA freezing;
- coalesce status refresh and avoid needless session-list rerenders;
- preserve unsaved per-Session form drafts locally across options-page reloads;
- remember/reopen last selected Session;
- bulk ChatGPT URL parser + add/replace task workflow;
- portable JSON profile preview/import/export through Core storage;
- explicit confirmation before imported autoStart;
- blank portable profile template.

Private ChatGPT URLs/prompts are not committed in this public package.
HUMAN_TESTED=false
NVDA_VERIFIED=false
