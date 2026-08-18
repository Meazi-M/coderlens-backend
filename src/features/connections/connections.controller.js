const { Op, QueryTypes } = require('sequelize');
const { sequelize, User, Connection, Telemetry } = require('../../config/db');
const { notifyConnectionUpdate, isDeveloperOnline } = require('../../websocket/wsServer');

async function sendRequest(req, res) {
    if (req.user.role !== 'recruiter')
        return res.status(403).json({ error: 'Only recruiters can send connection requests' });

    const { developerEmail } = req.body;
    if (!developerEmail)
        return res.status(400).json({ error: 'developerEmail is required' });

    const developer = await User.findOne({
        where: { email: developerEmail, role: 'developer' },
        attributes: ['id', 'name', 'email'],
    });
    if (!developer) return res.status(404).json({ error: 'No developer found with that email' });

    const existing = await Connection.findOne({
        where: { recruiter_id: req.user.id, developer_id: developer.id },
    });

    if (existing) {
        if (existing.status === 'terminated')
            return res.status(409).json({ error: 'This connection was permanently ended' });
        return res.status(409).json({ error: `Connection already exists: ${existing.status}` });
    }

    const conn = await Connection.create({
        recruiter_id: req.user.id,
        developer_id: developer.id,
    });

    try { notifyConnectionUpdate(req.user.id, developer.id); } catch (e) {}

    return res.json({ connection: conn.toJSON() });
}

async function respondToRequest(req, res) {
    if (req.user.role !== 'developer')
        return res.status(403).json({ error: 'Only developers can respond to requests' });

    const { action } = req.body;
    if (!['accept', 'reject'].includes(action))
        return res.status(400).json({ error: 'action must be accept or reject' });

    const conn = await Connection.findOne({
        where: { id: req.params.id, developer_id: req.user.id },
    });

    if (!conn) return res.status(404).json({ error: 'Connection not found' });
    if (conn.status !== 'pending')
        return res.status(400).json({ error: `Cannot respond to a ${conn.status} connection` });

    const newStatus = action === 'accept' ? 'active' : 'terminated';
    await conn.update({ status: newStatus, paused_by: null, paused_at: null, responded_at: new Date() });

    try { notifyConnectionUpdate(conn.recruiter_id, conn.developer_id); } catch (e) {}

    return res.json({ status: newStatus });
}

async function toggleConnection(req, res) {
    const conn = await Connection.findOne({
        where: {
            id: req.params.id,
            [Op.or]: [{ developer_id: req.user.id }, { recruiter_id: req.user.id }],
        },
    });

    if (!conn) return res.status(404).json({ error: 'Connection not found' });
    if (['terminated', 'pending'].includes(conn.status))
        return res.status(400).json({ error: `Cannot toggle a ${conn.status} connection` });

    const isPausing = !req.body.active;
    const userRole = req.user.role; // 'developer' or 'recruiter'

    // If attempting to RESUME (active: true), check if the current user is allowed to resume
    if (!isPausing) {
        if (conn.status === 'paused' && conn.paused_by && conn.paused_by !== userRole) {
            const roleLabel = conn.paused_by === 'developer' ? 'developer' : 'team lead';
            return res.status(403).json({
                error: `Tracking was paused by the ${roleLabel}. Only the user who paused it can resume.`
            });
        }
    }

    if (isPausing) {
        await conn.update({
            status: 'paused',
            paused_by: userRole,
            paused_at: new Date(),
        });
    } else {
        // Record completed pause interval for recruiter data isolation
        let intervals = [];
        try {
            intervals = JSON.parse(conn.pause_intervals || '[]');
        } catch (e) {
            intervals = [];
        }

        if (conn.paused_at) {
            intervals.push({
                start: new Date(conn.paused_at).toISOString(),
                end: new Date().toISOString(),
                paused_by: conn.paused_by, // 'developer' | 'recruiter' — used for self-filter in reports
            });
        }

        await conn.update({
            status: 'active',
            paused_by: null,
            paused_at: null,
            pause_intervals: JSON.stringify(intervals),
        });
    }

    try { notifyConnectionUpdate(conn.recruiter_id, conn.developer_id); } catch (e) {}

    return res.json({ status: conn.status, paused_by: conn.paused_by });
}

async function terminateConnection(req, res) {
    const conn = await Connection.findOne({
        where: {
            id: req.params.id,
            [Op.or]: [{ developer_id: req.user.id }, { recruiter_id: req.user.id }],
        },
    });

    if (!conn) return res.status(404).json({ error: 'Connection not found' });
    if (conn.status === 'terminated')
        return res.status(400).json({ error: 'Already terminated' });

    await conn.update({ status: 'terminated', paused_by: null, paused_at: null, terminated_at: new Date() });

    try { notifyConnectionUpdate(conn.recruiter_id, conn.developer_id); } catch (e) {}

    return res.json({ message: 'Connection permanently terminated' });
}

/**
 * Helper to build SQL WHERE conditions excluding telemetry recorded during pause periods for recruiter queries
 */
