"""Integration test harness: a real (headless) Thunderbird with the add-on,
driven over Marionette. Every test gets a fresh profile, and after Thunderbird
has quit the mbox files on disk are checked: no message may be lost."""

import base64
import json
import mailbox
import os
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from fixtures import build_messages, write_profile

ROOT = Path(__file__).resolve().parents[2]
THUNDERBIRD = os.environ.get(
    "THUNDERBIRD", "/Applications/Thunderbird.app/Contents/MacOS/thunderbird"
)
ARTIFACTS = Path(os.environ.get("WT_ARTIFACTS", tempfile.gettempdir() + "/thwunderthreads-tests"))
EXPUNGED = 0x0008  # nsMsgMessageFlags.Expunged in X-Mozilla-Status


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Marionette:
    """Just enough of the Marionette protocol (length-prefixed JSON)."""

    def __init__(self, port, timeout=60):
        deadline = time.time() + timeout
        while True:
            try:
                self.sock = socket.create_connection(("127.0.0.1", port), timeout=180)
                break
            except OSError:
                if time.time() > deadline:
                    raise
                time.sleep(0.3)
        self.msg_id = 0
        self._read()
        self.command("WebDriver:NewSession", {"capabilities": {}})
        self.command("Marionette:SetContext", {"value": "chrome"})
        self.command("WebDriver:SetTimeouts", {"script": 300000})

    def _read(self):
        buf = b""
        while b":" not in buf:
            chunk = self.sock.recv(1)
            if not chunk:
                raise ConnectionError("Marionette connection closed")
            buf += chunk
        size, rest = buf.split(b":", 1)
        size = int(size)
        while len(rest) < size:
            chunk = self.sock.recv(size - len(rest))
            if not chunk:
                raise ConnectionError("Marionette connection closed")
            rest += chunk
        return json.loads(rest)

    def command(self, name, params=None):
        self.msg_id += 1
        data = json.dumps([0, self.msg_id, name, params or {}]).encode()
        self.sock.sendall(str(len(data)).encode() + b":" + data)
        while True:
            reply = self._read()
            if reply[1] == self.msg_id:
                if reply[2]:
                    raise RuntimeError(f"{name}: {reply[2].get('message')}\n{reply[2].get('stacktrace', '')[:2000]}")
                return reply[3]

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


