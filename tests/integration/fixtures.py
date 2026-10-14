"""Test profile: two POP3 accounts (local storage, never connected) with
Gmail-style conversations spread over Inbox, Sent and Archives."""

import os
import shutil
import zlib
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import format_datetime

NOW = datetime.now(timezone.utc).replace(microsecond=0)

ME = "Me Myself <me@example.com>"
WORK = "Me at Work <me@work.test>"
ALICE = "Alice Archer <alice@example.org>"
BOB = "Bob Builder <bob@example.org>"
CAROL = "Carol Chen <carol@example.net>"
DAVE = "Dave Dorsey <dave@example.net>"
EVE = "Eve Evans <eve@example.com>"

A = "Mail/pop.example.com"
B = "Mail/pop.work.test"
A_URI = "mailbox://me@pop.example.com"
B_URI = "mailbox://me@pop.work.test"
UNIFIED_INBOX = "mailbox://nobody@smart%20mailboxes/Inbox"

d = lambda n: timedelta(days=n)
h = lambda n: timedelta(hours=n)


def uri(path):
    """Mbox path inside the profile -> folder URI."""
    base, name = path.rsplit("/", 1)
    return (A_URI if base == A else B_URI) + "/" + name


class Builder:
    def __init__(self):
        self.boxes = {}
        self.ids = {}  # fixture name -> Message-ID (without <>)
        self.folders = {}  # fixture name -> [folder URI]

    def msg(self, name, boxes, frm, to, subject, ago, body, refs=(), irt=None,
            read=False, html=None, attach=None, refs_header=True):
        mid = f"{name}.{zlib.crc32(name.encode())}@test.local"
        m = EmailMessage()
        m["From"], m["To"], m["Subject"] = frm, to, subject
        m["Date"] = format_datetime(NOW - ago)
        m["Message-ID"] = f"<{mid}>"
        ref_ids = [self.ids[r] for r in refs]
        if ref_ids and refs_header:
            m["References"] = " ".join(f"<{r}>" for r in ref_ids)
        if irt:
            m["In-Reply-To"] = f"<{self.ids[irt]}>"
        m["X-Mozilla-Status"] = "0001" if read else "0000"
        m["X-Mozilla-Status2"] = "00000000"
        m.set_content(body)
        if html:
            m.add_alternative(html, subtype="html")
        if attach:
            m.add_attachment(attach[1].encode(), maintype="text", subtype="plain", filename=attach[0])
        boxes = boxes if isinstance(boxes, list) else [boxes]
        for b in boxes:
            self.boxes.setdefault(b, []).append(m)
        self.ids[name] = mid
        self.folders[name] = [uri(b) for b in boxes]
        return m


