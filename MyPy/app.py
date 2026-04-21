import ast
import builtins
import io
import json
import mimetypes
import multiprocessing as mp
import os
import re
import sqlite3
import traceback
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
INDEX_FILE = BASE_DIR / "index.html"
NOTES_FILE = BASE_DIR / "notes.html"
CALENDAR_FILE = BASE_DIR / "calendar.html"
DEFAULT_DB_PATH = BASE_DIR / "mypy.db"
RENDER_DB_PATH = Path("/var/data/mypy.db")
DB_PATH = Path(os.environ.get("MYPY_DB_PATH", RENDER_DB_PATH if RENDER_DB_PATH.parent.exists() else DEFAULT_DB_PATH))
EXECUTION_TIMEOUT_SECONDS = 3

SAFE_IMPORTS = {
    "array",
    "bisect",
    "collections",
    "datetime",
    "decimal",
    "fractions",
    "functools",
    "heapq",
    "itertools",
    "json",
    "math",
    "random",
    "re",
    "statistics",
    "string",
}

DISALLOWED_IMPORTS = {
    "builtins",
    "ctypes",
    "importlib",
    "os",
    "pathlib",
    "resource",
    "shutil",
    "signal",
    "socket",
    "subprocess",
    "sys",
    "tempfile",
    "threading",
}

DISALLOWED_CALLS = {
    "__import__",
    "compile",
    "eval",
    "exec",
    "getattr",
    "globals",
    "input",
    "locals",
    "open",
    "setattr",
    "vars",
}