# Helpers available to every script run with Thunderbird.js().
PRELUDE = r"""
const tabmail = document.getElementById("tabmail");
const about3 = () => tabmail.currentAbout3Pane;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(check, what = "condition", timeout = 20000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await check();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${what}` + (last instanceof Error ? `: ${last}\n${last.stack}` : ""));
}
function debug() {
  const o = {};
  o.wrappedJSObject = o;
  Services.obs.notifyObservers(o, "thwunderthreads:debug");
  return o;
}
const folder = uri => MailServices.folderLookup.getFolderForURL(uri);
const hdrOf = (uri, id) => folder(uri).msgDatabase.getMsgHdrForMessageID(id);
const uriOf = hdr => hdr.folder.getUriForMsg(hdr);
function state3() {
  return debug().hooked?.get(about3());
}
async function settle() {
  await waitFor(() => {
    const w = about3();
    const st = state3();
    return (
      w.gViewWrapper && !w.gViewWrapper.searching &&
      w.dbViewWrapperListener.allMessagesLoaded &&
      (!st || (!st.refreshTimer && !st.updateTimer))
    );
  }, "the message list to settle");
  await sleep(150);
}
function rows() {
  const v = about3().gDBView;
  const out = [];
  for (let i = 0; i < v.rowCount; i++) {
    const h = v.getMsgHdrAt(i);
    out.push({ id: h.messageId, folder: h.folder.URI, subject: h.mime2DecodedSubject });
  }
  return out;
}
async function openFolder(uri) {
  const w = about3();
  if (uri.includes("smart%20mailboxes")) {
    w.folderPane.activeModes = ["smart", "all"];
    await waitFor(() => folder(uri), "unified folders");
  }
  w.displayFolder(uri);
  await waitFor(() => w.gFolder?.URI == uri, "folder " + uri);
  await settle();
}
function convWindow() {
  return about3().document.getElementById("thwunderthreadsBrowser")?.contentWindow;
}
function cards() {
  const doc = convWindow()?.document;
  if (!doc || about3().document.getElementById("thwunderthreadsBrowser").hidden) return null;
  return [...doc.querySelectorAll("#messages > li.message")].map(li => {
    const b = li.querySelector("browser");
    return {
      id: li.dataset.id,
      expanded: li.classList.contains("expanded"),
      folded: li.classList.contains("folded"),
      unread: li.classList.contains("unread"),
      from: li.querySelector(".from")?.textContent,
      folder: li.querySelector(".folder")?.textContent,
      shown: b?.contentWindow?.gMessage?.messageId ?? null,
      loaded: !!b?.contentWindow?.msgLoaded,
      height: b ? b.getBoundingClientRect().height : 0,
    };
  });
}
async function conversationLoaded() {
  return waitFor(() => {
    const c = cards();
    return c && c.length && c.filter(x => x.expanded).every(x => x.loaded && x.shown == x.id) && c;
  }, "the conversation to load");
}
async function select(id) {
  const w = about3();
  await settle();
  const i = rows().findIndex(r => r.id == id);
  if (i < 0) throw new Error("no row for " + id + " in " + JSON.stringify(rows().map(r => r.id)));
  w.threadTree.selectedIndex = i;
  return conversationLoaded();
}
function mailState() {
  const out = [];
  for (const f of MailServices.accounts.allFolders) {
    if (f.flags & Ci.nsMsgFolderFlags.Virtual) continue;
    let db;
    try { db = f.msgDatabase; } catch (e) { continue; }
    for (const h of db.enumerateMessages()) {
      out.push({ id: h.messageId, folder: f.URI, read: h.isRead, flagged: h.isFlagged });
    }
  }
  return out;
}
async function copyIn(uri, eml) {
  // Deliver a message the way Thunderbird stores downloaded mail.
  const file = Services.dirsvc.get("TmpD", Ci.nsIFile);
  file.append("wt-" + Math.random().toString(36).slice(2) + ".eml");
  await IOUtils.write(file.path, new TextEncoder().encode(eml));
  await new Promise((resolve, reject) => {
    MailServices.copy.copyFileMessage(file, folder(uri), null, false, 0, "", {
      QueryInterface: ChromeUtils.generateQI(["nsIMsgCopyServiceListener"]),
      onStartCopy() {}, onProgress() {}, setMessageKey() {}, getMessageId() { return ""; },
      onStopCopy(status) { status == 0 ? resolve() : reject(new Error("copy failed " + status)); },
    }, null);
  });
  await IOUtils.remove(file.path);
}
"""


class Thunderbird:
    def __init__(self, profile, port, log):
        self.profile, self.port, self.log = profile, port, log
        self.proc = None
        self.client = None

    def start(self):
        # 159 requires the environment opt-in; keep the command-line flag for 158.
        env = dict(os.environ, MOZ_HEADLESS_WIDTH="1400", MOZ_HEADLESS_HEIGHT="900",
                   MOZ_REMOTE_ALLOW_SYSTEM_ACCESS="1")
        with open(self.log, "ab") as log:
            self.proc = subprocess.Popen(
                [THUNDERBIRD, "--headless", "-no-remote", "--marionette",
                 "-remote-allow-system-access", "-profile", str(self.profile)],
                stdout=log, stderr=subprocess.STDOUT, env=env,
            )
        self.client = Marionette(self.port)
        for handle in self.client.command("WebDriver:GetWindowHandles"):
            self.client.command("WebDriver:SwitchToWindow", {"handle": handle})
            kind = self.client.command("WebDriver:ExecuteScript", {
                "script": "return document.documentElement.getAttribute('windowtype')"})["value"]
            if kind == "mail:3pane":
                break

    def js(self, body, timeout=90):
        """Run async JS (with PRELUDE) in the main window; returns its result."""
        script = (
            "const __done = arguments[arguments.length - 1];" + PRELUDE +
            "(async () => {" + body + "})().then(v => __done({ok: v === undefined ? null : v}),"
            " e => __done({error: String(e) + '\\n' + (e && e.stack)}));"
        )
        reply = self.client.command("WebDriver:ExecuteAsyncScript", {
            "script": script, "args": [], "scriptTimeout": timeout * 1000})["value"]
        if reply is None:
            raise AssertionError("JS was interrupted (a dialog?)")
        if "error" in reply:
            raise AssertionError("JS failed: " + reply["error"])
        return reply["ok"]

    def alert(self):
        """Text of an open modal dialog, which gets dismissed; None if none."""
        try:
            text = self.client.command("WebDriver:GetAlertText")["value"]
        except RuntimeError:
            return None
        self.client.command("WebDriver:DismissAlert")
        return text

    def screenshot(self, path):
        data = self.client.command("WebDriver:TakeScreenshot", {"full": False})["value"]
        Path(path).write_bytes(base64.b64decode(data))

    def quit(self):
        if self.client:
            try:
                self.client.command("WebDriver:ExecuteScript", {
                    "script": "setTimeout(() => Services.startup.quit(Ci.nsIAppStartup.eForceQuit), 0); return 1"})
            except Exception:
                pass
            self.client.close()
        if self.proc:
            try:
                self.proc.wait(60)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        # Nothing may keep running on this profile (a re-launched process
        # isn't our child any more).
        subprocess.run(["pkill", "-f", f"profile {self.profile}"], check=False)


