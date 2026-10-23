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
