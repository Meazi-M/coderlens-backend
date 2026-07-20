const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const DB_DIR = path.join(__dirname, '../../data');
const DB_FILE = path.join(DB_DIR, 'coderlens.db');
if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
}
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        name           TEXT    NOT NULL,
        email          TEXT    NOT NULL UNIQUE,
        password       TEXT,
        role           TEXT    NOT NULL CHECK(role IN ('developer', 'recruiter')),
        avatar_url     TEXT,
        oauth_provider TEXT,
        oauth_id       TEXT,
        created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
        last_seen      TEXT
    );
    CREATE TABLE IF NOT EXISTS connections (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        recruiter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        developer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status       TEXT    NOT NULL DEFAULT 'pending'
                             CHECK(status IN ('pending','active','paused','terminated')),
        initiated_at  TEXT   NOT NULL DEFAULT (datetime('now')),
        responded_at  TEXT,
        terminated_at TEXT,
        UNIQUE(recruiter_id, developer_id)
    );
    CREATE TABLE IF NOT EXISTS telemetry (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        file_path         TEXT    NOT NULL,
        file_name         TEXT    NOT NULL,
        language_id       TEXT,
        project_name      TEXT,
        project_framework TEXT,
        git_branch        TEXT,
        git_repo          TEXT,
        active_seconds    REAL    NOT NULL DEFAULT 0,
        lines_added       INTEGER NOT NULL DEFAULT 0,
        lines_deleted     INTEGER NOT NULL DEFAULT 0,
        lines_modified    INTEGER NOT NULL DEFAULT 0,
        raw_code_changes  TEXT,
        recorded_at       TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name        TEXT    NOT NULL,
        description TEXT,
        repo_name   TEXT,
        framework   TEXT,
        status      TEXT    NOT NULL DEFAULT 'in_progress'
                            CHECK(status IN ('planned','in_progress','shipped')),
        is_manual   INTEGER NOT NULL DEFAULT 0,
        first_seen  TEXT,
        last_seen   TEXT,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_telemetry_user_date ON telemetry(user_id, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_telemetry_project   ON telemetry(user_id, project_name);
    CREATE INDEX IF NOT EXISTS idx_connections_recruiter ON connections(recruiter_id, status);
    CREATE INDEX IF NOT EXISTS idx_connections_developer ON connections(developer_id, status);
`);