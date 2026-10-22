# Tinka board protocol

Tinka is a review surface. An experiment belongs to the product it is exploring, not to this review app. The app reads a board manifest and files; an experiment must remain runnable without the Tinka server, browser messages, or a host SDK.

## Schema 2 workspace

Schema 2 separates canonical items from board placements. It is explicitly enabled through `workspace init --apply` or `workspace migrate --apply`; merely installing the app does not convert a project. The metadata directory is `config.workspaceRoot` or `boardsRoot/.tinka`. Resource files remain outside that metadata and outside the replaceable app. Node 22+, ordinary JSON and files are sufficient; no SDK, dependency install, global registry or master process is required.

### Initialize, migrate and recover

```sh
node /absolute/app/cli.mjs workspace migrate --config /absolute/config.json --dry-run
node /absolute/app/cli.mjs workspace migrate --config /absolute/config.json --apply
node /absolute/app/cli.mjs workspace show --config /absolute/config.json
```

Dry-run is the default; only `--apply` writes. `workspace init` is an alias that also initializes a project with zero legacy boards. Back up the external boards, complete workspace metadata and resource folders before applying. Conversion retains original manifests, files, review notes and build history, including orphan feedback and revision lineage. It preserves legacy board IDs and records original round/concept keys on migrated items. Repeated conversion is safe and does not create duplicate migrated identities. Inspect the migration report before accepting it. After conversion, the canonical store owns organization, revisions, build state and feedback. Original board manifests, notes and AGENTS guides are preserved historical sources; editing them does not update migrated metadata. Detect the enabled workspace with GET `/api/workspace` or `workspace show`, then follow this schema 2 contract even when an older board guide says to edit rounds or notes directly. Prototype HTML/assets remain live editable resources.

CLI and HTTP share a locked transaction store, journal recovery and revision checks. Reopening the store rolls an interrupted journal forward after lock ownership is established. A lock is reclaimed automatically only when its recorded owner is provably dead. A crash before owner metadata is written, unverifiable ownership, or an orphan recovery guard fails closed with 409 instead of breaking a lock after a timeout. Stop and verify all server/CLI writers for this workspace before manual recovery; inspect and archive or rename only the orphan lock/guard metadata, preserving the complete workspace and `pending.json`, then reopen to apply the journal. This is redo recovery, not a guarantee against every crash or power-loss scenario. Back up and restore the complete metadata directory, rather than selected JSON files. For rollback to the unchanged legacy folders, stop only this instance, move the metadata directory to a recoverable archive outside its configured workspaceRoot, and restart. Graph-only items and later canonical feedback reappear when that metadata archive is restored. App replacement and data conversion are separate actions.

### Items, resources and children

An item has a stable `id`, `title`, `description`, optional `content`, optional `preview`, `revisions`, `review:{note,star,updatedAt}`, and `build:{state,message,updatedAt}`. It can have a `childBoardId` as well as content. Boards have an `ownerItemId`, `placements`, `reviewOrder`, `rounds`, `decorations` and optional `background`. A placement has `id,itemId,x,y,width,height,z`; archive/removal timestamps are local to it. Canonical archive/delete timestamps affect the item across references. Dates and original legacy records remain available for inspection.

Run operations from an agent with JSON or a file:

```sh
node /absolute/app/cli.mjs workspace op --config /absolute/config.json \
  --json '{"type":"createBoard","id":"ideas","title":"Ideas"}'
node /absolute/app/cli.mjs workspace op --config /absolute/config.json \
  --json '{"type":"createItem","boardId":"ideas","item":{"id":"opening-idea","title":"A better opening"}}'
node /absolute/app/cli.mjs workspace op --config /absolute/config.json --file /absolute/operation.json
```

Register named roots with `updateWorkspace`. Paths are relative to the workspace metadata directory, so projects can retain their existing folders. For example, if the metadata is `design/boards/.tinka` and the payload folder is `design/boards/experiments`, the registration is:

```json
{"type":"updateWorkspace","patch":{"resourceRoots":{"experiments":{"path":"../experiments"}}}}
```

An HTML item references its canonical entry point; ordinary relative assets resolve under the same named root:

```json
{"type":"createItem","boardId":"ideas","item":{"title":"Quiet opening","content":{"kind":"html","resource":{"rootId":"experiments","path":"quiet/index.html"}},"preview":{"resource":{"rootId":"experiments","path":"quiet/preview.png"}}}}
```