SAFE_BUILTIN_NAMES = [
    "__build_class__",
    "BaseException",
    "Exception",
    "False",
    "None",
    "RuntimeError",
    "TypeError",
    "True",
    "ValueError",
    "ZeroDivisionError",
    "abs",
    "all",
    "any",
    "bool",
    "callable",
    "classmethod",
    "chr",
    "complex",
    "dict",
    "divmod",
    "enumerate",
    "filter",
    "float",
    "format",
    "frozenset",
    "hash",
    "hasattr",
    "hex",
    "int",
    "IndexError",
    "isinstance",
    "issubclass",
    "iter",
    "KeyError",
    "len",
    "list",
    "map",
    "max",
    "min",
    "NameError",
    "next",
    "object",
    "oct",
    "ord",
    "pow",
    "print",
    "property",
    "range",
    "repr",
    "reversed",
    "round",
    "set",
    "slice",
    "sorted",
    "staticmethod",
    "str",
    "sum",
    "super",
    "tuple",
    "type",
    "zip",
]


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def get_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with get_connection() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS folders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS code_blocks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                folder_id INTEGER NOT NULL,
                parent_block_id INTEGER,
                name TEXT NOT NULL,
                description TEXT NOT NULL,
                type_test TEXT NOT NULL,
                code TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
                FOREIGN KEY (parent_block_id) REFERENCES code_blocks(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS note_folders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                folder_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (folder_id) REFERENCES note_folders(id) ON DELETE CASCADE
            );
            """
        )
        ensure_code_block_variant_support(connection)


def ensure_code_block_variant_support(connection: sqlite3.Connection) -> None:
    columns = {row["name"] for row in connection.execute("PRAGMA table_info(code_blocks)").fetchall()}
    if "parent_block_id" not in columns:
        connection.execute("ALTER TABLE code_blocks ADD COLUMN parent_block_id INTEGER")

    connection.execute("CREATE INDEX IF NOT EXISTS idx_code_blocks_parent_block_id ON code_blocks(parent_block_id)")


def require_text(value, field_name: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field_name} is required.")

    cleaned = value.strip()
    if not cleaned:
        raise ValueError(f"{field_name} is required.")

    return cleaned


def parse_parent_block_id(value) -> int | None:
    if value is None or value == "":
        return None

    try:
        return int(value)
    except (TypeError, ValueError) as error:
        raise ValueError("Parent block is invalid.") from error


def parse_variant_payloads(raw_variants) -> list[dict]:
    if raw_variants is None or raw_variants == "":
        return []

    if not isinstance(raw_variants, list):
        raise ValueError("Variants must be a list.")

    variants: list[dict] = []
    for index, raw_variant in enumerate(raw_variants, start=1):
        if not isinstance(raw_variant, dict):
            raise ValueError(f"Variant {index} must be an object.")

        name = require_text(raw_variant.get("name"), f"Variant {index} name")
        description = require_text(raw_variant.get("description"), f"Variant {index} description")
        type_test = require_text(raw_variant.get("type_test"), f"Variant {index} test")
        code = raw_variant.get("code", "")
        if not isinstance(code, str):
            raise ValueError(f"Variant {index} code must be a string.")

        variants.append(
            {
                "name": name,
                "description": description,
                "type_test": type_test,
                "code": code,
            }
        )

    return variants


def serialize_block_row(row: sqlite3.Row) -> dict:
    block = {
        "id": row["id"],
        "folder_id": row["folder_id"],
        "parent_block_id": row["parent_block_id"],
        "name": row["name"],
        "description": row["description"],
        "type_test": row["type_test"],
        "code": row["code"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }

    if "parent_name" in row.keys():
        block["parent_name"] = row["parent_name"]

    return block


def fetch_block_variants(connection: sqlite3.Connection, parent_block_id: int) -> list[dict]:
    rows = connection.execute(
        """
        SELECT
            id,
            folder_id,
            parent_block_id,
            name,
            description,
            type_test,
            code,
            created_at,
            updated_at
        FROM code_blocks
        WHERE parent_block_id = ?
        ORDER BY updated_at DESC, id DESC
        """,
        (parent_block_id,),
    ).fetchall()

    return [serialize_block_row(row) | {"variants": []} for row in rows]


def validate_block_parent(folder_id: int, parent_block_id: int | None, current_block_id: int | None = None) -> None:
    if parent_block_id is None:
        return

    with get_connection() as connection:
        row = connection.execute(
            """
            SELECT id, folder_id, parent_block_id
            FROM code_blocks
            WHERE id = ?
            """,
            (parent_block_id,),
        ).fetchone()

    if row is None:
        raise ValueError("Parent block does not exist.")

    if row["parent_block_id"] is not None:
        raise ValueError("Variants can only belong to a top-level code block.")

    if current_block_id is not None and row["id"] == current_block_id:
        raise ValueError("A code block cannot be its own parent.")

    if row["folder_id"] != folder_id:
        raise ValueError("Variant must stay in the same folder as its parent block.")


def fetch_folders_with_blocks() -> list[dict]:
    with get_connection() as connection:
        folder_rows = connection.execute(
            """
            SELECT id, name
            FROM folders
            ORDER BY id ASC
            """
        ).fetchall()
        block_rows = connection.execute(
            """
            SELECT
                id,
                folder_id,
                parent_block_id,
                name,
                description,
                type_test,
                code,
                created_at,
                updated_at
            FROM code_blocks
            ORDER BY
                folder_id ASC,
                CASE WHEN parent_block_id IS NULL THEN 0 ELSE 1 END ASC,
                updated_at DESC,
                id DESC
            """
        ).fetchall()

    grouped = {
        row["id"]: {
            "id": row["id"],
            "name": row["name"],
            "blocks": [],
        }
        for row in folder_rows
    }
    top_level_blocks: dict[int, dict] = {}

    for row in block_rows:
        block = serialize_block_row(row) | {"variants": []}
        parent_block_id = block["parent_block_id"]

        if parent_block_id is None:
            grouped[block["folder_id"]]["blocks"].append(block)
            top_level_blocks[block["id"]] = block
            continue

        parent_block = top_level_blocks.get(parent_block_id)
        if parent_block is None:
            grouped[block["folder_id"]]["blocks"].append(block)
            continue

        parent_block["variants"].append(block)

    return list(grouped.values())


def fetch_note_folders_with_notes() -> list[dict]:
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT
                f.id AS folder_id,
                f.name AS folder_name,
                n.id AS note_id,
                n.title AS note_title,
                n.content AS note_content,
                n.created_at AS note_created_at,
                n.updated_at AS note_updated_at
            FROM note_folders AS f
            LEFT JOIN notes AS n ON n.folder_id = f.id
            ORDER BY f.id ASC, n.updated_at DESC, n.id DESC
            """
        ).fetchall()

    grouped: dict[int, dict] = {}
    for row in rows:
        folder_id = row["folder_id"]
        if folder_id not in grouped:
            grouped[folder_id] = {
                "id": folder_id,
                "name": row["folder_name"],
                "notes": [],
            }

        if row["note_id"] is not None:
            grouped[folder_id]["notes"].append(
                {
                    "id": row["note_id"],
                    "title": row["note_title"],
                    "content": row["note_content"],
                    "created_at": row["note_created_at"],
                    "updated_at": row["note_updated_at"],
                }
            )

    return list(grouped.values())


