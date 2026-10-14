/* Thwunderthreads — Gmail-style conversations for Thunderbird.
 *
 * Privileged half of the add-on (a WebExtension Experiment, parent process):
 *  - a global conversation index over every mail folder of every account,
 *  - every message list reduced to one row per conversation,
 *  - list commands (archive, delete, move, mark read) applied to the whole
 *    conversation,
 *  - the message pane replaced by the conversation (content/conversation.*).
 */

"use strict";

/* global ExtensionCommon, ChromeUtils, Services, Cc, Ci, Cu */

const { ExtensionSupport } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);
const { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const { MailUtils } = ChromeUtils.importESModule(
  "resource:///modules/MailUtils.sys.mjs"
);
const { MessageArchiver } = ChromeUtils.importESModule(
  "resource:///modules/MessageArchiver.sys.mjs"
);
const { SearchSpec } = ChromeUtils.importESModule(
  "resource:///modules/SearchSpec.sys.mjs"
);
const { DBViewWrapper } = ChromeUtils.importESModule(
  "resource:///modules/DBViewWrapper.sys.mjs"
);
const { setTimeout, clearTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);

const ADDON_ID = "thwunderthreads@narmo";
const TERM_ID = "thwunderthreads@narmo#conversationHead";
const FF = Ci.nsMsgFolderFlags;
// Never part of a conversation.
const SKIPPED_FOLDERS = FF.Virtual | FF.Drafts | FF.Templates | FF.Queue;
// Indexed so that threading stays stable, but never displayed (like Gmail).
const HIDDEN_FOLDERS = FF.Trash | FF.Junk;
const SKIPPED_SERVERS = new Set(["rss", "nntp", "im"]);

let stopped = false;

function indexable(folder) {
  return (
    !folder.isServer &&
    !(folder.flags & SKIPPED_FOLDERS) &&
    !SKIPPED_SERVERS.has(folder.server.type)
  );
}

function hiddenFolder(folder) {
  return folder.isSpecialFolder(HIDDEN_FOLDERS, true);
}

const idle = () => new Promise(resolve => setTimeout(resolve, 0));

// content/core.mjs, imported in onStartup once its chrome:// package exists
// (from a fresh URL each time, so an updated add-on never runs stale code).
let core = null;

function toMsg(hdr, uri = hdr.folder.URI, hidden = hiddenFolder(hdr.folder)) {
  const refs = [];
  for (let i = 0; i < hdr.numReferences; i++) {
    refs.push(hdr.getStringReference(i));
  }
  return {
    id: hdr.messageId,
    subject: hdr.mime2DecodedSubject,
    date: hdr.date,
    author: hdr.mime2DecodedAuthor,
    refs,
    uri,
    key: hdr.messageKey,
    hidden,
  };
}

/* ---------------------------------------------------------------------------
 * Conversation index over every mail folder of every account (core.mjs),
 * fed from the folder databases and kept current by folder notifications.
 */

let index = null;

function createIndex() {
  return Object.assign(
    new core.ConversationIndex({
      wrapChange: (touched, mutate) => observeChange(touched, mutate),
    }),
    indexMethods
  );
}

const indexMethods = {
  ready: false,
  /** Folder URIs whose database has been scanned. */
  scanned: new Set(),

  addHdr(hdr) {
    return hdr.messageId ? this.add(toMsg(hdr)) : null;
  },

  removeHdr(hdr) {
    if (hdr.folder) {
      this.remove(hdr.messageId, hdr.folder.URI, hdr.messageKey);
    }
  },

  forgetTree(uri) {
    this.dropTree(uri);
    const prefix = uri + "/";
    for (const u of [...this.scanned]) {
      if (u === uri || u.startsWith(prefix)) {
        this.scanned.delete(u);
      }
    }
    refreshAll();
  },

  /** Folder URI -> resolver, for folders waiting for FolderLoaded. */
  loading: new Map(),

  /**
   * Add every message of the folder.
   *
   * @returns {Promise<boolean>} false if the folder database isn't available
   *   yet: a local folder without summary file is being reparsed.
   */
  async scan(folder) {
    const uri = folder.URI;
    if (stopped || this.scanned.has(uri) || !indexable(folder)) {
      return true;
    }
    let db;
    try {
      db = folder.msgDatabase;
    } catch (e) {
      if (folder instanceof Ci.nsIMsgLocalMailFolder) {
        // Missing or outdated summary: have Thunderbird rebuild it (this
        // only writes the .msf file). FolderLoaded follows.
        try {
          folder.getDatabaseWithReparse(null, null);
        } catch (e2) {}
      }
      return false;
    }
    if (!db) {
      return false;
    }
    this.scanned.add(uri);
    const hidden = hiddenFolder(folder);
    let n = 0;
    try {
      for (const hdr of db.enumerateMessages()) {
        if (hdr.messageId) {
          this.add(toMsg(hdr, uri, hidden));
        }
        if (++n % 2000 == 0) {
          await idle();
          if (stopped) {
            return true;
          }
        }
      }
    } catch (e) {
      // The database went away under us; FolderLoaded brings us back.
      this.scanned.delete(uri);
      return false;
    }
    return true;
  },

  /** Resolves once the folder's database is loaded (or after a minute). */
  whenLoaded(folder) {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.loading.delete(folder.URI);
        resolve();
      }, 60000);
      this.loading.set(folder.URI, () => {
        clearTimeout(timer);
        this.loading.delete(folder.URI);
        resolve();
      });
    });
  },

  async scanTree(folder) {
    for (const f of [folder, ...folder.descendants]) {
      await this.scan(f);
    }
  },

  async build() {
    if (this.building) {
      return;
    }
    this.building = true;
    const start = Date.now();
    const reparsing = [];
    for (const folder of MailServices.accounts.allFolders) {
      if (!(await this.scan(folder))) {
        reparsing.push(this.whenLoaded(folder).then(() => this.scan(folder)));
      }
      if (stopped) {
        return;
      }
    }
    await Promise.all(reparsing);
    if (stopped) {
      return;
    }
    this.ready = true;
    console.log(
      `Thwunderthreads: indexed ${this.recs.size} messages in ${this.scanned.size} folders, ${Date.now() - start} ms`
    );
    refreshAll();
  },
};

