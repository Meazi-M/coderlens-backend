const db = require('../../config/db');
const { notifyTelemetryUpdate } = require('../../websocket/wsServer');

function ensureTelemetryUser() {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get('telemetry@coderlens.local');
    if (existing) return existing.id;

    const result = db.prepare(`
        INSERT INTO users (name, email, password, role)
        VALUES (?, ?, ?, ?)
    `).run('Telemetry User', 'telemetry@coderlens.local', null, 'developer');

    return result.lastInsertRowid;
}

function ensureUserExists(userId) {
    const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (existing) return userId;
    return ensureTelemetryUser();
}

function resolveUserId(req, payload) {
    if (req.user && req.user.id) return req.user.id;

    const bodyUserId = Number(payload?.userId || payload?.user_id || req.query?.userId);
    if (Number.isInteger(bodyUserId) && bodyUserId > 0) {
        return bodyUserId;
    }

    return ensureTelemetryUser();
}

function resolveProjectName(rec) {
    if (rec.projectName) return rec.projectName;

    if (rec.gitRepo && rec.gitRepo !== 'local') {
        return rec.gitRepo.split('/').pop().replace(/\.git$/, '');
    }

    const filePath = typeof rec.filePath === 'string' ? rec.filePath : '';
    const parts = filePath.split(/[\\/]/).filter(Boolean); // handles both / and \
    return parts[0] || 'local-project';
}

