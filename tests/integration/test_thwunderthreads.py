"""Integration tests: a real headless Thunderbird with the add-on.

Run: python3 -m unittest discover -s tests/integration -v
Every test also checks, after Thunderbird has quit, that no message was lost
on disk (see harness.ThunderbirdTestCase)."""

import json
import time
import unittest

from fixtures import (ALICE, A_URI, B_URI, CAROL, EXPECTED_A_INBOX, ME,
                      UNIFIED_INBOX, d, eml, h)
from harness import ThunderbirdTestCase

INBOX_A, SENT_A, ARCHIVES_A, TRASH_A, DRAFTS_A = (
    f"{A_URI}/{n}" for n in ("Inbox", "Sent", "Archives", "Trash", "Drafts"))
INBOX_B, SENT_B, TRASH_B = (f"{B_URI}/{n}" for n in ("Inbox", "Sent", "Trash"))

q = json.dumps


class Base(ThunderbirdTestCase):
    def heads(self, uri):
        """Fixture names of the messages heading the rows of a folder."""
        rows = self.js(f"await openFolder({q(uri)}); return rows();")
        return [self.name(r["id"]) for r in rows]

    def select(self, name, folder=None):
        prefix = f"await openFolder({q(folder)});" if folder else ""
        cards = self.js(f"{prefix} return select({q(self.ids[name])});")
        return cards

    def cards(self):
        return self.js("return cards();")

    def where(self):
        """Fixture name -> sorted folder names holding a copy."""
        state = self.js("return mailState();")
        out = {}
        for m in state:
            out.setdefault(self.name(m["id"]), []).append(m["folder"].split("//", 1)[1])
        return {k: sorted(v) for k, v in out.items()}

    def wait_where(self, expected, timeout=20):
        """Wait until the given messages are exactly in the given folders."""
        js_expected = {self.ids[k]: sorted(v) for k, v in expected.items()}
        self.js(f"""
          const expected = {q(js_expected)};
          await waitFor(() => {{
            const now = {{}};
            for (const m of mailState()) (now[m.id] ??= []).push(m.folder.split("//")[1]);
            return Object.entries(expected).every(([id, f]) => JSON.stringify((now[id] ?? []).sort()) == JSON.stringify(f));
          }}, "messages to move", {timeout * 1000});
          await settle();
        """)