function maybeAdd(hdr) {
  if (hdr.messageId && indexable(hdr.folder)) {
    index.addHdr(hdr);
  }
}

/**
 * The live header for a record's location, or null. Fixes stale keys
 * (compaction, IMAP) on the way.
 */
function hdrFor(rec, loc) {
  const folder = MailServices.folderLookup.getFolderForURL(loc.uri);
  let db;
  try {
    db = folder?.msgDatabase;
  } catch (e) {}
  if (!db) {
    return null;
  }
  let hdr = null;
  try {
    hdr = db.getMsgHdrForKey(loc.key);
  } catch (e) {}
  if (hdr?.messageId !== rec.id) {
    hdr = db.getMsgHdrForMessageID(rec.id);
    if (hdr) {
      loc.key = hdr.messageKey;
    }
  }
  if (!hdr) {
    index.dropLoc(rec, loc);
  }
  if (!hdr || hdr.flags & Ci.nsMsgMessageFlags.IMAPDeleted) {
    return null;
  }
  return hdr;
}

/* ---------------------------------------------------------------------------
 * Conversation heads. A view context is the set of folders a message list
 * shows; the head of a conversation in it is its newest message there.
 */

const contexts = new Map();

function contextFor(value) {
  let ctx = contexts.get(value);
  if (!ctx) {
    contexts.set(value, (ctx = core.makeContext(JSON.parse(value))));
  }
  return ctx;
}

/** The custom search term: does this header head its conversation? */
function isHead(hdr, value) {
  if (!hdr.messageId) {
    return true;
  }
  const uri = hdr.folder.URI;
  const key = hdr.messageKey;
  let rec = index.recs.get(hdr.messageId);
  if (!rec?.locs.some(l => l.uri === uri && l.key === key)) {
    rec = index.addHdr(hdr);
  }
  return index.isHead(rec, uri, key, contextFor(value));
}

function registerTerm(impl) {
  let term = MailServices.filters.getCustomTerm(TERM_ID);
  if (!term) {
    // Custom terms can't be unregistered, so the term lives in its own
    // sandbox that outlives add-on reloads and forwards to the current impl.
    const sandbox = Cu.Sandbox(
      Services.scriptSecurityManager.getSystemPrincipal(),
      { sandboxName: ADDON_ID + " search term", wantGlobalProperties: ["ChromeUtils"] }
    );
    term = Cu.evalInSandbox(
      `({
        id: ${JSON.stringify(TERM_ID)},
        name: "Conversation head (Thwunderthreads)",
        needsBody: false,
        impl: null,
        getEnabled() { return true; },
        getAvailable() { return false; },
        getAvailableOperators() { return [${Ci.nsMsgSearchOp.Is}]; },
        match(hdr, value) {
          try { return this.impl ? this.impl(hdr, value) : true; } catch (e) { return true; }
        },
        get wrappedJSObject() { return this; },
        QueryInterface: ChromeUtils.generateQI(["nsIMsgSearchCustomTerm"]),
      })`,
      sandbox
    );
    MailServices.filters.addCustomTerm(term);
  }
  term.wrappedJSObject.impl = impl;
}

/* ---------------------------------------------------------------------------
 * Hooking about:3pane.
 */

/** about:3pane window -> per-window state. */
const hooked = new Map();
/** dbViewWrapperListener objects of hooked windows: their views get filtered. */
const hookedListeners = new WeakSet();

function isGmailView(viewWrapper) {
  if (
    !index.ready ||
    stopped ||
    !viewWrapper ||
    viewWrapper.isSynthetic ||
    !hookedListeners.has(viewWrapper.listener)
  ) {
    return false;
  }
  const folders = viewWrapper._underlyingFolders;
  return (
    !!folders?.length &&
    folders.every(f => indexable(f) && !hiddenFolder(f))
  );
}

const originals = {};

function patchModules() {
  originals.hasSearchTerms = Object.getOwnPropertyDescriptor(
    SearchSpec.prototype,
    "hasSearchTerms"
  );
  Object.defineProperty(SearchSpec.prototype, "hasSearchTerms", {
    configurable: true,
    get() {
      return (
        originals.hasSearchTerms.get.call(this) || isGmailView(this.owner)
      );
    },
  });

  originals.updateSession = SearchSpec.prototype.updateSession;
  SearchSpec.prototype.updateSession = function () {
    originals.updateSession.call(this);
    this._wtCtx = null;
    if (!isGmailView(this.owner) || !searchLocally(this.session)) {
      return;
    }
    const value = JSON.stringify(
      this.owner._underlyingFolders.map(f => f.URI).sort()
    );
    this._wtCtx = contextFor(value);
    const term = this.session.createTerm();
    term.attrib = Ci.nsMsgSearchAttrib.Custom;
    term.customId = TERM_ID;
    term.op = Ci.nsMsgSearchOp.Is;
    const termValue = term.value;
    termValue.attrib = Ci.nsMsgSearchAttrib.Custom;
    termValue.str = value;
    term.value = termValue;
    term.booleanAnd = true;
    // Last, so the other terms decide first.
    this.session.appendTerm(term);
  };

  // A conversation list is flat, like Gmail's.
  originals.createView = DBViewWrapper.prototype._createView;
  DBViewWrapper.prototype._createView = function () {
    if (isGmailView(this)) {
      const flags =
        this.__viewFlags ??
        Services.prefs.getIntPref("mailnews.default_view_flags", 1);
      this.__viewFlags =
        flags &
        ~(
          Ci.nsMsgViewFlagsType.kThreadedDisplay |
          Ci.nsMsgViewFlagsType.kGroupBySort
        );
    }
    return originals.createView.call(this);
  };
}