function toLocalSqlDate(dateInput) {
    const d = dateInput ? new Date(dateInput) : new Date();
    if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 19).replace('T', ' ');
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function ingestActivity(req, res) {
    console.log("📩 Telemetry request received");
    console.log(req.body);
    try {
        const payload = req.body || {};
        const userId = ensureUserExists(resolveUserId(req, payload));
        const events = Array.isArray(payload.events) ? payload.events : [];
        const batchTimestamp = toLocalSqlDate(payload.timestamp);

        if (!Array.isArray(events) || events.length === 0)
            return res.status(200).json({ status: 'ok', inserted: 0 });

        db.prepare("UPDATE users SET last_seen = datetime('now') WHERE id = ?").run(userId);

        const insert = db.prepare(`
            INSERT INTO telemetry (
                user_id, file_path, file_name, language_id,
                project_name, project_framework, git_branch, git_repo,
                active_seconds, lines_added, lines_deleted, lines_modified,
                raw_code_changes, last_commit_hash, last_commit_message, last_commit_timestamp, last_commit_status, recorded_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertMany = db.transaction((evts) => {
            for (const rec of evts) {
                const projectName = resolveProjectName(rec);
                const hasRemote = !!(rec.gitRepo && rec.gitRepo !== 'local');

                if (rec.lastCommitStatus === 'committed') {
                    db.prepare(`
                        UPDATE telemetry
                        SET last_commit_status = 'committed',
                            last_commit_hash = ?,
                            last_commit_message = ?,
                            last_commit_timestamp = ?
                        WHERE user_id = ?
                          AND project_name = ?
                          AND (? = 0 OR git_repo = ?)
                          AND last_commit_status = 'uncommitted'
                    `).run(
                        rec.lastCommitHash || 'none',
                        rec.lastCommitMessage || '',
                        rec.lastCommitTimestamp || '',
                        userId,
                        projectName,
                        hasRemote ? 1 : 0,
                        rec.gitRepo || ''
                    );

                    db.prepare(`
                        UPDATE projects
                        SET last_commit_status = 'committed',
                            last_commit_hash = ?,
                            last_commit_message = ?,
                            last_commit_timestamp = ?
                        WHERE user_id = ?
                          AND (repo_name = ? OR name = ?)
                          AND last_commit_status = 'uncommitted'
                    `).run(
                        rec.lastCommitHash || 'none',
                        rec.lastCommitMessage || '',
                        rec.lastCommitTimestamp || '',
                        userId,
                        projectName,
                        projectName
                    );
                }

                const activeSecs   = Number(rec.activeSeconds ?? rec.active_seconds) || 0;
                const linesAdded   = Number(rec.linesAdded ?? rec.lines_added) || 0;
                const linesDeleted = Number(rec.linesDeleted ?? rec.lines_deleted) || 0;
                const linesModified = Number(rec.linesModified ?? rec.lines_modified) || 0;

                // Skip rows with zero activity AND zero line changes — commit updates
                // are already handled by the UPDATE above, no new row needed.
                if (activeSecs === 0 && linesAdded === 0 && linesDeleted === 0 && linesModified === 0) {
                    continue;
                }

                insert.run(
                    userId,
                    rec.filePath || '',
                    rec.fileName || '',
                    rec.languageId || 'unknown',
                    projectName,
                    rec.projectFramework || 'none',
                    rec.gitBranch || 'none',
                    rec.gitRepo || 'local',
                    activeSecs,
                    linesAdded,
                    linesDeleted,
                    linesModified,
                    JSON.stringify(rec.rawCodeChanges || []),
                    rec.lastCommitHash || 'none',
                    rec.lastCommitMessage || '',
                    rec.lastCommitTimestamp || '',
                    rec.lastCommitStatus || 'unknown',
                    batchTimestamp
                );
            }
        });

        insertMany(events);
        upsertProjects(userId, events, batchTimestamp);
        try { notifyTelemetryUpdate(userId); } catch (e) { console.error('[ws] notification failed:', e); }

        return res.status(200).json({ status: 'success', inserted: events.length });
    } catch (err) {
        console.error('[telemetry] ingest error:', err);
        return res.status(500).json({ error: 'Failed to ingest telemetry' });
    }
}

function upsertProjects(userId, events, timestamp) {
    const seen = new Set();

    for (const rec of events) {
        const projectName = resolveProjectName(rec);
        if (seen.has(projectName)) continue;
        seen.add(projectName);

        const existing = db.prepare(
            'SELECT id FROM projects WHERE user_id = ? AND repo_name = ?'
        ).get(userId, projectName);

        if (existing) {
            db.prepare(`
                UPDATE projects
                SET last_seen = ?, status = 'in_progress', last_commit_hash = ?, last_commit_message = ?, last_commit_timestamp = ?, last_commit_status = ?
                WHERE id = ?
            `).run(timestamp, rec.lastCommitHash || 'none', rec.lastCommitMessage || '', rec.lastCommitTimestamp || '', rec.lastCommitStatus || 'unknown', existing.id);
        } else {
            db.prepare(`
                INSERT INTO projects (user_id, name, repo_name, framework, first_seen, last_seen, last_commit_hash, last_commit_message, last_commit_timestamp, last_commit_status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(userId, projectName, projectName, rec.projectFramework || 'none', timestamp, timestamp, rec.lastCommitHash || 'none', rec.lastCommitMessage || '', rec.lastCommitTimestamp || '', rec.lastCommitStatus || 'unknown');
        }
    }
}

function getSummary(req, res) {
    const userId = req.user.id;
    const to = req.query.to || new Date().toISOString();
    const from = req.query.from || new Date(Date.now() - 86400000).toISOString();

    const rows = db.prepare(`
        SELECT
            project_name,
            language_id,
            git_branch,
            SUM(active_seconds) AS total_seconds,
            SUM(lines_added)    AS total_added,
            SUM(lines_deleted)  AS total_deleted,
            SUM(lines_modified) AS total_modified,
            COUNT(*)            AS sessions
        FROM telemetry
        WHERE user_id = ? AND recorded_at BETWEEN ? AND ?
        GROUP BY project_name, language_id, git_branch
        ORDER BY total_seconds DESC
    `).all(userId, from, to);

    return res.json({ from, to, summary: rows });
}

module.exports = { ingestActivity, getSummary };