class ListTests(Base):
    def test_account_inbox_has_one_row_per_conversation(self):
        heads = self.heads(INBOX_A)
        self.assertCountEqual(heads, EXPECTED_A_INBOX)
        self.shot("inbox")

    def test_unified_inbox_shows_each_conversation_once(self):
        heads = self.heads(UNIFIED_INBOX)
        self.assertEqual(len(heads), len(set(heads)), heads)
        # "Team update" reached both accounts and still is one row.
        self.assertCountEqual(heads, EXPECTED_A_INBOX | {"r9", "invoice"})
        self.shot("unified")

    def test_sent_lists_conversations_with_my_messages(self):
        self.assertCountEqual(self.heads(SENT_A), ["k2", "l2", "n1", "hike2", "lab3"])

    def test_list_is_flat_and_sorted_by_newest_message(self):
        result = self.js(f"""
          await openFolder({q(INBOX_A)});
          const w = about3();
          return {{
            threaded: w.gViewWrapper.showThreaded,
            dates: rows().map(r => hdrOf(r.folder, r.id).date),
          }};
        """)
        self.assertFalse(result["threaded"])
        self.assertEqual(result["dates"], sorted(result["dates"], reverse=True))

    def test_card_rows_show_participants_and_count(self):
        rows = self.js(f"""
          await openFolder({q(UNIFIED_INBOX)});
          const w = about3();
          const out = {{}};
          for (const row of w.threadTree.querySelectorAll('tr[is="thread-card"]')) {{
            const hdr = w.gDBView.getMsgHdrAt(row.index);
            out[hdr.messageId] = {{
              names: row.querySelector(".sender").textContent,
              count: row.querySelector(".wt-count")?.textContent ?? null,
              subject: row.querySelector(".subject").textContent,
            }};
          }}
          return out;
        """)
        by_name = {self.name(k): v for k, v in rows.items()}
        self.assertEqual(by_name["k4"], {"names": "Alice, me, Bob", "count": "4", "subject": "Project kickoff"})
        self.assertEqual(by_name["l3"], {"names": "Carol, me", "count": "3", "subject": "Lunch on Friday?"})
        self.assertEqual(by_name["r9"]["count"], "9")
        self.assertEqual(by_name["n1"], {"names": "me", "count": None, "subject": "Note to self"})
        self.assertEqual(by_name["news"]["names"], "Newsletter")
        self.assertEqual(by_name["hike"], {"names": "Bob, me", "count": "2", "subject": "Weekend hike"})

    def test_table_rows_show_participants_and_count(self):
        rows = self.js(f"""
          Services.prefs.setIntPref("mail.threadpane.listview", 1);
          await openFolder({q(INBOX_A)});
          const w = about3();
          await waitFor(() => w.threadTree.querySelector('tr[is="thread-row"]'), "table rows");
          w.threadTree.invalidate();
          await sleep(200);
          const out = {{}};
          for (const row of w.threadTree.querySelectorAll('tr[is="thread-row"]')) {{
            const hdr = w.gDBView.getMsgHdrAt(row.index);
            const cell = [...row.querySelectorAll(".correspondentcol-column, .sendercol-column")]
              .find(c => w.getComputedStyle(c).display != "none");
            out[hdr.messageId] = cell?.textContent;
          }}
          return out;
        """)
        self.shot("table")
        by_name = {self.name(k): v for k, v in rows.items()}
        self.assertEqual(by_name["k4"], "Alice, me, Bob4")
        self.assertEqual(by_name["coffee"], "Dave Dorsey")

    def test_unread_older_message_makes_the_row_unread(self):
        props = self.js(f"""
          await openFolder({q(INBOX_A)});
          const k1 = hdrOf({q(INBOX_A)}, {q(self.ids["k1"])});
          const k4 = hdrOf({q(INBOX_A)}, {q(self.ids["k4"])});
          k4.folder.markMessagesRead([k4], true);
          k1.folder.markMessagesRead([k1], false);
          const w = about3();
          await waitFor(() => {{
            const row = [...w.threadTree.querySelectorAll('tr[is="thread-card"]')]
              .find(r => w.gDBView.getMsgHdrAt(r.index).messageId == k4.messageId);
            return row?.dataset.properties.split(" ").includes("unread") && row.dataset.properties;
          }}, "the conversation row to turn unread");
          return true;
        """)
        self.assertTrue(props)

    def test_trash_and_drafts_keep_thunderbirds_list(self):
        for uri in (TRASH_A, DRAFTS_A):
            ctx = self.js(f"await openFolder({q(uri)}); return about3().gViewWrapper.search._wtCtx ?? null;")
            self.assertIsNone(ctx, uri)

    def test_quick_filter_still_one_row_per_conversation(self):
        heads = self.js(f"""
          await openFolder({q(UNIFIED_INBOX)});
          const qfb = about3().quickFilterBar;
          qfb.filterer.setFilterValue("text", {{
            text: "plan", states: {{ sender: true, recipients: true, subject: true, body: false }},
          }});
          qfb.updateSearch();
          await waitFor(() => rows().length == 1, "the filter");
          await settle();
          return rows().map(r => r.id);
        """)
        self.assertEqual([self.name(i) for i in heads], ["r9"])