function unpatchModules() {
  if (originals.hasSearchTerms) {
    Object.defineProperty(
      SearchSpec.prototype,
      "hasSearchTerms",
      originals.hasSearchTerms
    );
  }
  if (originals.updateSession) {
    SearchSpec.prototype.updateSession = originals.updateSession;
  }
  if (originals.createView) {
    DBViewWrapper.prototype._createView = originals.createView;
  }
}

const LOCAL_SCOPES = new Set([
  Ci.nsMsgSearchScope.offlineMail,
  Ci.nsMsgSearchScope.onlineManual,
  Ci.nsMsgSearchScope.localNews,
]);

/**
 * The conversation term is answered from the local index, so it can't go to
 * an IMAP server (the Unified Inbox searches IMAP folders online). Switch
 * those folders to a local search, as Thunderbird does when filtering.
 *
 * @returns {boolean} false if some other term needs the server (a body
 *   search in a folder without local copies): then nothing is changed.
 */
function searchLocally(session) {
  const scopes = [];
  for (let i = 0; i < session.countSearchScopes(); i++) {
    const scope = {};
    const folder = {};
    session.getNthSearchScope(i, scope, folder);
    let local = scope.value;
    if (!LOCAL_SCOPES.has(local)) {
      local =
        folder.value.flags & FF.Offline
          ? Ci.nsMsgSearchScope.offlineMail
          : Ci.nsMsgSearchScope.onlineManual;
      const table = Cc["@mozilla.org/mail/search/validityManager;1"]
        .getService(Ci.nsIMsgSearchValidityManager)
        .getTable(local);
      const answerable = session.searchTerms.every(
        t =>
          t.matchAll ||
          t.attrib == Ci.nsMsgSearchAttrib.Custom ||
          table.getAvailable(t.attrib, t.op)
      );
      if (!answerable) {
        return false;
      }
    }
    scopes.push([local, folder.value]);
  }
  session.clearScopes();
  for (const [scope, folder] of scopes) {
    session.addScopeTerm(scope, folder);
  }
  return true;
}

/** Replace obj[name] with make(original); undone when unhooking. */
function patch(state, obj, name, make) {
  const orig = obj[name];
  const own = Object.hasOwn(obj, name);
  obj[name] = make(orig);
  state.undo.push(() => {
    if (own) {
      obj[name] = orig;
    } else {
      delete obj[name];
    }
  });
}

function hookMessenger(win) {
  const tabmail = win.document.getElementById("tabmail");
  if (!tabmail) {
    return;
  }
  tabmail.registerTabMonitor({
    monitorName: ADDON_ID,
    onTabOpened: tab => hookTab(tab),
    onTabClosing() {},
    onTabSwitched() {},
    onTabTitleChanged() {},
    onTabPersist() {},
    onTabRestored() {},
  });
  for (const tab of tabmail.tabInfo) {
    hookTab(tab);
  }
}

function unhookMessenger(win) {
  win.document
    .getElementById("tabmail")
    ?.unregisterTabMonitor({ monitorName: ADDON_ID });
}

function hookTab(tab) {
  if (tab.mode?.name != "mail3PaneTab") {
    return;
  }
  const browser = tab.chromeBrowser;
  let tries = 0;
  const attempt = () => {
    const w = browser.contentWindow;
    if (
      w?.location.href == "about:3pane" &&
      w.document.readyState == "complete" &&
      w.threadPane &&
      w.messagePane?.messageBrowser &&
      w.commandController
    ) {
      hook3Pane(w);
    } else if (++tries < 100 && !stopped) {
      setTimeout(attempt, 100);
    }
  };
  attempt();
}

function hook3Pane(w) {
  if (hooked.has(w) || stopped) {
    return;
  }
  const state = {
    undo: [],
    refreshTimer: null,
    updateTimer: null,
    refreshing: null,
    shown: null,
    selected: null,
    browser: null,
  };
  hooked.set(w, state);
  hookedListeners.add(w.dbViewWrapperListener);

  const link = w.document.createElement("link");
  link.rel = "stylesheet";
  link.href = "chrome://thwunderthreads/content/threadpane.css";
  w.document.head.append(link);
  state.undo.push(() => link.remove());

  patchRows(w, state);
  patchCommands(w, state);
  patchMessagePane(w, state);

  w.addEventListener(
    "unload",
    () => {
      clearTimeout(state.refreshTimer);
      clearTimeout(state.updateTimer);
      clearTimeout(state.refreshing);
      hooked.delete(w);
    },
    { once: true }
  );
  if (index.ready) {
    refreshView(w);
  }
  // The first 3-pane tab means the accounts and their folders are loaded.
  index.build().catch(console.error);
}

function unhook3Pane(w) {
  const state = hooked.get(w);
  if (!state) {
    return;
  }
  hooked.delete(w);
  clearTimeout(state.refreshTimer);
  clearTimeout(state.updateTimer);
  clearTimeout(state.refreshing);
  const wasShowing = state.browser && !state.browser.hidden;
  for (const undo of state.undo.reverse()) {
    try {
      undo();
    } catch (e) {
      console.error(e);
    }
  }
  try {
    const viewWrapper = w.gViewWrapper;
    if (viewWrapper?.search) {
      viewWrapper.search._wtCtx = null;
      // Back to the folder's own (stored, untouched) threading.
      try {
        viewWrapper.__viewFlags =
          viewWrapper.displayedFolder.msgDatabase.dBFolderInfo.viewFlags;
      } catch (e) {}
    }
    viewWrapper?.refresh();
    if (wasShowing) {
      w.threadPane._onSelect();
    }
  } catch (e) {
    console.error(e);
  }
}

/* ---------------------------------------------------------------------------
 * Keeping lists and the open conversation current.
 */