Other local kinds are `image`, `video`, `audio`, `pdf`, `markdown` and `file`. Inline notes use `{"kind":"note","text":"The thought to retain."}` or `text`. A title-only idea needs no image or content. File payloads never go into board JSON. Named-root serving rejects dotfiles, unsafe paths and symlink escapes and supports byte ranges for media. Declare only the project folders intended for this workspace.

An external document can open separately:

```json
{"type":"createItem","boardId":"ideas","item":{"title":"Research document","content":{"kind":"url","url":"https://example.org/document","openMode":"external"}}}
```

A local server may retain a screenshot and declarative start instructions:

```json
{"type":"createItem","boardId":"ideas","item":{"title":"Interactive prototype","content":{"kind":"html","url":"http://127.0.0.1:5173/","openMode":"preview","startInstructions":"In the prototype folder run its documented development command, then retry."},"preview":{"resource":{"rootId":"experiments","path":"prototype/preview.png"}}}}
```

The independently managed app owns startup, shutdown and hot updates. Tinka supplies a representation, instructions and retry/open actions when it is offline; it never executes instructions or fetches arbitrary URLs server-side. Embedding may depend on the target server's headers; external opening remains available. Each experiment retains its own README, assets and run instructions and can run without Tinka.

Attach children to an existing item with `{"type":"createBoard","itemId":"opening-idea","title":"Opening details","parentBoardId":"ideas"}`. The item keeps its content while gaining a Board view. Creating a board without `parentBoardId` adds it to home. Board containment is a directed acyclic graph; references that create a cycle fail.

### Organization and review

`reference` adds placements for the same canonical items; notes, stars and build state are shared. `move` changes memberships without moving files. Use `sourceBoardId` plus `placementIds`, or `itemIds`; supply `targetBoardId` or `newBoard:{title,parentBoardId?,id?}`. To group selected placements inside their current board atomically, set `newBoard.parentBoardId` to `sourceBoardId`; board creation, owner placement and move/reference commit in one revision, with source geometry retained inside the new board. With no target, only board-owner items can move/reference onto home. Moving a board owner into another board removes its home membership; referencing it keeps home membership.

```json
{"type":"reference","sourceBoardId":"ideas","placementIds":["PLACEMENT_ID"],"targetBoardId":"shortlist"}
```

```json
{"type":"move","sourceBoardId":"ideas","placementIds":["PLACEMENT_ID"],"newBoard":{"title":"Next round"}}
```

`duplicate` takes `itemId` and optional `targetBoardId` and creates an independent canonical item pointing at the same files. A board duplicate copies its arrangement while retaining references to its children. `archive` takes `boardId,placementIds,archived`; `archiveItem` takes `itemIds,archived`. `remove` detaches placements. `deleteItem` marks canonical items deleted across placements. None deletes resource files. Restore archives with `archived:false`; removal/deletion remains recoverable in metadata backups/history and the resource payload remains intact.

### Deferred cut and paste

Native Cut marks the active selection without changing graph metadata. Paste on
another board uses the existing `move` transaction, retaining canonical item IDs,
current content, review, resource references and child boards. Arrangement,
dimensions and presentation travel together; destination placement IDs are fresh,
as with other moves. The signed two-board movement receipt restores the original
source placement IDs on undo and the same destination IDs on redo.

A deferred move can supply the optional pair `expectedSourcePlacements` and
`expectedSourceReviewOrder`. These require `sourceBoardId`, `placementIds` and an
existing, distinct `targetBoardId`, with no `itemIds` or `newBoard`.
`expectedSourcePlacements` contains the complete active placement snapshots in
`placementIds` order. `expectedSourceReviewOrder` is the source board's review
order filtered to those IDs. Submit IDs in that filtered order to retain their
review order at the destination. Malformed or unpaired preconditions return 400.
The transaction compares the complete selected placements and filtered order
before changing either board; changed membership, geometry, presentation or
selected order returns 409. Archived source/destination owners or selected
items/placements, and deleted selected items, also reject. Missing boards return
404. Unrelated placement edits and newer canonical content/review/title/children
remain independent. Omitting both fields retains ordinary `move` behavior.