class ConversationTests(Base):
    def test_broken_chain_is_one_conversation_in_date_order(self):
        cards = self.select("k4", UNIFIED_INBOX)
        self.shot("kickoff")
        self.assertEqual([self.name(c["id"]) for c in cards], ["k1", "k2", "k3", "k4"])
        self.assertEqual([c["expanded"] for c in cards], [False, False, False, True])
        self.assertEqual(cards[1]["folder"], "Sent")
        self.assertEqual(cards[1]["from"], "Me Myself")
        # Opening the conversation marks it read, like Gmail.
        self.js(f"await waitFor(() => hdrOf({q(INBOX_A)}, {q(self.ids['k4'])}).isRead, 'k4 to be read');")

    def test_read_delay_survives_updates_and_card_toggles(self):
        result = self.js(f"""
          Services.prefs.setBoolPref("mailnews.mark_message_read.auto", false);
          await openFolder({q(INBOX_A)});
          await select({q(self.ids['k4'])});
          const cw = convWindow();
          const hdrs = [
            hdrOf({q(INBOX_A)}, {q(self.ids['k1'])}),
            hdrOf({q(SENT_A)}, {q(self.ids['k2'])}),
            hdrOf({q(INBOX_A)}, {q(self.ids['k3'])}),
            hdrOf({q(INBOX_A)}, {q(self.ids['k4'])}),
          ];
          hdrs[0].folder.markMessagesRead([hdrs[0]], false);
          const li = cw.document.querySelector('li[data-id="{self.ids['k4']}"]');
          const reader = li.querySelector("browser").contentWindow;
          // The conversation must not depend on the embedded reader's read callback.
          reader.autoMarkAsRead = () => {{}};
          reader.ClearPendingReadTimer();
          cw.wtShow(hdrs, {{ host: about3(), update: true }});
          await sleep(200);
          const disabled = hdrs[0].isRead || hdrs[3].isRead;
          Services.prefs.setBoolPref("mailnews.mark_message_read.auto", true);
          Services.prefs.setBoolPref("mailnews.mark_message_read.delay", true);
          Services.prefs.setIntPref("mailnews.mark_message_read.delay.interval", 1);
          cw.wtShow(hdrs, {{ host: about3(), update: true }});
          await sleep(200);
          const early = hdrs[0].isRead || hdrs[3].isRead;
          for (let i = 0; i < 14; i++) {{
            li.querySelector(".summary").click();
            li.querySelector(".summary").click();
            cw.document.body.scrollTop = i % 2 ? 100 : 0;
            cw.wtShow(hdrs, {{ host: about3(), update: true }});
            await sleep(100);
          }}
          const row = [...about3().threadTree.querySelectorAll('tr[is="thread-card"]')]
            .find(r => about3().gDBView.getMsgHdrAt(r.index).messageId == hdrs[3].messageId);
          return {{ disabled, early, read: hdrs.every(h => h.isRead),
            unreadCards: cards().some(c => c.unread),
            unreadRow: row.dataset.properties.split(" ").includes("unread") }};
        """)
        self.assertEqual(result, {"disabled": False, "early": False, "read": True,
                                  "unreadCards": False, "unreadRow": False})

    def test_leaving_conversation_cancels_read_delay(self):
        result = self.js(f"""
          Services.prefs.setBoolPref("mailnews.mark_message_read.delay", true);
          Services.prefs.setIntPref("mailnews.mark_message_read.delay.interval", 2);
          await openFolder({q(INBOX_A)});
          await select({q(self.ids['k4'])});
          const hdr = hdrOf({q(INBOX_A)}, {q(self.ids['k4'])});
          const early = hdr.isRead;
          about3().messagePane.clearAll();
          await sleep(2300);
          return {{ early, read: hdr.isRead }};
        """)
        self.assertEqual(result, {"early": False, "read": False})

    def test_archived_and_sent_messages_are_included(self):
        cards = self.select("l3", INBOX_A)
        self.assertEqual([(self.name(c["id"]), c["folder"]) for c in cards],
                         [("l1", "Archives"), ("l2", "Sent"), ("l3", "")])

    def test_copies_are_shown_once(self):
        self.assertEqual([self.name(c["id"]) for c in self.select("t1", UNIFIED_INBOX)], ["t1"])
        self.assertEqual([self.name(c["id"]) for c in self.select("n1")], ["n1"])

    def test_changed_subject_is_another_conversation(self):
        self.assertEqual([self.name(c["id"]) for c in self.select("b2", INBOX_A)], ["b2"])
        self.assertEqual([self.name(c["id"]) for c in self.select("b1")], ["b1"])

    def test_message_in_several_folders_is_shown_once_in_date_order(self):
        for folder in (INBOX_A, f"{A_URI}/Work", f"{A_URI}/Important"):
            cards = self.select("lab2", folder)
            self.assertEqual([self.name(c["id"]) for c in cards], ["lab1", "lab2", "lab3"], folder)

    def test_in_reply_to_only_reply_is_included(self):
        self.assertEqual([self.name(c["id"]) for c in self.select("hike", INBOX_A)], ["hike", "hike2"])

    def test_long_conversation_folds_older_messages(self):
        cards = self.select("r9", INBOX_B)
        self.shot("release")
        names = [self.name(c["id"]) for c in cards]
        self.assertEqual(names, [f"r{i}" for i in range(1, 10)])
        self.assertEqual([self.name(c["id"]) for c in cards if c["folded"]], ["r2", "r3", "r4", "r5"])
        self.assertEqual([self.name(c["id"]) for c in cards if c["expanded"]], ["r8", "r9"])
        cards = self.js("""
          convWindow().document.querySelector(".more button").click();
          return cards();
        """)
        self.assertFalse(any(c["folded"] for c in cards))

    def test_expand_and_collapse_a_message(self):
        self.select("k4", INBOX_A)
        k1 = self.ids["k1"]
        cards = self.js(f"""
          const doc = convWindow().document;
          doc.querySelector('li[data-id="{k1}"] .summary').click();
          await conversationLoaded();
          return cards();
        """)
        k1_card = next(c for c in cards if c["id"] == k1)
        self.assertTrue(k1_card["expanded"])
        self.assertEqual(k1_card["shown"], k1)
        cards = self.js(f"""
          const browser = convWindow().document.querySelector('li[data-id="{k1}"] browser');
          const header = browser.contentDocument.getElementById("messageHeader");
          header.dispatchEvent(new browser.contentWindow.MouseEvent("click", {{ bubbles: true, button: 0 }}));
          return cards();
        """)
        self.assertFalse(next(c for c in cards if c["id"] == k1)["expanded"])

    def test_messages_are_sized_to_their_content(self):
        self.select("r9", INBOX_B)
        result = self.js("""
          const doc = convWindow().document;
          await sleep(500);
          return [...doc.querySelectorAll("li.expanded browser")].map(b => {
            const pane = b.contentDocument.getElementById("messagepane");
            return { height: b.getBoundingClientRect().height, scroll: pane.contentWindow.scrollMaxY };
          });
        """)
        self.assertEqual(len(result), 2)
        for r in result:
            self.assertGreater(r["height"], 100)
            self.assertEqual(r["scroll"], 0, "the message itself must not scroll")

    def test_conversation_scrolls_and_uses_the_full_width(self):
        self.select("r9", INBOX_B)
        result = self.js("""
          const cw = convWindow();
          const doc = cw.document;
          doc.getElementById("toggleAll").click();
          await conversationLoaded();
          await sleep(1000);
          const scroller = doc.body;
          // Wheel over an open message scrolls the conversation.
          const browser = doc.querySelector("li.expanded browser");
          const r = browser.getBoundingClientRect();
          cw.windowUtils.sendWheelEvent(r.left + 50, r.top + 50, 0, 300, 0, cw.WheelEvent.DOM_DELTA_PIXEL, 0, 0, 0, 0);
          await waitFor(() => scroller.scrollTop > 0, "the wheel to scroll the conversation");
          return {
            scrollable: scroller.scrollHeight > scroller.clientHeight,
            scrolled: scroller.scrollTop,
            width: doc.getElementById("messages").getBoundingClientRect().width,
            pane: doc.documentElement.clientWidth,
          };
        """)
        self.assertTrue(result["scrollable"])
        self.assertGreater(result["scrolled"], 0)
        self.assertGreater(result["width"], result["pane"] - 60, result)

    def test_remote_content_stays_blocked(self):
        self.select("news", INBOX_A)
        blocked = self.js(f"""
          const browser = convWindow().document.querySelector('li[data-id="{self.ids['news']}"] browser');
          const aw = browser.contentWindow;
          await waitFor(() => aw.document.querySelector("#mail-notification-top notification-message[value='remoteContent'], #mail-notification-top [value='remoteContent']"),
            "the remote content notification");
          const img = aw.document.getElementById("messagepane").contentDocument.querySelector("img");
          return {{ img: !!img, loaded: img?.naturalWidth > 0 }};
        """)
        self.shot("remote")
        self.assertEqual(blocked, {"img": True, "loaded": False})

    def test_per_message_delete_only_deletes_that_message(self):
        self.select("k4", INBOX_A)
        k1 = self.ids["k1"]
        self.js(f"""
          convWindow().document.querySelector('li[data-id="{k1}"] .summary').click();
          await conversationLoaded();
          const browser = convWindow().document.querySelector('li[data-id="{k1}"] browser');
          browser.contentWindow.commandController.doCommand("cmd_deleteMessage");
        """)
        self.wait_where({"k1": ["me@pop.example.com/Trash"], "k3": ["me@pop.example.com/Inbox"],
                         "k4": ["me@pop.example.com/Inbox"], "k2": ["me@pop.example.com/Sent"]})
        cards = self.js("await waitFor(() => cards()?.length == 3, 'the conversation to update'); return cards();")
        self.assertEqual([self.name(c["id"]) for c in cards], ["k2", "k3", "k4"])
        self.assertIn("k4", self.heads(INBOX_A))