function activeViews() {
  const views = [];
  for (const w of hooked.keys()) {
    const ctx = w.gViewWrapper?.search?._wtCtx;
    if (ctx) {
      views.push({ w, ctx });
    }
  }
  return views;
}

/**
 * Run `mutate` and refresh the lists in which the head of one of the touched
 * conversations changed: the view adds new heads by itself, but never drops
 * the old ones. Conversations on display get updated too.
 */
function observeChange(touched, mutate) {
  if (!index.ready) {
    return mutate();
  }
  const views = activeViews();
  const before = views.map(v => index.headKeys(touched, v.ctx));
  const result = mutate();
  const after = result ? [...touched, result] : touched;
  views.forEach((v, i) => {
    if (core.headsReplaced(before[i], index.headKeys(after, v.ctx))) {
      scheduleRefresh(v.w);
    }
  });
  for (const [w, state] of hooked) {
    if (
      state.shown &&
      after.some(r => index.find(r) === index.find(state.shown))
    ) {
      scheduleUpdate(w, state);
    }
  }
  return result;
}

function scheduleRefresh(w) {
  const state = hooked.get(w);
  if (state && !state.refreshTimer) {
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;
      refreshView(w);
    }, 300);
  }
}

function refreshAll() {
  for (const w of hooked.keys()) {
    scheduleRefresh(w);
  }
}

/** Rebuild the list, keeping the selection on the same conversations. */
function refreshView(w) {
  const viewWrapper = w.gViewWrapper;
  if (!viewWrapper?.dbView || viewWrapper.isSynthetic) {
    return;
  }
  if (viewWrapper.searching) {
    scheduleRefresh(w);
    return;
  }
  const isGmail = isGmailView(viewWrapper);
  if (!isGmail && !viewWrapper.search._wtCtx) {
    return;
  }
  // Rebuilding the list clears the selection for a moment; the open
  // conversation stays until the selection is back (or turns out gone).
  const state = hooked.get(w);
  if (state?.shown) {
    clearTimeout(state.refreshing);
    state.refreshing = setTimeout(() => {
      state.refreshing = null;
      if (!w.gDBView?.numSelected) {
        w.messagePane.displayMessage();
      }
    }, 3000);
  }
  viewWrapper.refresh();
  // refresh() saved the selection; point it at the new conversation heads.
  const saved = w.threadPane._savedSelections?.get(
    w.threadPane._getSavedSelectionKey()
  );
  const ctx = viewWrapper.search._wtCtx;
  if (!saved || !ctx) {
    return;
  }
  const remap = uri => {
    try {
      const hdr = w.top.messenger.msgHdrFromURI(uri);
      const rec = index.recs.get(hdr.messageId);
      const root = rec && index.find(rec);
      const head = root && index.head(root, ctx);
      const owner = head && root.members.find(m => m.locs.includes(head));
      const headHdr = owner && hdrFor(owner, head);
      return headHdr ? headHdr.folder.getUriForMsg(headHdr) : uri;
    } catch (e) {
      return uri;
    }
  };
  if (saved.currentUri) {
    saved.currentUri = remap(saved.currentUri);
  }
  saved.selectedUris = saved.selectedUris.map(remap);
}

function scheduleUpdate(w, state) {
  if (!state.updateTimer) {
    state.updateTimer = setTimeout(() => {
      state.updateTimer = null;
      if (state.shown && !state.browser.hidden) {
        renderConversation(w, state, true);
      }
    }, 200);
  }
}

/* ---------------------------------------------------------------------------
 * Message list rows: participants, message count and conversation unread
 * state, like Gmail's "Alice, me, Bob 3".
 */

const ME_LABEL = Services.locale.appLocaleAsBCP47.startsWith("ru") ? "я" : "me";
const people = new Map();
let myAddresses = null;

function me(email) {
  if (!myAddresses) {
    myAddresses = new Set(
      MailServices.accounts.allIdentities
        .map(i => i.email?.toLowerCase())
        .filter(Boolean)
    );
  }
  return myAddresses.has(email.toLowerCase());
}

function person(author) {
  let p = people.get(author);
  if (!p) {
    const [first] = MailServices.headerParser.parseDecodedHeader(author);
    const email = first?.email || author;
    const name = first?.name || "";
    p = { key: email.toLowerCase(), name, email, me: me(email) };
    people.set(author, p);
  }
  return p;
}

function conversationInfo(hdr) {
  const rec = hdr?.messageId && index.recs.get(hdr.messageId);
  if (!rec) {
    return null;
  }
  const members = index.visibleMembers(rec);
  let unread = false;
  const seen = new Map();
  for (const m of members) {
    if (!unread) {
      const loc = m.locs.find(l => !l.hidden);
      const h = loc && hdrFor(m, loc);
      unread = !!h && !h.isRead;
    }
    const p = person(m.author);
    if (!seen.has(p.key)) {
      seen.set(p.key, p);
    }
  }
  return {
    count: members.length,
    unread,
    names: core.formatPeople([...seen.values()], ME_LABEL),
  };
}

function rowInfo(w, row) {
  if (!w.gViewWrapper?.search?._wtCtx) {
    return null;
  }
  if (row.dataset.properties?.split(" ").includes("dummy")) {
    return null;
  }
  try {
    const hdr = w.gDBView.getMsgHdrAt(row._index);
    const info = conversationInfo(hdr);
    // Gmail shows the conversation's subject, without "Re:".
    return info && { ...info, subject: hdr.mime2DecodedSubject };
  } catch (e) {
    return null;
  }
}

function setCount(target, count) {
  let badge = target.parentNode.querySelector(".wt-count");
  if (count < 2) {
    badge?.remove();
    return;
  }
  if (!badge) {
    badge = target.ownerDocument.createElement("span");
    badge.className = "wt-count";
  }
  badge.textContent = count;
  if (badge.previousSibling !== target) {
    target.after(badge);
  }
}

