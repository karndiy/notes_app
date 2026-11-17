"""
Notes — a macOS Notes–style web app built with Flask + SQLite.
Designed to run on PythonAnywhere (or any WSGI host).
"""
import os
import re
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from functools import wraps
from html import escape
from html.parser import HTMLParser

import click
from flask import (Flask, g, jsonify, redirect, render_template, request,
                   session, url_for, abort)
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INSTANCE_DIR = os.path.join(BASE_DIR, "instance")
os.makedirs(INSTANCE_DIR, exist_ok=True)


def _load_secret_key():
    env = os.environ.get("NOTES_SECRET_KEY")
    if env:
        return env
    path = os.path.join(INSTANCE_DIR, "secret_key")
    if not os.path.exists(path):
        with open(path, "w") as f:
            f.write(secrets.token_hex(32))
    with open(path) as f:
        return f.read().strip()


app = Flask(__name__)
app.config.update(
    SECRET_KEY=_load_secret_key(),
    DATABASE=os.environ.get("NOTES_DB", os.path.join(INSTANCE_DIR, "notes.db")),
    ALLOW_SIGNUP=os.environ.get("NOTES_ALLOW_SIGNUP", "1") == "1",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("NOTES_SECURE_COOKIE", "0") == "1",
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    MAX_CONTENT_LENGTH=4 * 1024 * 1024,
)

TRASH_DAYS = 30

# --------------------------------------------------------------------------
# Database
# --------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    theme TEXT NOT NULL DEFAULT 'auto',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
    title TEXT NOT NULL DEFAULT '',
    snippet TEXT NOT NULL DEFAULT '',
    body_html TEXT NOT NULL DEFAULT '',
    body_text TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_id, deleted_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id);
"""


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(app.config["DATABASE"])
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def _columns(db, table):
    return {r[1] for r in db.execute(f"PRAGMA table_info({table})")}


def init_db():
    """Create the schema. If the database is the old single-user schema
    (notes: id, title, body, folder, pinned, updated_at), keep that table
    intact as `notes_legacy` so it can be imported into a user account."""
    db = sqlite3.connect(app.config["DATABASE"])
    cols = _columns(db, "notes")
    if cols and "user_id" not in cols and "body" in cols:
        if not _columns(db, "notes_legacy"):
            db.execute("ALTER TABLE notes RENAME TO notes_legacy")
            db.commit()
    db.executescript(SCHEMA)
    if "theme" not in _columns(db, "users"):
        db.execute("ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'auto'")
    if "imported_to" not in _columns(db, "notes_legacy") and _columns(db, "notes_legacy"):
        db.execute("ALTER TABLE notes_legacy ADD COLUMN imported_to INTEGER")
    db.commit()
    db.close()


URL_RE = re.compile(r"(https?://[^\s<]+)")


def legacy_text_to_html(title, body):
    """Convert an old plain-text note to the rich-text format (title becomes the Title style)."""
    title = (title or "").strip()
    lines = (body or "").replace("\r\n", "\n").split("\n")
    while lines and not lines[-1].strip():
        lines.pop()
    first = next((ln.strip() for ln in lines if ln.strip()), "")
    if first == title:  # body already starts with the title — don't duplicate it
        idx = next(i for i, ln in enumerate(lines) if ln.strip())
        lines = lines[idx + 1:]
    parts = [f"<h1>{escape(title)}</h1>"] if title else []
    for ln in lines:
        if not ln.strip():
            parts.append("<div><br></div>")
            continue
        safe = escape(ln, quote=False).replace("  ", " &nbsp;")
        safe = URL_RE.sub(lambda m: f'<a href="{m.group(1)}">{m.group(1)}</a>', safe)
        parts.append(f"<div>{safe}</div>")
    return "".join(parts)


def _legacy_ts(value):
    """'2026-09-12 13:04:10.800458' (UTC, SQLite/Python default) -> ISO Z."""
    if not value:
        return now_iso()
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", ""))
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return now_iso()


def import_legacy(db, user_id):
    """Import not-yet-imported rows from notes_legacy into user_id. Returns count."""
    if not _columns(db, "notes_legacy"):
        return 0
    rows = db.execute("SELECT * FROM notes_legacy WHERE imported_to IS NULL ORDER BY id").fetchall()
    folder_ids = {r[1]: r[0] for r in db.execute(
        "SELECT id, name FROM folders WHERE user_id=?", (user_id,))}
    for r in rows:
        name = (r["folder"] or "Notes").strip() or "Notes"
        if name not in folder_ids:
            folder_ids[name] = db.execute(
                "INSERT INTO folders (user_id, name, created_at) VALUES (?,?,?)",
                (user_id, name, now_iso())).lastrowid
        html = sanitize_html(legacy_text_to_html(r["title"], r["body"]))
        title, snippet, text, tags = derive_fields(html)
        ts = _legacy_ts(r["updated_at"])
        db.execute(
            "INSERT INTO notes (user_id, folder_id, title, snippet, body_html, body_text, tags,"
            " pinned, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (user_id, folder_ids[name], title, snippet, html, text, tags,
             1 if r["pinned"] else 0, ts, ts))
        db.execute("UPDATE notes_legacy SET imported_to=? WHERE id=?", (user_id, r["id"]))
    db.commit()
    return len(rows)


@app.cli.command("import-legacy")
@click.argument("username")
def import_legacy_cmd(username):
    """Import notes from the old schema into USERNAME's account."""
    db = get_db()
    row = db.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
    if not row:
        raise click.ClickException(f"No user named {username!r}")
    click.echo(f"Imported {import_legacy(db, row['id'])} legacy notes into {username}.")