class CommandTests(Base):
    """Every command that moves or deletes mail, checked for what moved where."""

    def test_message_in_several_folders_goes_to_the_trash_once(self):
        self.assertEqual(self.where()["lab2"], sorted(
            ["me@pop.example.com/Important", "me@pop.example.com/Inbox", "me@pop.example.com/Work"]))
        self.select("lab2", INBOX_A)
        self.js('about3().commandController.doCommand("cmd_deleteMessage");')
        trash = ["me@pop.example.com/Trash"]
        self.wait_where({"lab1": trash, "lab2": trash, "lab3": trash})
        for uri in (f"{A_URI}/Work", f"{A_URI}/Important"):
            self.assertEqual(self.heads(uri), [], uri)

    def test_deleting_one_message_in_the_pane_takes_all_its_copies(self):
        self.select("lab2", f"{A_URI}/Work")
        lab2 = self.ids["lab2"]
        self.js(f"""
          convWindow().document.querySelector('li[data-id="{lab2}"] .summary').click();
          await conversationLoaded();
          const browser = convWindow().document.querySelector('li[data-id="{lab2}"] browser');
          browser.contentWindow.commandController.doCommand("cmd_delete");
        """)
        self.wait_where({"lab2": ["me@pop.example.com/Trash"], "lab1": ["me@pop.example.com/Inbox"],
                         "lab3": ["me@pop.example.com/Sent"]})

    def test_failed_trash_move_keeps_every_copy(self):
        # A Trash that can't be written to (disk full, permissions): the
        # move fails, so the other copies must not be removed either.
        trash = self.profile / "Mail" / "pop.example.com" / "Trash"
        trash.chmod(0o444)
        self.addCleanup(trash.chmod, 0o644)
        self.select("lab2", INBOX_A)
        self.js('setTimeout(() => about3().commandController.doCommand("cmd_deleteMessage"), 0);')
        alerts = []
        for _ in range(40):
            text = self.tb.alert()
            if text:
                alerts.append(text)
            time.sleep(0.25)
        self.assertTrue(alerts, "Thunderbird reports the failed move")
        where = self.where()
        self.assertEqual(where["lab2"], sorted(
            ["me@pop.example.com/Important", "me@pop.example.com/Inbox", "me@pop.example.com/Work"]))

    def test_archive_takes_the_conversation_out_of_the_inbox(self):
        self.select("k4", INBOX_A)
        self.js('about3().commandController.doCommand("cmd_archive");')
        self.wait_where({"k1": ["me@pop.example.com/Archives"], "k3": ["me@pop.example.com/Archives"],
                         "k4": ["me@pop.example.com/Archives"], "k2": ["me@pop.example.com/Sent"]})
        self.assertNotIn("k4", self.heads(INBOX_A))
        self.assertNotIn("k1", self.heads(INBOX_A))
        # Undo brings it all back.
        self.js("window.messenger.undo(window.msgWindow);")
        self.wait_where({"k1": ["me@pop.example.com/Inbox"], "k3": ["me@pop.example.com/Inbox"],
                         "k4": ["me@pop.example.com/Inbox"], "k2": ["me@pop.example.com/Sent"]})
        self.assertIn("k4", self.heads(INBOX_A))

    def test_delete_trashes_every_message_of_the_conversation(self):
        self.select("l3", INBOX_A)
        self.js('about3().commandController.doCommand("cmd_deleteMessage");')
        trash = ["me@pop.example.com/Trash"]
        self.wait_where({"l1": trash, "l2": trash, "l3": trash})
        self.assertNotIn("l3", self.heads(INBOX_A))
        where = self.where()
        self.assertEqual(where["k2"], ["me@pop.example.com/Sent"])  # other conversations untouched

    def test_undo_restores_a_deleted_conversation(self):
        # k1, k3, k4 are in the Inbox, k2 in Sent: like Thunderbird's own
        # cross-folder operations, one undo step per source folder.
        self.select("k4", INBOX_A)
        self.js('about3().commandController.doCommand("cmd_deleteMessage");')
        trash = ["me@pop.example.com/Trash"]
        self.wait_where({"k1": trash, "k2": trash, "k3": trash, "k4": trash})
        self.js("window.messenger.undo(window.msgWindow); await sleep(1500); window.messenger.undo(window.msgWindow);")
        inbox = ["me@pop.example.com/Inbox"]
        self.wait_where({"k1": inbox, "k3": inbox, "k4": inbox, "k2": ["me@pop.example.com/Sent"]})
        self.assertIn("k4", self.heads(INBOX_A))

    def test_undo_restores_a_moved_conversation(self):
        self.select("r9", UNIFIED_INBOX)
        self.js(f'about3().commandController.doCommand("cmd_moveMessage", folder({q(ARCHIVES_A)}));')
        arch = ["me@pop.example.com/Archives"]
        # The unified inbox lists Inbox messages: r5, r7, r9 (work account).
        self.wait_where({"r5": arch, "r7": arch, "r9": arch})
        self.js("window.messenger.undo(window.msgWindow);")
        inbox = ["me@pop.work.test/Inbox"]
        self.wait_where({"r5": inbox, "r7": inbox, "r9": inbox})

    def test_delete_across_accounts_uses_each_accounts_trash(self):
        self.select("r9", UNIFIED_INBOX)
        self.js('about3().commandController.doCommand("cmd_deleteMessage");')
        a, b = ["me@pop.example.com/Trash"], ["me@pop.work.test/Trash"]
        self.wait_where({"r1": a, "r3": a, "r2": b, "r4": b, "r5": b, "r6": b, "r7": b, "r8": b, "r9": b})
        self.assertNotIn("r9", self.heads(UNIFIED_INBOX))

    def test_cancelled_delete_changes_nothing(self):
        self.select("l3", INBOX_A)
        before = self.where()
        asked = self.js("""
          const real = Services.prompt;
          let asked = 0;
          Object.defineProperty(Services, "prompt", { configurable: true, writable: true,
            value: { confirmEx: () => { asked++; return 1; }, BUTTON_TITLE_IS_STRING: 127, BUTTON_POS_0: 1,
                     BUTTON_TITLE_CANCEL: 2, BUTTON_POS_1: 256 } });
          try {
            about3().commandController.doCommand("cmd_shiftDeleteMessage");
          } finally {
            Object.defineProperty(Services, "prompt", { configurable: true, writable: true, value: real });
          }
          await sleep(1000);
          return asked;
        """)
        self.assertEqual(asked, 1)
        self.assertEqual(self.where(), before)

    def test_shift_delete_purges_the_conversation_and_nothing_else(self):
        self.select("l3", INBOX_A)
        before = self.where()
        self.js("""
          Services.prefs.setBoolPref("mail.warn_on_shift_delete", false);
          about3().commandController.doCommand("cmd_shiftDeleteMessage");
        """)
        self.purged = {"l1", "l2", "l3"}
        self.js(f"""
          const gone = {q([self.ids[n] for n in ("l1", "l2", "l3")])};
          await waitFor(() => !mailState().some(m => gone.includes(m.id)), "the conversation to be purged");
          await settle();
        """)
        after = self.where()
        expected = {k: v for k, v in before.items() if k not in self.purged}
        self.assertEqual(after, expected)

    def test_move_takes_the_listed_messages_only(self):
        self.js(f"""
          const inbox = folder({q(INBOX_A)});
          inbox.createSubfolder("Projects", null);
          await waitFor(() => inbox.getChildNamed("Projects"), "the new folder");
        """)
        self.select("k4", INBOX_A)
        self.js(f"""
          const dest = folder({q(INBOX_A)}).getChildNamed("Projects");
          about3().commandController.doCommand("cmd_moveMessage", dest);
        """)
        dest = ["me@pop.example.com/Inbox/Projects"]
        self.wait_where({"k1": dest, "k3": dest, "k4": dest, "k2": ["me@pop.example.com/Sent"]})
        self.assertCountEqual(self.heads(INBOX_A + "/Projects"), ["k4"])

    def test_copy_keeps_the_originals(self):
        self.select("k4", INBOX_A)
        self.js(f"""
          about3().commandController.doCommand("cmd_copyMessage", folder({q(ARCHIVES_A)}));
        """)
        both = sorted(["me@pop.example.com/Inbox", "me@pop.example.com/Archives"])
        self.wait_where({"k1": both, "k3": both, "k4": both, "k2": ["me@pop.example.com/Sent"]})

    def test_mark_read_and_unread(self):
        state = self.js(f"""
          Services.prefs.setBoolPref("mailnews.mark_message_read.auto", false);
          await openFolder({q(INBOX_A)});
          const k1 = hdrOf({q(INBOX_A)}, {q(self.ids["k1"])});
          const k4 = hdrOf({q(INBOX_A)}, {q(self.ids["k4"])});
          k1.folder.markMessagesRead([k1], false);
          await select(k4.messageId);
          const cc = about3().commandController;
          cc.doCommand("cmd_markAsRead");
          await waitFor(() => k1.isRead && k4.isRead, "the conversation to be read");
          cc.doCommand("cmd_markAsUnread");
          await waitFor(() => !k4.isRead, "the head to be unread");
          return {{ k1: k1.isRead, k4: k4.isRead }};
        """)
        # Gmail's "mark unread" marks the latest message; the rest stays read.
        self.assertEqual(state, {"k1": True, "k4": False})

    def test_dragging_a_row_carries_its_conversation(self):
        uris = self.js(f"""
          await openFolder({q(INBOX_A)});
          await select({q(self.ids["k4"])});
          const w = about3();
          const row = [...w.threadTree.querySelectorAll('tr[is="thread-card"]')]
            .find(r => w.gDBView.getMsgHdrAt(r.index).messageId == {q(self.ids["k4"])});
          // A scripted DataTransfer only holds one item outside a real drag.
          const items = [];
          const dataTransfer = {{
            effectAllowed: "", setDragImage() {{}},
            get mozItemCount() {{ return items.length; }},
            mozSetDataAt(type, data, i) {{ (items[i] ??= {{}})[type] = data; }},
            mozGetDataAt(type, i) {{ return items[i]?.[type]; }},
          }};
          const event = {{ target: row, dataTransfer, ctrlKey: false, shiftKey: false,
            defaultPrevented: false, preventDefault() {{ this.defaultPrevented = true; }} }};
          w.threadPane._onDragStart(event);
          const out = [];
          for (let i = 0; i < dataTransfer.mozItemCount; i++) {{
            out.push(window.messenger.msgHdrFromURI(dataTransfer.mozGetDataAt("text/x-moz-message", i)).messageId);
          }}
          return out;
        """)
        self.assertCountEqual([self.name(u) for u in uris], ["k4", "k1", "k3"])


