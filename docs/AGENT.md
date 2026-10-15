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

Before claiming a running workspace, verify `/api/health` matches the selected
canonical config path and project label. Report the actual URL printed by start.
Do not kill, adopt or reconfigure another instance to resolve a collision.

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

## Install and upgrade

The app includes `scripts/install.mjs`; releases also provide the same standalone
`tinka-install.mjs`. It verifies SHA-256 and ZIP paths, stages replacements,
stops only the verified owned process and retains a backup. The optional skill
contains no installer or version-specific operations. Project setup updates its
version pin only after a successful installation. Commit that deliberate change.

Keep boards, config, notes and runtime state outside the replaceable app. App
replacement never includes user content. Before upgrading an old app, export
any browser-only notes; disk notes remain with each board. Installation does
not publish a release or authorize changes to the project's designs.
