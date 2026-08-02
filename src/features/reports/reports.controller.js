const db = require('../../config/db');

function canView(requesterId, requesterRole, developerId) {
    if (requesterRole === 'developer') return requesterId === developerId;
    return !!db.prepare(`
        SELECT id FROM connections
        WHERE recruiter_id = ? AND developer_id = ? AND status = 'active'
    `).get(requesterId, developerId);
}

// Internal helper — shared by dailyReport and dailyReportMe
function _dailyReport(res, devId, dateParam) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    let date = dateParam || `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

    let files = db.prepare(`
        SELECT
            file_path,
            file_name,
            language_id,
            project_name,
            git_branch,
            SUM(active_seconds)  AS active_seconds,
            SUM(lines_added)     AS lines_added,
            SUM(lines_deleted)   AS lines_deleted,
            SUM(lines_modified)  AS lines_modified
        FROM telemetry
        WHERE user_id = ? AND (recorded_at LIKE ? OR substr(recorded_at, 1, 10) = ?)
          AND project_name != 'unknown'
        GROUP BY file_path, file_name, language_id, project_name
        ORDER BY active_seconds DESC
    `).all(devId, `${date}%`, date);

    // If no records found for exact date string, fallback to developer's most recent activity date if within 24 hours
    if (files.length === 0 && !dateParam) {
        const latestRow = db.prepare(`
            SELECT substr(recorded_at, 1, 10) as recent_date FROM telemetry
            WHERE user_id = ? AND recorded_at >= datetime('now', '-24 hours')
            ORDER BY id DESC LIMIT 1
        `).get(devId);
        if (latestRow && latestRow.recent_date) {
            date = latestRow.recent_date;
            files = db.prepare(`
                SELECT
                    file_path, file_name, language_id, project_name, git_branch,
                    SUM(active_seconds)  AS active_seconds,
                    SUM(lines_added)     AS lines_added,
                    SUM(lines_deleted)   AS lines_deleted,
                    SUM(lines_modified)  AS lines_modified
                FROM telemetry
                WHERE user_id = ? AND (recorded_at LIKE ? OR substr(recorded_at, 1, 10) = ?)
                  AND project_name != 'unknown'
                GROUP BY file_path, file_name, language_id, project_name
                ORDER BY active_seconds DESC
            `).all(devId, `${date}%`, date);
        }
    }

    const totals = files.reduce((acc, r) => ({
        active_seconds: acc.active_seconds + r.active_seconds,
        lines_added:    acc.lines_added    + r.lines_added,
        lines_deleted:  acc.lines_deleted  + r.lines_deleted,
        lines_modified: acc.lines_modified + r.lines_modified,
    }), { active_seconds: 0, lines_added: 0, lines_deleted: 0, lines_modified: 0 });

    return res.json({ date, totals, files });
}

function dailyReport(req, res) {
    const devId = parseInt(req.params.devId, 10);
    if (!canView(req.user.id, req.user.role, devId))
        return res.status(403).json({ error: 'Access denied' });
    return _dailyReport(res, devId, req.query.date);
}

// Self-serve: the logged-in developer can GET /reports/daily/me?date=YYYY-MM-DD
function dailyReportMe(req, res) {
    if (req.user.role !== 'developer')
        return res.status(403).json({ error: 'Only developers can view their own reports' });
    return _dailyReport(res, req.user.id, req.query.date);
}

function weeklyReport(req, res) {
    const devId = parseInt(req.params.devId, 10);
    if (!canView(req.user.id, req.user.role, devId))
        return res.status(403).json({ error: 'Access denied' });

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const refDate = req.query.date || `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

    const files = db.prepare(`
        SELECT
            file_path,
            file_name,
            language_id,
            project_name,
            git_branch,
            SUM(active_seconds)  AS active_seconds,
            SUM(lines_added)     AS lines_added,
            SUM(lines_deleted)   AS lines_deleted,
            SUM(lines_modified)  AS lines_modified
        FROM telemetry
        WHERE user_id = ?
          AND recorded_at >= date(?, '-6 days')
          AND recorded_at <= date(?, '+1 day')
          AND project_name != 'unknown'
        GROUP BY file_path, file_name, language_id, project_name
        ORDER BY active_seconds DESC
    `).all(devId, refDate, refDate);

    const totals = files.reduce((acc, r) => ({
        active_seconds: acc.active_seconds + r.active_seconds,
        lines_added:    acc.lines_added    + r.lines_added,
        lines_deleted:  acc.lines_deleted  + r.lines_deleted,
        lines_modified: acc.lines_modified + r.lines_modified,
    }), { active_seconds: 0, lines_added: 0, lines_deleted: 0, lines_modified: 0 });

    const days = db.prepare(`
        SELECT substr(recorded_at, 1, 10) AS date,
               SUM(active_seconds) AS active_seconds,
               SUM(lines_added)    AS lines_added,
               SUM(lines_deleted)  AS lines_deleted,
               SUM(lines_modified) AS lines_modified,
               COUNT(DISTINCT project_name) AS projects_worked
        FROM telemetry
        WHERE user_id = ?
          AND recorded_at >= date(?, '-6 days')
          AND recorded_at <= date(?, '+1 day')
        GROUP BY date ORDER BY date ASC
    `).all(devId, refDate, refDate);

    return res.json({ period: 'weekly', date: refDate, totals, files, days });
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

function _commitsReport(res, devId, yearParam) {
    const year = parseInt(yearParam || new Date().getFullYear(), 10);
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    const dailyContributions = db.prepare(`
        SELECT date, SUM(cnt) AS count FROM (
            SELECT substr(committed_at, 1, 10) AS date, COUNT(*) AS cnt
            FROM commits
            WHERE user_id = ? AND substr(committed_at, 1, 10) BETWEEN ? AND ?
            GROUP BY date
            UNION ALL
            SELECT substr(recorded_at, 1, 10) AS date, COUNT(DISTINCT id) AS cnt
            FROM telemetry
            WHERE user_id = ? AND active_seconds > 0 AND substr(recorded_at, 1, 10) BETWEEN ? AND ?
            GROUP BY date
        ) GROUP BY date ORDER BY date ASC
    `).all(devId, startDate, endDate, devId, startDate, endDate);

    const commits = db.prepare(`
        SELECT id, project_name, git_branch, git_repo, commit_hash, commit_message, committed_at
        FROM commits
        WHERE user_id = ? AND substr(committed_at, 1, 10) BETWEEN ? AND ?
        ORDER BY committed_at DESC
    `).all(devId, startDate, endDate);

    const totalCommits = commits.length;

    return res.json({ year, totalCommits, dailyContributions, commits });
}

function getCommitsReport(req, res) {
    const devId = parseInt(req.params.devId, 10);
    if (!canView(req.user.id, req.user.role, devId))
        return res.status(403).json({ error: 'Access denied' });
    return _commitsReport(res, devId, req.query.year);
}

function getCommitsReportMe(req, res) {
    if (req.user.role !== 'developer')
        return res.status(403).json({ error: 'Only developers can view their commit reports' });
    return _commitsReport(res, req.user.id, req.query.year);
}

module.exports = { dailyReport, dailyReportMe, weeklyReport, monthlyReport, calendarReport, getCommitsReport, getCommitsReportMe };