def fetch_block(block_id: int) -> dict | None:
    with get_connection() as connection:
        row = connection.execute(
            """
            SELECT
                b.id,
                b.folder_id,
                b.parent_block_id,
                parent.name AS parent_name,
                b.name,
                b.description,
                b.type_test,
                b.code,
                b.created_at,
                b.updated_at
            FROM code_blocks AS b
            LEFT JOIN code_blocks AS parent ON parent.id = b.parent_block_id
            WHERE b.id = ?
            """,
            (block_id,),
        ).fetchone()

        if row is None:
            return None

        block = serialize_block_row(row)
        block["variants"] = fetch_block_variants(connection, block_id) if block["parent_block_id"] is None else []

    return block


def fetch_note(note_id: int) -> dict | None:
    with get_connection() as connection:
        row = connection.execute(
            """
            SELECT
                id,
                folder_id,
                title,
                content,
                created_at,
                updated_at
            FROM notes
            WHERE id = ?
            """,
            (note_id,),
        ).fetchone()

    return dict(row) if row else None


def validate_parent_exists(table_name: str, row_id: int) -> None:
    with get_connection() as connection:
        row = connection.execute(f"SELECT id FROM {table_name} WHERE id = ?", (row_id,)).fetchone()
    if row is None:
        raise ValueError(f"{table_name[:-1].replace('_', ' ').title()} does not exist.")


def validate_code(code: str) -> None:
    tree = ast.parse(code, mode="exec")
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root_name = alias.name.split(".")[0]
                if root_name in DISALLOWED_IMPORTS or root_name not in SAFE_IMPORTS:
                    raise ValueError(f"Import '{root_name}' is not allowed.")

        if isinstance(node, ast.ImportFrom):
            module_name = (node.module or "").split(".")[0]
            if not module_name or module_name in DISALLOWED_IMPORTS or module_name not in SAFE_IMPORTS:
                raise ValueError(f"Import '{module_name or 'relative import'}' is not allowed.")

        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in DISALLOWED_CALLS:
            raise ValueError(f"Call to '{node.func.id}' is not allowed.")


def build_safe_builtins() -> dict:
    safe_builtins = {name: getattr(builtins, name) for name in SAFE_BUILTIN_NAMES}

    def safe_import(name, globals_=None, locals_=None, fromlist=(), level=0):
        root_name = name.split(".")[0]
        if root_name not in SAFE_IMPORTS:
            raise ImportError(f"Import '{root_name}' is not allowed.")
        return builtins.__import__(name, globals_, locals_, fromlist, level)

    safe_builtins["__import__"] = safe_import
    return safe_builtins


