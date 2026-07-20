const db = require('../../config/db');

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

function ingestActivity(req, res) {
    console.log("📩 Telemetry request received");
    console.log(req.body);
    try {
        const payload = req.body || {};
        const userId = ensureUserExists(resolveUserId(req, payload));
        const events = Array.isArray(payload.events) ? payload.events : [];
        const batchTimestamp = payload.timestamp || new Date().toISOString();

        if (!Array.isArray(events) || events.length === 0)
            return res.status(200).json({ status: 'ok', inserted: 0 });

        const insert = db.prepare(`
            INSERT INTO telemetry (
                user_id, file_path, file_name, language_id,
                project_name, project_framework, git_branch, git_repo,
                active_seconds, lines_added, lines_deleted, lines_modified,
                raw_code_changes, recorded_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertMany = db.transaction((evts) => {
            for (const rec of evts) {
                const filePath = typeof rec.filePath === 'string' ? rec.filePath : '';
                const projectName = rec.gitRepo && rec.gitRepo !== 'local'
                    ? rec.gitRepo.split('/').pop()
                    : (filePath.split('/')[0] || 'unknown');

                insert.run(
                    userId,
                    rec.filePath || '',
                    rec.fileName || '',
                    rec.languageId || 'unknown',
                    projectName,
                    rec.projectFramework || 'none',
                    rec.gitBranch || 'none',
                    rec.gitRepo || 'local',
                    Number(rec.activeSeconds) || 0,
                    Number(rec.linesAdded) || 0,
                    Number(rec.linesDeleted) || 0,
                    Number(rec.linesModified) || 0,
                    JSON.stringify(rec.rawCodeChanges || []),
                    batchTimestamp
                );
            }
        });

        insertMany(events);
        upsertProjects(userId, events, batchTimestamp);

        return res.status(200).json({ status: 'success', inserted: events.length });
    } catch (err) {
        console.error('[telemetry] ingest error:', err);
        return res.status(500).json({ error: 'Failed to ingest telemetry' });
    }
}

function upsertProjects(userId, events, timestamp) {
    const seen = new Set();

    for (const rec of events) {
        const repoName = rec.gitRepo && rec.gitRepo !== 'local'
            ? rec.gitRepo.split('/').pop()
            : (rec.filePath.split('/')[0] || null);

        if (!repoName || seen.has(repoName)) continue;
        seen.add(repoName);

        const existing = db.prepare(
            'SELECT id FROM projects WHERE user_id = ? AND repo_name = ?'
        ).get(userId, repoName);

        if (existing) {
            db.prepare(`
                UPDATE projects SET last_seen = ?, status = 'in_progress' WHERE id = ?
            `).run(timestamp, existing.id);
        } else {
            db.prepare(`
                INSERT INTO projects (user_id, name, repo_name, framework, first_seen, last_seen)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(userId, repoName, repoName, rec.projectFramework || 'none', timestamp, timestamp);
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