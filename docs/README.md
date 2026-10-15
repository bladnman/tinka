# Operating a Tinka instance

Start with the [root README](../README.md) for installation and agent setup. Node >=22 is required. No build or dependency installation is needed.

The external config has `schemaVersion: 1`, an absolute `boardsRoot`, `projectLabel`, `port`, and `portMode` (`auto` or `fixed`). The CLI defaults to automatic ports and the current folder's name. Legacy configs without `portMode` remain fixed. The legacy `title` field is accepted for compatibility but does not replace Tinka's brand or project label.

The server never reads a global registry. A project's config defines its entire workspace. Its adjacent `.pid.json` records the owned process, actual port/URL, and installed version; `.log` receives managed output. The PID claim is acquired before binding so concurrent starts of one config cannot choose different ports. A dead PID record can be reclaimed; a live or unrecognized owner is never killed. A stale `.pid.json.recovery` directory indicates an interrupted reclaim; verify no startup is in progress before removing that directory and retrying.

`start` returns after the owned process reports ready. `stop` validates the exact CLI/config/token in the process command. Foreground `serve` processes use Ctrl-C; they cannot be stopped through an unverified managed record. If stopping fails, inspect the matching log and PID record rather than signaling by port.

A new automatic instance begins at 43821, with 100-port increments and 20 attempts. The selected port is saved only after binding. Restart tries the saved port first and may advance if occupied. A fixed collision is an error. No process probes, adopts, or signals a different project's server. `/api/config` and `/api/health` expose the current label, workspace identity, version, and URL to the loopback client.

Each immediate folder with `board.json` is discovered automatically. See [PROTOCOL.md](PROTOCOL.md) for experiments and build states. Notes live in each board's `.state/notes.json`; browser caches are namespaced to the canonical config and boards paths. Moving either path creates a new browser namespace but does not alter disk notes. Old unscoped browser notes are not automatically merged; export browser-only notes from the old app before upgrading.

Use one installed app copy per project for independent upgrades. The installer uses the old CLI to stop only that installation's matching managed process, replaces the complete app directory, then restarts it through the new CLI if it was running. Stopped installations stay stopped. It retains an adjacent backup; a failed swap/restart restores that backup and attempts to restart it. Configuration and boards are never included in an app replacement. The install receipt records the chosen version and checksum. Keep the backup until the update is accepted.
