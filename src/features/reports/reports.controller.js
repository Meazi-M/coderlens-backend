const db = require('../../config/db');

function canView(requesterId, requesterRole, developerId) {
    if (requesterRole === 'developer') return requesterId === developerId;
    return !!db.prepare(`
        SELECT id FROM connections
        WHERE recruiter_id = ? AND developer_id = ? AND status = 'active'
    `).get(requesterId, developerId);
}

function dailyReport(req, res) {
    const devId = parseInt(req.params.devId, 10);
    if (!canView(req.user.id, req.user.role, devId))
        return res.status(403).json({ error: 'Access denied' });

    const date = req.query.date || new Date().toISOString().slice(0, 10);

    const files = db.prepare(`
        SELECT file_name, language_id, project_name, git_branch,
               SUM(active_seconds) AS active_seconds,
               SUM(lines_added)    AS lines_added,
               SUM(lines_deleted)  AS lines_deleted,
               SUM(lines_modified) AS lines_modified
        FROM telemetry
        WHERE user_id = ? AND recorded_at LIKE ?
        GROUP BY file_name, language_id, project_name, git_branch
        ORDER BY active_seconds DESC
    `).all(devId, `${date}%`);

    const totals = files.reduce((acc, r) => ({
        active_seconds: acc.active_seconds + r.active_seconds,
        lines_added:    acc.lines_added    + r.lines_added,
        lines_deleted:  acc.lines_deleted  + r.lines_deleted,
        lines_modified: acc.lines_modified + r.lines_modified,
    }), { active_seconds: 0, lines_added: 0, lines_deleted: 0, lines_modified: 0 });

    return res.json({ date, totals, files });
}

function weeklyReport(req, res) {
    const devId = parseInt(req.params.devId, 10);
    if (!canView(req.user.id, req.user.role, devId))
        return res.status(403).json({ error: 'Access denied' });

    const days = db.prepare(`
        SELECT substr(recorded_at, 1, 10) AS date,
               SUM(active_seconds) AS active_seconds,
               SUM(lines_added)    AS lines_added,
               SUM(lines_deleted)  AS lines_deleted,
               SUM(lines_modified) AS lines_modified,
               COUNT(DISTINCT project_name) AS projects_worked
        FROM telemetry
        WHERE user_id = ? AND recorded_at >= datetime('now', '-7 days')
        GROUP BY date ORDER BY date ASC
    `).all(devId);

    return res.json({ period: 'weekly', days });
}

function monthlyReport(req, res) {
    const devId = parseInt(req.params.devId, 10);
    if (!canView(req.user.id, req.user.role, devId))
        return res.status(403).json({ error: 'Access denied' });

    const days = db.prepare(`
        SELECT substr(recorded_at, 1, 10) AS date,
               SUM(active_seconds) AS active_seconds,
               SUM(lines_added)    AS lines_added,
               SUM(lines_deleted)  AS lines_deleted,
               SUM(lines_modified) AS lines_modified,
               COUNT(DISTINCT project_name) AS projects_worked
        FROM telemetry
        WHERE user_id = ? AND recorded_at >= datetime('now', '-30 days')
        GROUP BY date ORDER BY date ASC
    `).all(devId);

    return res.json({ period: 'monthly', days });
}

function calendarReport(req, res) {
    const devId = parseInt(req.params.devId, 10);
    if (!canView(req.user.id, req.user.role, devId))
        return res.status(403).json({ error: 'Access denied' });

    const weeks = Math.min(parseInt(req.query.weeks || '12', 10), 52);
    const days = weeks * 7;

    const rows = db.prepare(`
        SELECT substr(recorded_at, 1, 10) AS date,
               ROUND(SUM(active_seconds) / 3600.0, 2) AS hours_coded,
               SUM(lines_added) AS lines_added
        FROM telemetry
        WHERE user_id = ? AND recorded_at >= datetime('now', '-${days} days')
        GROUP BY date ORDER BY date ASC
    `).all(devId);

    return res.json({ weeks, days: rows });
}

module.exports = { dailyReport, weeklyReport, monthlyReport, calendarReport };