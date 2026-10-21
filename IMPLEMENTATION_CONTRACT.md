# Tinka implementation contract

Internal package/archive name: board-room for installer compatibility. UI name: Tinka.
Node >=22, no runtime npm dependencies. Application lives independently of data.
CLI entry cli.mjs, server server.mjs, public files public/. Config JSON external:
{ "schemaVersion": 1, "port": 43821, "portMode": "auto", "projectLabel": "Atlas", "boardsRoot": "/absolute/path/to/boards", "title": "Tinka" }

## Schema 2 workspace

Explicit `workspace init|migrate --apply` enables schema 2. Dry-run is the default;
installing/upgrading never migrates data. `config.workspaceRoot` is an optional
absolute metadata location; default `boardsRoot/.tinka` stays with versioned project
boards. Custom absolute roots require explicit backup/restoration on other machines.
Config/metadata/resources remain outside replaceable app paths, including through
symlinks. The installer validates custom metadata locations before replacing files
and preserves external config without relocation.

The store has workspace.json plus per-item and per-board JSON and migration
receipts. Shared reads/writes take a project-local lock; redo journals recover
interrupted multi-document commits before snapshots are exposed. Locks are reclaimed
only for provably dead recorded owners. Missing/unverifiable ownership and orphan
recovery guards fail closed with 409; manual recovery requires verifying all
workspace writers are stopped, preserving/renaming the orphan lock/guard metadata
and retaining pending.json for redo. No unsafe timeout break or universal power-loss
guarantee is provided. Operations carry
optional expectedRevision and operationId; stale revisions or conflicting reuse
return 409. The most recent 64 operation receipts support idempotent retry.

Canonical items have stable id/title/description, optional content/preview/resources,
optional childBoardId, revisions, review {note,star,updatedAt}, build
{state,message,updatedAt}, creation/update timestamps and optional archive/delete
timestamps. Content kinds: html,image,markdown,video,pdf,url,text,note,audio,file;
content may hold resource {rootId,path}, HTTP(S) url, text, openMode and declarative
startInstructions. An item may have content and children together, or neither.
No command execution, remote fetching or file deletion is performed.

Boards have ownerItemId, placements [{id,itemId,x,y,width,height,z,...local state}],
reviewOrder, retained rounds, decorations and optional background. Placements share
canonical review; geometry, optional presentation and local archive state are board-scoped. Presentation accepts mode card/panel/icon, an optional viewport with integer width/height from 40 to 10000, and an optional hexadecimal paper color. Absence retains cards; panels fit the complete HTML/image viewport without cropping. The item footer ⋯ (Item details) control opens an attached nonmodal notes/appearance popup with Full preview, Compact card, Icon and paper choices. Notes/star remain canonical; appearance remains placement-local. Presentation patches replace the object, so clients preserve existing viewport and paper values when changing one field. Line decorations optionally accept boolean endArrow/flipX/flipY for an arrowhead and its endpoint orientation within the positive-size bounding box; absent flags preserve existing lines. Text, Colored region and Arrow are available from Add with direct on-board controls; ordinary lines remain supported decoration metadata. Containment
is a DAG, with explicit homeBoardIds. Resource roots are named workspace-relative
folder paths; files remain project-owned and standalone. Duplication creates a
new canonical identity pointing at the same files; board duplication copies its
arrangement while referencing children. Remove detaches placements; deleteItem
marks metadata deleted across placements; neither removes payloads.

Migration preserves legacy board IDs and stable concept lineage, original folder
bytes, round/revision order, feedback/build history and orphan/raw records in
receipts. Repeated migration does not duplicate items. Rollback can archive the
metadata directory and return to untouched legacy folders; restore complete metadata
to recover subsequent graph-only work. App rollback and metadata rollback are separate.

HTTP additions: GET /api/workspace returns {enabled:false,revision:0} before init,
otherwise full schema 2 snapshot plus enabled:true. GET /api/items/:id returns a
canonical item. GET /api/boards merges home graph summaries with unmigrated legacy
folders (no duplicate migrated cards); full board catalog is in workspace.boards.
GET /api/boards/:id returns a schema 2 snapshot with items keyed by ID when present.
POST /api/operations accepts the raw operation body. PATCH /api/items/:id/review
accepts {patch:{note?,star?},expectedRevision?,operationId?}. POST
/api/workspace/migrate requires explicit {dryRun:boolean}. GET/HEAD
/resources/:rootId/PATH uses named-root realpath/dotfile/symlink containment and media
byte ranges; ordinary relative HTML assets resolve in the same namespace.