function markUnread(row, info) {
  const props = row.dataset.properties.split(" ");
  if (info.unread && !props.includes("unread")) {
    row.dataset.properties = props
      .filter(p => p != "read")
      .concat("unread")
      .join(" ");
  }
}

function decorateCard(w, row) {
  const info = rowInfo(w, row);
  if (!info) {
    row.querySelector(".wt-count")?.remove();
    return;
  }
  row.senderLine.textContent = info.names;
  row.senderLine.title = info.names;
  if (info.subject) {
    row.subjectLine.textContent = info.subject;
  }
  setCount(row.senderLine, info.count);
  markUnread(row, info);
}

const PEOPLE_COLUMNS = new Set(["correspondentCol", "senderCol", "recipientCol"]);

function decorateTableRow(w, row) {
  const info = rowInfo(w, row);
  if (!info) {
    row.querySelector(".wt-count")?.remove();
    return;
  }
  const subject = row.querySelector(".subjectcol-column .subject-line span");
  if (subject && info.subject) {
    subject.textContent = info.subject;
  }
  let counted = false;
  for (const column of w.threadPane.columns) {
    if (column.hidden || !PEOPLE_COLUMNS.has(column.id)) {
      continue;
    }
    const cell = row.querySelector(`.${column.id.toLowerCase()}-column`);
    if (cell) {
      const names = w.document.createElement("span");
      names.textContent = info.names;
      cell.replaceChildren(names);
      cell.title = info.names;
      setCount(names, info.count);
      counted = true;
    }
  }
  if (!counted && subject) {
    setCount(subject, info.count);
  }
  markUnread(row, info);
}

function patchRows(w, state) {
  for (const [tag, decorate] of [
    ["thread-card", decorateCard],
    ["thread-row", decorateTableRow],
  ]) {
    const cls = w.customElements.get(tag);
    if (!cls) {
      continue;
    }
    patch(state, cls.prototype, "fillRow", orig => {
      return function () {
        orig.call(this);
        try {
          decorate(w, this);
        } catch (e) {
          console.error(e);
        }
      };
    });
  }
  state.undo.push(() => w.threadTree?.invalidate());
}

/* ---------------------------------------------------------------------------
 * Commands on a list row act on the whole conversation, as in Gmail: Delete
 * trashes every message of it; Archive, Move and Mark read take its messages
 * in the list's folders (archiving from the Inbox leaves replies in Sent).
 */

const CONVERSATION_COMMANDS = new Set([
  "cmd_archive",
  "cmd_deleteMessage",
  "cmd_shiftDeleteMessage",
  "cmd_moveMessage",
  "cmd_copyMessage",
  "cmd_markAsRead",
  "cmd_markThreadAsRead",
  "cmd_toggleRead",
]);

/** Messages of the selected conversations in the list's folders it doesn't show. */
function hiddenSiblings(w) {
  const ctx = w.gViewWrapper?.search?._wtCtx;
  if (!ctx) {
    return [];
  }
  const selected = w.gDBView.getSelectedMsgHdrs();
  const seen = new Set(selected.map(h => h.folder.URI + "#" + h.messageKey));
  const roots = new Set();
  for (const h of selected) {
    const rec = index.recs.get(h.messageId);
    if (rec) {
      roots.add(index.find(rec));
    }
  }
  const siblings = [];
  for (const root of roots) {
    for (const m of root.members) {
      for (const l of [...m.locs]) {
        const k = l.uri + "#" + l.key;
        if (l.hidden || !ctx.folders.has(l.uri) || seen.has(k)) {
          continue;
        }
        seen.add(k);
        const h = hdrFor(m, l);
        if (h) {
          siblings.push(h);
        }
      }
    }
  }
  return siblings;
}

function byFolder(hdrs) {
  const map = new Map();
  for (const h of hdrs) {
    const list = map.get(h.folder) ?? [];
    list.push(h);
    map.set(h.folder, list);
  }
  return map;
}

function markRead(hdrs) {
  for (const [folder, list] of byFolder(hdrs.filter(h => !h.isRead))) {
    folder.markMessagesRead(list, true);
  }
}

const keyOfHdr = hdr => hdr.folder.URI + "#" + hdr.messageKey;

function copiesOf(rec) {
  const hdrs = [];
  for (const loc of [...rec.locs]) {
    const hdr = !loc.hidden && hdrFor(rec, loc);
    if (hdr) {
      hdrs.push(hdr);
    }
  }
  return hdrs;
}

/** Does deleting in this folder move the message to the Trash? */
function movesToTrash(folder) {
  if (folder.server.type == "imap") {
    return (
      folder.server.QueryInterface(Ci.nsIImapIncomingServer).deleteModel ==
      Ci.nsMsgImapDeleteModels.MoveToTrash
    );
  }
  return true;
}

/**
 * Message-IDs (of `ids`) the Trash of the folder's account holds. An IMAP
 * Trash is synchronised (a few times: the server moves in its own time) until
 * it shows them.
 */
async function inTrash(folder, ids) {
  const trash = folder.server.rootFolder.getFolderWithFlags(FF.Trash);
  if (!trash) {
    return new Set();
  }
  const held = () =>
    new Set(
      ids.filter(id => {
        try {
          return !!trash.msgDatabase.getMsgHdrForMessageID(id);
        } catch (e) {
          return false;
        }
      })
    );
  let found = held();
  for (
    let attempt = 1;
    found.size < ids.length && trash.server.type == "imap" && attempt <= 5;
    attempt++
  ) {
    await new Promise(resolve => setTimeout(resolve, attempt * 1000));
    await Promise.race([
      MailUtils.updateFolderAsync(trash).catch(console.warn),
      new Promise(resolve => setTimeout(resolve, 30000)),
    ]);
    found = held();
  }
  return found;
}

