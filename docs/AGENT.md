# Using Tinka as an agent

Tinka works through ordinary folders and JSON. An installed skill is optional.
Use this installation's README and protocol as the authority for its version.

## Find this project's boards

Read the project's `AGENTS.md` and `TINKA.md`. A portable project has a visible
`tinka/project.json` with its pinned version, label and project-relative boards
path, plus `tinka/setup.mjs`. Its replaceable app is `tinka/app`; local absolute
config, PID and logs are in `tinka/local`. See the root README for setup.

Existing installations may use `.tinka/app`, a different config or external
boards. Keep their locations; a dot folder is a convention, not a requirement.
An optional `~/.config/tinka/workspaces.json` can supply legacy
`{projectRoot, appPath, configPath}` pointers. Match this project explicitly.
Do not depend on that machine's registry when preparing a portable project.
The app never reads a registry or discovers other processes.

When the app is missing after checkout, run the project's checked-in setup
script. It restores the pinned release (using a committed matching archive in
`tinka/packages/` when present) and creates local config from relative paths.
Keep all boards and disk notes. If no setup exists, follow the root
README's installation procedure; do not require a skill. Ask for a location only
when the project gives none. Recommend visible `tinka/` for tooling and
`design/boards/` for durable content. Installation paths are configurable.

When asked to open or return to boards, always run the normal `node /absolute/app/cli.mjs start --config /absolute/config.json`, even if the server is already healthy. This checks for updates once daily and returns the verified existing URL without restarting it. Relay an available update in one short sentence offering update now, later, or always install compatible updates; do not dump CLI lines or local paths into the user conversation. The CLI notice contains exact commands for the agent. Do not select auto policy without the user's explicit personal consent.

Before claiming a running workspace, verify `/api/health` matches the selected
canonical config path and project label. Report the actual URL printed by start.
Do not kill, adopt or reconfigure another instance to resolve a collision.

## Discover tools and selected work

The immediately readable tool catalog is [`../lib/tools.json`](../lib/tools.json).
It ships beside the CLI with schemas and examples; no MCP server or skill is
required. Discover compact tool names, read one schema, then inspect selected work:

```sh
node /absolute/app/cli.mjs tools list --summary
node /absolute/app/cli.mjs tools describe item.create
node /absolute/app/cli.mjs tools call workspace.search --config /absolute/config.json \
  --json '{"query":"release","kind":"boards","limit":10}'
node /absolute/app/cli.mjs tools call board.get --config /absolute/config.json \
  --json '{"boardId":"release-review"}'
```

`tools list` returns the full `{schemaVersion,name,tools}` catalog; each entry has
name, description and inputSchema. All named tools use `tools call NAME` with
`--json` or `--file`. Existing CLI and `workspace op` aliases remain supported.
HTTP uses GET `/api/tools` and POST `/api/tools/call` `{name,arguments}` with
normal runtime identity/origin guards. Local file-path imports are CLI-only;
browser imports retain their bounded multipart route.

`workspace.search` and `workspace.recent` find nested work by title, description,
creation/update dates and optional withinBoardId scope. Compact results provide
stable IDs, direct locations and links. Recursive scope is default; shared
descendants are visited once. Limit is 1–100, default 25. Sort uses stable ID ties;
the cursor binds query and workspace revision. Restart if it is stale.
`body:true` explicitly scans inline text/review notes, never linked resource files
or remote pages. Use item.get/board.get for selected records. workspace.show is
an explicit complete export and may be expensive. Browser Home/containment routes
use compact views rather than automatically exporting every document body.

The optional external `.discovery` cache is sharded, checksummed and rebuildable.
Missing/stale/corrupt cache rebuilds from authoritative individual files;
workspace.rebuildIndex requests this explicitly. workspace.inspect reports file
parse/identity and core graph errors, including a corrupt header, without repairing
authoritative data. Preserve complete metadata and the journal for recovery.
Search still stats all item/board files; warmed searches avoid parsing unrelated
bodies. Ordinary graph edits retain full load/clone/validation work.

