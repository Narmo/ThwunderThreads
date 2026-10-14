/* ThwunderThreads — conversation logic without any Thunderbird dependency,
 * shared by the add-on (api.js) and the unit tests (tests/unit). */

// Reply and forward prefixes; Gmail ignores them when comparing subjects.
const PREFIX =
  /^(?:\s*(?:re|fwd?|aw|wg|sv|vs|antw|tr|rif|ref|ответ|отв|пер|回复|转发)(?:\s*\[\d+\]|\s*\(\d+\))?\s*[:：])+/i;

export function normSubject(subject) {
  return (subject || "")
    .replace(PREFIX, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * One message, whatever number of folders it has copies in.
 *
 * @typedef {object} Loc
 * @property {string} uri - Folder URI.
 * @property {number} key - Message key in that folder.
 * @property {boolean} hidden - In Trash or Junk: links conversations, never shown.
 */
export class Rec {
  constructor(msg) {
    this.id = msg.id;
    this.subj = normSubject(msg.subject);
    this.date = msg.date;
    this.author = msg.author;
    /** @type {Loc[]} */
    this.locs = [];
    this.up = this;
    /** Conversation members, kept on the union-find root only. */
    this.members = [this];
  }
}

/**
 * Gmail's conversation rule: a message joins the conversation of a message it
 * references (References / In-Reply-To) when both have the same subject.
 * A conversation never splits again, deleting the message that linked it
 * included — Gmail keeps thread ids too.
 */
export class ConversationIndex {
  /**
   * @param {object} [options]
   * @param {Function} [options.wrapChange] - (touchedRecs, mutate) => result,
   *   called around every change so the caller can compare before and after.
   */
  constructor({ wrapChange } = {}) {
    /** @type {Map<string, Rec>} */
    this.recs = new Map();
    /** Message-IDs referenced but not seen yet -> records waiting for them. */
    this.waiting = new Map();
    /** Bumped on every change; invalidates cached conversation heads. */
    this.version = 0;
    this.wrapChange = wrapChange ?? ((touched, mutate) => mutate());
    this.uris = new Map();
  }

  /** Folder URIs are kept once in memory, however many messages they hold. */
  canon(uri) {
    let u = this.uris.get(uri);
    if (u === undefined) {
      this.uris.set(uri, (u = uri));
    }
    return u;
  }

  find(rec) {
    while (rec.up !== rec) {
      rec.up = rec.up.up;
      rec = rec.up;
    }
    return rec;
  }

  link(a, b) {
    if (a.subj !== b.subj) {
      return;
    }
    a = this.find(a);
    b = this.find(b);
    if (a === b) {
      return;
    }
    if (a.members.length < b.members.length) {
      [a, b] = [b, a];
    }
    b.up = a;
    for (const m of b.members) {
      a.members.push(m);
    }
    b.members = null;
  }

  /**
   * @param {object} msg - {id, subject, date, author, refs, uri, key, hidden}
   * @returns {?Rec} The record, or null for a message without Message-ID.
   */
  add(msg) {
    const { id, key } = msg;
    if (!id) {
      return null;
    }
    const uri = this.canon(msg.uri);
    let rec = this.recs.get(id);
    if (rec?.locs.some(l => l.uri === uri && l.key === key)) {
      return rec;
    }
    const refs = rec ? [] : msg.refs ?? [];
    const touched = rec
      ? [rec]
      : [
          ...refs.map(r => this.recs.get(r)).filter(Boolean),
          ...(this.waiting.get(id) ?? []),
        ];
    return this.wrapChange(touched, () => {
      if (!rec) {
        rec = new Rec(msg);
        this.recs.set(id, rec);
        for (const ref of refs) {
          const target = this.recs.get(ref);
          if (target) {
            this.link(rec, target);
          } else if (ref != id) {
            let list = this.waiting.get(ref);
            if (!list) {
              this.waiting.set(ref, (list = []));
            }
            list.push(rec);
          }
        }
        const waiters = this.waiting.get(id);
        if (waiters) {
          this.waiting.delete(id);
          for (const w of waiters) {
            this.link(w, rec);
          }
        }
      }
      rec.locs.push({ uri, key, hidden: !!msg.hidden });
      this.version++;
      return rec;
    });
  }

  remove(id, uri, key) {
    const rec = this.recs.get(id);
    const i = rec ? rec.locs.findIndex(l => l.uri === uri && l.key === key) : -1;
    if (i < 0) {
      return false;
    }
    this.wrapChange([rec], () => {
      rec.locs.splice(i, 1);
      this.version++;
    });
    return true;
  }

  /** @returns {boolean} false if the location is unknown. */
  rekey(id, uri, oldKey, newKey) {
    const loc = this.recs
      .get(id)
      ?.locs.find(l => l.uri === uri && l.key === oldKey);
    if (!loc) {
      return false;
    }
    loc.key = newKey;
    this.version++;
    return true;
  }

  /** Forget a stale location without notifying anyone. */
  dropLoc(rec, loc) {
    const i = rec.locs.indexOf(loc);
    if (i >= 0) {
      rec.locs.splice(i, 1);
      this.version++;
    }
  }

  /** Forget the locations in a folder and its subfolders. */
  dropTree(uri) {
    const prefix = uri + "/";
    for (const rec of this.recs.values()) {
      if (rec.locs.some(l => l.uri === uri || l.uri.startsWith(prefix))) {
        rec.locs = rec.locs.filter(
          l => l.uri !== uri && !l.uri.startsWith(prefix)
        );
      }
    }
    this.version++;
  }

  /** Members with a visible copy, oldest first. */
  visibleMembers(rec) {
    return this.find(rec)
      .members.filter(m => m.locs.some(l => !l.hidden))
      .sort((a, b) => a.date - b.date || (a.id < b.id ? -1 : 1));
  }

  /**
   * The newest visible copy of the conversation inside the folders of `ctx`:
   * the message representing the conversation in that list.
   *
   * @returns {?Loc}
   */
  head(root, ctx) {
    if (ctx.version !== this.version) {
      ctx.heads.clear();
      ctx.version = this.version;
    }
    let head = ctx.heads.get(root);
    if (head === undefined) {
      let best = null;
      for (const m of root.members) {
        for (const l of m.locs) {
          if (l.hidden || !ctx.folders.has(l.uri)) {
            continue;
          }
          if (
            !best ||
            m.date > best.m.date ||
            (m.date == best.m.date &&
              (m.id > best.m.id ||
                (m.id == best.m.id &&
                  (l.uri < best.l.uri ||
                    (l.uri == best.l.uri && l.key < best.l.key)))))
          ) {
            best = { m, l };
          }
        }
      }
      head = best?.l ?? null;
      ctx.heads.set(root, head);
    }
    return head;
  }

  /** Is (uri, key) the head of its conversation in `ctx`? */
  isHead(rec, uri, key, ctx) {
    const head = this.head(this.find(rec), ctx);
    return !head || (head.uri === uri && head.key === key);
  }

  /** "uri#key" of the heads of the conversations of `recs` in `ctx`. */
  headKeys(recs, ctx) {
    const keys = new Set();
    for (const rec of recs) {
      const head = this.head(this.find(rec), ctx);
      if (head) {
        keys.add(head.uri + "#" + head.key);
      }
    }
    return keys;
  }
}

/** A list context: the folders one message list shows. */
export function makeContext(folderUris) {
  return { folders: new Set(folderUris), heads: new Map(), version: -1 };
}

/** Did the heads of a list change in a way the list can't follow itself? */
export function headsReplaced(before, after) {
  return (
    before.size > 0 &&
    after.size > 0 &&
    (before.size != after.size || [...after].some(k => !before.has(k)))
  );
}

/**
 * Gmail's participant line: "Alice Archer" for one person, first names for
 * several, "Alice … Bob, me" for more than three.
 *
 * @param {{name: string, email: string, me: boolean}[]} people - In order of
 *   first message.
 */
export function formatPeople(people, meLabel = "me") {
  if (!people.length) {
    return "";
  }
  if (people.length == 1) {
    const [p] = people;
    return p.me ? meLabel : p.name || p.email;
  }
  const short = p =>
    p.me
      ? meLabel
      : p.name
        ? p.name.split(/[\s,]+/).find(Boolean) ?? p.name
        : p.email.split("@")[0];
  if (people.length <= 3) {
    return people.map(short).join(", ");
  }
  return `${short(people[0])} … ${people.slice(-2).map(short).join(", ")}`;
}