def execute_code_worker(code: str, queue) -> None:
    stdout_buffer = io.StringIO()
    stderr_buffer = io.StringIO()
    namespace = {"__builtins__": build_safe_builtins()}

    try:
        try:
            import resource

            memory_limit = 256 * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_AS, (memory_limit, memory_limit))
        except Exception:
            pass

        with redirect_stdout(stdout_buffer), redirect_stderr(stderr_buffer):
            exec(code, namespace, namespace)
    except Exception:
        traceback.print_exc(file=stderr_buffer)

    queue.put({"stdout": stdout_buffer.getvalue(), "stderr": stderr_buffer.getvalue()})


def list_folders_response():
    return 200, {"folders": fetch_folders_with_blocks()}


def create_folder_response(payload: dict):
    try:
        name = require_text(payload.get("name"), "Folder name")
    except ValueError as error:
        return 400, {"error": str(error)}

    with get_connection() as connection:
        cursor = connection.execute("INSERT INTO folders (name) VALUES (?)", (name,))
        folder_id = cursor.lastrowid

    return 201, {"folder": {"id": folder_id, "name": name, "blocks": []}}


def update_folder_response(folder_id: int, payload: dict):
    try:
        name = require_text(payload.get("name"), "Folder name")
    except ValueError as error:
        return 400, {"error": str(error)}

    with get_connection() as connection:
        cursor = connection.execute("UPDATE folders SET name = ? WHERE id = ?", (name, folder_id))
        if cursor.rowcount == 0:
            return 404, {"error": "Folder not found."}

    return 200, {"folder": {"id": folder_id, "name": name}}


def delete_folder_response(folder_id: int):
    with get_connection() as connection:
        cursor = connection.execute("DELETE FROM folders WHERE id = ?", (folder_id,))
        if cursor.rowcount == 0:
            return 404, {"error": "Folder not found."}

    return 200, {"deleted": True, "id": folder_id}


