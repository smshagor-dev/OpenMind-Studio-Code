# OpenMind Studio's Python cell runner (not Jupyter, not IPython): runs notebook cells one at a time in one shared
# namespace and answers each request with one JSON line. Requests arrive on stdin as {"id": n, "code": "..."}.
# It runs only after the user runs a cell, in the notebook's folder, and never reads the network.
import ast
import base64
import builtins
import contextlib
import io
import json
import os
import sys
import traceback

_protocol = sys.stdout
sys.stdout = io.StringIO()
sys.path[0] = os.getcwd()
_namespace = {"__name__": "__main__", "__builtins__": builtins}
_count = 0
_LIMIT = 1_000_000
_MAGIC = "IPython magics and shell commands (lines starting with % or !) are not supported by OpenMind's Python runner."


def _no_input(*_args, **_kwargs):
    raise RuntimeError("input() is not supported in notebook cells.")


builtins.input = _no_input


def _clip(text):
    return text if len(text) <= _LIMIT else text[:_LIMIT] + "\n... (output cut at 1 MB)"


def _rich(value):
    data = {"text/plain": _clip(repr(value))}
    for mime, method in (("image/png", "_repr_png_"), ("image/jpeg", "_repr_jpeg_")):
        make = getattr(value, method, None)
        if callable(make):
            try:
                raw = make()
                if isinstance(raw, bytes):
                    data[mime] = base64.b64encode(raw).decode("ascii")
            except Exception:
                pass
    return data


def _error(exc):
    lines = traceback.format_exception(type(exc), exc, exc.__traceback__)
    return {"ename": type(exc).__name__, "evalue": str(exc), "traceback": [line.rstrip("\n") for line in lines]}


def _run(code):
    global _count
    _count += 1
    for line in code.splitlines():
        if line.lstrip().startswith(("%", "!")):
            return {"status": "error", "count": _count, "stdout": "", "stderr": "", "result": None,
                    "error": {"ename": "UnsupportedSyntax", "evalue": _MAGIC, "traceback": []}}
    out, err = io.StringIO(), io.StringIO()
    result, error = None, None
    try:
        tree = ast.parse(code, "<cell>", "exec")
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = ast.Expression(tree.body.pop().value)
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            exec(compile(tree, "<cell>", "exec"), _namespace)
            if last is not None:
                value = eval(compile(last, "<cell>", "eval"), _namespace)
                if value is not None:
                    result = _rich(value)
                    _namespace["_"] = value
    except BaseException as exc:  # SystemExit and KeyboardInterrupt too: the runner itself keeps going
        error = _error(exc)
    return {"status": "error" if error else "ok", "count": _count, "stdout": _clip(out.getvalue()),
            "stderr": _clip(err.getvalue()), "result": result, "error": error}


for _raw in sys.stdin:
    try:
        _request = json.loads(_raw)
    except ValueError:
        continue
    _answer = _run(str(_request.get("code", "")))
    _answer["id"] = _request.get("id")
    _protocol.write(json.dumps(_answer) + "\n")
    _protocol.flush()