The browser authenticates a cut through an active intent scoped to this browser
profile and workspace, matching the exact native clipboard envelope. Cuts work
across navigation and tabs in that profile. A successful transfer consumes the
intent, including after undo; paste cannot clone or repeat it. Escape, a new copy
or a new cut cancels/replaces the pending intent without removing originals.
Pasting on the source board leaves the cut pending and requests another board.
Unsupported, cancelled or stale cut data never falls back to a copy or a hidden
selection. Failed paste leaves graph data intact. An uncertain response retries
the exact frozen move payload with the same `operationId`, using the existing
idempotence window; source preconditions reject an aged-out duplicate transfer.

`pastePlacements` takes `targetBoardId`, `targetPosition:{x,y}` and a copy-time
`clipboard` snapshot. Clipboard version 1 is
`{version:1,workspaceId,placements,items,boards,reviewOrder?}`: `workspaceId` is the
durable graph identity, `placements` is a nonempty array of unique active saved
placements, `items` is the matching canonical-item map keyed by their original
IDs, and `boards` contains only the child-board snapshots owned by those items.
Optional `reviewOrder` contains every selected placement ID exactly once; absent
order follows the placements array. Config paths, resource-root locations and
runtime identities are unnecessary and are not part of the clipboard envelope.
Resource references use roots already registered in this workspace. Clipboard
data from another durable workspace, unknown envelope fields, invalid geometry,
missing resources/children or containment cycles reject the entire transaction.

Paste creates fresh canonical and placement IDs in one revision, retaining saved
content, review, resource references, dimensions, presentation, relative x/y and
relative z distances. `targetPosition` anchors the selected minimum x/y corner;
stacking begins above existing destination placements. Copies of the same selected
item share one new canonical identity. Originals remain unchanged, and the saved
snapshot remains usable after their source placements move. Archived selections
produce visible unarchived copies. Board copies retain their saved arrangement,
rounds, decorations and background, referencing their existing children; references
to another selected item point to that item's new copy. This is not recursive
graph duplication and copies no files. New child boards stay off Home. Results
are `{boardId,itemIds,placementIds}` with IDs in input placement order, including
repeated canonical IDs for aliases.

External text and URL pastes may synthesize a single complete canonical-item
snapshot and placement with temporary clipboard IDs, then use the same operation.
Text content accepts up to 2000000 characters through the operation API; the
HTTP JSON request remains limited to 1 MB, including encoded metadata. A client
should check serialized UTF-8 bytes before submitting. `preview.url` may hold a
credential-free HTTP(S) preview image URL; it is validated like `content.url`.
No resource file is created by a text or URL paste.

### Clipboard images and dropped files

The schema 2 browser can paste clipboard image files or drop PNG, JPEG, GIF,
WebP and PDF files onto the board. Editing fields and the reader retain their
ordinary clipboard behavior. Each batch creates independent items with local
resource content and panel placements. Images use their original bytes as the
preview; PDF cards and collection covers use the browser's first-page PDF viewer
when available, with a filename/open fallback. No thumbnail converter or runtime
package is required. A browser without a PDF viewer can still open the original.

POST `/api/imports` accepts `multipart/form-data`, with one text field `metadata`
containing JSON and repeated file fields named `files` in placement order:

```json
{"workspaceId":"DURABLE_GRAPH_ID","targetBoardId":"ideas","targetPosition":{"x":100,"y":120},"expectedRevision":12,"operationId":"UUID","placements":[{"x":0,"y":0,"width":320,"height":260}]}
```

`workspaceId` is the durable ID returned by GET `/api/workspace`; the required
`x-tinka-workspace` header is the separate runtime config identity. Host, origin
and live-config checks match the ordinary write API. `expectedRevision` and a
stable `operationId` are required. Retry the same batch with its original ID after
an uncertain response; a successful retry returns the original result and receipt
within the shared 64-operation idempotence window. Conflicting ID reuse rejects.
File digests, names, geometry and target are part of retry identity; byte buffers
are never stored in metadata or history. `importFiles` is internal to this route
and cannot be submitted through the ordinary operation endpoint or CLI.

