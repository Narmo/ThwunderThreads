"""A large mailbox: 50,000 messages in 10,000 conversations over Inbox, Sent
and Archives. Slow, so only run with WT_STRESS=1."""

import json
import os
import time
import unittest
from datetime import timedelta
from email.utils import format_datetime

from fixtures import A, NOW
from harness import ThunderbirdTestCase

CONVERSATIONS = int(os.environ.get("WT_STRESS_CONVERSATIONS", "10000"))
PER_CONVERSATION = 5


def mbox_entry(mid, frm, subject, date, refs, read):
    lines = [
        f"From: {frm}",
        "To: Me Myself <me@example.com>",
        f"Subject: {subject}",
        f"Date: {format_datetime(date)}",
        f"Message-ID: <{mid}>",
        f"X-Mozilla-Status: {'0001' if read else '0000'}",
        "X-Mozilla-Status2: 00000000",
    ]
    if refs:
        lines.append("References: " + " ".join(f"<{r}>" for r in refs))
        lines.append(f"In-Reply-To: <{refs[-1]}>")
    return ("From - Mon Jan  1 00:00:00 2024\n" + "\n".join(lines)
            + "\n\nMessage body.\n\n").encode()


@unittest.skipUnless(os.environ.get("WT_STRESS"), "set WT_STRESS=1 to run")
class StressTests(ThunderbirdTestCase):
    def setUp(self):
        self._started = time.time()
        super().setUp()
        self.ready_after = time.time() - self._started

    def _add_big_folders(self):
        boxes = {"Inbox": [], "Sent": [], "Archives": []}
        self.inbox_conversations = set()
        for c in range(CONVERSATIONS):
            refs = []
            for i in range(PER_CONVERSATION):
                mid = f"s{c}.{i}@stress.test"
                mine = i % 2 == 1
                box = "Sent" if mine else ("Archives" if c % 7 == 0 else "Inbox")
                if box == "Inbox":
                    self.inbox_conversations.add(c)
                date = NOW - timedelta(minutes=c * 30) + timedelta(minutes=i)
                frm = "Me Myself <me@example.com>" if mine else f"Person {c % 97} <p{c % 97}@x.test>"
                subject = ("Re: " if i else "") + f"Topic {c}"
                boxes[box].append(mbox_entry(mid, frm, subject, date, list(refs), read=True))
                refs.append(mid)
        for name, entries in boxes.items():
            with open(self.profile / A / name, "ab") as out:
                out.write(b"".join(entries))

    def test_large_mailbox(self):
        # The fixture profile is up; add the big folders and start again.
        self.tb.quit()
        self._add_big_folders()
        self.initial = __import__("harness").disk_messages(self.profile)
        start = time.time()
        self.tb.start()
        self.tb.js("await waitFor(() => debug().index?.ready, 'the index', 600000);", timeout=900)
        ready = time.time() - start
        stats = self.tb.js("""
          const ix = debug().index;
          const t0 = Date.now();
          await openFolder("mailbox://me@pop.example.com/Inbox");
          const listMs = Date.now() - t0;
          const rows = about3().gDBView.rowCount;
          const id = about3().gDBView.getMsgHdrAt(Math.floor(rows / 2)).messageId;
          const t1 = Date.now();
          const cards = await select(id);
          return { recs: ix.recs.size, rows, listMs, openMs: Date.now() - t1, cards: cards.length,
                   memory: Cu.getJSEngineTelemetryValue?.() ?? null };
        """, timeout=900)
        print(f"\nstress: {json.dumps(stats)}; index ready {ready:.1f}s after start (includes mbox parsing)")
        self.shot("stress")
        total = CONVERSATIONS * PER_CONVERSATION
        self.assertGreaterEqual(stats["recs"], total)
        # One row per conversation with an Inbox message (+ the fixture's 12).
        self.assertEqual(stats["rows"], len(self.inbox_conversations) + 12)
        self.assertEqual(stats["cards"], PER_CONVERSATION)
        self.assertLess(stats["openMs"], 5000)