/**
 * Run `start(listener)` per folder of `hdrs`; resolves when each folder's copy
 * service listener reports back (or after a minute).
 *
 * @returns {Promise<boolean[]>} Success per folder.
 */
function perFolder(hdrs, start) {
  return Promise.all(
    [...byFolder(hdrs)].map(
      ([folder, list]) =>
        new Promise(resolve => {
          const timer = setTimeout(() => resolve(false), 60000);
          const done = ok => {
            clearTimeout(timer);
            resolve(ok);
          };
          const listener = {
            QueryInterface: ChromeUtils.generateQI(["nsIMsgCopyServiceListener"]),
            onStartCopy() {},
            onProgress() {},
            setMessageKey() {},
            getMessageId() {
              return "";
            },
            onStopCopy(status) {
              done(Components.isSuccessCode(status));
            },
          };
          try {
            if (start(folder, list, listener) === false) {
              // This operation doesn't report back.
              done(true);
            }
          } catch (e) {
            console.error(e);
            done(false);
          }
        })
    )
  );
}

function copyByFolder(hdrs, dest, isMove, msgWindow) {
  return perFolder(hdrs, (folder, list, listener) => {
    MailServices.copy.copyMessages(folder, list, dest, isMove, listener, msgWindow, true);
  });
}

function deleteByFolder(hdrs, permanent, msgWindow) {
  return perFolder(hdrs, (folder, list, listener) => {
    folder.deleteMessages(list, msgWindow, permanent, false, listener, !permanent);
    // Deleting for good, or on an IMAP server that doesn't move to the
    // Trash, bypasses the copy service: no callback.
    return !permanent && movesToTrash(folder);
  });
}

/**
 * Delete messages the way Gmail does: each message ends up in the Trash once,
 * however many folders hold a copy (Gmail labels over IMAP, filters copying
 * mail). Per account one copy moves to the Trash — the best ranked one; the
 * other copies are removed only after that account's Trash holds the message,
 * so a failed or partial move never loses anything.
 *
 * @param {Rec[]} recs
 * @param {object} options
 * @param {boolean} options.permanent - Shift+Delete: delete every copy for good.
 * @param {Function} options.rank - hdr => number; the highest moves to Trash.
 * @param {nsIMsgWindow} options.msgWindow - For undo.
 */
async function deleteMessages(recs, { permanent, rank, msgWindow }) {
  const direct = [];
  const primaries = [];
  const extras = [];
  for (const rec of recs) {
    const byServer = new Map();
    for (const hdr of copiesOf(rec)) {
      const list = byServer.get(hdr.folder.server.key) ?? [];
      list.push(hdr);
      byServer.set(hdr.folder.server.key, list);
    }
    for (const hdrs of byServer.values()) {
      if (permanent || !movesToTrash(hdrs[0].folder)) {
        direct.push(...hdrs);
        continue;
      }
      hdrs.sort((a, b) => rank(b) - rank(a));
      primaries.push(hdrs[0]);
      extras.push(...hdrs.slice(1).map(hdr => ({ hdr, id: rec.id })));
    }
  }
  if (direct.length) {
    await deleteByFolder(direct, permanent, msgWindow);
  }
  if (primaries.length) {
    await deleteByFolder(primaries, false, msgWindow);
  }
  if (!extras.length) {
    return;
  }
  const safe = [];
  const byServer = Map.groupBy(extras, e => e.hdr.folder.server);
  for (const [, list] of byServer) {
    const found = await inTrash(
      list[0].hdr.folder,
      list.map(e => e.id)
    );
    safe.push(...list.filter(e => found.has(e.id)));
  }
  if (safe.length < extras.length) {
    console.warn(
      `Thwunderthreads: kept ${extras.length - safe.length} copies whose message isn't in the Trash yet`
    );
  }
  if (safe.length) {
    await deleteByFolder(
      safe.map(e => e.hdr),
      true,
      msgWindow
    );
  }
}

/** The records of the conversations of the selected rows. */
function selectedConversations(w) {
  const roots = new Set();
  for (const h of w.gDBView.getSelectedMsgHdrs()) {
    const rec = index.recs.get(h.messageId);
    if (rec) {
      roots.add(index.find(rec));
    }
  }
  return [...roots].flatMap(root => root.members);
}

/** Delete one message (all its copies) from the conversation pane. */
function deleteOne(w, hdr, permanent) {
  const rec = index.recs.get(hdr.messageId);
  if (!rec) {
    return;
  }
  const shown = keyOfHdr(hdr);
  deleteMessages([rec], {
    permanent,
    rank: h => (keyOfHdr(h) == shown ? 1 : 0),
    msgWindow: w.top.msgWindow,
  }).catch(console.error);
}

