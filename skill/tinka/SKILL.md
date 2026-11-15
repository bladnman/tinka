---
name: tinka
description: Show visual work on this project's Tinka boards. Use when creating or showing designs, mockups, images, illustrations, diagrams, prototypes, visual comparisons or screenshots in a project that has Tinka (a TINKA.md or tinka/project.json), and whenever the user mentions Tinka. Tinka also works without this optional skill.
---

# Tinka

In a project with Tinka, visual work for the user goes on a board, where it can
be found again: add it there and give the user the board link, as well as showing
it the way you otherwise would, such as sending the same image or file in the
conversation. Board links open only on this computer.

Always give the user the Tinka link to exactly what you added or changed (the
`link` in each tool result), not just the board; it lets them review and decide
fast. When the user may be away from this computer (on a phone, say) or just
needs to see the work, consider also sending a picture of it with that link
(`item shot` or `board overview`, described in the app's agent guide).

Read the project's `AGENTS.md` and `TINKA.md` to locate its boards and
installation. Follow the selected app's `docs/AGENT.md` (or its README on older
installs) and `docs/PROTOCOL.md`, plus the board's own instructions. Those files carry the guidance for that installed version.

When the user mentions comments, notes or feedback on the boards, run the inbox
(`node tinka/app/cli.mjs inbox --config tinka/local/config.json`; see `TINKA.md`).

If the app is missing, follow the project's checked-in `tinka/setup.mjs` and
`tinka/project.json` to restore its pinned release. Existing installations may
use other paths; an optional `~/.config/tinka/workspaces.json` has legacy
`{projectRoot, appPath, configPath}` pointers. Match the project explicitly.

If no setup exists, use https://github.com/bladnman/tinka for installation.
Preserve existing boards, earlier rounds, stable IDs and notes. Keep durable
project content outside the replaceable app. No skill is required by Tinka.