function buildPauseExclusionSql(conn) {
    const conditions = [];

    // Exclude currently ongoing pause period
    if (conn.status === 'paused' && conn.paused_at) {
        const pauseStartIso = new Date(conn.paused_at).toISOString();
        conditions.push(`recorded_at < '${pauseStartIso}'`);
    }

    // Exclude past completed pause intervals
    let intervals = [];
    try { intervals = JSON.parse(conn.pause_intervals || '[]'); } catch (e) {}

    if (Array.isArray(intervals) && intervals.length > 0) {
        for (const interval of intervals) {
            if (interval.start && interval.end) {
                conditions.push(`NOT (recorded_at >= '${interval.start}' AND recorded_at <= '${interval.end}')`);
            }
        }
    }

    if (conditions.length === 0) return '';
    return ' AND (' + conditions.join(' AND ') + ')';
}

async function getMyTeam(req, res) {
    if (req.user.role !== 'recruiter')
        return res.status(403).json({ error: 'Only recruiters can view their team' });

    const connections = await Connection.findAll({
        where: {
            recruiter_id: req.user.id,
            status: { [Op.in]: ['active', 'paused'] },
        },
        include: [{
            model: User,
            as: 'developer',
            attributes: ['id', 'name', 'email', 'avatar_url', 'last_seen'],
        }],
        order: [['status', 'ASC'], [{ model: User, as: 'developer' }, 'name', 'ASC']],
    });

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

    const enriched = await Promise.all(connections.map(async (connRec) => {
        const conn = connRec.toJSON();
        const dev = conn.developer;

        let isOnline = isDeveloperOnline(dev.id);
        if (conn.status === 'paused') {
            isOnline = false; // Hide live online status if stream is currently paused
        } else if (!isOnline && dev.last_seen) {
            const lastSeenTime = new Date(dev.last_seen).getTime();
            if (!isNaN(lastSeenTime) && (Date.now() - lastSeenTime) < 5 * 60 * 1000) {
                isOnline = true;
            }
        }

        const base = {
            connection_id: conn.id,
            status:        conn.status,
            paused_by:     conn.paused_by || null,
            initiated_at:  conn.initiated_at,
            developer_id:  dev.id,
            name:          dev.name,
            email:         dev.email,
            avatar_url:    dev.avatar_url,
            last_seen:     dev.last_seen,
            isOnline,
        };

        const pauseFilter = buildPauseExclusionSql(conn);

        // Query daily stats matching DATE(recorded_at) = today AND excluding paused periods
        const [statsRows] = await sequelize.query(`
            SELECT
                COALESCE(SUM(active_seconds), 0)  AS total_seconds,
                COALESCE(SUM(lines_added), 0)     AS lines_added,
                COALESCE(SUM(lines_deleted), 0)   AS lines_deleted,
                COALESCE(SUM(lines_modified), 0)  AS lines_modified,
                (
                    SELECT project_name FROM telemetry
                    WHERE user_id = :devId AND DATE(recorded_at) = :today ${pauseFilter}
                    ORDER BY id DESC LIMIT 1
                ) AS current_project
            FROM telemetry
            WHERE user_id = :devId AND DATE(recorded_at) = :today ${pauseFilter}
        `, {
            replacements: { devId: dev.id, today },
            type: QueryTypes.SELECT,
        });

        return {
            ...base,
            todayStats: {
                total_seconds:   Number(statsRows?.total_seconds || 0),
                lines_added:     Number(statsRows?.lines_added || 0),
                lines_deleted:   Number(statsRows?.lines_deleted || 0),
                lines_modified:  Number(statsRows?.lines_modified || 0),
                current_project: statsRows?.current_project || null,
            },
        };
    }));

    return res.json({ team: enriched });
}

async function getPendingRequests(req, res) {
    if (req.user.role !== 'developer')
        return res.status(403).json({ error: 'Only developers can view pending requests' });

    const requests = await Connection.findAll({
        where: { developer_id: req.user.id, status: 'pending' },
        include: [{
            model: User,
            as: 'recruiter',
            attributes: ['id', 'name', 'email', 'avatar_url'],
        }],
        order: [['initiated_at', 'DESC']],
    });

    return res.json({
        requests: requests.map(r => {
            const c = r.toJSON();
            return {
                connection_id: c.id,
                initiated_at:  c.initiated_at,
                recruiter_id:  c.recruiter.id,
                name:          c.recruiter.name,
                email:         c.recruiter.email,
                avatar_url:    c.recruiter.avatar_url,
            };
        }),
    });
}

async function getMyConnections(req, res) {
    if (req.user.role !== 'developer')
        return res.status(403).json({ error: 'Only developers can view their connections' });

    const connections = await Connection.findAll({
        where: {
            developer_id: req.user.id,
            status: { [Op.in]: ['active', 'paused'] },
        },
        include: [{
            model: User,
            as: 'recruiter',
            attributes: ['id', 'name', 'email', 'avatar_url'],
        }],
        order: [['status', 'ASC'], [{ model: User, as: 'recruiter' }, 'name', 'ASC']],
    });

    return res.json({
        connections: connections.map(c => {
            const conn = c.toJSON();
            return {
                connection_id: conn.id,
                status:        conn.status,
                paused_by:     conn.paused_by || null,
                initiated_at:  conn.initiated_at,
                recruiter_id:  conn.recruiter.id,
                name:          conn.recruiter.name,
                email:         conn.recruiter.email,
                avatar_url:    conn.recruiter.avatar_url,
            };
        }),
    });
}

module.exports = {
    sendRequest, respondToRequest, toggleConnection,
    terminateConnection, getMyTeam, getPendingRequests, getMyConnections,
};