/** @returns {boolean} true if the command was fully handled. */
function conversationCommand(w, command, args) {
  const msgWindow = w.top.msgWindow;
  if (command == "cmd_deleteMessage" || command == "cmd_shiftDeleteMessage") {
    // Like Gmail, trashing a conversation trashes all of it: replies in Sent,
    // archived messages, every copy.
    const permanent = command == "cmd_shiftDeleteMessage";
    if (!MailUtils.confirmDelete(permanent, w.gDBView, w.gFolder)) {
      return true;
    }
    const selected = new Set(w.gDBView.getSelectedMsgHdrs().map(keyOfHdr));
    const listed = w.gViewWrapper.search._wtCtx.folders;
    const recs = selectedConversations(w);
    w.dbViewWrapperListener.threadPaneCommandUpdater.updateNextMessageAfterDelete();
    deleteMessages(recs, {
      permanent,
      rank: h => (selected.has(keyOfHdr(h)) ? 2 : listed.has(h.folder.URI) ? 1 : 0),
      msgWindow,
    }).catch(console.error);
    return true;
  }
  // Archive, move and read state stay within the list's folders.
  const siblings = hiddenSiblings(w);
  if (!siblings.length) {
    return false;
  }
  switch (command) {
    case "cmd_archive": {
      w.dbViewWrapperListener.threadPaneCommandUpdater.updateNextMessageAfterDelete();
      const archiver = new MessageArchiver();
      archiver.msgWindow = msgWindow;
      archiver.archiveMessages([
        ...w.gDBView.getSelectedMsgHdrs(),
        ...siblings,
      ]);
      return true;
    }
    case "cmd_moveMessage":
    case "cmd_copyMessage": {
      const [dest] = args;
      if (!dest) {
        return false;
      }
      // One copy-service call per source folder, so one undo step each.
      const isMove = command == "cmd_moveMessage";
      if (isMove) {
        w.dbViewWrapperListener.threadPaneCommandUpdater.updateNextMessageAfterDelete();
      }
      // What Thunderbird's own command records for "Move/Copy to … Again".
      Services.prefs.setStringPref("mail.last_msg_movecopy_target_uri", dest.URI);
      Services.prefs.setBoolPref("mail.last_msg_movecopy_was_move", isMove);
      copyByFolder(
        [...w.gDBView.getSelectedMsgHdrs(), ...siblings],
        dest,
        isMove,
        msgWindow
      ).catch(console.error);
      return true;
    }
    case "cmd_toggleRead":
      if (w.gDBView.hdrForFirstSelectedMessage?.isRead) {
        return false;
      }
    // Falls through: toggling an unread conversation reads all of it.
    case "cmd_markAsRead":
    case "cmd_markThreadAsRead":
      markRead(siblings);
      return false;
  }
  return false;
}

function patchCommands(w, state) {
  patch(state, w.commandController, "doCommand", orig => {
    return function (command, ...args) {
      if (
        CONVERSATION_COMMANDS.has(command) &&
        isGmailView(w.gViewWrapper) &&
        this.isCommandEnabled(command)
      ) {
        try {
          if (conversationCommand(w, command, args)) {
            return undefined;
          }
        } catch (e) {
          console.error(e);
        }
      }
      return orig.call(this, command, ...args);
    };
  });

  // Dragging a row to a folder moves its conversation along. Thunderbird
  // copies a drop from a single source folder, so add same-folder siblings.
  patch(state, w.threadPane, "_onDragStart", orig => {
    return function (event) {
      orig.call(this, event);
      if (event.defaultPrevented || !isGmailView(w.gViewWrapper)) {
        return;
      }
      const dt = event.dataTransfer;
      const first = dt.mozItemCount
        ? w.top.messenger.msgHdrFromURI(
            dt.mozGetDataAt("text/x-moz-message", 0)
          )
        : null;
      let n = dt.mozItemCount;
      for (const h of hiddenSiblings(w)) {
        if (first && h.folder == first.folder) {
          dt.mozSetDataAt("text/x-moz-message", h.folder.getUriForMsg(h), n++);
        }
      }
    };
  });
}

/* ---------------------------------------------------------------------------
 * Message pane: the conversation instead of the single message.
 */

function wantsConversation(uri) {
  if (!index.ready || stopped) {
    return false;
  }
  try {
    const hdr = MailServices.messageServiceFromURI(uri).messageURIToMsgHdr(uri);
    return (
      !!hdr?.messageId && indexable(hdr.folder) && !hiddenFolder(hdr.folder)
    );
  } catch (e) {
    return false;
  }
}

/**
 * The conversation of `selected`: one header per message, oldest first.
 * Copies are collapsed, preferring the selected one, then one in the list.
 */
function conversationHeaders(root, selected, listFolders) {
  const hdrs = [];
  for (const m of root.members) {
    let hdr = null;
    if (m.id === selected.messageId) {
      hdr = selected;
    } else {
      const locs = m.locs
        .filter(l => !l.hidden)
        .sort((a, b) => listFolders.has(b.uri) - listFolders.has(a.uri));
      for (const l of locs) {
        hdr = hdrFor(m, l);
        if (hdr) {
          break;
        }
      }
    }
    if (hdr) {
      hdrs.push(hdr);
    }
  }
  return hdrs.sort(
    (a, b) => a.date - b.date || (a.messageId < b.messageId ? -1 : 1)
  );
}

function renderConversation(w, state, update) {
  const cw = state.browser.contentWindow;
  if (!cw?.wtShow || cw.document.readyState != "complete") {
    if (!state.waitingForLoad) {
      state.waitingForLoad = true;
      state.browser.addEventListener(
        "load",
        () => {
          state.waitingForLoad = false;
          if (state.shown) {
            renderConversation(w, state, false);
          }
        },
        { capture: true, once: true }
      );
    }
    return;
  }
  const rec = state.shown;
  let selected = state.selected;
  if (selected && !hdrFor(rec, { uri: selected.folder.URI, key: selected.messageKey })) {
    selected = null;
  }
  const listFolders = w.gViewWrapper?.search?._wtCtx?.folders ?? new Set();
  const hdrs = conversationHeaders(
    index.find(rec),
    selected ?? { messageId: null },
    listFolders
  );
  cw.wtShow(hdrs, {
    host: w,
    update,
    selected,
    deleteMessage: (hdr, permanent) => deleteOne(w, hdr, permanent),
  });
}

