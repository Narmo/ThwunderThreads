"""IMAP: one message in several folders (like Gmail labels) inside a
conversation, against a real IMAP server (GreenMail). The server's own state
is checked: each message ends up in the Trash once and nothing is lost."""

import json
import time
from email.message import EmailMessage
from email.utils import format_datetime

import greenmail
from fixtures import CAROL, DAVE, ME, NOW, UNIFIED_INBOX, d, h
from harness import ARTIFACTS, ThunderbirdTestCase, free_port

IMAP = "imap://me@127.0.0.1"
q = json.dumps


def message(mid, frm, to, subject, ago, body, refs=()):
    m = EmailMessage()
    m["From"], m["To"], m["Subject"] = frm, to, subject
    m["Date"] = format_datetime(NOW - ago)
    m["Message-ID"] = f"<{mid}>"
    if refs:
        m["References"] = " ".join(f"<{r}>" for r in refs)
        m["In-Reply-To"] = f"<{refs[-1]}>"
    m.set_content(body)
    return m.as_bytes()


class ImapTests(ThunderbirdTestCase):
    def setUp(self):
        jar = greenmail.jar(ARTIFACTS)
        if not jar:
            self.skipTest("GreenMail needs Java and a one-time download")
        port = free_port()
        self.server = greenmail.GreenMail(jar, port, ARTIFACTS / "greenmail.log")
        self.addCleanup(self.server.stop)
        g = {n: f"{n}@imap.test" for n in ("g1", "g2", "g3", "g9")}
        g1 = message(g["g1"], CAROL, ME, "Contract draft", d(2), "Here is the contract draft.")
        g2 = message(g["g2"], DAVE, ME, "Re: Contract draft", h(20), "Looks good.", refs=[g["g1"]])
        g3 = message(g["g3"], ME, DAVE, "Re: Contract draft", h(10), "I'll sign it.", refs=[g["g1"], g["g2"]])
        g9 = message(g["g9"], CAROL, ME, "Unrelated", h(5), "Something else.")
        # g2 carries three labels: it is in INBOX, Work and Important.
        self.server.seed({"INBOX": [g1, g2, g9], "Work": [g2], "Important": [g2], "Sent": [g3], "Trash": []})
        self.on_server = self.server.contents()
        self.addCleanup(self._check_server)

        s, i = "mail.server.server4.", "mail.identity.id3."
        self.prefs = {
            "mail.accountmanager.accounts": "account1,account2,account3,account4",
            "mail.account.account4.server": "server4",
            "mail.account.account4.identities": "id3",
            s + "type": "imap", s + "hostname": "127.0.0.1", s + "port": port, s + "userName": "me",
            s + "name": "me@imap.test", s + "socketType": 0, s + "authMethod": 3,
            s + "login_at_startup": False, s + "check_new_mail": False,
            s + "directory-rel": "[ProfD]ImapMail/127.0.0.1", s + "delete_model": 1,
            s + "trash_folder_name": "Trash", s + "using_subscription": False,
            s + "autosync_offline_stores": False,
            i + "useremail": "me@imap.test", i + "fullName": "Me Myself", i + "valid": True,
            i + "fcc_folder": f"{IMAP}/Sent", i + "archive_folder": f"{IMAP}/Archives",
            i + "draft_folder": f"{IMAP}/Drafts",
        }
        super().setUp()
        self.ids.update(g)
        self.js(r"""
          const info = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
          info.init("imap://127.0.0.1", null, "imap://127.0.0.1", "me", "secret", "", "");
          await Services.logins.addLoginAsync(info);
          const root = MailServices.accounts.findServer("me", "127.0.0.1", "imap").rootFolder;
          const run = start => new Promise(resolve => start({
            OnStartRunningUrl() {}, OnStopRunningUrl() { resolve(); },
          }));
          await run(l => MailServices.imap.discoverAllFolders(root, l, msgWindow));
          const names = ["Work", "Important", "Sent", "Trash"];
          await waitFor(() => root.getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox) &&
            names.every(n => root.getChildNamed(n)), "the IMAP folders");
          const { MailUtils } = ChromeUtils.importESModule("resource:///modules/MailUtils.sys.mjs");
          for (const f of [root.getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox), ...names.map(n => root.getChildNamed(n))]) {
            await MailUtils.updateFolderAsync(f);
          }
          await waitFor(() => debug().index.recs.get("g2@imap.test")?.locs.length == 3,
            "the IMAP messages in the index");
        """)

    def _check_server(self):
        before = {mid for ids in self.on_server.values() for mid in ids}
        after = {mid for ids in self.server.contents().values() for mid in ids}
        self.assertEqual(before - after, set(), "messages lost on the IMAP server")

    def test_message_with_three_labels_is_one_message_of_the_conversation(self):
        heads = self.js(f"await openFolder({q(IMAP + '/INBOX')}); return rows().map(r => r.id);")
        self.assertCountEqual(heads, [self.ids["g2"], self.ids["g9"]])
        for folder in ("INBOX", "Work", "Important"):
            cards = self.js(f"await openFolder({q(IMAP + '/' + folder)}); return select({q(self.ids['g2'])});")
            self.assertEqual([c["id"] for c in cards], [self.ids[n] for n in ("g1", "g2", "g3")], folder)
        self.shot("imap")

    def test_unified_inbox_with_an_imap_inbox_loads(self):
        # The Unified Inbox searches IMAP folders on the server, which can't
        # answer the conversation term; it must still load.
        result = self.js(f"""
          await openFolder({q(UNIFIED_INBOX)});
          return {{ searching: about3().gViewWrapper.searching, ids: rows().map(r => r.id) }};
        """)
        self.assertFalse(result["searching"])
        ids = result["ids"]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertIn(self.ids["g2"], ids)
        self.assertIn(self.ids["g9"], ids)
        self.assertNotIn(self.ids["g1"], ids)
        self.assertIn(self.ids["k4"], ids)  # the local accounts are there too
        self.shot("unified")

    def test_deleting_the_conversation_trashes_each_message_once_on_the_server(self):
        self.js(f"await openFolder({q(IMAP + '/INBOX')}); await select({q(self.ids['g2'])});")
        self.js('about3().commandController.doCommand("cmd_deleteMessage");')
        expected = {
            "INBOX": [self.ids["g9"]],
            "Work": [],
            "Important": [],
            "Sent": [],
            "Trash": sorted(self.ids[n] for n in ("g1", "g2", "g3")),
        }
        deadline = time.time() + 60
        while True:
            contents = {k: v for k, v in self.server.contents().items() if k in expected}
            if contents == expected or time.time() > deadline:
                break
            time.sleep(1)
        self.assertEqual(contents, expected)