Imports accept 1–20 nonempty files, at most **20 MiB per file** and **50 MiB total**.
The multipart request allows 128 KiB additional envelope overhead and metadata
is limited to 16 KiB. Unknown fields, unsupported byte signatures, malformed
geometry, or any failed file validation reject the entire batch. Filename
extensions and claimed MIME types do not determine content kind. Supported
formats are identified from their binary headers/structure; this is not a full
media decoder. SVG, HTML and other file types are rejected. The ordinary JSON
write endpoints keep their **1 MB** limit.

Optional `placements` must contain one `{x,y,width,height}` per file. The x/y
values are offsets from `targetPosition`, finite and within ±10000000, including
resulting coordinates; width/height are finite from 40 to 10000. Without hints,
the server uses a four-column layout, 320-wide image/PDF panels, image height 240
and PDF height 438. The client may supply aspect-aware image sizes instead.

Original bytes are retained in `boardsRoot/imports/BATCH/ORDINAL-SAFE-NAME.EXT`,
outside the replaceable app and workspace metadata. BATCH derives from durable
workspace and operation IDs. Extensions come from detected bytes; names are
sanitized and ordinal-prefixed, and original files are never overwritten. Import
paths reject pre-existing symlinks and unsafe directories. The named resource
root is registered relative to `workspaceRoot` in the same locked metadata
transaction as all created placements. An existing root pointing at that folder
is reused; a conflicting `imports` root is rejected rather than replaced. Keep
the complete `imports` folder with the project's other durable resource folders.

The response is `{revision,result:{boardId,itemIds,placementIds,resources},history}`.
There is one revision and one signed movement-history receipt for the entire
batch. Undo detaches its placements; redo restores their identities and geometry.
Original files and canonical review edits remain available. All metadata and
file validation completes before new payload writes. Files already preserved
are retained even after cancellation, I/O failure, or an interrupted metadata
commit; such an interruption can leave unreferenced originals for manual recovery.
Cancellation is honored before commit where possible. A disconnect after commit
does not roll back saved cards; retry with the same operation ID to resolve an
uncertain outcome. File removal is never part of import, undo or recovery.

Canvas also submits `move` when a dragged placement is released inside a valid,
visible board card. An outline and “Move into…” hint identify the destination;
ordinary card overlap is still freeform arrangement. The existing selection
toolbar’s Move… action provides a keyboard alternative. A successful drop
refreshes the automatic collection cover without creating a new item or preview.
The resolved Parent header link is also a drop destination; multiple parents
require an existing valid entry context or a unique parent. Dropping there keeps
the current board open and places the item in a clear spot beside its containing
board. Holding a direct visible collection-cover tile for 450 ms lifts that child
as a labelled proxy. Immediate movement instead drags the collection. A lifted
child can move from its collection to the current canvas, another board or the
resolved parent. Release without movement, return to its source collection,
Escape, cancellation, loss of focus or a second pointer makes no mutation.

For moved source placements and an existing `targetBoardId`, `move` may include
`targetPosition:{x,y}`. Both coordinates must be finite numbers within ±10000000.
The position is the group’s minimum x/y corner; every placement retains its source
offset from that corner, dimensions and presentation. Membership and destination
geometry commit together in one revision, with the source stacking order retained
above existing destination placements. Result placement IDs follow the input order,
including separate placements referencing the same canonical item. References and
new-board moves omit this option. Single-placement behavior is unchanged, and
Canvas cover-child pull-outs use the logical release point as that top-left corner.

`translatePlacements` takes `boardId,placementIds,dx,dy`. It validates all unique
active source placements, finite dx/dy within ±10000000 and supported resulting
coordinates, then moves the entire selection by that delta in one revision. Sizes,
presentation, z order and canonical items stay unchanged. An invalid/missing ID,
coordinate overflow or revision conflict rejects the entire operation.

Successful `remove`, `pastePlacements`, geometry `updatePlacement`, `translatePlacements` and `move` operations
from source placements into an existing board also return an opaque, signed
top-level `history` receipt beside `revision` and `result`. A geometry patch can
include presentation changes; presentation-only patches and unchanged arrangements
do not return receipts. New-board creation, home-only moves, references, canonical
deletion and canonical item edits are outside movement history.

