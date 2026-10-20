# Board instructions and workspace compatibility

For a schema 2 board, the authoritative arrangement is its document in the external
workspace metadata directory. Items are canonical documents; placements reference
them. Resource files may remain in this folder or another named root. Use the
selected app's `workspace show` and `workspace op` commands, preserve stable IDs,
and read `docs/PROTOCOL.md` before moves, references or review edits. Removing a
placement or deleting Tinka metadata never deletes its files. Notes/stars/status
are shared across references; placement geometry and local archive state are not.

The legacy folder guide below remains applicable to unmigrated boards and to the
source material preserved by migration. Do not rewrite legacy manifests to make
a schema 2 organizational change.

# Working with this Tinka board

This folder is a portable design archive. No agent skill is required. Read its
files before changing it; project requirements and accepted design decisions
belong to the project, not to Tinka.

- `board.json` identifies the board; `rounds.json` lists explorations, concepts
  and revisions. Experiment paths are relative to this folder.
- `build-state.json` records observed progress. `.state/notes.json` contains
  durable review notes. Preserve both, including notes for older experiments.
- Retain earlier rounds and stable IDs. Add a round or revision for a new
  direction. Preserve assets and shared dependencies. Follow the owner's exact
  scope; do not add sample content unless requested.
- Each experiment owns its entry point, assets and README with run commands,
  dependencies, real versus simulated behavior and product handoff. Use the
  target product's styling. No Tinka SDK or server is required by an experiment.
- Register slots before building. Use `reserved`, `building`, `review` and
  `ready` truthfully; mark ready after checking the actual interaction.

Look for `TINKA.md` and `tinka/project.json` in the containing project. They
identify the installation and restore command. If the app is missing, the
manifests, design sources and handoffs are still readable; do not replace them
with a fresh board. Keep this whole folder, including disk notes, in project
version control or another explicit backup.

Read the selected installation's `docs/AGENT.md` (or README on older installs)
and `docs/PROTOCOL.md` for its
complete supported format and CLI. A basic manifest has this shape:

```json
{
  "rounds": [{
    "id": "first", "number": "01", "title": "First exploration",
    "concepts": [{
      "id": "quiet", "number": "01", "name": "Quiet",
      "kind": "html", "path": "experiments/quiet/index.html",
      "handoff": "experiments/quiet/README.md"
    }]
  }],
  "revisions": {}
}
```

Supported kinds are `html`, `image`, `markdown`, `video` and `pdf`. A framework
preview may have an explicit HTTP(S) `url` and its own documented start command;
Tinka never executes it. If this board has been copied alone, its experiment
READMEs describe what else must travel with it. To browse it in Tinka, place the
complete folder under a configured boards root; do not reinitialize its files.

When creating this board, or revisiting it without a cover as part of requested
work, consider a quick, distinctive image of its subject so the owner can
recognize it among other boards. Reuse a suitable asset or make a simple SVG
when enough; generating an image is optional. Save it inside this board and set
`board.json`'s optional `cover` to a board-relative path such as `assets/cover.svg`.
See **Board cover image** in the selected installation's `docs/PROTOCOL.md` for
the full file and design guidance. Covers are optional and should not delay the
requested work. Preserve an existing custom cover unless asked to change it.

For app installation and recovery without a skill, see
https://github.com/bladnman/tinka. A project's `TINKA.md` takes precedence over
generic placement examples. Never use a different project's instance to resolve
a port conflict.
