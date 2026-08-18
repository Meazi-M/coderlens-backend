const { Op, QueryTypes } = require('sequelize');
const { sequelize, Connection } = require('../../config/db');

// ── helpers ───────────────────────────────────────────────────────────────────

async function getRecruiterConnection(requesterId, requesterRole, developerId) {
    if (requesterRole === 'developer') return null;
    return await Connection.findOne({
        where: {
            recruiter_id: requesterId,
            developer_id: developerId,
            status: { [Op.in]: ['active', 'paused'] },
        },
    });
}

/**
 * Builds a SQL AND clause that excludes rows recorded during pause intervals.
 * Works for a single connection object (recruiter viewing developer).
 */
function buildPauseExclusionSql(conn) {
    if (!conn) return '';

    const conditions = [];

    // Exclude currently ongoing pause period
    if (conn.status === 'paused' && conn.paused_at) {
        const pauseStartIso = new Date(conn.paused_at).toISOString();
        conditions.push(`recorded_at < '${pauseStartIso}'`);
    }

    // Exclude past completed pause intervals
    let intervals = [];
    try { intervals = JSON.parse(conn.pause_intervals || '[]'); } catch (e) {}

    for (const interval of intervals) {
        if (interval.start && interval.end) {
            conditions.push(`NOT (recorded_at >= '${interval.start}' AND recorded_at <= '${interval.end}')`);
        }
    }

    if (conditions.length === 0) return '';
    return ' AND (' + conditions.join(' AND ') + ')';
}

/**
 * For a DEVELOPER viewing their own reports:
 * Merges pause intervals from ALL recruiter connections where paused_by = 'recruiter'.
 * This hides the recruiter-paused periods from the developer's own view too.
 */
async function buildDeveloperSelfPauseFilter(developerId) {
    const recruiterPausedConns = await Connection.findAll({
        where: {
            developer_id: developerId,
            status: { [Op.in]: ['active', 'paused'] },
        },
    });

    const conditions = [];

    for (const conn of recruiterPausedConns) {
        // Only apply self-filter for connections paused BY the recruiter
        if (conn.paused_by !== 'recruiter') continue;

        // Ongoing pause by recruiter
        if (conn.status === 'paused' && conn.paused_at) {
            const pauseStartIso = new Date(conn.paused_at).toISOString();
            conditions.push(`recorded_at < '${pauseStartIso}'`);
        }

        // Past recruiter-paused intervals
        let intervals = [];
        try { intervals = JSON.parse(conn.pause_intervals || '[]'); } catch (e) {}

        for (const interval of intervals) {
            if (interval.start && interval.end && interval.paused_by === 'recruiter') {
                conditions.push(`NOT (recorded_at >= '${interval.start}' AND recorded_at <= '${interval.end}')`);
            }
        }
    }

    if (conditions.length === 0) return '';
    return ' AND (' + conditions.join(' AND ') + ')';
}

// ── daily report helper ───────────────────────────────────────────────────────

