# keep-sessions

**English** | [Русский](README.ru.md)

A Claude Code mod (plugin) that keeps the Code-tab session list in the Claude
desktop app when you switch accounts. macOS only.

## The problem

Transcripts live in `~/.claude/projects` and are shared by every account.
The sidebar list, however, is built from pointer files in

```
~/Library/Application Support/Claude/claude-code-sessions/<account>/<organization>/local_*.json
```

An app installed as a second copy keeps its data in `Claude-01` (`Claude-02`, …)
instead of `Claude`; the mod reads every such folder and writes into the one the
current session runs from.

Each account has its own folder, so after signing in with another account the
list is empty even though the chats are still on disk.

## What the mod does

- At the start of every session, and on `/keep-sessions sync`, copies the
  missing pointer files from other account folders into the current one.
- Never overwrites a file.
- Does not restore sessions you removed from the list (`deleted_*` markers).
- Backs up the current list to `~/.claude/keep-sessions-backup-<date>/` before
  the first copy.
- Does nothing outside the desktop app (in a terminal session).

## Install

In a terminal Claude Code session:

```
/plugin install keep-sessions --marketplace IlyaPryzhykau/claude-keep-sessions
```

From a shell:

```bash
claude plugin install keep-sessions --marketplace IlyaPryzhykau/claude-keep-sessions
```

Answer `y` to `Add marketplace?`, then pick the `user` scope.
Requires Claude Code 2.1.299 or newer (the desktop app already ships it).

In the desktop app, where `/plugin` does not run: click **+** next to the
prompt box, then **Plugins**, **Add marketplace** with
`IlyaPryzhykau/claude-keep-sessions`, then **Add plugin**.

From a local folder, without GitHub:

```bash
claude plugin marketplace add /path/to/claude-keep-sessions
claude plugin install keep-sessions@addon-mods
```

## Switching accounts

1. Sign out and sign in with the other account from the app menu.
2. Open any Code-tab session. The mod copies the pointers and shows a toast
   with the number of chats added.
3. Fully quit and reopen the app (Cmd+Q). The chats and project folders are
   back in the sidebar.

Commands inside a session:

| Command | What it does |
| --- | --- |
| `/keep-sessions status` | Chats per folder and how many would be added. Changes nothing. |
| `/keep-sessions sync` | Copy the missing pointers now. |

## Limitations

- The app's folder layout is undocumented and may change with an update.
- Cloud and Remote Control sessions may show up in the list but will not
  resume locally.
- The mod does not sign you in or out: the app issues the token.

## Development

```bash
claude plugin validate .
claude plugin test .
```

The file-selection logic lives in `hooks/plan.ts` and is covered by
`hooks/keep-sessions.test.ts`.