function patchMessagePane(w, state) {
  const pane = w.messagePane;
  const browser = w.document.createXULElement("browser");
  browser.id = "thwunderthreadsBrowser";
  browser.setAttribute("hidden", "hidden");
  browser.setAttribute("src", "chrome://thwunderthreads/content/conversation.xhtml");
  browser.style.flex = "1";
  pane.append(browser);
  state.browser = browser;
  state.undo.push(() => browser.remove());

  const hide = () => {
    state.shown = null;
    state.selected = null;
    if (!browser.hidden) {
      browser.hidden = true;
      browser.contentWindow?.wtClear?.();
    }
  };
  state.undo.push(hide);

  patch(state, pane, "displayMessage", orig => {
    return function (uri) {
      if (!uri && state.refreshing) {
        return orig.call(this);
      }
      clearTimeout(state.refreshing);
      state.refreshing = null;
      if (
        uri &&
        !this.classList.contains("collapsed-by-splitter") &&
        wantsConversation(uri)
      ) {
        // Let Thunderbird clear and hide its own browsers first.
        orig.call(this);
        this.clearWebPage();
        const hdr = MailServices.messageServiceFromURI(uri).messageURIToMsgHdr(uri);
        const rec = index.recs.get(hdr.messageId) ?? index.addHdr(hdr);
        const same =
          state.shown && index.find(state.shown) === index.find(rec);
        state.shown = rec;
        state.selected = hdr;
        browser.hidden = false;
        renderConversation(w, state, same);
        return undefined;
      }
      hide();
      return orig.call(this, uri);
    };
  });
  for (const name of ["displayMessages", "clearAll", "displayWebPage"]) {
    patch(state, pane, name, orig => {
      return function (...args) {
        hide();
        return orig.apply(this, args);
      };
    });
  }
}

/* ---------------------------------------------------------------------------
 * Listeners.
 */

const mfnListener = {
  msgAdded(hdr) {
    maybeAdd(hdr);
  },
  msgsClassified(hdrs) {
    for (const h of hdrs) {
      maybeAdd(h);
    }
  },
  msgsDeleted(hdrs) {
    for (const h of hdrs) {
      index.removeHdr(h);
    }
  },
  msgsMoveCopyCompleted(isMove, srcHdrs, destFolder, destHdrs) {
    if (isMove) {
      for (const h of srcHdrs) {
        index.removeHdr(h);
      }
    }
    for (const h of destHdrs) {
      maybeAdd(h);
    }
  },
  msgKeyChanged(oldKey, hdr) {
    if (!index.rekey(hdr.messageId, hdr.folder.URI, oldKey, hdr.messageKey)) {
      maybeAdd(hdr);
    }
  },
  folderDeleted(folder) {
    index.forgetTree(folder.URI);
  },
  folderMoveCopyCompleted(isMove, srcFolder, destFolder) {
    if (isMove) {
      index.forgetTree(srcFolder.URI);
    }
    index.scanTree(destFolder);
  },
  folderRenamed(oldFolder, newFolder) {
    index.forgetTree(oldFolder.URI);
    index.scanTree(newFolder);
  },
  folderCompactFinish(folder) {
    index.forgetTree(folder.URI);
    index.scan(folder);
  },
};

const folderListener = {
  onFolderEvent(folder, event) {
    if (event != "FolderLoaded") {
      return;
    }
    const waiting = index.loading.get(folder.URI);
    if (waiting) {
      waiting();
    } else if (!index.scanned.has(folder.URI)) {
      index.scan(folder);
    }
  },
  onFolderPropertyFlagChanged(item, property) {
    // A message read elsewhere in a conversation changes the row's state.
    if (property == "Status") {
      for (const w of hooked.keys()) {
        if (w.gViewWrapper?.search?._wtCtx) {
          w.threadTree?.invalidate();
        }
      }
    }
  },
};

// Lets the integration tests look inside: notify "thwunderthreads:debug"
// with a JS object as subject and read .index / .hooked from it.
const debugObserver = {
  observe(subject) {
    Object.assign(subject.wrappedJSObject, { index, hooked, contexts });
  },
};

/* ---------------------------------------------------------------------------
 * Lifecycle.
 */

this.thwunderthreads = class extends ExtensionCommon.ExtensionAPI {
  onStartup() {
    const aomStartup = Cc[
      "@mozilla.org/addons/addon-manager-startup;1"
    ].getService(Ci.amIAddonManagerStartup);
    const manifestURI = Services.io.newURI(
      "manifest.json",
      null,
      this.extension.rootURI
    );
    this.chromeHandle = aomStartup.registerChrome(manifestURI, [
      ["content", "thwunderthreads", "content/"],
    ]);
    core = ChromeUtils.importESModule(
      "chrome://thwunderthreads/content/core.mjs?" + Date.now()
    );
    index = createIndex();

    registerTerm(isHead);
    patchModules();
    const nfs = Ci.nsIMsgFolderNotificationService;
    MailServices.mfn.addListener(
      mfnListener,
      nfs.msgAdded |
        nfs.msgsClassified |
        nfs.msgsDeleted |
        nfs.msgsMoveCopyCompleted |
        nfs.msgKeyChanged |
        nfs.folderDeleted |
        nfs.folderMoveCopyCompleted |
        nfs.folderRenamed |
        nfs.folderCompactFinish
    );
    MailServices.mailSession.AddFolderListener(
      folderListener,
      Ci.nsIFolderListener.event | Ci.nsIFolderListener.propertyFlagChanged
    );
    Services.obs.addObserver(debugObserver, "thwunderthreads:debug");
    ExtensionSupport.registerWindowListener(ADDON_ID, {
      chromeURLs: ["chrome://messenger/content/messenger.xhtml"],
      onLoadWindow: hookMessenger,
      onUnloadWindow: unhookMessenger,
    });
  }

  onShutdown(isAppShutdown) {
    stopped = true;
    if (isAppShutdown) {
      return;
    }
    registerTerm(null);
    Services.obs.removeObserver(debugObserver, "thwunderthreads:debug");
    MailServices.mfn.removeListener(mfnListener);
    MailServices.mailSession.RemoveFolderListener(folderListener);
    ExtensionSupport.unregisterWindowListener(ADDON_ID);
    for (const win of Services.wm.getEnumerator("mail:3pane")) {
      unhookMessenger(win);
    }
    unpatchModules();
    for (const w of [...hooked.keys()]) {
      unhook3Pane(w);
    }
    this.chromeHandle?.destruct();
    Services.obs.notifyObservers(null, "startupcache-invalidate");
  }

  getAPI() {
    return { thwunderthreads: {} };
  }
};
