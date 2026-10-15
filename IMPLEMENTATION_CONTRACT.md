# Tinka implementation contract

Internal package/archive name: board-room for installer compatibility. UI name: Tinka.
Node >=22, no runtime npm dependencies. Application lives independently of data.
CLI entry cli.mjs, server server.mjs, public files public/. Config JSON external:
{ "schemaVersion": 1, "port": 43821, "portMode": "auto", "projectLabel": "Atlas", "boardsRoot": "/absolute/path/to/boards", "title": "Tinka" }

## Data
Each immediate subfolder with board.json is a board. Slug [a-z0-9][a-z0-9-]*.
board.json: {schemaVersion:1,title,description,createdAt,cover?,legacyNotesKey?}.
cover is an optional board-relative image path, normally assets/cover.svg or assets/cover.png. Recommended 1200x600 (2:1), PNG/JPEG/WebP/SVG. Home displays it as the board card's large image; missing images use the generic paper artwork. Changes to the cover file or metadata refresh the card. The Change cover action generates an agent prompt scoped to this board.
rounds.json: {rounds:[{id,date,number,title,description,concepts:[{id,number,name,category,description,question,hint,tone,kind?,path?,url?,handoff?,dependencies?}]}],revisions:{"round/id":[{id,name,path,kind?,hint}]}}.
Existing concept metadata remains compatible. Default kind html, default path rounds/<round>/<concept>/index.html. kind accepts html,image,markdown,video,pdf. path is board-relative. url optional explicitly configured http(s) preview for independently started apps. handoff optional board-relative README path.
build-state.json and .state/notes.json preserve existing shapes. No executing manifests.

## HTTP
GET / serves public/home.html; /boards/:id/ serves public/board.html.
GET /app/* serves public/*; /boards/:id/files/* serves board files with containment checks.
GET /api/config -> {title,projectLabel,workspaceId,port,portMode,url,boardsRoot,configPath,version,appPath,agentGuidePath,protocolPath}.
GET /api/boards -> {boards:[{id,title,description,createdAt,updatedAt,conceptCount,revisionCount,roundCount,buildingCount,cover?}],errors:[],revision,shellRevision}.
GET /api/boards/:id -> {id,...boardMetadata,rounds,revisions}.
GET /api/boards/:id/live -> existing live.js schema {revision,shellRevision,manifestRevision,concepts:{"round/id":{state,message,revision,updatedAt}}}.
GET/PUT /api/boards/:id/notes -> existing notes map shape.
GET /api/health -> {app:"board-room",version,projectLabel,workspaceId,port,url,configPath,boardsRoot}.
No browser writes except notes. Bound loopback. Realpath containment, dotfile block, reject unsafe paths/symlink escapes, origin checks for writes.

Board and experiment removal controls generate agent prompts with explicit workspace and target identity. They never mutate board files through the browser. New workspaces and boards start empty; reference content is optional.

## CLI
node cli.mjs project init --project PATH [--boards design/boards] [--label TEXT]
node cli.mjs init --config PATH --boards PATH [--port auto|NUMBER] [--label TEXT]
node cli.mjs serve|start|stop --config PATH
node cli.mjs board create SLUG --config PATH --title TEXT [--description TEXT]
node cli.mjs board guide SLUG --config PATH
node cli.mjs status --config PATH --board SLUG ROUND/CONCEPT building|review|ready|reserved [MESSAGE]
Runtime PID/log belongs alongside config, never in app. Refuse overwrite existing board/config. PID ownership validated. CLI export optional if time allows; portability is mandatory protocol, not necessarily export tooling.

## Portability
No installed skill is required. The app ships docs/AGENT.md, docs/PROTOCOL.md, docs/BOARD.md and scripts/install.mjs. New boards carry portable AGENTS.md; board guide adds it to old boards without replacing existing instructions. The optional skill ZIP contains only a stable discovery SKILL.md. Browser prompts identify the selected app and instruction paths directly.

Portable project scaffolding uses visible tinka/project.json {schemaVersion:1,version,projectLabel,boards,repo}, with a project-relative boards path, standalone tinka/setup.mjs, tinka/.gitignore, root TINKA.md and a short appended project AGENTS.md pointer. Boards stay outside tinka/. App tinka/app and machine-specific tinka/local are ignored by default. Setup restores the exact pin and creates this machine's absolute config; an explicit --version updates the pin after successful install. Commit complete boards including disk notes. No registry or previous app is required after checkout. Manual absolute configs and existing dotfolder layouts remain supported; no automatic relocation.

A matching committed tinka/packages/tinka-vVERSION.zip and .sha256 sidecar allow offline setup with no arguments. Selection follows the project version pin; explicit --zip or --repo takes precedence. Missing bundle checksums fail before installation.

Every experiment is independently owned, uses its target product's vocabulary/layout/behavior, no required host SDK/imports. HTML prototypes run via ordinary static HTTP server rooted at their board, or standalone at experiment folder if all dependencies local. Framework prototypes can provide URL + own start command. Metadata is an adapter outside implementation. Shared assets allowed with explicit dependency/run/handoff documentation; no runtime dependency on application public/ files. Each experiment README.md records purpose, run command/root, file/dependency list, real vs simulated behavior, target-product transfer guidance. Portable means no required board-room server API for experiment functionality. Optional preference messages must safely do nothing when standalone.

## Independent instances

One project owns its config, boards root, runtime record, log, saved port, and browser namespace. There is no runtime registry lookup or cross-project coordination. Init defaults to port 43821 in auto mode; actual binds try up to 20 candidates at +100 increments, saving the successful port for restarts. Numeric ports and legacy configs are fixed. A config runtime claim precedes binding, so simultaneous starts cannot create two owners. Process stop validates CLI, config and token. Each project uses its own app copy for independent upgrades.

The brand is Tinka; projectLabel is separate; board title is separate. Home shows Tinka / Project. Board views and browser titles include the project and board. The collapsed bar stays one row and scrolls on narrow screens so controls remain available.