async function _dailyReport(res, devId, dateParam, connFilter = '') {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    let date = dateParam ||
        `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

    let files = await sequelize.query(`
        SELECT
            file_path,
            file_name,
            language_id,
            project_name,
            git_branch,
            COALESCE(SUM(active_seconds), 0)  AS active_seconds,
            COALESCE(SUM(lines_added), 0)     AS lines_added,
            COALESCE(SUM(lines_deleted), 0)   AS lines_deleted,
            COALESCE(SUM(lines_modified), 0)  AS lines_modified
        FROM telemetry
        WHERE user_id = :devId
          AND DATE(recorded_at) = :date
          AND project_name != 'unknown' ${connFilter}
        GROUP BY file_path, file_name, language_id, project_name, git_branch
        ORDER BY active_seconds DESC
    `, { replacements: { devId, date }, type: QueryTypes.SELECT });

    // Fallback: use most-recent date within last 24h if today has no data
    if (files.length === 0 && !dateParam) {
        const [latestRow] = await sequelize.query(`
            SELECT TO_CHAR(recorded_at, 'YYYY-MM-DD') AS recent_date
            FROM telemetry
            WHERE user_id = :devId AND recorded_at >= NOW() - INTERVAL '24 hours' ${connFilter}
            ORDER BY id DESC LIMIT 1
        `, { replacements: { devId }, type: QueryTypes.SELECT });

        if (latestRow && latestRow.recent_date) {
            date = latestRow.recent_date;
            files = await sequelize.query(`
                SELECT
                    file_path, file_name, language_id, project_name, git_branch,
                    COALESCE(SUM(active_seconds), 0)  AS active_seconds,
                    COALESCE(SUM(lines_added), 0)     AS lines_added,
                    COALESCE(SUM(lines_deleted), 0)   AS lines_deleted,
                    COALESCE(SUM(lines_modified), 0)  AS lines_modified
                FROM telemetry
                WHERE user_id = :devId
                  AND DATE(recorded_at) = :date
                  AND project_name != 'unknown' ${connFilter}
                GROUP BY file_path, file_name, language_id, project_name, git_branch
                ORDER BY active_seconds DESC
            `, { replacements: { devId, date }, type: QueryTypes.SELECT });
        }
    }

    const processedFiles = files.map(f => ({
        ...f,
        active_seconds: Number(f.active_seconds || 0),
        lines_added:    Number(f.lines_added || 0),
        lines_deleted:  Number(f.lines_deleted || 0),
        lines_modified: Number(f.lines_modified || 0),
    }));

    const totals = processedFiles.reduce((acc, r) => ({
        active_seconds: acc.active_seconds + r.active_seconds,
        lines_added:    acc.lines_added    + r.lines_added,
        lines_deleted:  acc.lines_deleted  + r.lines_deleted,
        lines_modified: acc.lines_modified + r.lines_modified,
    }), { active_seconds: 0, lines_added: 0, lines_deleted: 0, lines_modified: 0 });

    return res.json({ date, totals, files: processedFiles });
}

// ── recruiter viewing developer ───────────────────────────────────────────────

async function dailyReport(req, res) {
    const devId = parseInt(req.params.devId, 10);
    const conn = await getRecruiterConnection(req.user.id, req.user.role, devId);
    if (req.user.role !== 'developer' && !conn)
        return res.status(403).json({ error: 'Access denied' });

    const pauseFilter = buildPauseExclusionSql(conn);
    return _dailyReport(res, devId, req.query.date, pauseFilter);
}

// ── developer viewing their own data ─────────────────────────────────────────

async function dailyReportMe(req, res) {
    if (req.user.role !== 'developer')
        return res.status(403).json({ error: 'Only developers can view their own reports' });
    // Apply recruiter-pause filter: hide periods where any recruiter paused the connection
    const selfFilter = await buildDeveloperSelfPauseFilter(req.user.id);
    return _dailyReport(res, req.user.id, req.query.date, selfFilter);
}

// ── weekly report ─────────────────────────────────────────────────────────────

async function weeklyReport(req, res) {
    const devId = parseInt(req.params.devId, 10);
    const isOwnReport = req.user.role === 'developer' && req.user.id === devId;

    let pauseFilter = '';
    if (isOwnReport) {
        pauseFilter = await buildDeveloperSelfPauseFilter(devId);
    } else {
        const conn = await getRecruiterConnection(req.user.id, req.user.role, devId);
        if (!conn) return res.status(403).json({ error: 'Access denied' });
        pauseFilter = buildPauseExclusionSql(conn);
    }

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const refDate = req.query.date ||
        `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

    const files = await sequelize.query(`
        SELECT
            file_path, file_name, language_id, project_name, git_branch,
            COALESCE(SUM(active_seconds), 0)  AS active_seconds,
            COALESCE(SUM(lines_added), 0)     AS lines_added,
            COALESCE(SUM(lines_deleted), 0)   AS lines_deleted,
            COALESCE(SUM(lines_modified), 0)  AS lines_modified
        FROM telemetry
        WHERE user_id = :devId
          AND DATE(recorded_at) >= :refDate::date - INTERVAL '6 days'
          AND DATE(recorded_at) <= :refDate::date + INTERVAL '1 day'
          AND project_name != 'unknown' ${pauseFilter}
        GROUP BY file_path, file_name, language_id, project_name, git_branch
        ORDER BY active_seconds DESC
    `, { replacements: { devId, refDate }, type: QueryTypes.SELECT });

    const processedFiles = files.map(f => ({
        ...f,
        active_seconds: Number(f.active_seconds || 0),
        lines_added:    Number(f.lines_added || 0),
        lines_deleted:  Number(f.lines_deleted || 0),
        lines_modified: Number(f.lines_modified || 0),
    }));

    const totals = processedFiles.reduce((acc, r) => ({
        active_seconds: acc.active_seconds + r.active_seconds,
        lines_added:    acc.lines_added    + r.lines_added,
        lines_deleted:  acc.lines_deleted  + r.lines_deleted,
        lines_modified: acc.lines_modified + r.lines_modified,
    }), { active_seconds: 0, lines_added: 0, lines_deleted: 0, lines_modified: 0 });

    const days = await sequelize.query(`
        SELECT
            TO_CHAR(recorded_at, 'YYYY-MM-DD') AS date,
            COALESCE(SUM(active_seconds), 0)  AS active_seconds,
            COALESCE(SUM(lines_added), 0)     AS lines_added,
            COALESCE(SUM(lines_deleted), 0)   AS lines_deleted,
            COALESCE(SUM(lines_modified), 0)  AS lines_modified,
            COUNT(DISTINCT project_name)      AS projects_worked
        FROM telemetry
        WHERE user_id = :devId
          AND DATE(recorded_at) >= :refDate::date - INTERVAL '6 days'
          AND DATE(recorded_at) <= :refDate::date + INTERVAL '1 day' ${pauseFilter}
        GROUP BY date ORDER BY date ASC
    `, { replacements: { devId, refDate }, type: QueryTypes.SELECT });

    return res.json({ period: 'weekly', date: refDate, totals, files: processedFiles, days });
}

// ── monthly report ────────────────────────────────────────────────────────────