Operations: createItem, updateItem, createBoard, updateBoard, updatePlacement,
move, reference, duplicate, archive, archiveItem, remove, deleteItem, review,
updateWorkspace. CLI workspace show/op and item show use these same transactions.
Graph-aware board create/status preserve existing command usage. See
[PROTOCOL.md](docs/PROTOCOL.md#schema-2-workspace) for exact payloads and examples.

All write endpoints require JSON (1 MB HTTP bound), same-origin loopback Host/Origin
checks, and x-tinka-workspace matching live config identity. Absent Origin remains
valid for loopback API tools. Config identity hashes canonical config and boards paths, adding the metadata
path when it differs from the default; this retains default browser namespaces. It is distinct from the durable graph workspaceId. Runtime config
root changes disable writes until restart. Legacy whole-map notes PUT returns 409
once migrated so stale clients cannot overwrite canonical feedback. Legacy notes
GET overlays canonical known-item review on original legacy orphan notes.

Graph live state exposes workspace manifestRevision plus per-item resource revision
hashes independently of metadata updates. Content and relative asset edits trigger
a safe reload offer without replacing an active preview. No remote URL is probed.
Board-only primary cover/title actions open their child board directly; composites retain content plus an explicit board choice. Grid and Canvas share placements; composite Content/Board views retain sequential
review order. Graph and legacy readers retain previous/next, dots, versions,
notes/star, sizing, standalone links and browser history semantics described below.

## Legacy data
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
Legacy browsers write notes; schema 2 browsers use validated operations and item review. Bound loopback. Realpath containment, dotfile block, reject unsafe paths/symlink escapes, origin checks for writes.

Legacy board and experiment removal controls generate agent prompts with explicit workspace and target identity. Graph organization controls mutate metadata through the validated operation API and never delete resource files. New workspaces and boards start empty; reference content is optional.

## CLI
node cli.mjs project init --project PATH [--boards design/boards] [--label TEXT]
node cli.mjs init --config PATH --boards PATH [--port auto|NUMBER] [--label TEXT]
node cli.mjs workspace init|migrate --config PATH [--dry-run|--apply]
node cli.mjs workspace show --config PATH
node cli.mjs workspace op --config PATH --json JSON|--file PATH
node cli.mjs item show ITEM_ID --config PATH
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

The brand is Tinka; projectLabel is separate; board title is separate. Home shows Tinka / Project. Board views and browser titles include the project and board. The board header shows the Tinka mark with a visible Home link, an explicit ← Parent return when a containing board exists, one complete current board title, and Tools. Project identity remains in the Home tooltip and accessible name and browser title. A valid ?from entry context selects the return destination; a sole parent can be used without context, while multiple parents without context offer a chooser. Top-level boards show no parent return. Tools contains graph creation (+ Add), Grid/Canvas, search and review filters, board details, notes export and help. Long current titles wrap rather than forming a truncated breadcrumb chain. The board footer keeps live and notes status quiet on the left, with the zoom slider (synced with pinch and Control/⌘-scroll) and Fit on the right.

The experiment viewer's header shows Home, an explicit ← Board return to the containing board, the current item title, its shortlist star and a Notes panel that uses the same notes as the board card. Its footer offers Back to board (Esc), previous/next controls and a dot track showing position in board manifest order across rounds, plus a View popover containing Type size, Fit, Light, window size (with Version when revisions exist), Open standalone and applicable graph item actions. Tools and View support keyboard focus, Escape dismissal and outside click. Navigation skips reserved/building slots, stops at either end, and preserves window size (including custom dimensions), light and type settings. Each destination opens its original version and updates the URL, title, hint and standalone link. Opening, stepping between or closing experiments and choosing a version each add one browser history entry; Back and Forward restore them, while view settings, notes and zoom do not add entries. Live status and manifest updates refresh the navigation without reloading the current preview. Arrow keys remain available to the experiment itself.