@app.cli.command("create-user")
@click.argument("username")
@click.password_option()
def create_user_cmd(username, password):
    """Create a user account (works even when sign-up is disabled)."""
    create_user(username, password)
    click.echo(f"Created {username}.")


init_db()

# --------------------------------------------------------------------------
# HTML sanitizer (allow-list) for note bodies
# --------------------------------------------------------------------------
ALLOWED_TAGS = {
    "p", "div", "br", "b", "strong", "i", "em", "u", "s", "strike", "del",
    "h1", "h2", "h3", "ul", "ol", "li", "pre", "code", "blockquote", "a",
    "hr", "span", "table", "thead", "tbody", "tr", "td", "th",
}
VOID_TAGS = {"br", "hr"}
DROP_CONTENT = {"script", "style", "iframe", "object", "embed", "noscript", "template"}
ALLOWED_CLASSES = {"checklist", "dashed", "checked", "mono"}


class _Sanitizer(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []
        self.stack = []
        self.drop_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in DROP_CONTENT:
            self.drop_depth += 1
            return
        if self.drop_depth or tag not in ALLOWED_TAGS:
            return
        clean = []
        for name, value in attrs:
            value = value or ""
            if name == "class":
                cls = " ".join(c for c in value.split() if c in ALLOWED_CLASSES)
                if cls:
                    clean.append(("class", cls))
            elif name == "href" and tag == "a":
                if re.match(r"^(https?:|mailto:)", value.strip(), re.I):
                    clean.append(("href", value.strip()))
                    clean.append(("target", "_blank"))
                    clean.append(("rel", "noopener noreferrer"))
            elif name == "data-checked" and tag == "li":
                clean.append(("data-checked", "true" if value == "true" else "false"))
        attr_s = "".join(f' {k}="{escape(v, quote=True)}"' for k, v in clean)
        self.out.append(f"<{tag}{attr_s}>")
        if tag not in VOID_TAGS:
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag in DROP_CONTENT:
            self.drop_depth = max(0, self.drop_depth - 1)
            return
        if self.drop_depth or tag not in ALLOWED_TAGS or tag in VOID_TAGS:
            return
        if tag in self.stack:
            while self.stack:
                t = self.stack.pop()
                self.out.append(f"</{t}>")
                if t == tag:
                    break

    def handle_data(self, data):
        if not self.drop_depth:
            self.out.append(escape(data, quote=False))

    def result(self):
        while self.stack:
            self.out.append(f"</{self.stack.pop()}>")
        return "".join(self.out)


def sanitize_html(html):
    s = _Sanitizer()
    s.feed(html or "")
    s.close()
    return s.result()


class _TextExtractor(HTMLParser):
    BLOCK = {"p", "div", "br", "h1", "h2", "h3", "li", "pre", "blockquote", "tr", "hr"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        self.parts.append(data)


TAG_RE = re.compile(r"(?:^|\s)#([\w\-]{1,40})", re.UNICODE)


def derive_fields(html):
    ex = _TextExtractor()
    ex.feed(html)
    text = "".join(ex.parts).replace("\xa0", " ")
    lines = [ln.strip() for ln in text.split("\n") if ln.strip()]
    title = lines[0][:200] if lines else ""
    snippet = " ".join(lines[1:3])[:200] if len(lines) > 1 else ""
    tags = sorted({t.lower() for t in TAG_RE.findall(text)})
    return title, snippet, "\n".join(lines), ",".join(tags)


# --------------------------------------------------------------------------
# Auth helpers / CSRF
# --------------------------------------------------------------------------
def csrf_token():
    if "csrf" not in session:
        session["csrf"] = secrets.token_urlsafe(32)
    return session["csrf"]


app.jinja_env.globals["csrf_token"] = csrf_token

THEMES = ("auto", "light", "warm", "dark")


def current_theme():
    """Theme for this request: the signed-in user's setting, else the cookie."""
    if "user_id" in session:
        row = get_db().execute("SELECT theme FROM users WHERE id=?", (session["user_id"],)).fetchone()
        if row and row["theme"] in THEMES:
            return row["theme"]
    t = request.cookies.get("theme")
    return t if t in THEMES else "auto"


app.jinja_env.globals["current_theme"] = current_theme


@app.before_request
def csrf_protect():
    if request.method in ("POST", "PATCH", "PUT", "DELETE"):
        token = request.headers.get("X-CSRF-Token") or request.form.get("csrf")
        if not token or not secrets.compare_digest(token, session.get("csrf", "")):
            if request.path.startswith("/api/"):
                return jsonify(error="Invalid CSRF token"), 403
            abort(400, "Invalid form token — please reload the page.")


def login_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if "user_id" not in session:
            if request.path.startswith("/api/"):
                return jsonify(error="Not signed in"), 401
            return redirect(url_for("login"))
        return view(*args, **kwargs)
    return wrapper


def uid():
    return session["user_id"]


def create_user(username, password):
    db = get_db()
    cur = db.execute(
        "INSERT INTO users (username, password_hash, created_at) VALUES (?,?,?)",
        (username, generate_password_hash(password), now_iso()),
    )
    user_id = cur.lastrowid
    ts = now_iso()
    fid = db.execute("INSERT INTO folders (user_id, name, created_at) VALUES (?,?,?)",
                     (user_id, "Notes", ts)).lastrowid
    # The first account created on a database that came from the old app
    # receives the old notes automatically.
    if db.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 1 and import_legacy(db, user_id):
        return user_id
    welcome = (
        "<h1>Welcome to Notes</h1>"
        "<div>This app is modeled on Notes for macOS. A few things to try:</div>"
        '<ul class="checklist">'
        '<li data-checked="true">Create a note with the compose button</li>'
        '<li data-checked="false">Use <b>Aa</b> to add a Title, Heading or list</li>'
        '<li data-checked="false">Add a checklist with the ☑︎ button</li>'
        '<li data-checked="false">Pin important notes to the top</li>'
        "</ul>"
        "<div>Add #tags anywhere in a note to browse by tag in the sidebar.</div>"
    )
    title, snippet, text, tags = derive_fields(welcome)
    db.execute(
        "INSERT INTO notes (user_id, folder_id, title, snippet, body_html, body_text, tags,"
        " pinned, created_at, updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)",
        (user_id, fid, title, snippet, welcome, text, tags, ts, ts),
    )
    db.commit()
    return user_id


# --------------------------------------------------------------------------
# Pages
# --------------------------------------------------------------------------
@app.route("/")
@login_required
def index():
    user = get_db().execute("SELECT username FROM users WHERE id=?", (uid(),)).fetchone()
    if user is None:
        session.clear()
        return redirect(url_for("login"))
    return render_template("index.html", username=user["username"])


@app.route("/login", methods=["GET", "POST"])
def login():
    error = None
    if request.method == "POST":
        username = (request.form.get("username") or "").strip()
        password = request.form.get("password") or ""
        row = get_db().execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        if row and check_password_hash(row["password_hash"], password):
            session.clear()
            session.permanent = True
            session["user_id"] = row["id"]
            return redirect(url_for("index"))
        error = "Incorrect username or password."
    return render_template("login.html", mode="login", error=error,
                           allow_signup=app.config["ALLOW_SIGNUP"])


@app.route("/signup", methods=["GET", "POST"])
def signup():
    if not app.config["ALLOW_SIGNUP"]:
        abort(404)
    error = None
    if request.method == "POST":
        username = (request.form.get("username") or "").strip()
        password = request.form.get("password") or ""
        if not re.fullmatch(r"[A-Za-z0-9_.\-]{3,32}", username):
            error = "Username must be 3–32 characters: letters, numbers, . _ -"
        elif len(password) < 8:
            error = "Password must be at least 8 characters."
        elif get_db().execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
            error = "That username is taken."
        else:
            user_id = create_user(username, password)
            session.clear()
            session.permanent = True
            session["user_id"] = user_id
            return redirect(url_for("index"))
    return render_template("login.html", mode="signup", error=error, allow_signup=True)


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return redirect(url_for("login"))


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------
def purge_trash(db):
    cutoff = (datetime.now(timezone.utc) - timedelta(days=TRASH_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    db.execute("DELETE FROM notes WHERE user_id=? AND deleted_at IS NOT NULL AND deleted_at < ?",
               (uid(), cutoff))


def note_summary(r):
    return {
        "id": r["id"], "folder_id": r["folder_id"], "title": r["title"],
        "snippet": r["snippet"], "pinned": bool(r["pinned"]),
        "created_at": r["created_at"], "updated_at": r["updated_at"],
        "deleted_at": r["deleted_at"],
    }


def own_folder(db, folder_id):
    row = db.execute("SELECT * FROM folders WHERE id=? AND user_id=?", (folder_id, uid())).fetchone()
    if row is None:
        abort(404)
    return row


def own_note(db, note_id):
    row = db.execute("SELECT * FROM notes WHERE id=? AND user_id=?", (note_id, uid())).fetchone()
    if row is None:
        abort(404)
    return row


@app.errorhandler(404)
def not_found(e):
    if request.path.startswith("/api/"):
        return jsonify(error="Not found"), 404
    return e


@app.get("/api/sidebar")
@login_required
def api_sidebar():
    db = get_db()
    purge_trash(db)
    db.commit()
    folders = db.execute(
        "SELECT f.id, f.name, COUNT(n.id) AS count FROM folders f "
        "LEFT JOIN notes n ON n.folder_id=f.id AND n.deleted_at IS NULL "
        "WHERE f.user_id=? GROUP BY f.id ORDER BY f.name COLLATE NOCASE", (uid(),)
    ).fetchall()
    all_count = db.execute("SELECT COUNT(*) FROM notes WHERE user_id=? AND deleted_at IS NULL",
                           (uid(),)).fetchone()[0]
    deleted = db.execute("SELECT COUNT(*) FROM notes WHERE user_id=? AND deleted_at IS NOT NULL",
                         (uid(),)).fetchone()[0]
    tags = {}
    for (t,) in db.execute("SELECT tags FROM notes WHERE user_id=? AND deleted_at IS NULL AND tags!=''",
                           (uid(),)):
        for tag in t.split(","):
            tags[tag] = tags.get(tag, 0) + 1
    return jsonify(
        folders=[dict(f) for f in folders], all_count=all_count, deleted_count=deleted,
        tags=[{"name": k, "count": v} for k, v in sorted(tags.items())],
    )


@app.post("/api/folders")
@login_required
def api_create_folder():
    name = ((request.get_json(silent=True) or {}).get("name") or "").strip()[:80] or "New Folder"
    db = get_db()
    fid = db.execute("INSERT INTO folders (user_id, name, created_at) VALUES (?,?,?)",
                     (uid(), name, now_iso())).lastrowid
    db.commit()
    return jsonify(id=fid, name=name, count=0), 201


@app.patch("/api/folders/<int:fid>")
@login_required
def api_rename_folder(fid):
    db = get_db()
    own_folder(db, fid)
    name = ((request.get_json(silent=True) or {}).get("name") or "").strip()[:80]
    if not name:
        return jsonify(error="Name required"), 400
    db.execute("UPDATE folders SET name=? WHERE id=?", (name, fid))
    db.commit()
    return jsonify(ok=True)


@app.delete("/api/folders/<int:fid>")
@login_required
def api_delete_folder(fid):
    db = get_db()
    own_folder(db, fid)
    ts = now_iso()
    db.execute("UPDATE notes SET deleted_at=?, folder_id=NULL, pinned=0 "
               "WHERE folder_id=? AND user_id=? AND deleted_at IS NULL", (ts, fid, uid()))
    db.execute("UPDATE notes SET folder_id=NULL WHERE folder_id=? AND user_id=?", (fid, uid()))
    db.execute("DELETE FROM folders WHERE id=?", (fid,))
    db.commit()
    return jsonify(ok=True)


@app.get("/api/notes")
@login_required
def api_list_notes():
    db = get_db()
    view = request.args.get("view", "all")
    q = (request.args.get("q") or "").strip()
    sql = "SELECT * FROM notes WHERE user_id=?"
    params = [uid()]
    if view == "deleted":
        sql += " AND deleted_at IS NOT NULL"
    else:
        sql += " AND deleted_at IS NULL"
        if view.startswith("folder:"):
            sql += " AND folder_id=?"
            params.append(int(view.split(":", 1)[1]))
        elif view.startswith("tag:"):
            sql += " AND (',' || tags || ',') LIKE ?"
            params.append(f"%,{view.split(':', 1)[1].lower()},%")
    if q:
        for word in q.split():
            sql += " AND (title LIKE ? ESCAPE '\\' OR body_text LIKE ? ESCAPE '\\')"
            like = "%" + word.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            params += [like, like]
    sql += " ORDER BY pinned DESC, updated_at DESC"
    rows = db.execute(sql, params).fetchall()
    return jsonify(notes=[note_summary(r) for r in rows])


@app.post("/api/notes")
@login_required
def api_create_note():
    db = get_db()
    data = request.get_json(silent=True) or {}
    folder_id = data.get("folder_id")
    if folder_id is not None:
        own_folder(db, folder_id)
    else:
        row = db.execute("SELECT id FROM folders WHERE user_id=? ORDER BY id LIMIT 1", (uid(),)).fetchone()
        if row is None:
            folder_id = db.execute("INSERT INTO folders (user_id, name, created_at) VALUES (?,?,?)",
                                   (uid(), "Notes", now_iso())).lastrowid
        else:
            folder_id = row["id"]
    ts = now_iso()
    nid = db.execute(
        "INSERT INTO notes (user_id, folder_id, created_at, updated_at) VALUES (?,?,?,?)",
        (uid(), folder_id, ts, ts)).lastrowid
    db.commit()
    return jsonify(note_summary(own_note(db, nid)) | {"body_html": ""}), 201


@app.get("/api/notes/<int:nid>")
@login_required
def api_get_note(nid):
    r = own_note(get_db(), nid)
    return jsonify(note_summary(r) | {"body_html": r["body_html"]})


@app.patch("/api/notes/<int:nid>")
@login_required
def api_update_note(nid):
    db = get_db()
    note = own_note(db, nid)
    data = request.get_json(silent=True) or {}
    sets, params = [], []
    touch = False
    if "body_html" in data:
        if note["deleted_at"]:
            return jsonify(error="Recover the note before editing it."), 409
        html = sanitize_html(str(data["body_html"]))
        title, snippet, text, tags = derive_fields(html)
        sets += ["body_html=?", "title=?", "snippet=?", "body_text=?", "tags=?"]
        params += [html, title, snippet, text, tags]
        touch = True
    if "pinned" in data:
        sets.append("pinned=?")
        params.append(1 if data["pinned"] else 0)
    if "folder_id" in data:
        own_folder(db, int(data["folder_id"]))
        sets.append("folder_id=?")
        params.append(int(data["folder_id"]))
    if not sets:
        return jsonify(error="Nothing to update"), 400
    if touch:
        sets.append("updated_at=?")
        params.append(now_iso())
    db.execute(f"UPDATE notes SET {', '.join(sets)} WHERE id=?", params + [nid])
    db.commit()
    return jsonify(note_summary(own_note(db, nid)))


@app.delete("/api/notes/<int:nid>")
@login_required
def api_delete_note(nid):
    db = get_db()
    note = own_note(db, nid)
    if note["deleted_at"]:
        db.execute("DELETE FROM notes WHERE id=?", (nid,))
    else:
        db.execute("UPDATE notes SET deleted_at=?, pinned=0 WHERE id=?", (now_iso(), nid))
    db.commit()
    return jsonify(ok=True)


@app.post("/api/notes/<int:nid>/restore")
@login_required
def api_restore_note(nid):
    db = get_db()
    note = own_note(db, nid)
    folder_id = note["folder_id"]
    if folder_id is None or not db.execute("SELECT 1 FROM folders WHERE id=?", (folder_id,)).fetchone():
        row = db.execute("SELECT id FROM folders WHERE user_id=? ORDER BY id LIMIT 1", (uid(),)).fetchone()
        folder_id = row["id"] if row else db.execute(
            "INSERT INTO folders (user_id, name, created_at) VALUES (?,?,?)",
            (uid(), "Notes", now_iso())).lastrowid
    db.execute("UPDATE notes SET deleted_at=NULL, folder_id=? WHERE id=?", (folder_id, nid))
    db.commit()
    return jsonify(ok=True)


@app.patch("/api/settings")
@login_required
def api_settings():
    theme = (request.get_json(silent=True) or {}).get("theme")
    if theme not in THEMES:
        return jsonify(error="Unknown theme"), 400
    db = get_db()
    db.execute("UPDATE users SET theme=? WHERE id=?", (theme, uid()))
    db.commit()
    resp = jsonify(theme=theme)
    # cookie lets the sign-in page use the same theme after signing out
    resp.set_cookie("theme", theme, max_age=365 * 86400, samesite="Lax",
                    secure=app.config["SESSION_COOKIE_SECURE"])
    return resp


@app.delete("/api/trash")
@login_required
def api_empty_trash():
    db = get_db()
    db.execute("DELETE FROM notes WHERE user_id=? AND deleted_at IS NOT NULL", (uid(),))
    db.commit()
    return jsonify(ok=True)


if __name__ == "__main__":
    app.run(debug=True, port=5000)
