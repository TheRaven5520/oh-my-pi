# OMP Central

`omp central` is a private workspace for active OMP chats: transcripts, questions,
per-chat message drafts, status lines, and source-local Codex/Claude quotas.

## Workflow

1. Start Central in its own terminal: `omp --central` (or `omp central`).
2. The current chat's structured question is shown with its real options, previews,
   multi-select state, custom-answer editor, and notes.
3. Submit an answer to advance. `Esc` skips the visible chat to the back without
   cancelling or answering it. `Ctrl+O` opens the selected chat even when it has
   no pending question. `Tab` / `Shift+Tab` cycle through all chats forward/backward
   without moving or submitting drafts. `F2` switches between a pending question
   and the message composer; clicking the composer focuses it directly. Arrow
   keys operate the focused input; `Shift+Up/Down` scrolls the transcript, and
   the wheel scrolls the transcript or question.
   `Ctrl+C` closes Central only.
4. If the original chat answers or withdraws a question, Central advances without
   sending the Central draft elsewhere. An unsent draft is retained for viewing.

Custom answers and per-option notes accept clipboard images and pasted image paths,
including image-only answers. Enter waits for pending image reads; failed reads
leave the prompt open with an error instead of submitting an empty answer. Image
paths are read on the machine running Central, even for questions from SSH hosts.

The bottom composer sends plain-text messages to the selected existing session.
`Enter` sends, `Shift+Enter` adds a line, and multiline pastes keep their text.
These drafts are independent of the original terminal's input. Sending never
overwrites that input, forks the chat, or interprets slash commands locally.
Busy chats receive the message through their normal steering queue.

A confirmed rejection leaves the draft editable. An uncertain delivery retains
the original target and request ID: `Ctrl+R` retries that same message, rather
than sending a duplicate. New text typed during delivery is retained. A changed
source session rejects the old request instead of sending it to a different chat.

The composer uses the normal OMP editor and the source session's composer shape
and status-line settings (including the Claude preset). Status appears in the
same top chrome or bottom bar as that shape, not a separate Central theme. The
bottom-right usage stack shows both Codex and Claude, using the same remaining-quota gradient
as the status line, including available tier windows and reset credits. Usage is
scoped to that source's accounts, not summed across chats or hosts. Missing or
stale data is labeled, never represented as zero usage. Narrow terminals stack
the quota rows below the workspace; `Alt+Up/Down` scrolls rows that do not fit.
Older source processes show an actionable unavailable message, including on
Enter, rather than silently discarding the send. Open the original chat with
`Ctrl+O` (or manually when directed) and resume it with current OMP to enable
Central sending. The Central draft stays intact. When the selected source cannot
provide account-scoped usage, Central labels it unavailable rather than borrowing
another chat's potentially different account metrics.

Central does not scrape terminal panes and does not type into another chat. Each
interactive OMP process publishes a short-lived owner-only local socket with the
structured question payload. Answers are authenticated, validated against the
pending question, and removed when either side answers. Continued questions stay
pending while the agent works.

`Ctrl+O` can focus an existing local chat only when it shares Central's tmux
server and exactly one non-control tmux client is displaying Central's pane.
It targets that client explicitly rather than choosing another attached client.
If the caller is ambiguous or detached, or the chat belongs to a different tmux
server, an SSH source, or a direct terminal, Central gives manual-open guidance;
it does not open a duplicate chat or create a new terminal.

## Other hosts

Central uses only explicitly configured SSH destinations; it never scans the
network. The probe is non-interactive and bounded. When a configured host is
unavailable, local chats remain usable and Central shows that source's bounded
unavailable status. Its last-known questions and unsent drafts remain visible;
answers and chat actions are blocked until it reconnects. Only a successful poll
can retire a removed question. An empty host list disables remote access:

```sh
omp config set central.hosts '["user@mini"]'
```

Set `central.identity` to the designated SSH key in the local configuration;
the public repository intentionally does not prescribe a private key path.

The remote host must run a Central-capable OMP binary. SSH is used only for the
bounded JSONL bridge; question text and answers are not logged. A remote source
that cannot connect stays visible as an error instead of looking like an empty
queue.

## Updates

When a new OMP build is installed over the binary Central is running from,
Central restarts itself onto it in the same terminal. It waits until nothing
would be lost: no typed message draft, no started or sending answer, no
unconfirmed delivery, and no keypress for a minute. A remote host's bridge
reports its own new build in its chat-list reply; Central then drops that SSH
connection between requests, and the next poll starts the new bridge.

Slider selectors remain in the original chat because their answer is not a single
string. Disabled options are preserved and cannot be selected from Central.