def build_messages():
    """All fixture messages. Kept deterministic: tests refer to them by name."""
    f = Builder()
    # 1. Broken chain: Alice's second reply only points at my reply in Sent.
    f.msg("k1", f"{A}/Inbox", ALICE, ME, "Project kickoff", d(3), "Hi! Shall we start the project on Monday?\n\nAlice", read=True)
    f.msg("k2", f"{A}/Sent", ME, ALICE, "Re: Project kickoff", d(3) - h(2), "Monday works for me.", refs=["k1"], irt="k1", read=True)
    f.msg("k3", f"{A}/Inbox", ALICE, ME, "Re: Project kickoff", d(2), "Great, I'll book the room.", refs=["k2"], irt="k2", read=True)
    f.msg("k4", f"{A}/Inbox", BOB, f"{ME}, {ALICE}", "Re: Project kickoff", h(5), "Count me in, I'll bring the plans.", refs=["k1", "k2", "k3"], irt="k3")
    # 2. The start of the conversation was archived.
    f.msg("l1", f"{A}/Archives", CAROL, ME, "Lunch on Friday?", d(9), "Lunch on Friday at the usual place?", read=True)
    f.msg("l2", f"{A}/Sent", ME, CAROL, "Re: Lunch on Friday?", d(9) - h(1), "Sure, see you at noon.", refs=["l1"], irt="l1", read=True)
    f.msg("l3", f"{A}/Inbox", CAROL, ME, "Re: Lunch on Friday?", h(26), "Same again this week?", refs=["l1", "l2"], irt="l2")
    # 3. One message delivered to both accounts.
    f.msg("t1", [f"{A}/Inbox", f"{B}/Inbox"], EVE, f"{ME}, {WORK}", "Team update", h(30), "Quarterly numbers are in.", read=True)
    # 4. A changed subject starts a new conversation.
    f.msg("b1", f"{A}/Inbox", DAVE, ME, "Budget 2027", d(4), "Draft budget attached.", read=True, attach=("budget.txt", "rent 100\nfood 50\n"))
    f.msg("b2", f"{A}/Inbox", DAVE, ME, "Offsite location", d(1), "Different topic: where do we hold the offsite?", refs=["b1"], irt="b1")
    # 5. Note to self: one message in Sent and in the Inbox.
    f.msg("n1", [f"{A}/Sent", f"{A}/Inbox"], ME, ME, "Note to self", h(40), "Buy milk.", read=True)
    # 6. Long conversation over two accounts and three folders.
    prev, refs = None, []
    for i in range(9):
        frm, box = (WORK, f"{B}/Sent") if i % 2 else (ALICE, f"{B}/Inbox" if i > 3 else f"{A}/Archives")
        name = f"r{i + 1}"
        f.msg(name, box, frm, ALICE if frm == WORK else WORK, "Release plan" if i == 0 else "Re: Release plan",
              d(6) - h(10 * i), f"Release plan message #{i + 1}.\n\nSome more details about step {i + 1}.",
              refs=list(refs), irt=prev, read=i < 7)
        prev = name
        refs.append(name)
    # 7. HTML with a remote image.
    f.msg("news", f"{A}/Inbox", "Newsletter <news@shop.example>", ME, "Autumn sale", h(3), "Autumn sale!",
          html='<h1 style="color:#c40">Autumn sale</h1><p>Everything <b>-30%</b>.</p><img src="https://example.com/pixel.png" alt="tracker">')
    # 8. Singles; my answer to the hike only carries In-Reply-To.
    f.msg("hike", f"{A}/Inbox", BOB, ME, "Weekend hike", d(5), "Weekend hike - details inside.", read=True)
    f.msg("hike2", f"{A}/Sent", ME, BOB, "Re: Weekend hike", d(5) - h(3), "I'm in!", irt="hike", read=True)
    f.msg("invoice", f"{B}/Inbox", EVE, WORK, "Invoice #4512", d(6), "Invoice #4512 - details inside.", read=True)
    f.msg("coffee", f"{A}/Inbox", DAVE, ME, "Coffee machine is fixed", d(7), "Coffee machine is fixed - details inside.", read=True)
    # 9. Two Inbox messages joined only by a reply of mine that is not in the
    #    profile yet (tests add "trip2" to Sent).
    f.msg("trip1", f"{A}/Inbox", CAROL, ME, "Trip to Lisbon", d(8), "Shall we go to Lisbon in May?", read=True)
    f.ids["trip2"] = "trip2.1@test.local"
    f.msg("trip3", f"{A}/Inbox", CAROL, ME, "Re: Trip to Lisbon", d(7), "Flights booked!", refs=["trip2"], irt="trip2", read=True)
    # 10. Gmail labels over IMAP (or a filter copying mail): one message in
    #     three folders, inside a conversation.
    f.msg("lab1", f"{A}/Inbox", CAROL, ME, "Contract draft", d(2.5), "Here is the contract draft.", read=True)
    f.msg("lab2", [f"{A}/Inbox", f"{A}/Work", f"{A}/Important"], DAVE, f"{ME}, {CAROL}", "Re: Contract draft",
          h(20), "Looks good, two remarks inside.", refs=["lab1"], irt="lab1", read=True)
    f.msg("lab3", f"{A}/Sent", ME, f"{DAVE}, {CAROL}", "Re: Contract draft", h(10), "Thanks, I'll sign it.",
          refs=["lab1", "lab2"], irt="lab2", read=True)
    return f


# The message heading each conversation row of account A's Inbox. trip1 and
# trip3 are two rows until my reply between them arrives.
EXPECTED_A_INBOX = {
    "news", "k4", "b2", "l3", "t1", "n1", "b1", "hike", "coffee", "trip1", "trip3", "lab2",
}


def eml(f, name, frm, to, subject, ago, body, refs=(), read=False):
    """A message that isn't in the profile yet, as bytes for copyFileMessage."""
    m = EmailMessage()
    m["From"], m["To"], m["Subject"] = frm, to, subject
    m["Date"] = format_datetime(NOW - ago)
    mid = f.ids.get(name) or f"{name}.{zlib.crc32(name.encode())}@test.local"
    f.ids[name] = mid
    m["Message-ID"] = f"<{mid}>"
    if refs:
        m["References"] = " ".join(f"<{f.ids[r]}>" for r in refs)
        m["In-Reply-To"] = f"<{f.ids[refs[-1]]}>"
    m.set_content(body)
    return m.as_bytes().replace(b"\r\n", b"\n")