def disk_messages(profile):
    """Message-IDs of the messages stored (not deleted) in every mbox file."""
    found = {}
    for path in Path(profile, "Mail").rglob("*"):
        if not path.is_file() or path.suffix in (".msf", ".dat", ".json", ".html") or path.name.startswith("."):
            continue
        with open(path, "rb") as fh:
            if not fh.read(5) == b"From ":
                continue
        box = mailbox.mbox(str(path), create=False)
        try:
            for msg in box:
                status = int((msg.get("X-Mozilla-Status") or "0").strip() or "0", 16)
                if status & EXPUNGED:
                    continue
                mid = (msg.get("Message-ID") or "").strip().strip("<>")
                found.setdefault(mid, []).append(str(path.relative_to(profile)))
        finally:
            box.close()
    return found


class ThunderbirdTestCase(unittest.TestCase):
    """Fresh profile and Thunderbird per test; checks for lost mail after."""

    addon = True
    prefs = None

    def setUp(self):
        # Kept after the run for inspection; recreated by the next run.
        self.profile = ARTIFACTS / "profiles" / self.id().split(".", 1)[-1]
        shutil.rmtree(self.profile, ignore_errors=True)
        self.profile.mkdir(parents=True)
        self.fixture = build_messages()
        self.ids = self.fixture.ids
        port = free_port()
        # WT_XPI=dist/thwunderthreads-x.y.z.xpi tests a built package instead.
        addon = os.path.abspath(os.environ.get("WT_XPI") or ROOT) if self.addon else None
        write_profile(str(self.profile), self.fixture, port, addon=addon, prefs=self.prefs)
        self.initial = disk_messages(self.profile)
        # Messages a test deletes on purpose (shift+delete).
        self.purged = set()
        self.tb = Thunderbird(self.profile, port, self.profile / "thunderbird.log")
        self.addCleanup(self._finish)
        self.tb.start()
        if self.addon:
            self.tb.js("""
              await waitFor(() => debug().index?.ready, "the conversation index", 60000);
              await waitFor(() => state3(), "about:3pane to be hooked");
            """)

    def js(self, body, **kw):
        return self.tb.js(body, **kw)

    def name(self, message_id):
        """Fixture name of a Message-ID."""
        for name, mid in self.ids.items():
            if mid == message_id:
                return name
        return message_id

    def shot(self, label):
        path = ARTIFACTS / f"{self.id().split('.')[-1]}-{label}.png"
        self.tb.screenshot(path)
        return path

    def console_errors(self):
        return self.js(r"""
          return Services.console.getMessageArray()
            .filter(m => m instanceof Ci.nsIScriptError && !(m.flags & Ci.nsIScriptError.warningFlag))
            .map(m => `${m.errorMessage} (${m.sourceName}:${m.lineNumber})`)
            .filter(m => /thwunderthreads|api\.js|core\.mjs|conversation\.js/.test(m));
        """)

    def _finish(self):
        try:
            if self.tb.client:
                errors = self.console_errors()
                self.assertEqual(errors, [], "errors from the add-on in the console")
        finally:
            self.tb.quit()
            # The data safety check: everything on disk at the start is still on
            # disk now, in some folder, unless the test deleted it on purpose.
            after = disk_messages(self.profile)
            lost = {self.name(mid) for mid in self.initial if mid not in after}
            lost -= set(self.purged)
            if lost:
                raise AssertionError(f"messages lost on disk: {sorted(lost)} (profile: {self.profile})")
