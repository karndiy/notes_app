# Notes (Flask) — a macOS Notes–style web app

Three-pane layout (folders · note list · editor), rich text, checklists, pinning,
#tags, search, gallery view, Recently Deleted (30 days), themes (Auto / Light / Warm / Dark), and an
iPhone-style single-pane layout on phones. Python Flask + SQLite, no other dependencies.

## Using your old database (`notes.db`)
The app opens the old schema (`notes: id, title, body, folder, pinned, updated_at`) directly:

1. Put the old file at `instance/notes.db` (or point `NOTES_DB` at it).
2. On first start the old table is renamed to `notes_legacy` (kept untouched) and the new tables are created.
3. **The first account you sign up gets all the old notes automatically** — plain text becomes
   rich text, the old `title` becomes the Title line, links become clickable, folders are created
   by name, and pin + `updated_at` are kept.
4. To import into a different/existing account instead:
   `flask --app app import-legacy <username>` (each old note is only imported once).

Back up `notes.db` before the first run.

## Run locally
```bash
pip install flask
python app.py          # http://127.0.0.1:5000
```

## Deploy on PythonAnywhere
1. **Files** tab → upload `notes_app.zip` to your home folder, then in a **Bash console**:
   ```bash
   unzip notes_app.zip -d ~/notes_app
   cp ~/notes.db ~/notes_app/instance/notes.db   # your old database, if you have it there
   ```
2. **Web** tab → *Add a new web app* → *Manual configuration* → latest Python 3.x.
3. Under *Code*: Source code = `/home/<username>/notes_app`.
   Open the *WSGI configuration file* link and replace its content with
   `pythonanywhere_wsgi.py` (change `<username>`).
4. Under *Static files* add: URL `/static/` → Directory `/home/<username>/notes_app/static`.
5. Under *Security* turn on **Force HTTPS**. Click **Reload**.
6. Visit `https://<username>.pythonanywhere.com`, create your account (old notes import here).
7. Optional: set `NOTES_ALLOW_SIGNUP` to `"0"` in the WSGI file and reload, so nobody else can sign up.
   You can still add users with `flask --app app create-user <name>` from a console.

## Themes
Pick **Auto** (follows the device's light/dark setting), **Light**, **Warm** (paper/sepia tones)
or **Dark** at the bottom of the sidebar. The choice is saved to your account, so it follows you
to every device; it is also remembered for the sign-in page. Existing databases get the new
`users.theme` column automatically on start-up.

## Configuration (environment variables)
| Variable | Default | Purpose |
|---|---|---|
| `NOTES_DB` | `instance/notes.db` | SQLite file |
| `NOTES_SECRET_KEY` | auto-generated in `instance/secret_key` | session signing |
| `NOTES_ALLOW_SIGNUP` | `1` | `0` disables the sign-up page |
| `NOTES_SECURE_COOKIE` | `0` | `1` when served over HTTPS |

## Keyboard shortcuts
⌥⌘N / Ctrl+Alt+N new note · ⇧⌘T Title · ⇧⌘H Heading · ⇧⌘J Subheading · ⇧⌘B Body ·
⇧⌘M Monostyled · ⇧⌘L Checklist · ⇧⌘7 Numbered · ⇧⌘8 Bulleted · ⌘B/I/U ·
⌥⌘F search · ↑/↓ move through the list · Delete removes the selected note.
Right-click a folder to rename/delete it; drag notes onto a folder to move them.

## Structure
```
app.py                  Flask app: auth, JSON API, sanitizer, legacy import
templates/              login.html, index.html
static/app.css, app.js  UI (vanilla JS, no build step)
pythonanywhere_wsgi.py  WSGI file template
instance/               notes.db + secret_key (created at runtime, not in the zip)
```
