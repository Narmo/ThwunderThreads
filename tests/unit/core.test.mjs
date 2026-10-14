// Unit tests for content/core.mjs. Run: node --test tests/unit
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ConversationIndex,
  formatPeople,
  headsReplaced,
  makeContext,
  normSubject,
} from "../../content/core.mjs";

const INBOX = "mailbox://me@a/Inbox";
const SENT = "mailbox://me@a/Sent";
const ARCHIVE = "mailbox://me@a/Archives";
const TRASH = "mailbox://me@a/Trash";
const INBOX2 = "mailbox://me@b/Inbox";

let nextKey = 1;
function msg(id, subject, date, { refs = [], uri = INBOX, key, hidden = false, author = "x@y" } = {}) {
  return { id, subject, date, author, refs, uri, key: key ?? nextKey++, hidden };
}

/** Message-IDs per conversation, sorted, for easy comparison. */
function conversations(index) {
  const out = new Map();
  for (const rec of index.recs.values()) {
    const root = index.find(rec);
    out.set(root, root.members.map(m => m.id).sort());
  }
  return [...out.values()].map(ids => ids.join(" ")).sort();
}

test("normSubject strips reply/forward prefixes, case and spacing", () => {
  for (const [input, expected] of [
    ["Hello", "hello"],
    ["Re: Hello", "hello"],
    ["RE: re: Hello", "hello"],
    ["Fwd: Re: Hello", "hello"],
    ["FW:Hello", "hello"],
    ["Re[2]: Hello", "hello"],
    ["Re (3): Hello", "hello"],
    ["AW: WG: Hello", "hello"],
    ["Ответ: Привет", "привет"],
    ["回复：你好", "你好"],
    ["  Hello   world  ", "hello world"],
    ["[list] Re: Hello", "[list] re: hello"],
    ["Rendering issue", "rendering issue"],
    ["Fwdx: Hello", "fwdx: hello"],
    ["", ""],
    [null, ""],
  ]) {
    assert.equal(normSubject(input), expected, JSON.stringify(input));
  }
});

test("a reply joins the conversation it references", () => {
  const index = new ConversationIndex();
  index.add(msg("a", "Plan", 1));
  index.add(msg("b", "Re: Plan", 2, { refs: ["a"], uri: SENT }));
  index.add(msg("c", "Re: Plan", 3, { refs: ["a", "b"] }));
  assert.deepEqual(conversations(index), ["a b c"]);
});

test("a broken chain is joined through a message in another folder", () => {
  // c only references b, which lives in Sent: the case the Unified Inbox
  // gets wrong on its own.
  const index = new ConversationIndex();
  index.add(msg("a", "Kickoff", 1));
  index.add(msg("b", "Re: Kickoff", 2, { refs: ["a"], uri: SENT }));
  index.add(msg("c", "Re: Kickoff", 3, { refs: ["b"] }));
  assert.deepEqual(conversations(index), ["a b c"]);
});

test("a changed subject starts a new conversation (Gmail rule)", () => {
  const index = new ConversationIndex();
  index.add(msg("a", "Budget", 1));
  index.add(msg("b", "Offsite location", 2, { refs: ["a"] }));
  index.add(msg("c", "Re: Offsite location", 3, { refs: ["a", "b"] }));
  assert.deepEqual(conversations(index), ["a", "b c"]);
});

test("order of arrival does not matter", () => {
  const msgs = [
    msg("a", "Plan", 1),
    msg("b", "Re: Plan", 2, { refs: ["a"] }),
    msg("c", "Re: Plan", 3, { refs: ["b"] }),
    msg("d", "Re: Plan", 4, { refs: ["c"] }),
    msg("x", "Other", 5, { refs: ["d"] }),
  ];
  const expected = ["a b c d", "x"];
  for (const order of [
    [0, 1, 2, 3, 4],
    [4, 3, 2, 1, 0],
    [2, 0, 4, 3, 1],
    [3, 1, 4, 0, 2],
  ]) {
    const index = new ConversationIndex();
    for (const i of order) {
      index.add(msgs[i]);
    }
    assert.deepEqual(conversations(index), expected, `order ${order}`);
    assert.equal(index.waiting.size, 0);
  }
});

test("messages sharing only a missing parent stay apart", () => {
  const index = new ConversationIndex();
  index.add(msg("b", "Re: Plan", 2, { refs: ["missing"] }));
  index.add(msg("c", "Re: Plan", 3, { refs: ["missing"] }));
  assert.deepEqual(conversations(index), ["b", "c"]);
  // ...until the parent shows up.
  index.add(msg("missing", "Plan", 1));
  assert.deepEqual(conversations(index), ["b c missing"]);
});

test("a message referencing itself is harmless", () => {
  const index = new ConversationIndex();
  index.add(msg("a", "Loop", 1, { refs: ["a"] }));
  assert.deepEqual(conversations(index), ["a"]);
  assert.equal(index.waiting.size, 0);
});

