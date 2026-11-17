# PythonAnywhere WSGI configuration
# ---------------------------------
# Copy the contents of this file into the WSGI file linked on your
# PythonAnywhere "Web" tab (e.g. /var/www/<username>_pythonanywhere_com_wsgi.py).
# Replace <username> below with your PythonAnywhere username.
import os
import sys

project_home = "/home/<username>/notes_app"
if project_home not in sys.path:
    sys.path.insert(0, project_home)

# Optional settings
os.environ.setdefault("NOTES_SECURE_COOKIE", "1")      # site is served over HTTPS
os.environ.setdefault("NOTES_ALLOW_SIGNUP", "1")       # set to "0" after creating your account
# os.environ["NOTES_DB"] = "/home/<username>/notes_app/instance/notes.db"  # default location

from app import app as application  # noqa: E402
