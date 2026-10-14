# ThwunderThreads

<img src="icons/thwunderthreads.svg" width="64" height="64" alt="ThwunderThreads icon">

Gmail-style conversations for Thunderbird 158+.

- **One row per conversation** in every message list — folders, the Unified
  Inbox, quick filter results. The row shows the participants
  ("Alice, me, Bob"), the number of messages and is bold while any message of
  the conversation is unread.
- **The whole conversation in the message pane**, oldest first: replies from
  Sent, archived messages, other accounts. A message stored in several folders
  (Gmail labels over IMAP, filters copying mail, one mail to two accounts) is
  shown once. Read messages are folded, unread ones and the latest are open;
  each open message is Thunderbird's own reader, so remote content blocking,
  attachments and encryption work as usual.
- **Actions on a row act on the conversation**, as in Gmail:
  - *Delete* puts every message of the conversation into the Trash — once per
    message and account, wherever its copies are (Inbox, Sent, Archives,
    labels). *Shift+Delete* deletes them for good, after Thunderbird's prompt.
  - *Archive*, *Move*, *Copy*, *Mark as read* take the conversation's messages
    in the list's folders: archiving from the Inbox leaves your replies in Sent.
  - Dragging a row to a folder carries the conversation's messages from the
    same folder.
- Delete inside the conversation pane removes that one message (all its copies).

## How conversations are built

Like Gmail: a message joins the conversation of a message it references
(`References` / `In-Reply-To`) when both have the same subject, ignoring
`Re:`/`Fwd:` and their translations. The links go through every mail folder of
every account (not News or Feeds), so a reply that only points at your message
in Sent still lands in the right conversation. A conversation never splits
again, even when the message that linked it is deleted.

The index lives in memory and is built from Thunderbird's folder summaries at
start-up (≈ 50,000 messages in a few seconds), then kept current from folder
notifications. Nothing leaves the computer.

## Mail safety

The add-on never changes mail on its own; it only runs the commands you give,
through Thunderbird's own copy, move and delete code (undo included).
Removing the extra copies of a message happens only after its account's
Trash is confirmed to hold the message — on IMAP the Trash is synchronised
first; if it can't be confirmed, the copies stay. A failing move (full disk,
read-only Trash) leaves every copy in place.

## Install

```sh
scripts/build.sh            # -> dist/thwunderthreads-<version>.xpi
```

Thunderbird → Add-ons and Themes → ⚙ → *Install Add-on From File…*. The
add-on uses a WebExtension Experiment (privileged code), which Thunderbird
allows for add-ons installed from a file.

## Tests

```sh
node --test tests/unit                                    # conversation logic
python3 -m unittest discover -s tests/integration -v      # real Thunderbird
```

The integration tests start a headless Thunderbird (`$THUNDERBIRD`, default
`/Applications/Thunderbird.app/Contents/MacOS/thunderbird`) over Marionette on
a fresh profile per test and check lists, conversations, every command that
moves or deletes mail, live updates and disabling/enabling. After each test the
mbox files on disk are parsed: a message that disappeared fails the test.

- `WT_XPI=dist/thwunderthreads-<version>.xpi` tests the built package.
- `WT_STRESS=1` adds a 50,000-message mailbox.
- The IMAP tests run against [GreenMail](https://greenmail-mail-test.github.io/greenmail/)
  (needs Java; the jar is downloaded once from Maven Central and checked against
  its SHA-1) and verify the server's own state.
- Screenshots and the test profiles are kept in `$TMPDIR/thwunderthreads-tests`.

## Limits

- Tested with Thunderbird 158 on macOS. The pane uses Thunderbird's theme
  colours and system font, so light/dark mode and other platforms follow.
- Gmail labels are tested with a real IMAP server holding copies in several
  folders, not against Gmail itself.
- With a quick filter, a conversation is listed when its newest message in the
  list matches the filter.
- Lists are flat while the add-on is active (Thunderbird's threads are
  ignored); disabling the add-on restores each folder's own view settings.
- Undo works like Thunderbird's own operations across folders: one step per
  folder the messages came from (a conversation trashed from Inbox and Sent
  takes two). Each message comes back once, to the folder it was trashed
  from; its extra copies (labels) are not recreated.
- Not done: Gmail's 100-message cap per conversation, drafts inside
  conversations, folding quoted text, find (Ctrl+F) and print for the whole
  conversation.

## License

The code and documentation are public domain under the Unlicense; the icon
(`icons/thwunderthreads.svg`) is CC0 1.0. See `LICENSE` and `icons/LICENSE`.