Submit `{"type":"restoreMovement","history":RECEIPT}` to undo that movement.
The operation accepts the usual `expectedRevision` and `operationId`, restores
the original placement IDs, complete geometry, presentation, placement-array and
review order in one transaction, and returns a reciprocal `history` receipt for
redo. Existing-board moves also restore any home membership/order they changed.
Removing selected placements is one atomic history step; undo restores their exact
IDs, geometry, presentation and review order, while other references, current
canonical notes/stars, children and resources remain intact. Delete or Backspace
removes the current rendered selection immediately outside editing fields, readers,
dialogs, previews and active gestures/writes. Holding the key makes one request.
The toolbar keeps its confirmation and produces the same undoable operation. A
successful removal cancels only the pending cut intent captured before its request,
so the next Cmd/Ctrl-Z can restore the removed placements. A rejected removal
retains that cut intent.
Undoing a paste detaches its new placements; redo restores those exact IDs and
arrangement. Copied canonical data and child boards remain available privately,
later review edits survive, and undone child boards do not appear on Home.
Receipts contain only affected placement states and arrangement preconditions;
they do not restore canonical items, notes, stars, content or resource files.
Normal geometry and containment-cycle validation still applies.

Receipts are bound to their durable workspace and authenticated using a private
key stored lazily in workspace metadata. Public workspace/board responses and
CLI workspace views omit this key. A changed arrangement on either affected board
(or changed home order when the movement changed it) rejects restoration with 409
before any commit. Unrelated note, star, item title and board title edits remain
valid. Receipts remain usable after the 64-operation idempotence window expires;
they are not a general workspace rollback API. Clients retain a bounded movement
history for the current tab session, including navigation between boards, clear
redo after a new movement, and consume reciprocal receipts only after success.

Dragging a selected Canvas card carries the valid selected placements currently
shown on that board. Each card keeps its offset; ordinary canvas drops submit one
`translatePlacements`, and board/Parent drops submit one `move` with group geometry.
Hit testing ignores all moving cards, while cycle exclusion combines every moved
item’s descendants. Any invalid destination rejects the whole drop. Unselected
card drags, resizing and deliberate cover-child holds remain single-placement
gestures. Cancellation or a rejected write restores all dragged cards and retains
selection and local review drafts. Success clears only the placements moved away.

In Canvas, primary mouse/pen dragging on empty space starts a selection rectangle
after six screen pixels. A positive intersection with a currently rendered card
selects that outer placement, including archived placements shown by the Archive
filter; cover children are not separate targets. Plain gestures replace selection,
and Shift at pointerdown unions with the original selection. Empty plain click
clears selection; Shift empty click preserves it. Escape, pointer cancellation,
loss of capture/focus or a second pointer restores the original selection. The box
is clipped to the viewport and tracks pan/zoom without moving cards or reloading
their previews. Selection makes no metadata, geometry or review operation.

Unused region interiors are empty space for this gesture. The region label band
(at least 28 screen pixels at the top) and six screen pixels along its border
retain decoration move/edit behavior. Text/arrow decorations, card contents,
controls, editable text, menus and scrollbars do not start a selection box.
Touch retains background navigation, and Grid/reader/modal views are excluded.
Card outlines, selection checkboxes and counts update directly; the toolbar keeps
its original visibility until completion, then local pan compensates its layout
change. Live metadata refresh defers until the gesture ends, preserving drafts.

`updatePlacement` patches `x,y,width,height,z,presentation`. Presentation is local to a placement: omit it or use `{"mode":"card"}` for the original card; use `{"mode":"icon"}` for a compact icon, or `{"mode":"panel","viewport":{"width":360,"height":650}}` to show a full HTML/image design viewport, fitted without cropping. Viewport dimensions are integers from 40 to 10000; the default is 1000×720. Placement width/height include the compact caption. For a 360×650 design at natural size, use width 362 and height 696 (borders plus caption). Canvas starts at 100% and scrolls naturally; Grid retains panel dimensions for comparison. The item footer’s ⋯ (Item details) control opens an attached, nonmodal popup with canonical notes, Full preview / Compact card / Icon appearance choices and paper swatches. Appearance is placement-local. The optional `presentation.paper` is a hexadecimal color (`#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`); omission retains the default paper. When changing appearance, preserve existing `viewport` and `paper` values as appropriate: `updatePlacement` replaces the supplied presentation object. The popup does not expose geometry fields. Full preview uses a supplied preview image when available, with the same uncropped sizing as an HTML fallback; the primary content and canonical identity stay unchanged. The same canonical item may have a card reference elsewhere; notes, stars, revisions and reader behavior stay shared. `createItem.placement` accepts the same presentation field. `updateBoard` patches `title,description,reviewOrder,decorations,background`; `background.resource` is a named-root reference. Decorations are board-local presentation metadata. Text, region and line decorations retain `id,type,x,y,width,height,color,text`. A line may additionally set boolean `endArrow`, `flipX` and `flipY`: `endArrow:true` adds the arrowhead at its end, while the flips reverse the horizontal and vertical start/end orientation within its positive-size bounding box. Absent flags preserve ordinary lines. The Add menu offers Text, Colored region and Arrow, with direct on-board editing controls. Ordinary lines remain supported decoration metadata. `updateItem` changes title, description, content, preview, revisions or build metadata. Review is `{"type":"review","itemId":"opening-idea","patch":{"note":"Try a shorter introduction.","star":true}}`. `status --board BOARD ITEM_ID reserved|building|review|ready [MESSAGE]` also updates canonical build state; migrated `ROUND/CONCEPT` keys remain accepted.

