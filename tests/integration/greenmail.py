"""GreenMail, a standalone IMAP test server (Java), for the IMAP tests.
The jar is downloaded once from Maven Central and checked against its SHA-1."""

import email
import hashlib
import imaplib
import shutil
import socket
import subprocess
import time
import urllib.request
from pathlib import Path

VERSION = "2.1.14"
URL = f"https://repo1.maven.org/maven2/com/icegreen/greenmail-standalone/{VERSION}/greenmail-standalone-{VERSION}.jar"
SHA1 = "0cb7511420b76f63c6ed437088149dc8f7fc3a08"
USER, PASSWORD = "me", "secret"


def jar(cache_dir):
    """Path of the jar, downloading it if needed; None if unavailable."""
    path = Path(cache_dir) / f"greenmail-standalone-{VERSION}.jar"
    if not path.exists():
        if not shutil.which("java"):
            return None
        try:
            data = urllib.request.urlopen(URL, timeout=120).read()
        except OSError:
            return None
        if hashlib.sha1(data).hexdigest() != SHA1:
            raise RuntimeError("GreenMail download does not match its checksum")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return path


class GreenMail:
    def __init__(self, jar_path, port, log):
        self.port = port
        self.proc = subprocess.Popen(
            ["java", f"-Dgreenmail.imap.port={port}", "-Dgreenmail.imap.hostname=127.0.0.1",
             f"-Dgreenmail.users={USER}:{PASSWORD}", "-jar", str(jar_path)],
            stdout=open(log, "ab"), stderr=subprocess.STDOUT)
        deadline = time.time() + 60
        while True:
            try:
                socket.create_connection(("127.0.0.1", port), timeout=1).close()
                break
            except OSError:
                if time.time() > deadline or self.proc.poll() is not None:
                    self.stop()
                    raise RuntimeError("GreenMail did not start")
                time.sleep(0.3)

    def connect(self):
        imap = imaplib.IMAP4("127.0.0.1", self.port)
        imap.login(USER, PASSWORD)
        return imap

    def seed(self, folders):
        """folders: {name: [message bytes]}; INBOX exists already."""
        imap = self.connect()
        try:
            for name, messages in folders.items():
                if name != "INBOX":
                    imap.create(name)
                for raw in messages:
                    imap.append(name, "(\\Seen)", None, raw.replace(b"\n", b"\r\n"))
        finally:
            imap.logout()

    def contents(self):
        """{folder: [Message-ID]} of the messages not flagged \\Deleted."""
        imap = self.connect()
        out = {}
        try:
            for line in imap.list()[1]:
                name = line.decode().rsplit(' "." ', 1)[-1].strip('"')
                imap.select(f'"{name}"', readonly=True)
                ids = []
                typ, data = imap.uid("SEARCH", None, "UNDELETED")
                uids = data[0].split() if data and data[0] else []
                for uid in uids:
                    typ, msg = imap.uid("FETCH", uid, "(BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])")
                    header = email.message_from_bytes(msg[0][1])
                    ids.append((header["Message-ID"] or "").strip().strip("<>"))
                out[name] = sorted(ids)
        finally:
            imap.logout()
        return out

    def stop(self):
        self.proc.terminate()
        try:
            self.proc.wait(20)
        except subprocess.TimeoutExpired:
            self.proc.kill()
