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

function ensureColumn(tableName, columnName, definition) {
    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
    if (columns.some((column) => column.name === columnName)) {
        return;
    }
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

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
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name                TEXT    NOT NULL,
        description         TEXT,
        repo_name           TEXT,
        framework           TEXT,
        status              TEXT    NOT NULL DEFAULT 'in_progress'
                                      CHECK(status IN ('planned','in_progress','on_hold','shipped')),
        is_manual           INTEGER NOT NULL DEFAULT 0,
        first_seen          TEXT,
        last_seen           TEXT,
        last_commit_hash    TEXT,
        last_commit_message TEXT,
        last_commit_timestamp TEXT,
        created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS commits (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_name   TEXT    NOT NULL,
        git_branch     TEXT,
        git_repo       TEXT,
        commit_hash    TEXT    NOT NULL,
        commit_message TEXT,
        committed_at   TEXT    NOT NULL,
        created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
        UNIQUE(user_id, project_name, commit_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_telemetry_user_date ON telemetry(user_id, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_telemetry_project   ON telemetry(user_id, project_name);
    CREATE INDEX IF NOT EXISTS idx_connections_recruiter ON connections(recruiter_id, status);
    CREATE INDEX IF NOT EXISTS idx_connections_developer ON connections(developer_id, status);
    CREATE INDEX IF NOT EXISTS idx_commits_user_date     ON commits(user_id, committed_at);
`);

ensureColumn('telemetry', 'last_commit_hash', 'TEXT');
ensureColumn('telemetry', 'last_commit_message', 'TEXT');
ensureColumn('telemetry', 'last_commit_timestamp', 'TEXT');
ensureColumn('telemetry', 'last_commit_status', 'TEXT');
ensureColumn('projects', 'last_commit_hash', 'TEXT');
ensureColumn('projects', 'last_commit_message', 'TEXT');
ensureColumn('projects', 'last_commit_timestamp', 'TEXT');
ensureColumn('projects', 'last_commit_status', 'TEXT');

// Migrate projects table to support 'on_hold' status
// SQLite doesn't allow ALTER COLUMN so we recreate the table if the old constraint is present.
try {
    const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='projects'").get();
    if (tableInfo && tableInfo.sql && tableInfo.sql.includes("'planned','in_progress','shipped'") && !tableInfo.sql.includes("'on_hold'")) {
        db.exec(`
            PRAGMA foreign_keys = OFF;
            CREATE TABLE projects_new (
                id                    INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name                  TEXT    NOT NULL,
                description           TEXT,
                repo_name             TEXT,
                framework             TEXT,
                status                TEXT    NOT NULL DEFAULT 'in_progress'
                                              CHECK(status IN ('planned','in_progress','on_hold','shipped')),
                is_manual             INTEGER NOT NULL DEFAULT 0,
                first_seen            TEXT,
                last_seen             TEXT,
                last_commit_hash      TEXT,
                last_commit_message   TEXT,
                last_commit_timestamp TEXT,
                last_commit_status    TEXT,
                created_at            TEXT    NOT NULL DEFAULT (datetime('now'))
            );
            INSERT INTO projects_new SELECT id, user_id, name, description, repo_name, framework,
                status, is_manual, first_seen, last_seen, last_commit_hash, last_commit_message,
                last_commit_timestamp, last_commit_status, created_at FROM projects;
            DROP TABLE projects;
            ALTER TABLE projects_new RENAME TO projects;
            CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
            PRAGMA foreign_keys = ON;
        `);
        console.log('[db] Migrated projects table: added on_hold status support');
    }
} catch (e) {
    console.error('[db] Migration error (non-fatal):', e.message);
}

module.exports = db;