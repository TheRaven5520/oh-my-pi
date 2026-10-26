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

With the matching tmux companion, a red tab means an interactive question is
still open, including a question temporarily stepped aside for another dialog.
Answering locally, through a collaboration guest, or from Central clears that
question; cancellation, timeout, session teardown and exit do the same. The tab
stays red while another question remains open in the window. Typing, focusing a
tab, sending a Central message and turn-completion bells do not acknowledge a
question. Existing completion notifications are independent and unchanged.

Local OMP targets its own `TMUX_PANE` using `tmux run-shell -t <pane>` and
`python3 ~/.config/tmux/reply-alert.py set #{pane_id} <pid>` / `ack #{pane_id}`.
The optional owner PID lets the companion retire an abruptly killed process.
SSH-hosted OMP instead emits OSC 1337 `SetUserVar=omp_reply_alert=<base64>` and
`omp_reply_ack=<base64>` frames. The payload is one stable PID-UUID owner per
open-question lifetime. Open frames renew every two seconds, independently of
watermark/focus state or external editors; the companion expires a missing
remote owner after seven seconds. The matching owner acknowledgment stops the
heartbeat immediately. This lease also clears abrupt remote exits when the
surrounding SSH shell stays open.

`Ctrl+O` can focus an existing local chat only when it shares Central's tmux
server and exactly one non-control tmux client is displaying Central's pane.
It targets that client explicitly rather than choosing another attached client.
If the caller is ambiguous or detached, or the chat belongs to a different tmux
server, an SSH source, or a direct terminal, Central gives manual-open guidance;
it does not open a duplicate chat or create a new terminal.

## Focus one chat

`omp central --focus <chat>` (or `omp --central --focus <chat>`) shows a single
chat, named by its Central name, sessionId or chatId on any configured host,
plus every open question from every chat Central lists.

- **View:** the conversation as turns, newest at the bottom and scrollable
  (`Shift+Up/Down`, wheel). Each reply is all of the chat's text between two
  user messages, rendered as Markdown under a divider with the time of its
  first text in `display.timeZone` (e.g. `── 10:38 PM ──`), so a reply split by
  tool calls stays one turn. Each message sent from a focus composer shows as a
  dimmed `you:` line without its prefix; a message the busy chat has accepted
  but not yet taken in shows at once, marked `(queued)`, until the transcript
  holds a sent turn with the same text stamped no earlier than 15 s before it
  was sent (each sent turn clears one queued line). Other user messages
  are not shown. `…working` follows while the chat is busy. Tool calls,
  thinking, tool results, and custom and system messages are not shown. Status
  rows and quotas are omitted. No model is called.
- **Flow entries:** each `/command` run from the composer and each question
  that ended elsewhere is entered into the conversation at the time it
  happened, as a dimmed `── 5:12 PM · /tan · ran in the chat ──` (or
  `· local, not sent`) header followed by its output (the first 40 lines, then
  `… N more lines`), or one `── 5:14 PM · SPRILICIM (mini) question "…" ended elsewhere ──`
  line naming the question's chat (and its host when that is not this machine).
  Entries are merged by time with the chat's turns, so later replies render
  below them; a reply still being written when a command ran is split there
  and continues below the entry under its own time. Times come from each
  host's own clock, so skew between hosts can reorder events seconds apart.
  Entries are never sent and are not in the chat's transcript: they survive
  live reloads but not a restart of the focus view (including the automatic
  restart onto a new build). Running a command is your own action, so the view
  jumps to the bottom even if you had scrolled up; while the entry is the
  newest thing in the flow, an open question card leaves it up to a third of
  the screen.
- **Copy:** the view captures the mouse, so tmux and the terminal cannot select
  in it; focus selects itself. Drag with the left button over the transcript
  or an open question card: the cells under the drag show in reverse video,
  and a drag past the top or bottom of a scrolling area
  scrolls it (and keeps scrolling while held there). On release the selected
  text is copied without colors, each row trimmed of trailing padding and rows
  joined by newlines (wide characters count by terminal cell), and the footer
  shows `Copied N chars`. The copy goes out as OSC 52, so it needs a terminal
  (and tmux `set-clipboard on`) that accepts clipboard writes; native clipboard
  tools are tried too. A click without a drag focuses the composer or question
  as before. The next click, any key, the selection scrolling out of view, or
  a change to the rows under it (new turns, a reload, a resize) clears it.
  `Ctrl+X` copies the latest reply's text as the chat wrote it (Markdown source).