decoration.create/update/remove provide scoped text, region/sticky/shape and line
operations. Region shape is rectangle/rounded/diamond/ellipse. Lines define both
from/to as exact `{x,y}` or attachments such as
`{placementId,side:"right",offset:0.5}` / `{decorationId,side:"left"}`.
Coordinates are board units. board.geometry returns resolved endpoints, silhouette
ports, bounds and detached state. Owned target moves/removals preserve the last
resolved point in an attachment fallback; target IDs remain visible. Copied board
attachments remap placement IDs. Cross-board moves detach source connectors.
Old box/flip lines remain supported.

feedback.comment/list/reply/resolve provide annotations distinct from note
content and existing canonical review.note/star. Threads may be general, board
point/placement/decoration attached, or anchored to item text quotes. Replies and
resolution retain history. item.vote sets one yes/no/abstain value per actor;
null clears it. Actors are self-reported local descriptors, not authentication.
Inspect anchor status after document edits; quotes are never silently retargeted.
Independent threads/ID.json files use the same lock/journal/revision as graph work.

Point comments can follow a target with normalized fractions while retaining a
creation fallback. For example, after inspecting a board and its placement IDs:

```json
{"boardId":"release-review","itemId":"opening-idea","anchor":{"kind":"point","x":360,"y":220,"placementId":"PLACEMENT_ID","relative":{"x":0.5,"y":0.25}},"author":{"id":"review-agent","label":"Review agent","kind":"agent"},"body":"Leave more room here."}
```

Call `feedback.comment` with that payload. `relative` requires exactly one
placement or decoration target. `feedback.list` returns derived
`anchorPoint:{x,y,detached,fallback}`. Missing/archived targets use the saved
creation x/y; this is not a last-known-position history. Without `relative`, x/y
stays fixed even when a legacy anchor contains target IDs. Do not rewrite thread
files when geometry changes.

Local Markdown uses `content:{kind:"markdown",resource:{rootId,path}}` and a
placement with `presentation:{mode:"panel"}` for a useful canvas document.
Reader and panel share the safe renderer; the reader adds Contents, source link,
Reload source and current-version text selection. Source files remain authoritative.
Text anchors use `{kind:"text",quote,prefix?,suffix?,start?,end?,sourceRevision?}`;
offsets are UTF-16. Linked Markdown offsets refer to rendered text normalized by
the shipped `public/markdown-document.js` parser: whitespace runs become one space
and outer whitespace is trimmed; markup and images are excluded. Inline content
keeps its exact stored-text offsets. `sourceRevision` is `sha256:` plus the raw
source bytes' SHA-256 (UTF-8 bytes for inline text), not a hash of normalized text.
Use that shared parser/matcher instead of guessing offsets from Markdown syntax.

`feedback.list` checks local Markdown sources through the registered root, up to
2 MiB per source, memoized within one query. It returns anchor status without
returning document bodies: matched, uncertain, stale, unverified or detached.
Changed revision/context can make a surviving quote uncertain; duplicate or
missing quotes are never silently retargeted. Unsupported, unsafe or unavailable
sources remain unverified. Saved anchor facts/replies remain unchanged. Current
local-document readers can create comments; historical variant relays are declined.

Browser views use the project server's `/api/events` stream instead of routine
data polling. Existing JSON reads and named tools remain available to agents.
CLI transactions and local resource edits trigger watcher-driven updates; each
connection/reconnection resynchronizes from current state. A stream is an
invalidation/snapshot transport, not a lossless activity log or authentication.

These optional additions require no installation-time conversion. Older app
versions may reject/ignore newly authored shapes, endpoints, votes or thread files.
Preserved bytes/schema number alone do not establish old-app usability; retain a
complete backup and use a compatible app when restoring such work.

## Schema 2 agent operations