def write_profile(profile, f, port, addon=None, prefs=None):
    os.makedirs(f"{profile}/Mail/Local Folders", exist_ok=True)
    for folder in ("Inbox", "Sent", "Archives", "Trash", "Drafts"):
        for acct in (A, B):
            f.boxes.setdefault(f"{acct}/{folder}", [])
    for path, msgs in f.boxes.items():
        os.makedirs(os.path.dirname(f"{profile}/{path}"), exist_ok=True)
        with open(f"{profile}/{path}", "wb") as out:
            for m in msgs:
                out.write(b"From - Mon Jan  1 00:00:00 2024\n")
                raw = m.as_bytes().replace(b"\r\n", b"\n").replace(b"\nFrom ", b"\n>From ")
                out.write(raw.rstrip(b"\n") + b"\n\n")

    all_prefs = {
        "marionette.port": port,
        "xpinstall.signatures.required": False,
        "extensions.autoDisableScopes": 0,
        "extensions.startupScanScopes": 15,
        "extensions.experiments.enabled": True,
        "mail.shell.checkDefaultClient": False,
        "mail.provider.suppress_dialog_on_startup": True,
        "mailnews.start_page.enabled": False,
        "mail.rights.override": True,
        "mail.inappnotifications.enabled": False,
        "datareporting.policy.dataSubmissionPolicyBypassNotification": True,
        "toolkit.telemetry.reportingpolicy.firstRun": False,
        "app.update.disabledForTesting": True,
        "browser.dom.window.dump.enabled": True,
        "devtools.console.stdout.chrome": True,
        "mail.spotlight.firstRunDone": True,
        "mail.startup.enabledMailCheckOnce": True,
        "mailnews.mark_message_read.delay": False,
        "mail.accountmanager.accounts": "account1,account2,account3",
        "mail.accountmanager.defaultaccount": "account1",
        "mail.accountmanager.localfoldersserver": "server3",
        "mail.account.account1.server": "server1",
        "mail.account.account1.identities": "id1",
        "mail.account.account2.server": "server2",
        "mail.account.account2.identities": "id2",
        "mail.account.account3.server": "server3",
        "mail.server.server3.type": "none",
        "mail.server.server3.hostname": "Local Folders",
        "mail.server.server3.userName": "nobody",
        "mail.server.server3.name": "Local Folders",
        "mail.server.server3.directory-rel": "[ProfD]Mail/Local Folders",
    }
    for n, host, email, name in ((1, "pop.example.com", "me@example.com", "Me Myself"),
                                 (2, "pop.work.test", "me@work.test", "Me at Work")):
        s = f"mail.server.server{n}."
        all_prefs.update({s + "type": "pop3", s + "hostname": host, s + "userName": "me", s + "name": email,
                          s + "directory-rel": f"[ProfD]Mail/{host}", s + "login_at_startup": False,
                          s + "check_new_mail": False, s + "download_on_biff": False})
        i = f"mail.identity.id{n}."
        all_prefs.update({i + "useremail": email, i + "fullName": name, i + "valid": True,
                          i + "fcc_folder": f"mailbox://me@{host}/Sent",
                          i + "archive_folder": f"mailbox://me@{host}/Archives",
                          i + "archive_granularity": 0,
                          i + "draft_folder": f"mailbox://me@{host}/Drafts"})
    all_prefs.update(prefs or {})
    with open(f"{profile}/user.js", "w") as out:
        for k, v in all_prefs.items():
            v = "true" if v is True else "false" if v is False else v if isinstance(v, int) else '"%s"' % v
            out.write(f'user_pref("{k}", {v});\n')

    if addon:
        os.makedirs(f"{profile}/extensions", exist_ok=True)
        if addon.endswith(".xpi"):  # a built package
            shutil.copy(addon, f"{profile}/extensions/thwunderthreads@narmo.xpi")
        else:  # a proxy file: the add-on is loaded unpacked from the source tree
            with open(f"{profile}/extensions/thwunderthreads@narmo", "w") as out:
                out.write(os.path.abspath(addon) + "\n")