- **Questions:** the open ask, select and editor questions of every chat on
  every configured host, not just the focused one, use Central's own forms
  and are answered in place. The focused chat's questions come first, then
  the others oldest first. The card's header names its chat, with the host
  when it is not this machine, and counts when there is more than one:
  `── question 2 of 3 · SPRILICIM (mini) ──` (`· focused` while the keyboard is
  in it); the top line adds `N from other chats`. An answer goes only to the
  card's own chat, as an answer to that question; it is never sent to the
  focused chat or as a message, and `Ctrl+O` from a card opens the card's chat.
  A question that arrives takes the keyboard by itself, scrolled into view
  with its control showing (`· focused` in the header, `Enter answer` in the
  footer), so arrows, digits and `Enter` answer it at once. It does so only when
  nothing typed can land in it: the composer is empty (no `/` popup), no key
  or click for 3 seconds, the keyboard is in the composer, no drag is under
  way, and the card on screen has no answer started (an untouched card it
  replaces stays in the queue for `Tab`). It also closes the `F8` view. A
  not-responding chat's question never takes it until the chat responds.
  Until then the question is marked: a highlighted header
  `── new question · SPRILICIM (mini) · ↓ or F2 to answer ──` (`F2 to answer`
  while the composer has text), the footer `new question: … to answer`, or,
  on a card in use, `· new question from SPRILICIM (mini)`; in the `F8` view
  the footer says `new question waiting`. Polls run every second, so it takes
  the keyboard within about a second of the composer becoming empty and quiet.
  Race guard: quiet is measured at the moment of the switch, and for 1 second
  after it, until another key reaches the card, text, a paste, `Enter` or
  `Backspace` counts as typing for the composer that began as the card
  appeared: it goes to the composer, the keyboard goes back with it, and the
  question is marked new again (it retakes the keyboard after the next 3 quiet
  seconds). So nothing meant for the composer ever answers a question; arrows
  and `Tab` in that second are the card's. Several new questions take the
  keyboard one at a time, the focused chat's first, each after an answer and
  3 quiet seconds. With the composer empty, an arrow key also moves into the
  shown question (and moves its selection); `Enter` then answers. `F2` or a
  click also selects it, and `Esc` returns to the composer without cancelling;
  a question the keyboard has been in is no longer new and does not take it
  again by itself.
  From a selected card, `Tab` / `Shift+Tab` show the next or previous open
  question (in the composer, `Tab` stays completion). `Enter`, `Esc`, `Space`,
  digits and typing on the composer never touch a question. A poll never swaps
  the card while the keyboard is in it, an answer is started, or it was chosen
  with `Tab`; otherwise the first new question shows, else the first in order.
  After an answer, typing goes back to the composer. A chat that is not
  responding (or whose host is unreachable) keeps its last-known question on
  screen, marked `not responding`
  in the header and a line on the card; no key answers it until the chat
  answers a poll again. A question answered, withdrawn or ended in its own chat
  leaves the flow entry above, and if the keyboard was in its card it returns
  to the composer; if you had started an answer there (moved its selection or
  typed), the entry adds `draft kept: F8 to view`. `F8` shows that draft
  read-only in place of the question card (`F8` or `Esc` goes back, `F9`
  discards it and the entry then says `draft discarded`); it is never sent, and
  keys meanwhile go to the composer (`F9` is bound nowhere else, unlike
  `Delete`/`Ctrl+D`, the composer's forward delete). Only the latest kept draft
  stays; an older entry then says `draft replaced by a newer one`. A kept draft
  holds the idle restart onto a new build until it has been viewed with `F8`
  and closed, or for 30 minutes; after that the restart goes ahead and drops it
  (its question no longer exists, and flow entries do not survive a restart).
- **Composer:** text is sent through Central's normal prompt path, prefixed with
  `[FOCUS: Shreyan says] `. A busy chat, including one with an ask open, receives
  it as a queued steer; the message never answers or cancels that ask. Uncertain
  deliveries keep their request ID for `Ctrl+R`, and drafts survive failures.
  The prefix is a text convention, not authentication: anything that can send a
  Central prompt, or type it, can produce the same text.
- **Commands:** a line starting with `/` names a local Central command (table
  below) or one of the chat's own commands. Local commands win a name clash,
  run in the focus window and are never sent. Any other `/command` runs in the
  chat through Central's `command` operation, as if typed in that chat's own
  composer and submitted with Enter: the same built-in, extension, custom,
  skill, file and prompt-template commands, with the same behaviour while the
  chat is busy. No prefix is added, and it is never sent as a message. The
  chat's local draft is set aside while it runs and put back afterwards. What
  the command showed in the chat (status, warning or error lines), or `ran`,
  becomes its flow entry, headed `ran in the chat`; a command still running
  after 1.5 s also says `still running in the chat`. A command that opens a
  picker or other overlay there
  (`/model` with no argument) is closed with `Esc`, so the chat window is not
  left waiting on it, and the result reads "opens a picker in the chat's own
  window; give an argument (e.g. /model <name>) or use the chat". A dialog the
  chat publishes as a Central question stays open and is answered in focus.
  Typing `/` opens the same completion list the chat composer uses, with the
  local commands (marked `local`) and the chat's command list; `Tab`, arrows and
  `Enter` act on the list while it is open. A chat whose OMP predates the
  `command` operation refuses `/commands` with "update OMP on the chat's host"
  and nothing is sent. Uncertain results keep their request ID for `Ctrl+R`.

| Local command | Effect |
| --- | --- |
| `/chats` | every chat on every host, busy/idle, open questions, and chats that are not responding |
| `/send <chat> <msg>` | `hqmsg --from FOCUS --kind relay --to <chat> <msg>`: a relay request to the coordinator, not a direct message. Quote names with spaces |
| `/dag` | the task board URL |
| `/inbox [N]` | `hqmsg --tail N` (default 10) |
| `/pause`, `/resume` | create or remove the inbox-steer pause file and show the result |
| `/help` | the list above, then the chat's own command names |

The coordinator commands read three settings, empty by default; an empty one
reports "not configured":

```sh
omp config set central.focus.hqmsg ~/scratch/hq/bin/hqmsg
omp config set central.focus.pauseFile ~/scratch/hq/inbox-steer.paused
omp config set central.focus.boardUrl https://example/board/
```

The target is re-resolved on every poll: first by its last session, then by
its name, so a restarted or resumed chat is followed. An ambiguous name lists the
matches. While the chat does not answer, is unlisted or is restarting, the last
view and draft stay and the header shows `not responding; retrying`. The
automatic restart onto a new build keeps `--focus`.

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

Each chat on a host is polled separately with a 2-second limit, so one slow
chat (for example one whose process is starved for CPU) does not hide the
others. A chat that is still registered but does not answer keeps its
last-known entry, including its pending question and your unsent draft, and
Central shows `<chat name>: not responding (host_timeout); retrying` (with
`on <host>` for SSH sources). Its answer, message, transcript and status
requests are refused until it answers a poll again; `Ctrl+O` still opens its
terminal. A chat that never answered since Central started shows only that
error. Remote bridges report such chats only to Central clients that ask for
partial lists; an older client still sees the whole host fail, so it never
mistakes a silent chat for a withdrawn question. Unreadable registration
metadata still fails the host's whole list.

## Updates

When a new OMP build is installed over the binary Central is running from,
Central restarts itself onto it in the same terminal. It waits until nothing
would be lost: no typed message draft, no started or sending answer, no
unconfirmed delivery, and no keypress for a minute. A remote host's bridge
reports its own new build in its chat-list reply; Central then drops that SSH
connection between requests, and the next poll starts the new bridge.

Slider selectors remain in the original chat because their answer is not a single
string. Disabled options are preserved and cannot be selected from Central.