A board-only item’s primary cover/title action opens its child board directly. An item with both content and children keeps the content action and an explicit Open board choice. Comparison-reader stepping remains available.

Collection covers are derived at read time from up to four visible placements in review order, with a quiet remaining count for larger boards. Saved item preview images take priority, followed by local image content and local HTML fitted to the placement's complete viewport. Unsupported, unavailable and board-only children use title tiles; nested collections do not recursively embed their descendants. An explicit owner preview retains priority over the automatic cover. Composites retain their own primary content. Covers require no stored preview type, metadata write, migration or generated file and apply to existing collections after upgrade.

Local HTML cover thumbnails use an inert sandbox with an opaque origin. Local render scripts and styles can draw the design; parent access, storage, forms, nested frames, network APIs and remote assets are unavailable. Applications requiring those capabilities should supply a saved preview image. Relative local static assets are fingerprinted within their declared resource root with a bounded dependency walk (64 files, eight levels); content changes update the affected thumbnail while ordinary placement and review edits retain existing media documents.

Grid and Canvas use the same placements. Review order is separate from freeform geometry and remains suitable for comparison. Graph boards retain the comparison reader's previous/next, dots, revisions, notes/star, sizing, standalone opening and browser Back/Forward behavior. The compact header shows Home, an explicit parent return when applicable, one current title and Tools. Tools contains + Add, Grid/Canvas, search, recent, starred and archive views, board details, export and help. A valid `?from=BOARD_ID` retains the entry parent; ambiguous parents without entry context open a chooser. The reader uses Home, a containing-board return and one current item title; View holds comparison settings and item actions. Search, recent, starred and archive views operate on canonical items; a shared reference does not create another source of truth.

### HTTP and concurrent agents

GET `/api/workspace` returns `{enabled:false,revision:0}` before initialization, or the schema 2 snapshot with `enabled:true`, `items:[]`, `boards:[]`, `homeBoardIds` and `resourceRoots`. GET `/api/boards` lists home graph boards and unmigrated legacy boards; the complete destination catalog is in `/api/workspace.boards`. GET `/api/boards/:id` returns the schema 2 board snapshot with canonical `items` keyed by ID, or the legacy response for an unmigrated board. Workspace and board responses add derived `boardCovers` keyed by represented board ID, with `count` and at most four `tiles`; these are response data, not stored metadata. GET `/api/items/:id` returns one canonical item. GET `/api/items/:id/cover-thumbnail` returns a confined local HTML cover representation. `/resources/:rootId/PATH` serves declared local resources and preserves relative HTML asset URLs.

POST `/api/operations` accepts one operation as its JSON body. PATCH `/api/items/:id/review` accepts `{patch:{note,star},expectedRevision?,operationId?}`. POST `/api/workspace/migrate` requires explicit `{dryRun:true}` or `{dryRun:false}`. Legacy notes endpoints remain supported for legacy boards.

POST `/api/link-preview` accepts JSON `{url:string}` with the same current
`x-tinka-workspace`, loopback Host and same-origin write guards as operations.
It returns plain `{url,title,description,siteName,image?,author?}` metadata without
graph or resource writes. Invalid HTTP(S) URLs, credentials or malformed input
return 400; blocked or unavailable targets return 200 with a readable original-URL
or domain fallback. Fetching is limited to the explicitly supplied URL: public DNS
is validated and the connection is pinned for every hop, with at most three
redirects per document, six seconds total including DNS, 512 KiB HTML and 128 KiB
oEmbed bounds. No cookies, authentication or HTML execution is used. An optional
image is a validated public HTTP(S) URL; images are not downloaded or proxied.
Ordinary board and resource reads never fetch URLs.

