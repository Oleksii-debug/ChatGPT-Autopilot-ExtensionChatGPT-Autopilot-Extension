# Portable configuration v0.1

The extension can stay installed while its Sessions are reconfigured through a JSON file.

Format:
- `format`: `chatgpt-autopilot-profile`
- `version`: `1`
- up to 5 Sessions per imported file
- up to 50 Tasks per Session
- stable Session and Task ids
- shared or unique prompts
- run/timing/tab settings
- optional `autoStart`

`autoStart` semantics:
- top-level `autoStart: true` requests automatic start for every Session in the imported profile;
- Session-level `autoStart: true` requests automatic start for that Session when the top-level flag is false;
- neither flag starts anything by itself: the user must explicitly activate `Import and start requested Sessions`;
- imports performed without that explicit confirmation leave imported Sessions STOPPED.

Safety:
- import is one atomic Core storage transaction;
- only Sessions whose ids occur in the imported file are created/replaced;
- unrelated Sessions are untouched;
- an active or unresolved target Session cannot be overwritten;
- automatic start occurs only when the file requests it **and** the user activates `Import and start requested Sessions`;
- active/unresolved ChatGPT URL ownership collisions reject the whole import;
- export contains configuration, not runtime operations, cookies, browser data, secrets or ChatGPT credentials;
- exported Sessions default to `autoStart: false`.

The shipped blank template is `src/config/portable-profile-template.json`.

For bulk URL entry in the options page, paste ChatGPT links into the bulk field. One URL per line is recommended, but numbered lists and whitespace-separated URLs are accepted. Normalized duplicates are ignored.
