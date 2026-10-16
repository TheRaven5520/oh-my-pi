# OMP Central

`omp central` is a private inbox for questions waiting in active OMP chats.

## Workflow

1. Start Central in its own terminal: `omp --central` (or `omp central`).
2. The current chat's structured question is shown with its real options, previews,
   multi-select state, custom-answer editor, and notes.
3. Submit an answer to advance. `Esc` skips the visible chat to the back without
   cancelling or answering it. `Ctrl+O` opens the original chat when it needs work
   beyond the question. `Tab` switches between the chat roster and question;
   arrow keys select chats, and the wheel scrolls the transcript or question.
   `Ctrl+C` closes Central only.
4. If the original chat answers or withdraws a question, Central advances without
   sending the Central draft elsewhere. An unsent draft is retained for viewing.

Custom answers and per-option notes accept clipboard images and pasted image paths,
including image-only answers. Enter waits for pending image reads; failed reads
leave the prompt open with an error instead of submitting an empty answer. Image
paths are read on the machine running Central, even for questions from SSH hosts.

Central does not scrape terminal panes and does not type into another chat. Each
interactive OMP process publishes a short-lived owner-only local socket with the
structured question payload. Answers are authenticated, validated against the
pending question, and removed when either side answers. Continued questions stay
pending while the agent works.

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

Slider selectors remain in the original chat because their answer is not a single
string. Disabled options are preserved and cannot be selected from Central.