class LiveTests(Base):
    def test_new_reply_replaces_the_row_and_joins_the_open_conversation(self):
        self.select("k4", INBOX_A)
        message = eml(self.fixture, "k5", ALICE, ME, "Re: Project kickoff", h(1), "See you on Monday!",
                      refs=["k1", "k2", "k3", "k4"])
        self.js(f"await copyIn({q(INBOX_A)}, {q(message.decode())}); await settle();")
        heads = self.heads(INBOX_A)
        self.assertIn("k5", heads)
        self.assertNotIn("k4", heads)
        state = self.js(f"""
          await waitFor(() => cards()?.length == 5, "the new message in the conversation");
          await conversationLoaded();
          const w = about3();
          return {{ selected: w.gDBView.hdrForFirstSelectedMessage?.messageId, cards: cards() }};
        """)
        self.shot("live")
        self.assertEqual(self.name(state["selected"]), "k5")
        self.assertEqual([self.name(c["id"]) for c in state["cards"]], ["k1", "k2", "k3", "k4", "k5"])
        self.assertTrue(state["cards"][-1]["expanded"])
        self.assertTrue(state["cards"][-2]["expanded"], "what was open stays open")

    def test_late_reply_merges_two_rows(self):
        self.assertTrue({"trip1", "trip3"} <= set(self.heads(INBOX_A)))
        message = eml(self.fixture, "trip2", ME, CAROL, "Re: Trip to Lisbon", d(7) + h(12), "Yes, let's go!",
                      refs=["trip1"])
        self.js(f"await copyIn({q(SENT_A)}, {q(message.decode())}); await settle();")
        heads = self.heads(INBOX_A)
        self.assertIn("trip3", heads)
        self.assertNotIn("trip1", heads)

    def test_older_message_coming_back_does_not_duplicate_the_row(self):
        self.js(f"""
          await openFolder({q(INBOX_A)});
          const l1 = hdrOf({q(ARCHIVES_A)}, {q(self.ids["l1"])});
          MailServices.copy.copyMessages(l1.folder, [l1], folder({q(INBOX_A)}), true, null, null, false);
          await waitFor(() => hdrOf({q(INBOX_A)}, {q(self.ids["l1"])}), "l1 in the inbox");
          await settle();
        """)
        heads = self.heads(INBOX_A)
        self.assertIn("l3", heads)
        self.assertNotIn("l1", heads)

    def test_removed_head_hands_the_row_to_the_previous_message(self):
        self.js(f"""
          await openFolder({q(INBOX_A)});
          const k4 = hdrOf({q(INBOX_A)}, {q(self.ids["k4"])});
          k4.folder.deleteMessages([k4], null, false, false, null, false);
          await waitFor(() => !hdrOf({q(INBOX_A)}, {q(self.ids["k4"])}), "k4 to be deleted");
          await settle();
        """)
        heads = self.heads(INBOX_A)
        self.assertIn("k3", heads)
        self.assertEqual(sum(h in ("k1", "k3", "k4") for h in heads), 1)

    def test_new_conversation_gets_a_row(self):
        message = eml(self.fixture, "fresh", CAROL, ME, "Brand new topic", h(0), "Hello there")
        self.js(f"await openFolder({q(INBOX_A)}); await copyIn({q(INBOX_A)}, {q(message.decode())}); await settle();")
        self.assertIn("fresh", self.heads(INBOX_A))