def list_blocks_response():
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT
                id,
                folder_id,
                parent_block_id,
                name,
                description,
                type_test,
                code,
                created_at,
                updated_at
            FROM code_blocks
            ORDER BY updated_at DESC, id DESC
            """
        ).fetchall()

    return 200, {"blocks": [serialize_block_row(row) for row in rows]}


def get_block_response(block_id: int):
    block = fetch_block(block_id)
    if block is None:
        return 404, {"error": "Code block not found."}
    return 200, {"block": block}


def create_block_response(payload: dict):
    try:
        folder_id = int(payload.get("folder_id"))
        parent_block_id = parse_parent_block_id(payload.get("parent_block_id"))
        name = require_text(payload.get("name"), "Block name")
        description = require_text(payload.get("description"), "Description")
        type_test = require_text(payload.get("type_test"), "test")
        code = payload.get("code", "")
        if not isinstance(code, str):
            raise ValueError("Code must be a string.")
        variants = parse_variant_payloads(payload.get("variants"))
        validate_parent_exists("folders", folder_id)
        validate_block_parent(folder_id, parent_block_id)
        if parent_block_id is not None and variants:
            raise ValueError("Variants cannot contain nested variants.")
    except (TypeError, ValueError) as error:
        return 400, {"error": str(error)}

    with get_connection() as connection:
        timestamp = utc_now()
        cursor = connection.execute(
            """
            INSERT INTO code_blocks (
                folder_id,
                parent_block_id,
                name,
                description,
                type_test,
                code,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (folder_id, parent_block_id, name, description, type_test, code, timestamp, timestamp),
        )
        block_id = cursor.lastrowid

        for variant in variants:
            variant_timestamp = utc_now()
            connection.execute(
                """
                INSERT INTO code_blocks (
                    folder_id,
                    parent_block_id,
                    name,
                    description,
                    type_test,
                    code,
                    created_at,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    folder_id,
                    block_id,
                    variant["name"],
                    variant["description"],
                    variant["type_test"],
                    variant["code"],
                    variant_timestamp,
                    variant_timestamp,
                ),
            )

    return 201, {"block": fetch_block(block_id)}


def update_block_response(block_id: int, payload: dict):
    with get_connection() as connection:
        existing_block = connection.execute(
            """
            SELECT id, folder_id, parent_block_id
            FROM code_blocks
            WHERE id = ?
            """,
            (block_id,),
        ).fetchone()
        child_variant_count = connection.execute(
            "SELECT COUNT(*) AS count FROM code_blocks WHERE parent_block_id = ?",
            (block_id,),
        ).fetchone()["count"]

    if existing_block is None:
        return 404, {"error": "Code block not found."}

    try:
        folder_id = int(payload.get("folder_id"))
        parent_block_id = parse_parent_block_id(payload.get("parent_block_id", existing_block["parent_block_id"]))
        name = require_text(payload.get("name"), "Block name")
        description = require_text(payload.get("description"), "Description")
        type_test = require_text(payload.get("type_test"), "test")
        code = payload.get("code", "")
        if not isinstance(code, str):
            raise ValueError("Code must be a string.")
        validate_parent_exists("folders", folder_id)
        validate_block_parent(folder_id, parent_block_id, current_block_id=block_id)
        if parent_block_id is not None and child_variant_count:
            raise ValueError("A code block with variants cannot become a variant.")
    except (TypeError, ValueError) as error:
        return 400, {"error": str(error)}

    timestamp = utc_now()
    with get_connection() as connection:
        cursor = connection.execute(
            """
            UPDATE code_blocks
            SET folder_id = ?, parent_block_id = ?, name = ?, description = ?, type_test = ?, code = ?, updated_at = ?
            WHERE id = ?
            """,
            (folder_id, parent_block_id, name, description, type_test, code, timestamp, block_id),
        )
        if cursor.rowcount == 0:
            return 404, {"error": "Code block not found."}

        if parent_block_id is None:
            connection.execute(
                """
                UPDATE code_blocks
                SET folder_id = ?, updated_at = ?
                WHERE parent_block_id = ?
                """,
                (folder_id, timestamp, block_id),
            )

    return 200, {"block": fetch_block(block_id)}


def delete_block_response(block_id: int):
    with get_connection() as connection:
        cursor = connection.execute(
            "DELETE FROM code_blocks WHERE id = ? OR parent_block_id = ?",
            (block_id, block_id),
        )
        if cursor.rowcount == 0:
            return 404, {"error": "Code block not found."}

    return 200, {"deleted": True, "id": block_id}


def list_note_folders_response():
    return 200, {"folders": fetch_note_folders_with_notes()}


def create_note_folder_response(payload: dict):
    try:
        name = require_text(payload.get("name"), "Folder name")
    except ValueError as error:
        return 400, {"error": str(error)}

    with get_connection() as connection:
        cursor = connection.execute("INSERT INTO note_folders (name) VALUES (?)", (name,))
        folder_id = cursor.lastrowid

    return 201, {"folder": {"id": folder_id, "name": name, "notes": []}}


def update_note_folder_response(folder_id: int, payload: dict):
    try:
        name = require_text(payload.get("name"), "Folder name")
    except ValueError as error:
        return 400, {"error": str(error)}

    with get_connection() as connection:
        cursor = connection.execute("UPDATE note_folders SET name = ? WHERE id = ?", (name, folder_id))
        if cursor.rowcount == 0:
            return 404, {"error": "Note folder not found."}

    return 200, {"folder": {"id": folder_id, "name": name}}


def delete_note_folder_response(folder_id: int):
    with get_connection() as connection:
        cursor = connection.execute("DELETE FROM note_folders WHERE id = ?", (folder_id,))
        if cursor.rowcount == 0:
            return 404, {"error": "Note folder not found."}

    return 200, {"deleted": True, "id": folder_id}


def list_notes_response():
    return 200, {"folders": fetch_note_folders_with_notes()}


def get_note_response(note_id: int):
    note = fetch_note(note_id)
    if note is None:
        return 404, {"error": "Note not found."}
    return 200, {"note": note}


def create_note_response(payload: dict):
    try:
        folder_id = int(payload.get("folder_id"))
        title = require_text(payload.get("title"), "Title")
        content = payload.get("content", "")
        if not isinstance(content, str):
            raise ValueError("Content must be a string.")
        validate_parent_exists("note_folders", folder_id)
    except (TypeError, ValueError) as error:
        return 400, {"error": str(error)}

    timestamp = utc_now()
    with get_connection() as connection:
        cursor = connection.execute(
            """
            INSERT INTO notes (
                folder_id,
                title,
                content,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (folder_id, title, content, timestamp, timestamp),
        )
        note_id = cursor.lastrowid

    return 201, {"note": fetch_note(note_id)}


def update_note_response(note_id: int, payload: dict):
    try:
        folder_id = int(payload.get("folder_id"))
        title = require_text(payload.get("title"), "Title")
        content = payload.get("content", "")
        if not isinstance(content, str):
            raise ValueError("Content must be a string.")
        validate_parent_exists("note_folders", folder_id)
    except (TypeError, ValueError) as error:
        return 400, {"error": str(error)}

    with get_connection() as connection:
        cursor = connection.execute(
            """
            UPDATE notes
            SET folder_id = ?, title = ?, content = ?, updated_at = ?
            WHERE id = ?
            """,
            (folder_id, title, content, utc_now(), note_id),
        )
        if cursor.rowcount == 0:
            return 404, {"error": "Note not found."}

    return 200, {"note": fetch_note(note_id)}


def delete_note_response(note_id: int):
    with get_connection() as connection:
        cursor = connection.execute("DELETE FROM notes WHERE id = ?", (note_id,))
        if cursor.rowcount == 0:
            return 404, {"error": "Note not found."}

    return 200, {"deleted": True, "id": note_id}


def run_code_response(payload: dict):
    code = payload.get("code", "")
    if not isinstance(code, str):
        return 400, {"error": "Code must be a string."}

    try:
        validate_code(code)
    except SyntaxError as error:
        return 400, {"stdout": "", "stderr": f"Syntax error: {error}"}
    except ValueError as error:
        return 400, {"stdout": "", "stderr": str(error)}

    context = mp.get_context("spawn")
    queue = context.Queue()
    process = context.Process(target=execute_code_worker, args=(code, queue))
    process.start()
    process.join(EXECUTION_TIMEOUT_SECONDS)

    if process.is_alive():
        process.terminate()
        process.join()
        return 408, {"stdout": "", "stderr": f"Execution timed out after {EXECUTION_TIMEOUT_SECONDS} seconds."}

    result = {"stdout": "", "stderr": ""}
    if not queue.empty():
        result = queue.get()

    return 200, result


def route_request(method: str, path: str, payload: dict | None):
    if method == "GET" and path == "/health":
        return 200, {"status": "ok", "database_path": str(DB_PATH)}

    if method == "GET" and path == "/folders":
        return list_folders_response()
    if method == "POST" and path == "/folders":
        return create_folder_response(payload or {})

    match = re.fullmatch(r"/folders/(\d+)", path)
    if match:
        folder_id = int(match.group(1))
        if method == "PUT":
            return update_folder_response(folder_id, payload or {})
        if method == "DELETE":
            return delete_folder_response(folder_id)

    if method == "GET" and path == "/blocks":
        return list_blocks_response()
    if method == "POST" and path == "/blocks":
        return create_block_response(payload or {})

    match = re.fullmatch(r"/blocks/(\d+)", path)
    if match:
        block_id = int(match.group(1))
        if method == "GET":
            return get_block_response(block_id)
        if method == "PUT":
            return update_block_response(block_id, payload or {})
        if method == "DELETE":
            return delete_block_response(block_id)

    if method == "GET" and path == "/note-folders":
        return list_note_folders_response()
    if method == "POST" and path == "/note-folders":
        return create_note_folder_response(payload or {})

    match = re.fullmatch(r"/note-folders/(\d+)", path)
    if match:
        folder_id = int(match.group(1))
        if method == "PUT":
            return update_note_folder_response(folder_id, payload or {})
        if method == "DELETE":
            return delete_note_folder_response(folder_id)

    if method == "GET" and path == "/notes":
        return list_notes_response()
    if method == "POST" and path == "/notes":
        return create_note_response(payload or {})

    match = re.fullmatch(r"/notes/(\d+)", path)
    if match:
        note_id = int(match.group(1))
        if method == "GET":
            return get_note_response(note_id)
        if method == "PUT":
            return update_note_response(note_id, payload or {})
        if method == "DELETE":
            return delete_note_response(note_id)

    if method == "POST" and path == "/run":
        return run_code_response(payload or {})

    return 404, {"error": "Route not found."}


class MyPyRequestHandler(BaseHTTPRequestHandler):
    server_version = "myPyHTTP/1.0"

    def do_GET(self):
        self.handle_request("GET")

    def do_POST(self):
        self.handle_request("POST")

    def do_PUT(self):
        self.handle_request("PUT")

    def do_DELETE(self):
        self.handle_request("DELETE")

    def log_message(self, format_, *args):
        return

    def handle_request(self, method: str):
        parsed = urlparse(self.path)
        raw_path = parsed.path or "/"
        path = raw_path.rstrip("/") or "/"

        if method == "GET" and (path in {"/", "/index.html"} or path.endswith("/index.html")):
            self.send_file(INDEX_FILE)
            return

        if method == "GET" and (
            path in {"/notes-app", "/notes.html"} or path.endswith("/notes-app") or path.endswith("/notes.html")
        ):
            self.send_file(NOTES_FILE)
            return

        if method == "GET" and (
            path in {"/calendar", "/calendar.html"} or path.endswith("/calendar") or path.endswith("/calendar.html")
        ):
            self.send_file(CALENDAR_FILE)
            return

        if method == "GET" and "/static/" in raw_path:
            _, static_suffix = raw_path.split("/static/", 1)
            self.send_static_file(f"/static/{static_suffix}")
            return

        payload = None
        if method in {"POST", "PUT"}:
            payload = self.read_json_body()
            if isinstance(payload, tuple):
                status, body = payload
                self.send_json(status, body)
                return

        status, body = route_request(method, path, payload)
        self.send_json(status, body)

    def read_json_body(self):
        content_length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(content_length) if content_length else b""

        if not raw_body:
            return {}

        try:
            parsed = json.loads(raw_body.decode("utf-8"))
        except json.JSONDecodeError:
            return 400, {"error": "Invalid JSON body."}

        if not isinstance(parsed, dict):
            return 400, {"error": "JSON body must be an object."}

        return parsed

    def send_json(self, status: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, file_path: Path):
        if not file_path.exists():
            self.send_json(404, {"error": "File not found."})
            return

        content = file_path.read_bytes()
        content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        if content_type.startswith("text/"):
            content_type = f"{content_type}; charset=utf-8"

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(content)

    def send_static_file(self, request_path: str):
        relative_path = request_path.removeprefix("/static/")
        target_path = (STATIC_DIR / relative_path).resolve()

        if not str(target_path).startswith(str(STATIC_DIR.resolve())) or not target_path.is_file():
            self.send_json(404, {"error": "Static file not found."})
            return

        self.send_file(target_path)


def run_server():
    init_db()
    host = "0.0.0.0"
    port = int(os.environ.get("PORT", "5000"))
    server = ThreadingHTTPServer((host, port), MyPyRequestHandler)
    print(f"Serving myPy on http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    run_server()