Every HTTP write requires `Content-Type: application/json` and `x-tinka-workspace` equal to the **live `/api/config.workspaceId`**. That machine identity preserves the existing config/boards namespace for the default metadata location, and additionally scopes a genuinely custom workspaceRoot. It is distinct from the durable `/api/workspace.workspaceId`. Same-origin Host/Origin checks and a 1 MB request limit apply. A stale tab or changed live config cannot save into a different project. CLI operations address their explicit config and use the same locks.

Each operation may include `expectedRevision` and a unique `operationId`. A stale revision returns 409; reload and reconcile the intended edit before retrying. A repeated operation ID with identical payload replays its result; reuse with different input fails. The idempotence cache retains up to the most recent 64 operations, evicting older responses sooner when needed to fit the metadata byte budget. If a single exceptional movement receipt cannot fit, the original response still returns its full `history`; an identical retry retains the original result/revision but may omit that optional receipt. Independently held movement receipts remain valid after cache eviction. Successful operations return `{revision,result}` with created IDs and optional movement `history`. Invalid operations return 400, unknown targets 404, cycles/conflicts 409; no partial metadata change is committed.

## Legacy boards

The sections below describe schema 1 folders. They remain readable without migration. For schema 2 items and direct organization operations, see the workspace contract above.

## Start a board

Create a board with `node cli.mjs board create SLUG --config /absolute/config.json --title "Title"`. Its immediate folder under `boardsRoot` contains `AGENTS.md`, `board.json`, `rounds.json`, `build-state.json`, and `.state/notes.json`. The portable guide stays with the board. Use `board guide SLUG --config PATH` to add it to an older board without overwriting an existing guide. No installed skill is required. The app never executes a manifest or an experiment start command. Keep source and evidence in that external board folder; keep the application installation replaceable.

Keep durable boards in project version control, including assets, experiment handoffs and `.state/notes.json`. A portable project records its relative boards path and version pin in `tinka/project.json`; the checked-in `tinka/setup.mjs` restores the app and rebuilds machine-local config after checkout. See the [root README](../README.md) and [agent guide](AGENT.md). Existing external boards remain supported and need their own explicit backup or transfer; they are not automatically included by checking out a product repository.

New workspaces have no boards, and new boards have no experiments. Create only what the owner requests. Do not add a reference board, workspace guide, sample or starter experiment unless requested. Reference material is ordinary optional content and can be removed like any other item.

Before assigning work, add the dated round and every reserved concept slot to `rounds.json`. Give each concept a stable `id`, visible `number`, name, category, description, question, hint, and tone. Keep earlier rounds and revisions; add a new round or revision record instead of overwriting an accepted exploration. Mark each reserved slot with `node cli.mjs status --config /absolute/config.json --board SLUG ROUND/CONCEPT reserved "Owner and intended result"`. Change it to `building`, `review`, or `ready` as observed work progresses. A named owner or a status entry alone does not prove a runnable prototype. The reviewer should see the slot and truthful status before delegation starts.

## Board cover image

Each board owns the large image at the top of its card on the home page. The two sheets of paper are fallback artwork. The project's agent can create a simple, distinctive graphic that represents the board's actual subject, then save it with the board and set the optional `cover` field in `board.json`:

```json
{
  "schemaVersion": 1,
  "title": "A better first step",
  "description": "Different ways to begin.",
  "createdAt": "2026-10-15T00:00:00Z",
  "cover": "assets/cover.svg"
}
```

- Recommended canvas: **1200 × 600 pixels (2:1)**, or an SVG with `viewBox="0 0 1200 600"`. PNG, JPEG, WebP and SVG work. Aim for a small file, ideally under 300 KB.
- Use a board-relative file path, usually `assets/cover.svg` or `assets/cover.png`. The file lives inside this board's folder, outside the replaceable app. Absolute paths, URLs and paths escaping the board are not accepted.
- Prefer a clear visual idea, diagram or illustration. The board title is already below it; avoid tiny text, private information and important details near the edges. The image scales to the card; the title supplies its accessible name.
- Edit the image or change `cover` to update the card automatically. Omit `cover` to use the default paper artwork. Each board can use its own image; no image service or Tinka SDK is required.

