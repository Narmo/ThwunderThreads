/* ThwunderThreads — the conversation in the message pane.
 *
 * A chrome document inside about:3pane, filled by api.js through wtShow().
 * Collapsed messages are one-line summaries; every expanded message is a real
 * about:message, so Thunderbird itself renders it (remote content blocking,
 * attachments, encryption) and its buttons act on that message only. */

"use strict";

/* global Services, ChromeUtils, Ci, Cr */

const { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const { DBViewWrapper, IDBViewWrapperListener } = ChromeUtils.importESModule(
  "resource:///modules/DBViewWrapper.sys.mjs"
);
const { MsgHdrToMimeMessage } = ChromeUtils.importESModule(
  "resource:///modules/gloda/MimeMessage.sys.mjs"
);
const { mimeMsgToContentSnippetAndMeta } = ChromeUtils.importESModule(
  "resource:///modules/gloda/GlodaContent.sys.mjs"
);
const { MailUtils } = ChromeUtils.importESModule(
  "resource:///modules/MailUtils.sys.mjs"
);

// about:message closes its parent once its message is deleted (that is how a
// standalone message window goes away). Here the parent is this pane.
window.close = () => {};

/** The about:3pane window this pane lives in. */
let host = null;
/** api.js: (hdr, permanent) => delete the message with all its copies. */
let deleteMessage = null;
// about:message takes its tab from its parent; it decides whether the message
// is visible and so whether it may be marked as read.
Object.defineProperty(window, "tabOrWindow", {
  configurable: true,
  get: () => host?.tabOrWindow,
});

const locale = Services.locale.appLocalesAsBCP47;
const STRINGS = {
  en: {
    me: "me",
    older: n => (n == 1 ? "1 older message" : `${n} older messages`),
    expandAll: "Expand all",
    collapseAll: "Collapse all",
    noSubject: "(no subject)",
  },
  ru: {
    me: "я",
    older: n =>
      `${n} ${
        {
          one: "более раннее сообщение",
          few: "более ранних сообщения",
          many: "более ранних сообщений",
        }[new Intl.PluralRules("ru").select(n)] ?? "более ранних сообщения"
      }`,
    expandAll: "Развернуть все",
    collapseAll: "Свернуть все",
    noSubject: "(без темы)",
  },
};
const strings = STRINGS[locale[0]?.split("-")[0]] ?? STRINGS.en;

// Services.intl follows the regional settings of the OS, like Thunderbird.
const timeFormat = new Services.intl.DateTimeFormat(undefined, {
  timeStyle: "short",
});
const dayFormat = new Services.intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const yearFormat = new Services.intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
});
const fullFormat = new Services.intl.DateTimeFormat(undefined, {
  dateStyle: "full",
  timeStyle: "short",
});

/** messageId -> card */
const cards = new Map();
/** messageIds, oldest first. */
let order = [];
/** The "N older messages" fold has been opened. */
let olderOpen = false;
let markReadTimer = null;
/** More unread messages than this stay folded; they still get read. */
const MAX_OPEN_UNREAD = 10;
const snippets = new Map();

const $ = id => document.getElementById(id);
const keyOf = hdr => hdr.folder.URI + "#" + hdr.messageKey;

function shortDate(date) {
  const now = new Date();
  if (date.toDateString() == now.toDateString()) {
    return timeFormat.format(date);
  }
  return date.getFullYear() == now.getFullYear()
    ? dayFormat.format(date)
    : yearFormat.format(date);
}

function author(hdr) {
  const [first] = MailServices.headerParser.parseDecodedHeader(
    hdr.mime2DecodedAuthor
  );
  const email = first?.email || "";
  return { name: first?.name || email || hdr.mime2DecodedAuthor, email };
}