async function monthlyReport(req, res) {
    const devId = parseInt(req.params.devId, 10);
    const isOwnReport = req.user.role === 'developer' && req.user.id === devId;

    let pauseFilter = '';
    if (isOwnReport) {
        pauseFilter = await buildDeveloperSelfPauseFilter(devId);
    } else {
        const conn = await getRecruiterConnection(req.user.id, req.user.role, devId);
        if (!conn) return res.status(403).json({ error: 'Access denied' });
        pauseFilter = buildPauseExclusionSql(conn);
    }

    const days = await sequelize.query(`
        SELECT
            TO_CHAR(recorded_at, 'YYYY-MM-DD') AS date,
            COALESCE(SUM(active_seconds), 0)  AS active_seconds,
            COALESCE(SUM(lines_added), 0)     AS lines_added,
            COALESCE(SUM(lines_deleted), 0)   AS lines_deleted,
            COALESCE(SUM(lines_modified), 0)  AS lines_modified,
            COUNT(DISTINCT project_name)      AS projects_worked
        FROM telemetry
        WHERE user_id = :devId AND recorded_at >= NOW() - INTERVAL '30 days' ${pauseFilter}
        GROUP BY date ORDER BY date ASC
    `, { replacements: { devId }, type: QueryTypes.SELECT });

    return res.json({ period: 'monthly', days });
}

// ── calendar report ───────────────────────────────────────────────────────────

async function calendarReport(req, res) {
    const devId = parseInt(req.params.devId, 10);
    const isOwnReport = req.user.role === 'developer' && req.user.id === devId;

    let pauseFilter = '';
    if (isOwnReport) {
        pauseFilter = await buildDeveloperSelfPauseFilter(devId);
    } else {
        const conn = await getRecruiterConnection(req.user.id, req.user.role, devId);
        if (!conn) return res.status(403).json({ error: 'Access denied' });
        pauseFilter = buildPauseExclusionSql(conn);
    }

    const weeks = Math.min(parseInt(req.query.weeks || '12', 10), 52);
    const days = weeks * 7;

    const rows = await sequelize.query(`
        SELECT
            TO_CHAR(recorded_at, 'YYYY-MM-DD') AS date,
            ROUND(SUM(active_seconds) / 3600.0, 2) AS hours_coded,
            COALESCE(SUM(lines_added), 0) AS lines_added
        FROM telemetry
        WHERE user_id = :devId AND recorded_at >= NOW() - INTERVAL '${days} days' ${pauseFilter}
        GROUP BY date ORDER BY date ASC
    `, { replacements: { devId }, type: QueryTypes.SELECT });

    return res.json({ weeks, days: rows });
}

// ── commits report ────────────────────────────────────────────────────────────

async function _commitsReport(res, devId, yearParam) {
    const year      = parseInt(yearParam || new Date().getFullYear(), 10);
    const startDate = `${year}-01-01`;
    const endDate   = `${year}-12-31`;

    const dailyContributions = await sequelize.query(`
        SELECT date, SUM(cnt) AS count FROM (
            SELECT TO_CHAR(committed_at, 'YYYY-MM-DD') AS date, COUNT(*) AS cnt
            FROM commits
            WHERE user_id = :devId
              AND TO_CHAR(committed_at, 'YYYY-MM-DD') BETWEEN :startDate AND :endDate
            GROUP BY date
            UNION ALL
            SELECT TO_CHAR(recorded_at, 'YYYY-MM-DD') AS date, COUNT(DISTINCT id) AS cnt
            FROM telemetry
            WHERE user_id = :devId
              AND active_seconds > 0
              AND TO_CHAR(recorded_at, 'YYYY-MM-DD') BETWEEN :startDate AND :endDate
            GROUP BY date
        ) sub
        GROUP BY date ORDER BY date ASC
    `, { replacements: { devId, startDate, endDate }, type: QueryTypes.SELECT });

    const commits = await sequelize.query(`
        SELECT id, project_name, git_branch, git_repo, commit_hash, commit_message, committed_at
        FROM commits
        WHERE user_id = :devId
          AND TO_CHAR(committed_at, 'YYYY-MM-DD') BETWEEN :startDate AND :endDate
        ORDER BY committed_at DESC
    `, { replacements: { devId, startDate, endDate }, type: QueryTypes.SELECT });

    return res.json({ year, totalCommits: commits.length, dailyContributions, commits });
}

async function getCommitsReport(req, res) {
    const devId = parseInt(req.params.devId, 10);
    const conn = await getRecruiterConnection(req.user.id, req.user.role, devId);
    if (req.user.role !== 'developer' && !conn)
        return res.status(403).json({ error: 'Access denied' });
    return _commitsReport(res, devId, req.query.year);
}

async function getCommitsReportMe(req, res) {
    if (req.user.role !== 'developer')
        return res.status(403).json({ error: 'Only developers can view their commit reports' });
    return _commitsReport(res, req.user.id, req.query.year);
}

module.exports = {
    dailyReport, dailyReportMe, weeklyReport, monthlyReport,
    calendarReport, getCommitsReport, getCommitsReportMe,
};