The home page's **Change cover…** action prepares a prompt with the board's exact workspace, file location and image specification for its agent.

## Each experiment stands alone

- Give every experiment its own entry point and run instructions. Plain HTML can be served by any static HTTP server rooted at the board, or from its experiment directory if all referenced files are local. A framework experiment runs through its own documented start command and URL.
- Design with the target product's vocabulary, layout, and behavior. Do not copy the Tinka canvas appearance unless that is the product being explored.
- Keep the implementation free of required imports from `public/`, host-only globals, and required `postMessage` responses. Optional host preference messages must safely do nothing when the experiment runs alone.
- Put an `README.md` beside the entry point. Record the concept's purpose, exact command and working directory, required files and external dependencies, what is real, what is simulated, and what should transfer to the target product. This is the handoff; a screenshot or a board status is not enough.
- If shared assets or data are required, name their paths and explain how to carry them with the experiment. Keep user data out of release ZIPs.

The manifest is an adapter. For a static experiment, omit `kind` (defaults to `html`) and `path` (defaults to `rounds/<round>/<concept>/index.html`) when those defaults are correct. Explicit `kind` values are `html`, `image`, `markdown`, `video`, and `pdf`; `path` is board-relative. A framework preview can declare an explicit HTTP(S) `url` and a board-relative `handoff` README path. The URL is a preview location, not a command for Tinka to run. Document how to start and stop that framework yourself.

Custom entry paths can use any folder layout. Tinka watches their containing directory. Declare additional shared files or directories in `dependencies` so edits outside that directory refresh the preview too. The conventional board `shared/` and `assets/` directories are also watched. A separate framework server owns its own hot updates; Tinka does not execute its start command.

Minimal `rounds.json` example (valid even before the prototype exists):

```json
{
  "rounds": [{
    "id": "2026-10-14", "number": "01", "date": "October 14, 2026",
    "title": "A different starting point", "description": "Three directions to compare.",
    "concepts": [{
      "id": "quiet", "number": "01", "name": "Quiet",
      "category": "LESS TO LEARN", "description": "A focused first step.",
      "question": "Is the next action clear?", "hint": "Try the primary action.",
      "tone": "paper", "kind": "html", "path": "experiments/quiet/index.html",
      "dependencies": ["shared"], "handoff": "experiments/quiet/README.md"
    }]
  }],
  "revisions": {}
}
```

After adding the slot, record its state with `node cli.mjs status --config /absolute/config.json --board board-slug 2026-10-14/quiet building "Building the quiet direction."`. Updates to files and manifests appear automatically; a currently open experiment offers a reload instead of interrupting the reader. Preserve its ID when changing its label or path.

To offer a comparison, add `"2026-10-14/quiet": [{"id":"second","name":"Second version","path":"experiments/quiet-v2/index.html","hint":"Compare the first action."}]` inside `revisions`. Revisions can declare their own `kind` and `dependencies` as well.

## Review and transfer

Use `building` while implementation is active, `review` when the artifact is runnable and needs evaluation, and `ready` only after that evaluation. Compare behavior in the experiment and, when relevant, in the target product. Preserve the distinction between a concept, a tested prototype, a product implementation, and a release. Notes and review decisions live in the external board's `.state/notes.json` through the UI; installation and upgrades must not edit them.

## Remove an item

Each experiment and board has a **Remove…** action that prepares a copyable agent prompt. In legacy boards, the browser does not delete or move files. The prompt identifies the project, workspace, config, board and, for an experiment, its round and stable ID. Verify that identity against `/api/health` before editing.

When the owner supplies a removal prompt, remove exactly that target. For an experiment, save a recoverable manifest copy in the board's `.state` folder, then remove its concept and revision entries from `rounds.json`. Keep its files, shared dependencies, notes and build history; leave other IDs, numbering and rounds intact. For a board, move its complete folder to a recoverable archive outside `boardsRoot`, preserving all contents. Report the archive or snapshot location and verify that the target has disappeared from the review surface. Do not recreate removed reference material. An already absent target is a completed removal, not permission to choose a substitute.
