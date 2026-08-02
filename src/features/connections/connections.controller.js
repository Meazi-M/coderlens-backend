const db = require('../../config/db');
const { notifyConnectionUpdate, isDeveloperOnline } = require('../../websocket/wsServer');

function sendRequest(req, res) {
    if (req.user.role !== 'recruiter')
        return res.status(403).json({ error: 'Only recruiters can send connection requests' });

    const { developerEmail } = req.body;
    if (!developerEmail)
        return res.status(400).json({ error: 'developerEmail is required' });

    const developer = db.prepare(
        "SELECT id, name, email FROM users WHERE email = ? AND role = 'developer'"
    ).get(developerEmail);
    if (!developer) return res.status(404).json({ error: 'No developer found with that email' });

    const existing = db.prepare(
        'SELECT id, status FROM connections WHERE recruiter_id = ? AND developer_id = ?'
    ).get(req.user.id, developer.id);

    if (existing) {
        if (existing.status === 'terminated')
            return res.status(409).json({ error: 'This connection was permanently ended' });
        return res.status(409).json({ error: `Connection already exists: ${existing.status}` });
    }

    const result = db.prepare(
        'INSERT INTO connections (recruiter_id, developer_id) VALUES (?, ?)'
    ).run(req.user.id, developer.id);

    try { notifyConnectionUpdate(req.user.id, developer.id); } catch (e) {}

    return res.json({
        connection: db.prepare('SELECT * FROM connections WHERE id = ?').get(result.lastInsertRowid)
    });
}

function respondToRequest(req, res) {
    if (req.user.role !== 'developer')
        return res.status(403).json({ error: 'Only developers can respond to requests' });

    const { action } = req.body;
    if (!['accept', 'reject'].includes(action))
        return res.status(400).json({ error: 'action must be accept or reject' });

    const conn = db.prepare(
        'SELECT * FROM connections WHERE id = ? AND developer_id = ?'
    ).get(req.params.id, req.user.id);

    if (!conn) return res.status(404).json({ error: 'Connection not found' });
    if (conn.status !== 'pending')
        return res.status(400).json({ error: `Cannot respond to a ${conn.status} connection` });

    const newStatus = action === 'accept' ? 'active' : 'terminated';
    db.prepare(
        "UPDATE connections SET status = ?, responded_at = datetime('now') WHERE id = ?"
    ).run(newStatus, conn.id);

    try { notifyConnectionUpdate(conn.recruiter_id, conn.developer_id); } catch (e) {}

    return res.json({ status: newStatus });
}

function toggleConnection(req, res) {
    const conn = db.prepare(
        'SELECT * FROM connections WHERE id = ? AND (developer_id = ? OR recruiter_id = ?)'
    ).get(req.params.id, req.user.id, req.user.id);

    if (!conn) return res.status(404).json({ error: 'Connection not found' });
    if (['terminated', 'pending'].includes(conn.status))
        return res.status(400).json({ error: `Cannot toggle a ${conn.status} connection` });

    const newStatus = req.body.active ? 'active' : 'paused';
    db.prepare('UPDATE connections SET status = ? WHERE id = ?').run(newStatus, conn.id);

    try { notifyConnectionUpdate(conn.recruiter_id, conn.developer_id); } catch (e) {}

    return res.json({ status: newStatus });
}

function terminateConnection(req, res) {
    const conn = db.prepare(
        'SELECT * FROM connections WHERE id = ? AND (developer_id = ? OR recruiter_id = ?)'
    ).get(req.params.id, req.user.id, req.user.id);

    if (!conn) return res.status(404).json({ error: 'Connection not found' });
    if (conn.status === 'terminated')
        return res.status(400).json({ error: 'Already terminated' });

    db.prepare(
        "UPDATE connections SET status = 'terminated', terminated_at = datetime('now') WHERE id = ?"
    ).run(conn.id);

    try { notifyConnectionUpdate(conn.recruiter_id, conn.developer_id); } catch (e) {}

    return res.json({ message: 'Connection permanently terminated' });
}

function getMyTeam(req, res) {
    if (req.user.role !== 'recruiter')
        return res.status(403).json({ error: 'Only recruiters can view their team' });

    const connections = db.prepare(`
        SELECT c.id AS connection_id, c.status, c.initiated_at,
               u.id AS developer_id, u.name, u.email, u.avatar_url, u.last_seen
        FROM connections c
        JOIN users u ON u.id = c.developer_id
        WHERE c.recruiter_id = ? AND c.status IN ('active', 'paused')
        ORDER BY c.status ASC, u.name ASC
    `).all(req.user.id);

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

    const enriched = connections.map(conn => {
        let isOnline = isDeveloperOnline(conn.developer_id);
        if (!isOnline && conn.last_seen) {
            const lastSeenTime = new Date(conn.last_seen.includes('T') ? conn.last_seen : conn.last_seen + 'Z').getTime();
            if (!isNaN(lastSeenTime) && (Date.now() - lastSeenTime) < 5 * 60 * 1000) {
                isOnline = true;
            }
        }

        if (conn.status !== 'active') {
            return {
                ...conn,
                isOnline: false,
                todayStats: { total_seconds: 0, lines_added: 0, lines_deleted: 0, lines_modified: 0, current_project: null }
            };
        }

        const stats = db.prepare(`
            SELECT SUM(active_seconds) AS total_seconds,
                   SUM(lines_added) AS lines_added,
                   SUM(lines_deleted) AS lines_deleted,
                   SUM(lines_modified) AS lines_modified,
                   (
                       SELECT project_name FROM telemetry
                       WHERE user_id = ? AND (recorded_at LIKE ? OR substr(recorded_at, 1, 10) = ?)
                       ORDER BY id DESC LIMIT 1
                   ) AS current_project
            FROM telemetry
            WHERE user_id = ? AND (recorded_at LIKE ? OR substr(recorded_at, 1, 10) = ?)
        `).get(conn.developer_id, `${today}%`, today, conn.developer_id, `${today}%`, today);

        return {
            ...conn,
            isOnline,
            todayStats: stats || { total_seconds: 0, lines_added: 0, lines_deleted: 0, lines_modified: 0, current_project: null }
        };
    });

    return res.json({ team: enriched });
}

function getPendingRequests(req, res) {
    if (req.user.role !== 'developer')
        return res.status(403).json({ error: 'Only developers can view pending requests' });

    const requests = db.prepare(`
        SELECT c.id AS connection_id, c.initiated_at,
               u.id AS recruiter_id, u.name, u.email, u.avatar_url
        FROM connections c
        JOIN users u ON u.id = c.recruiter_id
        WHERE c.developer_id = ? AND c.status = 'pending'
        ORDER BY c.initiated_at DESC
    `).all(req.user.id);

    return res.json({ requests });
}

function getMyConnections(req, res) {
    if (req.user.role !== 'developer')
        return res.status(403).json({ error: 'Only developers can view their connections' });

    const connections = db.prepare(`
        SELECT c.id AS connection_id, c.status, c.initiated_at,
               u.id AS recruiter_id, u.name, u.email, u.avatar_url
        FROM connections c
        JOIN users u ON u.id = c.recruiter_id
        WHERE c.developer_id = ? AND c.status IN ('active', 'paused')
        ORDER BY c.status ASC, u.name ASC
    `).all(req.user.id);

    return res.json({ connections });
}

module.exports = {
    sendRequest, respondToRequest, toggleConnection,
    terminateConnection, getMyTeam, getPendingRequests, getMyConnections
};