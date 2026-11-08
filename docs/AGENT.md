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

## Showing visual work

In a project with Tinka, visual work you make for the user to look at (designs,
mockups, images, illustrations, diagrams, prototypes, alternatives to compare,
screenshots for review) goes on a board, where it can be found again, and you
give the user the board link. The board is added to the usual way of showing
work, not substituted for it: also send the same image or file in the
conversation, or show it however you otherwise would. Board links open only on
this computer (Tinka answers only `127.0.0.1`), so the copy in the conversation
is what reaches someone reading on another device. Send the file the board uses,
saved in the project, rather than a temporary copy that will not last. A
requested file, format or destination is provided as asked.
The project-root `AGENTS.md` (read by Codex, Claude Code and other agents) carries
this rule in a short Tinka-managed block that setup, installs, updates and
starts keep current. Do not edit between its markers; put project rules outside.

1. Run the normal `start` command and use the URL it prints.
2. Use the board the user or project guidance names, or the board holding related
   work (`workspace.search`); otherwise create one with a clear title (`board.create`).
3. Save files in a project folder registered as a resource root
   (`workspace.update` with `resourceRoots`, paths relative to the workspace
   metadata), never in the app or metadata folders. For images and PDFs,
   `files.import` copies them into the boards root's `imports/` instead.