Read [the workspace protocol](PROTOCOL.md#schema-2-workspace) before changing an
initialized workspace. Use `workspace show` or GET `/api/workspace` to obtain IDs,
board membership, resource roots and the current revision. Use `workspace op`
instead of hand-editing transaction metadata. After migration, original board
AGENTS guides, rounds, status and note files are historical snapshots. Follow the
schema 2 contract for organization/feedback even if an older guide instructs direct
manifest writes; those writes do not update canonical metadata. Prototype files
and assets remain live editable resources. `board create` creates a graph board
when initialized and a legacy folder otherwise. `status --board BOARD ITEM_ID STATE`
updates an initialized item's status; migrated `ROUND/CONCEPT` keys also work.

Register the project-controlled resource folder once through `updateWorkspace`,
then reference files by `{rootId,path}`. Keep file payloads, app processes and
start instructions owned by the controlling project. A title-only item is valid.
An item with a child board can also have content. Use `reference` to share canonical
review; use `duplicate` for independent feedback without copying source files.

Keep resource folders and workspace metadata outside the replaceable app and in
an explicit backup. Migration requires a reviewed dry-run and explicit apply;
never convert production data merely to inspect a candidate. See the protocol for
backup/rollback and note lineage. No operation authorizes deleting resource files.

## Build and review

Read [PROTOCOL.md](PROTOCOL.md) and the board's own `AGENTS.md`. Create only the
requested content, register concept slots before work, preserve earlier rounds,
stable IDs and notes, and use truthful build states. Each experiment stands
alone, with target-product styling, assets and handoff instructions. Check its
actual interaction before marking it ready. When delegating, give workers
separate experiment folders and keep manifest integration with the coordinator.

New boards receive a portable `AGENTS.md`. For an existing board, use
`node cli.mjs board guide SLUG --config /absolute/config.json` to add it without
overwriting an existing guide. No board content or notes are changed.

When creating a board, or revisiting a coverless board as part of requested work,
consider a quick, distinctive cover that represents its subject. It helps the
owner recognize the board among other boards. Reuse a suitable asset or make a
simple SVG when enough; generating an image is optional. Save the image inside
the board and set `board.json`'s optional `cover` to its board-relative path, such
as `assets/cover.svg`. Follow [Board cover image](PROTOCOL.md#board-cover-image)
for the full file and design guidance. Covers are optional and should not delay
the requested work. Preserve an existing custom cover unless asked to change it.

## Install and upgrade

The app includes `scripts/install.mjs`; releases also provide the same standalone
`tinka-install.mjs`. It verifies SHA-256 and ZIP paths, stages replacements,
stops only the verified owned process and retains a backup. The optional skill
contains no installer or version-specific operations. Project setup updates its
version pin only after verified successful health. Review and commit that change;
the updater never commits it. Run `update now`, `update later` (24h), or
`update policy notify|auto|off` with the same explicit config. `update check`
refreshes metadata without installing. Default notify announces each new release
once; failures/offline checks are cached for 24h. Auto policy installs only an
explicitly compatible stable release before starting a stopped instance and
never interrupts an already-running board. A failed auto install is not retried
until explicit `update now` or a different release.

Compatibility metadata must name eligible starting versions, runtime and schemas,
and declare no migration; major changes, missing/unknown compatibility and local
app edits require review. Old installation receipts lack file baselines. Follow
the root README's current standalone-installer reinstall command to establish a
baseline even when already current; preserve custom setup.mjs/TINKA.md. App setup
with no arguments remains a pinned restore. Preferences/cache stay local, and
manual/dotfolder config paths stay in place.

Keep boards, config, notes and runtime state outside the replaceable app. App
replacement never includes user content. Before upgrading an old app, export
any browser-only notes; legacy disk notes remain with each board and schema 2 notes remain in canonical metadata. Installation does
not publish a release or authorize changes to the project's designs.

Persistent text marks use `highlight.add`, `highlight.list` and `highlight.remove`;
inspect their bounded schemas with `tools describe`. Add needs the actual actor,
canonical item and current text anchor. A unique quote/context can resolve once,
while supplied stale SHA/offset facts reject. These marks have no comment body and
do not change source files. Read current `anchorStatus` before treating a saved
quote as current; changed source revisions are never silently highlighted. Remove
only the requested highlight ID. References share marks; duplicates snapshot
independent review. Compact discovery does not export marks; use targeted reads.
Older apps may reject the new review field, so retained metadata is not proof of
rollback usability. Preserve complete data and use a compatible app.

Current Markdown selection facts include `textModel:'markdown-v2'`, which identifies
rendered UTF-16 extraction separately from raw source SHA. Simple pipe tables are
supported within 16 columns/200 rows. Do not reuse legacy offsets against the new
table extraction: read status, retain history and select current facts. Missing
model remains compatible for unchanged extraction; changed table extraction is
uncertain/stale, and unknown saved models are unverified. Source bytes are unchanged.
