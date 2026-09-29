"""Before cleaning Python packages in a test copy: is this interpreter isolated from the user's own site-packages?

Run it with exactly the interpreter and flags the cleanup would use, for example:

    & "<copy>\\runtimes\\python\\versions\\<v>\\python.exe" -s scripts\\check-python-isolation.py

Exit code 0: the user site is not on sys.path, so pip in this interpreter only sees the test copy's packages.
Exit code 1: STOP. The user's personal site-packages are visible; `pip uninstall` could remove the user's own packages
(this happened once: numpy/pandas/python-dateutil/six/tzdata were removed from %APPDATA%\\Python\\Python314). Use an
OpenMind terminal, or `python -s` with PYTHONNOUSERSITE=1, and run this check again. See docs/smoke-testing.md.
"""
import os
import site
import sys

user_site = site.getusersitepackages() if hasattr(site, "getusersitepackages") else site.USER_SITE
normalized = [os.path.normcase(os.path.abspath(p)) for p in sys.path if p]
visible = bool(user_site) and os.path.normcase(os.path.abspath(user_site)) in normalized

print(f"sys.executable       {sys.executable}")
print(f"USER_SITE            {user_site}")
print(f"ENABLE_USER_SITE     {site.ENABLE_USER_SITE}")
print(f"USER_SITE in sys.path {visible}")
print(f"PYTHONNOUSERSITE     {os.environ.get('PYTHONNOUSERSITE', '<not set>')}")
if visible:
    print("STOP: the user's personal site-packages are visible. Do not run pip uninstall/install here.")
    sys.exit(1)
print("OK: isolated from the user's site-packages.")
