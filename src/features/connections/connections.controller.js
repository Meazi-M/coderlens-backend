const db = require('../../config/db');

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

    return res.status(201).json({
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

    return res.json({ status: newStatus });
}

function toggleConnection(req, res) {
    if (req.user.role !== 'developer')
        return res.status(403).json({ error: 'Only developers can toggle connections' });

    const conn = db.prepare(
        'SELECT * FROM connections WHERE id = ? AND developer_id = ?'
    ).get(req.params.id, req.user.id);

    if (!conn) return res.status(404).json({ error: 'Connection not found' });
    if (['terminated', 'pending'].includes(conn.status))
        return res.status(400).json({ error: `Cannot toggle a ${conn.status} connection` });

    const newStatus = req.body.active ? 'active' : 'paused';
    db.prepare('UPDATE connections SET status = ? WHERE id = ?').run(newStatus, conn.id);

    return res.json({ status: newStatus });
}

function terminateConnection(req, res) {
    if (req.user.role !== 'recruiter')
        return res.status(403).json({ error: 'Only recruiters can terminate connections' });

    const conn = db.prepare(
        'SELECT * FROM connections WHERE id = ? AND recruiter_id = ?'
    ).get(req.params.id, req.user.id);

    if (!conn) return res.status(404).json({ error: 'Connection not found' });
    if (conn.status === 'terminated')
        return res.status(400).json({ error: 'Already terminated' });

    db.prepare(
        "UPDATE connections SET status = 'terminated', terminated_at = datetime('now') WHERE id = ?"
    ).run(conn.id);

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
        WHERE c.recruiter_id = ?
        ORDER BY c.status ASC, u.name ASC
    `).all(req.user.id);

    const today = new Date().toISOString().slice(0, 10);

    const enriched = connections.map(conn => {
        if (conn.status !== 'active') return { ...conn, todayStats: null };

        const stats = db.prepare(`
            SELECT SUM(active_seconds) AS total_seconds,
                   SUM(lines_added) AS lines_added,
                   project_name AS current_project
            FROM telemetry
            WHERE user_id = ? AND recorded_at LIKE ?
            GROUP BY project_name ORDER BY total_seconds DESC LIMIT 1
        `).get(conn.developer_id, `${today}%`);

        return { ...conn, todayStats: stats || { total_seconds: 0, lines_added: 0, current_project: null } };
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