test("copies of one message share a record", () => {
  const index = new ConversationIndex();
  const r1 = index.add(msg("t", "Team update", 1, { uri: INBOX, key: 10 }));
  const r2 = index.add(msg("t", "Team update", 1, { uri: INBOX2, key: 20 }));
  const r3 = index.add(msg("t", "Team update", 1, { uri: INBOX2, key: 20 }));
  assert.equal(r1, r2);
  assert.equal(r1, r3);
  assert.deepEqual(
    r1.locs.map(l => [l.uri, l.key]),
    [
      [INBOX, 10],
      [INBOX2, 20],
    ]
  );
});

test("messages without Message-ID are ignored", () => {
  const index = new ConversationIndex();
  assert.equal(index.add(msg("", "x", 1)), null);
  assert.equal(index.recs.size, 0);
});

test("removing the linking message keeps the conversation together", () => {
  const index = new ConversationIndex();
  index.add(msg("a", "Plan", 1, { key: 1 }));
  index.add(msg("b", "Re: Plan", 2, { refs: ["a"], uri: SENT, key: 2 }));
  index.add(msg("c", "Re: Plan", 3, { refs: ["b"], key: 3 }));
  assert.equal(index.remove("b", SENT, 2), true);
  assert.equal(index.remove("b", SENT, 2), false);
  assert.deepEqual(conversations(index), ["a b c"]);
  assert.deepEqual(
    index.visibleMembers(index.recs.get("a")).map(m => m.id),
    ["a", "c"]
  );
});

test("the head is the newest visible copy in the list's folders", () => {
  const index = new ConversationIndex();
  index.add(msg("a", "Plan", 1, { uri: ARCHIVE, key: 1 }));
  index.add(msg("b", "Re: Plan", 2, { refs: ["a"], uri: INBOX, key: 2 }));
  index.add(msg("c", "Re: Plan", 3, { refs: ["b"], uri: SENT, key: 3 }));
  index.add(msg("d", "Re: Plan", 4, { refs: ["c"], uri: TRASH, key: 4, hidden: true }));
  const root = index.find(index.recs.get("a"));

  assert.deepEqual(index.head(root, makeContext([INBOX])), { uri: INBOX, key: 2, hidden: false });
  assert.equal(index.head(root, makeContext([SENT])).key, 3);
  assert.equal(index.head(root, makeContext([INBOX, SENT, ARCHIVE])).key, 3);
  // Trash copies never head a list, even a list of the Trash.
  assert.equal(index.head(root, makeContext([TRASH])), null);
  assert.equal(index.head(root, makeContext([INBOX2])), null);
});

test("exactly one head when a message has copies in two listed folders", () => {
  const index = new ConversationIndex();
  index.add(msg("t", "Team update", 5, { uri: INBOX2, key: 7 }));
  index.add(msg("t", "Team update", 5, { uri: INBOX, key: 9 }));
  const ctx = makeContext([INBOX, INBOX2]);
  const rec = index.recs.get("t");
  const heads = [
    index.isHead(rec, INBOX, 9, ctx),
    index.isHead(rec, INBOX2, 7, ctx),
  ];
  assert.deepEqual(heads.filter(Boolean).length, 1);
});

test("equal dates still give a single, stable head", () => {
  const index = new ConversationIndex();
  index.add(msg("a", "Same", 5, { key: 1 }));
  index.add(msg("b", "Re: Same", 5, { refs: ["a"], key: 2 }));
  const ctx = makeContext([INBOX]);
  const rec = index.recs.get("a");
  const heads = [1, 2].filter(key => index.isHead(rec, INBOX, key, ctx));
  assert.equal(heads.length, 1);
  assert.deepEqual(heads, [1, 2].filter(key => index.isHead(rec, INBOX, key, ctx)));
});

test("a message outside the index heads its own row", () => {
  const index = new ConversationIndex();
  const rec = index.add(msg("a", "Plan", 1, { key: 1 }));
  // Its only copy is elsewhere: the list shows it anyway rather than hide mail.
  assert.equal(index.isHead(rec, INBOX2, 99, makeContext([INBOX2])), true);
});

test("head cache follows changes", () => {
  const index = new ConversationIndex();
  index.add(msg("a", "Plan", 1, { key: 1 }));
  const ctx = makeContext([INBOX]);
  const rec = index.recs.get("a");
  assert.equal(index.isHead(rec, INBOX, 1, ctx), true);
  index.add(msg("b", "Re: Plan", 2, { refs: ["a"], key: 2 }));
  assert.equal(index.isHead(rec, INBOX, 1, ctx), false);
  assert.equal(index.isHead(rec, INBOX, 2, ctx), true);
  index.remove("b", INBOX, 2);
  assert.equal(index.isHead(rec, INBOX, 1, ctx), true);
});