function avatar(person) {
  const span = document.createElement("span");
  span.className = "avatar";
  const photo = person.email
    ? MailServices.ab.cardForEmailAddress(person.email)?.photoURL
    : null;
  if (photo) {
    const img = document.createElement("img");
    img.src = photo;
    img.alt = "";
    span.append(img);
    return span;
  }
  span.textContent = (person.name.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();
  let hash = 0;
  for (const c of person.email || person.name) {
    hash = (hash * 31 + c.charCodeAt(0)) | 0;
  }
  span.style.setProperty("--avatar-hue", Math.abs(hash) % 360);
  return span;
}

/* ---------------------------------------------------------------------------
 * Cards.
 */

function makeCard(hdr) {
  const li = document.createElement("li");
  li.className = "message";
  const summary = document.createElement("div");
  summary.className = "summary";
  summary.tabIndex = 0;
  summary.setAttribute("role", "button");
  li.append(summary);
  const card = { hdr, li, summary, expanded: false, browser: null };
  summary.addEventListener("click", () => toggle(card));
  summary.addEventListener("keydown", event => {
    if (event.key == "Enter" || event.key == " ") {
      event.preventDefault();
      toggle(card);
    }
  });
  fillSummary(card);
  return card;
}

function fillSummary(card) {
  const { hdr, li, summary } = card;
  const person = author(hdr);
  const date = new Date(hdr.date / 1000);

  const from = document.createElement("span");
  from.className = "from";
  from.textContent = person.name;
  from.title = person.email;

  const snippet = document.createElement("span");
  snippet.className = "snippet";
  snippet.textContent = snippets.get(hdr.messageId) ?? "";
  card.snippet = snippet;

  const icons = document.createElement("span");
  icons.className = "icons";
  if (hdr.flags & Ci.nsMsgMessageFlags.Attachment) {
    icons.append(Object.assign(document.createElement("span"), { className: "icon attachment" }));
  }
  if (hdr.isFlagged) {
    icons.append(Object.assign(document.createElement("span"), { className: "icon starred" }));
  }

  const time = document.createElement("time");
  time.className = "date";
  time.dateTime = date.toISOString();
  time.textContent = shortDate(date);
  time.title = fullFormat.format(date);

  const folder = document.createElement("span");
  folder.className = "folder";
  const listed = host?.gViewWrapper?._underlyingFolders ?? [];
  if (!listed.some(f => f.URI == hdr.folder.URI)) {
    folder.textContent = hdr.folder.localizedName;
    folder.title = `${hdr.folder.server.prettyName} › ${hdr.folder.localizedName}`;
  }

  summary.replaceChildren(avatar(person), from, folder, snippet, icons, time);
  li.classList.toggle("unread", !hdr.isRead);
  li.dataset.id = hdr.messageId;
  if (!snippets.has(hdr.messageId)) {
    fetchSnippet(hdr);
  }
}

function fetchSnippet(hdr) {
  const id = hdr.messageId;
  snippets.set(id, "");
  try {
    MsgHdrToMimeMessage(
      hdr,
      null,
      (msgHdr, mime) => {
        if (!mime) {
          return;
        }
        const [text] = mimeMsgToContentSnippetAndMeta(mime, msgHdr.folder, 300);
        snippets.set(id, text);
        const card = cards.get(id);
        if (card) {
          card.snippet.textContent = text;
        }
      },
      false,
      { saneBodySize: true }
    );
  } catch (e) {
    // An IMAP message without a local copy while offline: no snippet.
  }
}

function toggle(card) {
  if (card.expanded) {
    collapse(card);
  } else {
    expand(card);
  }
  layout();
}

function collapse(card) {
  card.expanded = false;
  card.li.classList.remove("expanded");
  fillSummary(card);
}

function expand(card) {
  card.expanded = true;
  card.li.classList.add("expanded");
  if (card.browser) {
    return;
  }
  const browser = document.createXULElement("browser");
  browser.className = "message-browser";
  browser.setAttribute("src", "about:message");
  browser.setAttribute("disableglobalhistory", "true");
  card.browser = browser;
  const onLoad = event => {
    // The message inside about:message loads too; wait for about:message.
    if (event.target == browser.contentDocument) {
      browser.removeEventListener("load", onLoad, true);
      display(card);
    }
  };
  browser.addEventListener("load", onLoad, true);
  browser.addEventListener("MsgLoaded", () => onMessageLoaded(card), true);
  card.li.append(browser);
}

/** Show card.hdr in the card's about:message, on a view of that message only. */
function display(card) {
  const aboutMessage = card.browser.contentWindow;
  const { hdr } = card;
  const source = aboutMessage.dbViewWrapperListener;
  const listener = Object.assign(new IDBViewWrapperListener(), {
    messenger: source.messenger,
    msgWindow: source.msgWindow,
    threadPaneCommandUpdater: source.threadPaneCommandUpdater,
  });
  const viewWrapper = new DBViewWrapper(listener);
  viewWrapper.openSearchView();
  const view = viewWrapper.dbView.QueryInterface(Ci.nsIMsgSearchNotify);
  view.onNewSearch();
  view.onSearchHit(hdr, hdr.folder);
  view.onSearchDone(Cr.NS_OK);
  // about:message clones the wrapper, so it ends up with its own copy.
  aboutMessage.displayMessage(hdr.folder.getUriForMsg(hdr), viewWrapper);
  viewWrapper.close();
  card.shownKey = keyOf(hdr);
  hookDelete(card);
}

/**
 * Delete in a message (button, key, menu) removes that message from the
 * conversation: all its copies, into the Trash once, like a conversation.
 */
function hookDelete(card) {
  const aboutMessage = card.browser.contentWindow;
  const controller = aboutMessage.commandController;
  if (controller.wtHooked) {
    return;
  }
  controller.wtHooked = true;
  const doCommand = controller.doCommand;
  controller.doCommand = function (command, ...args) {
    if (
      (command == "cmd_deleteMessage" || command == "cmd_shiftDeleteMessage") &&
      deleteMessage &&
      this.isCommandEnabled(command)
    ) {
      const permanent = command == "cmd_shiftDeleteMessage";
      if (MailUtils.confirmDelete(permanent, aboutMessage.gDBView, card.hdr.folder)) {
        deleteMessage(card.hdr, permanent);
      }
      return undefined;
    }
    return doCommand.call(this, command, ...args);
  };
}

function onMessageLoaded(card) {
  const doc = card.browser.contentDocument;
  doc.getElementById("singleMessage")?.classList.add("in-conversation");
  const header = doc.getElementById("messageHeader");
  if (header && !header.wtHooked) {
    header.wtHooked = true;
    // Like Gmail, clicking the header of an open message folds it.
    header.addEventListener("click", event => {
      const interactive = event.target.closest(
        "button, a, input, select, textarea, label, li, [tabindex], [role='button'], toolbarbutton"
      );
      if (event.button == 0 && (!interactive || interactive == header)) {
        collapse(card);
        layout();
      }
    });
  }
  observeSize(card);
  fit(card);
}

/** Size the about:message to its content: the conversation scrolls, not it. */
function fit(card) {
  const doc = card.browser?.contentDocument;
  const pane = doc?.getElementById("messagepane");
  const inner = pane?.contentDocument?.documentElement;
  if (!inner || !card.expanded) {
    return;
  }
  const chrome =
    doc.documentElement.getBoundingClientRect().height -
    pane.getBoundingClientRect().height;
  const scrollbar = pane.contentWindow.scrollMaxX > 0 ? 18 : 0;
  const height = Math.ceil(
    chrome + inner.getBoundingClientRect().height + scrollbar
  );
  if (Math.abs((parseFloat(card.browser.style.height) || 0) - height) > 1) {
    card.browser.style.height = `${height}px`;
  }
}

function observeSize(card) {
  card.observers?.forEach(o => o.disconnect());
  const doc = card.browser.contentDocument;
  const pane = doc.getElementById("messagepane");
  const inner = pane?.contentDocument;
  card.observers = [];
  for (const [win, elements] of [
    [inner?.defaultView, [inner?.documentElement]],
    [
      doc.defaultView,
      ["messageHeader", "mail-notification-top", "attachmentView"].map(id =>
        doc.getElementById(id)
      ),
    ],
  ]) {
    if (!win) {
      continue;
    }
    const observer = new win.ResizeObserver(() => fit(card));
    for (const element of elements) {
      if (element) {
        observer.observe(element);
      }
    }
    card.observers.push(observer);
  }
}

function unload(card) {
  card.observers?.forEach(o => o.disconnect());
  try {
    card.browser?.contentWindow?.displayMessage?.();
  } catch (e) {}
  card.browser?.remove();
  card.li.remove();
}

/* ---------------------------------------------------------------------------
 * Layout.
 */

function layout() {
  const list = $("messages");
  // Insert new cards in place. Existing cards never move: moving a <browser>
  // reloads it.
  let next = null;
  for (let i = order.length - 1; i >= 0; i--) {
    const card = cards.get(order[i]);
    if (card.li.parentNode != list) {
      list.insertBefore(card.li, next);
    }
    next = card.li;
  }

  // Like Gmail, fold the read messages before the first open one, keeping
  // the first message and the last two visible.
  let end = order.findIndex(id => cards.get(id).expanded);
  if (end < 0) {
    end = order.length;
  }
  const folded = new Set();
  if (!olderOpen && end - 3 >= 2) {
    for (let i = 1; i < end - 2; i++) {
      folded.add(order[i]);
    }
  }
  for (const [id, card] of cards) {
    card.li.classList.toggle("folded", folded.has(id));
  }
  list.querySelector(".more")?.remove();
  if (folded.size) {
    const more = document.createElement("li");
    more.className = "more";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = strings.older(folded.size);
    button.addEventListener("click", () => {
      olderOpen = true;
      layout();
    });
    more.append(button);
    list.insertBefore(more, cards.get(order[1]).li);
  }

  const anyCollapsed = [...cards.values()].some(c => !c.expanded);
  $("toggleAll").textContent = anyCollapsed
    ? strings.expandAll
    : strings.collapseAll;
  $("toggleAll").hidden = cards.size < 2;
}

function toggleAll() {
  const anyCollapsed = [...cards.values()].some(c => !c.expanded);
  for (const [i, id] of order.entries()) {
    const card = cards.get(id);
    if (anyCollapsed) {
      expand(card);
    } else if (i < order.length - 1) {
      collapse(card);
    }
  }
  olderOpen = anyCollapsed;
  layout();
}

function fillHeader(hdrs) {
  $("subject").textContent =
    hdrs[0]?.mime2DecodedSubject || strings.noSubject;
  const chips = new Map();
  for (const hdr of hdrs) {
    const name = hdr.folder.localizedName;
    const where = `${hdr.folder.server.prettyName} › ${name}`;
    const titles = chips.get(name) ?? new Set();
    titles.add(where);
    chips.set(name, titles);
  }
  $("folders").replaceChildren(
    ...[...chips].map(([name, titles]) => {
      const li = document.createElement("li");
      li.textContent = name;
      li.title = [...titles].join("\n");
      return li;
    })
  );
}

/** Bring the first unread message (or the last one) into view. */
function scrollToFocus() {
  const target =
    order.map(id => cards.get(id)).find(c => !c.hdr.isRead && c.expanded) ??
    cards.get(order.at(-1));
  window.requestAnimationFrame(() => {
    if (target && target != cards.get(order[0])) {
      target.li.scrollIntoView({ block: "start" });
    } else {
      document.body.scrollTop = 0;
    }
  });
}

/* ---------------------------------------------------------------------------
 * Entry points for api.js.
 */

function clear() {
  clearTimeout(markReadTimer);
  markReadTimer = null;
  for (const card of cards.values()) {
    unload(card);
  }
  cards.clear();
  order = [];
  olderOpen = false;
  $("messages").replaceChildren();
}

/**
 * @param {nsIMsgDBHdr[]} hdrs - The conversation, oldest first, one per message.
 * @param {object} options
 * @param {Window} options.host - The about:3pane window.
 * @param {boolean} options.update - Same conversation as before: keep what is
 *   open and only add or drop messages.
 */
window.wtShow = function (hdrs, options) {
  host = options.host;
  deleteMessage = options.deleteMessage;
  const ids = hdrs.map(h => h.messageId);
  const update = options.update && ids.some(id => cards.has(id));
  if (!update) {
    clear();
    $("conversation").hidden = true;
  }
  for (const [id, card] of cards) {
    if (!ids.includes(id)) {
      unload(card);
      cards.delete(id);
    }
  }
  const last = ids.at(-1);
  const openUnread = new Set(
    hdrs
      .filter(h => !h.isRead)
      .slice(-MAX_OPEN_UNREAD)
      .map(h => h.messageId)
  );
  for (const hdr of hdrs) {
    let card = cards.get(hdr.messageId);
    if (card) {
      const moved = keyOf(card.hdr) != keyOf(hdr);
      card.hdr = hdr;
      if (!card.expanded) {
        fillSummary(card);
      } else if (moved && card.shownKey) {
        display(card);
      }
      continue;
    }
    card = makeCard(hdr);
    cards.set(hdr.messageId, card);
    // Gmail opens the unread messages and the latest one.
    if (openUnread.has(hdr.messageId) || hdr.messageId == last) {
      expand(card);
    }
  }
  order = ids;
  layout();
  fillHeader(hdrs);
  $("conversation").hidden = false;
  if (!update) {
    scrollToFocus();
  }
  markConversationRead();
};

/** Read the whole conversation without depending on embedded readers' timers. */
function markConversationRead() {
  // Live updates must not restart the configured delay.
  if (markReadTimer !== null) {
    return;
  }
  const tab = host?.tabOrWindow;
  if (
    !Services.prefs.getBoolPref("mailnews.mark_message_read.auto", true) ||
    !(Window.isInstance(tab) || tab?.selected)
  ) {
    return;
  }
  const delay = Services.prefs.getBoolPref("mailnews.mark_message_read.delay", false)
    ? Services.prefs.getIntPref("mailnews.mark_message_read.delay.interval", 0) * 1000
    : 0;
  markReadTimer = setTimeout(() => {
    markReadTimer = null;
    if (
      !Services.prefs.getBoolPref("mailnews.mark_message_read.auto", true) ||
      !(Window.isInstance(tab) || tab?.selected)
    ) {
      return;
    }
    const unread = [...cards.values()]
      .filter(c => !c.hdr.isRead)
      .map(c => c.hdr);
    for (const [folder, list] of Map.groupBy(unread, h => h.folder)) {
      folder.markMessagesRead(list, true);
    }
    for (const card of cards.values()) {
      card.li.classList.toggle("unread", !card.hdr.isRead);
    }
  }, delay);
}

window.wtClear = function () {
  clear();
  $("conversation").hidden = true;
};

window.addEventListener("load", () => {
  $("toggleAll").addEventListener("click", toggleAll);
});
