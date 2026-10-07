# Five-hour continuation check

**Current limitation:** scheduled checks ran on 6 October, but resuming this
conversation failed with `already has an active writer` while another Codex
process owned it. Usage checking works; automatic continuation in this situation
is not yet resolved. The schedule alone is not evidence that work resumed.

Installed on this Mac as the user LaunchAgent `com.bendbound.continue-work`.
`StartInterval=18000` checks every five hours while logged in and awake. It cannot
wake a powered-off Mac. No model call is needed for the check itself.

`check_usage.py` uses the installed Codex app-server's documented
`account/rateLimits/read` API. It starts work only with an explicit positive usage
permission or reported available credits, and does not infer recovery from a
reset timestamp. It does not purchase/redeem credits or bypass limits.
[Codex App Server](https://learn.chatgpt.com/docs/app-server).

The ignored file `automation/.state/continuation.json` holds the exact thread ID,
Codex executable and work list. Only `pending` items are runnable. Mark an item
`done`, `blocked` or `cancelled` to stop automatic work on it; set `enabled` false
to disable all work. This is scoped to authorised work in this Bendbound thread,
not every unrelated Codex conversation. Keep this file current when work changes.

The check skips active/unknown thread state and interrupted turns (so manual
stops remain respected). Failed turns can resume if usage is available. It uses
`codex exec resume` with the explicit thread ID, never `--last`, and inherits
existing permissions. A file lock prevents overlapping scheduled runs. A changed
Codex installation path may require reinstalling the LaunchAgent.

```sh
python3 automation/check_usage.py --dry-run
python3 automation/test_usage.py
launchctl print gui/$(id -u)/com.bendbound.continue-work
```

Checks log only a status in `.state/checks.log`. The last resumed run's output is
in `.state/last-run.log`, overwritten rather than accumulated. Both stay local and
out of Git. The scheduler does not start work while everything is completed or
waiting for external deployment details.

To remove the scheduler:

```sh
launchctl bootout gui/$(id -u)/com.bendbound.continue-work
rm ~/Library/LaunchAgents/com.bendbound.continue-work.plist
```

To reinstall, use `python3 automation/install.py --thread YOUR_THREAD_ID`.