class LifecycleTests(Base):
    def test_package_metadata(self):
        meta = self.js("""
          const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
          const addon = await AddonManager.getAddonByID("thwunderthreads@narmo");
          const icon = AddonManager.getPreferredIconURL(addon, 64);
          const response = await fetch(icon);
          return { name: addon.name, creator: addon.creator?.name, description: addon.description,
                   icon: icon.endsWith("icons/thwunderthreads.svg"), svg: (await response.text()).includes("<svg") };
        """)
        self.assertEqual(meta["name"], "ThwunderThreads")
        self.assertEqual(meta["creator"], "Nikita Denin")
        self.assertTrue(meta["description"].startswith("Gmail-style conversations"))
        self.assertTrue(meta["icon"] and meta["svg"], meta)

    def test_disable_and_enable(self):
        heads = self.heads(UNIFIED_INBOX)
        self.assertEqual(len(heads), len(set(heads)))
        native = self.js("""
          const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
          const addon = await AddonManager.getAddonByID("thwunderthreads@narmo");
          await addon.disable();
          await settle();
          const w = about3();
          const { SearchSpec } = ChromeUtils.importESModule("resource:///modules/SearchSpec.sys.mjs");
          const getter = Object.getOwnPropertyDescriptor(SearchSpec.prototype, "hasSearchTerms").get;
          // The message pane is Thunderbird's own again.
          w.threadTree.selectedIndex = 0;
          await waitFor(() => !w.messagePane.messageBrowser.hidden, "Thunderbird's message browser");
          return {
            patched: getter.toString().includes("isGmailView"),
            browser: !!w.document.getElementById("thwunderthreadsBrowser"),
            ownDisplay: Object.hasOwn(w.messagePane, "displayMessage"),
            term: !!w.gViewWrapper.search._wtCtx,
          };
        """)
        self.assertEqual(native, {"patched": False, "browser": False, "ownDisplay": False, "term": False})
        again = self.js("""
          const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
          const addon = await AddonManager.getAddonByID("thwunderthreads@narmo");
          await addon.enable();
          await waitFor(() => debug().index?.ready && state3(), "the add-on to come back", 60000);
          await settle();
          return rows().map(r => r.id);
        """)
        self.assertEqual(len(again), len(set(again)))
        self.assertCountEqual([self.name(i) for i in again], heads)

    def test_compaction_keeps_the_index_right(self):
        self.select("l3", INBOX_A)
        self.js('about3().commandController.doCommand("cmd_deleteMessage");')
        trash = ["me@pop.example.com/Trash"]
        self.wait_where({"l1": trash, "l2": trash, "l3": trash})
        self.js(f"""
          for (const uri of [{q(INBOX_A)}, {q(SENT_A)}, {q(ARCHIVES_A)}]) {{
            await new Promise(resolve => folder(uri).compact({{
              OnStartRunningUrl() {{}}, OnStopRunningUrl() {{ resolve(); }},
            }}, null));
          }}
          await settle();
        """)
        self.assertCountEqual(self.heads(INBOX_A), EXPECTED_A_INBOX - {"l3"})
        cards = self.select("k4", INBOX_A)
        self.assertEqual([self.name(c["id"]) for c in cards], ["k1", "k2", "k3", "k4"])


class WithoutAddonTests(ThunderbirdTestCase):
    """The fixture itself, as plain Thunderbird shows it: the problem we fix."""

    addon = False

    def test_plain_thunderbird_lists_conversations_more_than_once(self):
        ids = self.js(f"""
          await openFolder({q(UNIFIED_INBOX)});
          const v = about3().gDBView;
          v.doCommand(Ci.nsMsgViewCommandType.expandAll);
          return rows().map(r => r.id);
        """)
        # "Team update" twice, and every conversation message as its own row.
        self.assertGreater(len(ids), len(set(ids)))
        self.assertGreaterEqual(len(ids), 16)


if __name__ == "__main__":
    unittest.main()