test("wrapChange sees the conversations before and after", () => {
  const seen = [];
  const index = new ConversationIndex({
    wrapChange(touched, mutate) {
      const ctx = makeContext([INBOX]);
      const before = index.headKeys(touched, ctx);
      const result = mutate();
      const after = index.headKeys(result ? [...touched, result] : touched, ctx);
      seen.push(headsReplaced(before, after));
      return result;
    },
  });
  index.add(msg("a", "Plan", 1, { key: 1 })); // new conversation
  index.add(msg("b", "Re: Plan", 2, { refs: ["a"], key: 2 })); // new head
  index.add(msg("c", "Re: Plan", 0, { refs: ["a"], key: 3 })); // older, head stays
  index.add(msg("x", "Other", 3, { key: 4 })); // unrelated
  index.remove("b", INBOX, 2); // head deleted, "a" takes over
  index.remove("a", INBOX, 1); // head deleted again, "c" takes over
  index.add(msg("c", "Re: Plan", 0, { refs: ["a"], uri: SENT, key: 5 })); // copy outside the list
  index.remove("c", INBOX, 3); // conversation leaves the list
  assert.deepEqual(seen, [false, true, false, false, true, true, false, false]);
});

test("two listed conversations merged by a late message replace a head", () => {
  const index = new ConversationIndex();
  index.add(msg("a", "Kickoff", 1, { key: 1 }));
  index.add(msg("c", "Re: Kickoff", 3, { refs: ["b"], key: 3 }));
  const ctx = makeContext([INBOX]);
  const touched = [index.recs.get("a"), index.recs.get("c")];
  const before = index.headKeys(touched, ctx);
  assert.equal(before.size, 2);
  const b = index.add(msg("b", "Re: Kickoff", 2, { refs: ["a"], uri: SENT, key: 2 }));
  const after = index.headKeys([...touched, b], ctx);
  assert.deepEqual([...after], [`${INBOX}#3`]);
  assert.equal(headsReplaced(before, after), true);
});

test("rekey and dropTree", () => {
  const index = new ConversationIndex();
  index.add(msg("a", "Plan", 1, { uri: INBOX, key: 1 }));
  index.add(msg("b", "Plan 2", 1, { uri: INBOX + "/Sub", key: 2 }));
  index.add(msg("c", "Plan 3", 1, { uri: INBOX + "2", key: 3 }));
  assert.equal(index.rekey("a", INBOX, 1, 100), true);
  assert.equal(index.rekey("a", INBOX, 1, 100), false);
  assert.equal(index.recs.get("a").locs[0].key, 100);
  index.dropTree(INBOX);
  assert.deepEqual(index.recs.get("a").locs, []);
  assert.deepEqual(index.recs.get("b").locs, []);
  // "Inbox2" is not inside "Inbox".
  assert.equal(index.recs.get("c").locs.length, 1);
});

test("visibleMembers skips Trash copies and sorts by date", () => {
  const index = new ConversationIndex();
  index.add(msg("b", "Re: Plan", 2, { refs: ["a"] }));
  index.add(msg("a", "Plan", 1));
  index.add(msg("c", "Re: Plan", 3, { refs: ["b"], uri: TRASH, hidden: true }));
  assert.deepEqual(index.visibleMembers(index.recs.get("c")).map(m => m.id), ["a", "b"]);
});

test("headsReplaced", () => {
  const s = (...a) => new Set(a);
  assert.equal(headsReplaced(s(), s("x")), false); // the list adds it itself
  assert.equal(headsReplaced(s("x"), s()), false); // the list removes it itself
  assert.equal(headsReplaced(s("x"), s("x")), false);
  assert.equal(headsReplaced(s("x"), s("y")), true);
  assert.equal(headsReplaced(s("x", "y"), s("x")), true);
});

test("formatPeople follows Gmail", () => {
  const p = (name, email, me = false) => ({ name, email, me });
  assert.equal(formatPeople([]), "");
  assert.equal(formatPeople([p("Alice Archer", "a@x")]), "Alice Archer");
  assert.equal(formatPeople([p("", "a@x")]), "a@x");
  assert.equal(formatPeople([p("Me Myself", "me@x", true)]), "me");
  assert.equal(formatPeople([p("Me Myself", "me@x", true)], "я"), "я");
  assert.equal(
    formatPeople([p("Alice Archer", "a@x"), p("Me", "me@x", true), p("", "bob@x")]),
    "Alice, me, bob"
  );
  assert.equal(
    formatPeople([p("Alice A", "a@x"), p("Bob B", "b@x"), p("Carol C", "c@x"), p("Dave D", "d@x")]),
    "Alice … Carol, Dave"
  );
  assert.equal(formatPeople([p("Archer, Alice", "a@x"), p("Bob", "b@x")]), "Archer, Bob");
});

test("scales to a large mailbox", () => {
  const index = new ConversationIndex();
  const start = performance.now();
  const N = 200000;
  for (let i = 0; i < N; i++) {
    const thread = Math.floor(i / 5);
    const prev = i % 5 ? [`m${i - 1}`] : [];
    index.add(msg(`m${i}`, `${i % 5 ? "Re: " : ""}Subject ${thread}`, i, { refs: prev, key: i }));
  }
  const ms = performance.now() - start;
  assert.equal(conversations(index).length, N / 5);
  assert.ok(ms < 5000, `indexing ${N} messages took ${ms} ms`);
});