4. Add one item per piece with `item.create` and
   `content:{kind,resource:{rootId,path}}` (`html`, `image`, `pdf`, `markdown`,
   `video`). Visual kinds default to a Full preview panel; size detailed designs
   as described in [Make the work visible](#make-the-work-visible).
5. Check the rendered board, then give the user `URL/boards/BOARD_ID/`, adding
   `?reveal=PLACEMENT_ID` from the result's `placementIds` to focus one item.

To show another board from a board, place that board itself rather than a card
holding its URL: `reference` its `ownerItemId` (from `board.get`) with
`{"type":"reference","itemIds":["OWNER_ITEM_ID"],"targetBoardId":"BOARD_ID"}`
through `workspace op`. The board tile keeps working when the port or machine
changes; a pasted `http://127.0.0.1:PORT/...` link does not.

A worked example: add a render saved at `renders/look-a.png` in the project to
board `art-directions`, beside a short note. `resourceRoots` paths are relative
to the workspace metadata folder (by default `design/boards/.tinka`), so the
project's `renders/` folder is `../../../renders`. Register it once:

```sh
node tinka/app/cli.mjs tools call workspace.update --config tinka/local/config.json \
  --json '{"patch":{"resourceRoots":{"renders":{"path":"../../../renders"}}}}'
node tinka/app/cli.mjs tools call item.create --config tinka/local/config.json \
  --json '{"boardId":"art-directions",
  "item":{"title":"Look A","content":{"kind":"image","resource":{"rootId":"renders","path":"look-a.png"}}},
  "placement":{"x":620,"y":0,"width":962,"height":600,"presentation":{"mode":"panel"}}}'
node tinka/app/cli.mjs tools call item.create --config tinka/local/config.json \
  --json '{"boardId":"art-directions",
  "item":{"title":"Which look? Star one, or just tell me.","content":{"kind":"note","text":"My pick is A."}},
  "placement":{"x":0,"y":0,"width":560,"height":300}}'
```

A changing call prints `{"revision":N,"result":{"itemId":"…","boardId":"…","placementIds":["…"]}}`.
`board.get` prints the board object itself (`id`, `ownerItemId`, `placements`
with x/y/width/height, and canonical `items` keyed by ID), not `{"board":…}`.
Over HTTP the same reads are GET `/api/boards/BOARD_ID` (plural `boards`) and
POST `/api/tools/call`. Coordinates are board units; leave 40–60 units between
neighbours.

To send a whole board as one picture (for someone on a phone, or a chat that
cannot open the link), save an overview into the project and send that file:

```sh
node tinka/app/cli.mjs board overview BOARD_ID --config tinka/local/config.json \
  --out /absolute/project/design/BOARD_ID-overview.png
```

It renders the board as it looks at its saved geometry, fitted to one PNG at most
2400 pixels wide (`--width`), light by default (`--appearance dark`), in about ten
seconds. Other Tinka commands for this app wait while it runs, so do not start it
alongside a batch of tool calls. It needs this project's Tinka running and an
installed Chrome, Chromium, Edge or Brave (or `CHROMIUM_EXECUTABLE`); without one,
screenshot `URL/boards/BOARD_ID/?overview`.
It refuses to overwrite a file, so name each round's image (`-r02`). Everything
on the board is in the picture at one scale, so long notes shrink with it. For a
choice between options, keep the options together on their own board or child
board, render that, and also place the image as the first tile of the board
where the question is asked.

See [the protocol](PROTOCOL.md#items-resources-and-children) for payloads; legacy
(schema 1) boards use [Start a board](PROTOCOL.md#start-a-board).

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

### Make the work visible

Make a board useful to work from. Put the work a person needs to compare at a
readable size and keep its title and controls subordinate to the content. Choose
full-preview placements for substantial visual work and readable documents;
compact cards remain useful for short ideas. Arrange related work together and
keep enough context to understand the decision. Check the rendered board at its
saved geometry and a useful zoom; a registered item or tiny thumbnail alone is
not evidence that the work can be understood on the board.

For new visual comparisons, `createItem` (including `item.create` and the Add
form) defaults HTML, images, video, PDF, Markdown and saved-image previews to
**Full preview**, 720 × 560 board units. Title-only ideas keep Compact card.
Explicit `placement.presentation.mode` and width/height always win. Existing
placements are never resized or converted when the app changes.

For detailed designs, declare the actual design viewport and size the placement
to make its text readable: a 1000 × 720 design can use `width:1002,height:766,
presentation:{mode:"panel",viewport:{width:1000,height:720}}`. Start related
comparisons with 40–60 units between their edges (for example x 0, 1060 and 2120),
then inspect at 100% zoom and at a narrow browser width. Let Canvas scroll to the
work; do not shrink a whole collection until every preview becomes unreadable.
Use a saved image when an application cannot render a useful embedded preview.
While work is building, retain that truthful state; the preview can arrive later.
Choose `mode:"card"` explicitly for a summary or `mode:"icon"` for navigation.
Do not restyle or rearrange an existing board without its owner's direction.

When presenting a nested round, choose representative pieces for the actual
question, rather than automatically selecting the first items or forcing a fixed
number. Make clear when other work remains in the round. Select items inside the
round and use **Show on parent…**, or in schema 2 use the corresponding
`reference` operation with `featureOnParent:true` (see the protocol). These are
references to the same items; notes and stars are shared, while the parent
placements have their own positions. Existing user layouts, prior rounds and
source placements stay intact. Point feedback remains scoped to its own board.
An item shown on a parent does not automatically track later source-board
membership or arrangement; revisit the featured selection when the work changes.

A composed cover can help explain a round or recognize a board, but should not
replace readable work where comparison matters. For schema-2 boards an explicit
preview belongs to the board's owner item; changing an old `board.json` does not
update a migrated workspace. Legacy boards use the optional board-relative cover
in [Board cover image](PROTOCOL.md#board-cover-image). Preserve existing covers.
For an unavailable or unsupported preview, use an honest fallback or a suitable
saved image; never invent a result or hide important missing context. Avoid
silently replacing project-specific guides or rearranging a person's boards.

### What to put in a tile preview

A preview has one job: someone glancing at the board should be able to tell
*what this is* and *how it differs from its neighbours*. A beautiful preview that
could belong to any tile has failed at that job.

**The two-second test.** Zoom the board to 25%. Can you name each tile in two
seconds without reading its title? If two siblings look interchangeable, at least
one preview is wrong.

Do:

- **Show the work itself**: the screen a person will actually meet, the real
  photo or the real chart, not a poster *about* the work.
- **Crop to what makes it this one.** Frame the distinctive region at a readable
  size rather than the whole page shrunk down. For a form, show the form; for a
  pricing table, show the prices.
- **Prefer big type to small text.** One heading readable at 25% beats a
  paragraph nobody can read. Keep preview text at 24px or more of source pixels.
- **Capture the meaningful state**: loaded, filled in, the error, the result,
  step 2 of 3. Never a spinner, a blank shell or a cookie banner.
- **Frame a comparison set the same way.** Crop every variant (v1–v5, A/B/C)
  identically so only the difference changes from tile to tile.
- **Show a board's contents.** A board cover should be a collage of its real
  children, or the single best child; Tinka adds the item count.
- **Use the native size.** Capture at the design's own viewport (for example
  1000 × 720) and let Tinka scale it; use 2× pixel density for large tiles.

Don't:

- Use one decorative template (colour band, eyebrow, slogan, glyph) for every
  tile. Templates make siblings identical.
- Repeat the title as tiny text inside the image; Tinka already shows it.
- Use abstract art, gradients or icons in place of content, unless the work *is*
  abstract art.
- Put meaning near the edges; tiles round their corners and may crop slightly.
- Fake it. If the work isn't built yet, leave the preview empty and keep the
  build state truthful. An honest placeholder beats an invented result.
- Put private material (paths, names, tokens) in a preview. Previews travel with
  the board.

| Kind | Put in the preview |
|---|---|
| HTML prototype | The hero or key screen in its meaningful state, cropped to the distinctive region |
| Image or photo set | The best single image, or a 2–3 image crop; don't letterbox |
| Markdown or document | The title in large type plus 2–3 key lines, a checklist score or the decision |
| Data or report | The chart or the headline number, not the table |
| Video | One telling frame with real content, never the black first frame |
| Board | A collage of up to 4 real children (or the best one); Tinka shows the count |
| Note or idea | Nothing. A card with readable text is the preview. |

Before marking work ready: open the board at 100% and at 25%, run the two-second
test against the tile's neighbours, and check that the preview still matches the
current revision. Replace it when the work changes.

### Dates

Store timestamps as ISO 8601 instants (the operations do this for you). Tinka
renders every date with one readable formatter in the viewer's local time zone:
"just now", "N min ago", "N hours ago" (same calendar day), "Yesterday, 3:40 PM",
a weekday and time for 2–6 days back ("Sat, 9:12 AM"), then "Oct 21" this year or
"Oct 28, 2025" for earlier years; future or clock-skewed times read "just now".
The exact time ("Tuesday, November 3, 2026 at 3:58 PM") is one hover away. Home
cards show when a board was created (the sort order) plus a quieter "edited" line;
board-tiles show when their board was last edited; the Inspector shows both. When
you write about dates in board text or handoffs, prefer the same forms rather
than "3 days ago", which hides the time and cannot be placed on a calendar.

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
