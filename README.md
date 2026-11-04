# orca-magpie

An [Orca](https://github.com/stablyai/orca) plugin for
[magpie](https://github.com/yetone/magpie): every account and quota window
on your magpie gateway — Claude, Codex, Copilot, plans — in Orca's sidebar,
with one-click account switching through the magpie CLI.

## What it adds

- **Magpie panel** (right sidebar): one card per account/plan with its
  quota windows (use %, reset), which account is currently serving, and a
  Refresh button. Polls `GET <gateway>/v1/magpie/quotas` — the same data
  `magpie quota` prints.
- **Status bar item**: `magpie 42%` — the tightest window across all
  cards (amber ≥ 80%, red ≥ 95%). Click to refresh.
- **Palette commands**: refresh, type `magpie quota` into a terminal,
  type `magpie accounts switch claude|codex next`, type a gateway health
  check, type the magpie install command.
- **Optional gateway key** (for a shared/remote gateway) stored in
  Orca's encrypted plugin secrets, and an **Open /me** button.

Commands are *typed into a terminal of the focused workspace* — visible
and reviewable — because Orca's plugin host API has no clean
process-execution method yet ([stablyai/orca#36400](https://github.com/stablyai/orca/pull/36400)).
Press Return yourself, or turn on **autoEnter** in settings to have the
plugin do it. Text goes to a plain shell terminal when one exists, never
an agent pane, so it isn't fed to a running agent.

## Requirements

- Orca **≥ 1.4.248** with the plugin system enabled
  (Settings → Plugins).
- magpie installed and its gateway running (default
  `http://127.0.0.1:3425`). A local gateway needs no key.

## Install

Once this repo is public, in Orca: **Settings → Plugins → install from
git URL** and paste this repository's URL.

While developing:

```sh
git clone https://github.com/themiguelamador/orca-magpie
cd orca-magpie
orca plugin dev load .        # add --approve on the re-run it prints
```

`orca plugin dev load .` watches and hot-reloads; `orca plugin dev reload`
forces one after network-folder saves. `pnpm validate:plugin .` (from an
Orca checkout) or `orca plugin check .` validate the manifest strictly.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `gatewayUrl` | `http://127.0.0.1:3425` | Base URL of the magpie gateway |
| `pollIntervalMs` | `30000` | How often the worker polls (5 s – 10 min) |
| `autoEnter` | `false` | Press Return after typing a command |
| `showStatusBar` | `true` | Show the status bar item |

## How it works

The worker (a `trusted-worker`) polls the gateway's quota endpoint,
normalizes the JSON, keeps the last result in plugin storage, pushes
`magpie.updated` to any open panel, and updates the status bar item. The
panel is a sandboxed frame with **no network access** — all gateway I/O
happens in the worker, exactly as Orca's plugin model prescribes.

The quota JSON's exact field names are not a declared contract; the
normalizer maps the documented shape defensively (`used`/`total`,
`usedPct`, window labels, reset times, `last`, `lastServedAt`) and falls
back to showing card names. If a field ever stops matching, `magpie quota`
typed into a terminal is always the source of truth.

## Limitations / roadmap

- One gateway per Orca install (the local one by default). Remote/SSH
  hosts like grazr's engine model are a natural next step.
- Switching uses `magpie accounts switch <agent> next` on this machine;
  per-workspace account pinning (per-worktree gateway keys restricted
  with `magpie gateway-key accounts`) is the planned v0.2.
- When orca#36400 (`commands.execute`) lands, typed-command actions
  switch to it and the Return-to-confirm dance disappears.

## License

MIT — see [LICENSE](LICENSE).
