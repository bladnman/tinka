# Tinka implementation contract

Internal package/archive name: board-room for installer compatibility. UI name: Tinka.
Node >=22, no runtime npm dependencies. Application lives independently of data.
CLI entry cli.mjs, server server.mjs, public files public/. Config JSON external:
{ "schemaVersion": 1, "port": 43821, "portMode": "auto", "projectLabel": "Atlas", "boardsRoot": "/absolute/path/to/boards", "title": "Tinka" }

## Data
Each immediate subfolder with board.json is a board. Slug [a-z0-9][a-z0-9-]*.
board.json: {schemaVersion:1,title,description,createdAt,cover?,legacyNotesKey?}.
rounds.json: {rounds:[{id,date,number,title,description,concepts:[{id,number,name,category,description,question,hint,tone,kind?,path?,url?,handoff?,dependencies?}]}],revisions:{"round/id":[{id,name,path,kind?,hint}]}}.
Existing concept metadata remains compatible. Default kind html, default path rounds/<round>/<concept>/index.html. kind accepts html,image,markdown,video,pdf. path is board-relative. url optional explicitly configured http(s) preview for independently started apps. handoff optional board-relative README path.
build-state.json and .state/notes.json preserve existing shapes. No executing manifests.

## HTTP
GET / serves public/home.html; /boards/:id/ serves public/board.html.
GET /app/* serves public/*; /boards/:id/files/* serves board files with containment checks.
GET /api/config -> {title,projectLabel,workspaceId,port,portMode,url,boardsRoot,configPath,version}.
GET /api/boards -> {boards:[{id,title,description,createdAt,updatedAt,conceptCount,revisionCount,roundCount,buildingCount,cover?}],errors:[],revision,shellRevision}.
GET /api/boards/:id -> {id,...boardMetadata,rounds,revisions}.
GET /api/boards/:id/live -> existing live.js schema {revision,shellRevision,manifestRevision,concepts:{"round/id":{state,message,revision,updatedAt}}}.
GET/PUT /api/boards/:id/notes -> existing notes map shape.
GET /api/health -> {app:"board-room",version,projectLabel,workspaceId,port,url,configPath,boardsRoot}.
No browser writes except notes. Bound loopback. Realpath containment, dotfile block, reject unsafe paths/symlink escapes, origin checks for writes.

## CLI
node cli.mjs init --config PATH --boards PATH [--port auto|NUMBER] [--label TEXT]
node cli.mjs serve|start|stop --config PATH
node cli.mjs board create SLUG --config PATH --title TEXT [--description TEXT]
node cli.mjs status --config PATH --board SLUG ROUND/CONCEPT building|review|ready|reserved [MESSAGE]
Runtime PID/log belongs alongside config, never in app. Refuse overwrite existing board/config. PID ownership validated. CLI export optional if time allows; portability is mandatory protocol, not necessarily export tooling.

## Portability
Every experiment is independently owned, uses its target product's vocabulary/layout/behavior, no required host SDK/imports. HTML prototypes run via ordinary static HTTP server rooted at their board, or standalone at experiment folder if all dependencies local. Framework prototypes can provide URL + own start command. Metadata is an adapter outside implementation. Shared assets allowed with explicit dependency/run/handoff documentation; no runtime dependency on application public/ files. Each experiment README.md records purpose, run command/root, file/dependency list, real vs simulated behavior, target-product transfer guidance. Portable means no required board-room server API for experiment functionality. Optional preference messages must safely do nothing when standalone.

## Independent instances

One project owns its config, boards root, runtime record, log, saved port, and browser namespace. There is no runtime registry lookup or cross-project coordination. Init defaults to port 43821 in auto mode; actual binds try up to 20 candidates at +100 increments, saving the successful port for restarts. Numeric ports and legacy configs are fixed. A config runtime claim precedes binding, so simultaneous starts cannot create two owners. Process stop validates CLI, config and token. Each project uses its own app copy for independent upgrades.

The brand is Tinka; projectLabel is separate; board title is separate. Home shows Tinka / Project. Board views and browser titles include the project and board. The collapsed bar stays one row and scrolls on narrow screens so controls remain available.
