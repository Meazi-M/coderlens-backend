const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const { User, Connection } = require('../config/db');

const SECRET = process.env.JWT_SECRET || 'coderlens-dev-secret-change-in-production';

// userId → Set of open WebSocket connections
const clientsByUser = new Map();

function attachWebSocketServer(httpServer) {
    const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

    wss.on('connection', async (ws, req) => {
        const url = new URL(req.url, 'http://localhost');
        const token = url.searchParams.get('token');

        if (!token) { ws.close(4001, 'No token'); return; }

        let user;
        try { user = jwt.verify(token, SECRET); }
        catch { ws.close(4001, 'Invalid token'); return; }

        if (!clientsByUser.has(user.id)) clientsByUser.set(user.id, new Set());
        clientsByUser.get(user.id).add(ws);

        User.update({ last_seen: new Date() }, { where: { id: user.id } }).catch(() => {});

        if (user.role === 'developer') {
            broadcastToRecruiters(user.id, {
                type: 'developer_online',
                developerId: user.id,
                timestamp: new Date().toISOString(),
            });
        }

        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                if (msg.type === 'ping') send(ws, { type: 'pong' });
                if (msg.type === 'status_update' && user.role === 'developer') {
                    broadcastToRecruiters(user.id, {
                        type: 'developer_status_update',
                        developerId: user.id,
                        currentProject: msg.currentProject || null,
                        linesAddedToday: msg.linesAddedToday || 0,
                        timestamp: new Date().toISOString(),
                    });
                }
            } catch { /* ignore malformed */ }
        });

        ws.on('close', () => {
            const sockets = clientsByUser.get(user.id);
            if (sockets) {
                sockets.delete(ws);
                if (sockets.size === 0) {
                    clientsByUser.delete(user.id);
                    if (user.role === 'developer') {
                        broadcastToRecruiters(user.id, {
                            type: 'developer_offline',
                            developerId: user.id,
                            timestamp: new Date().toISOString(),
                        });
                    }
                }
            }
        });

        send(ws, { type: 'connected', userId: user.id, role: user.role });
    });

    console.log('[ws] WebSocket server ready');
    return wss;
}

function sendToUser(userId, payload) {
    const sockets = clientsByUser.get(userId);
    if (!sockets) return;
    for (const ws of sockets) send(ws, payload);
}

async function broadcastToRecruiters(developerId, payload) {
    try {
        const recruiters = await Connection.findAll({
            where: { developer_id: developerId, status: 'active' },
            attributes: ['recruiter_id'],
        });

        for (const conn of recruiters) {
            sendToUser(conn.recruiter_id, payload);
        }
    } catch (e) {
        console.error('[ws] broadcastToRecruiters error:', e.message);
    }
}

function send(ws, payload) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function isDeveloperOnline(developerId) {
    const sockets = clientsByUser.get(developerId);
    return !!(sockets && sockets.size > 0);
}

async function notifyTelemetryUpdate(developerId) {
    User.update({ last_seen: new Date() }, { where: { id: developerId } }).catch(() => {});
    const payload = { type: 'telemetry_updated', developerId, timestamp: new Date().toISOString() };
    sendToUser(developerId, payload);
    broadcastToRecruiters(developerId, payload);
    broadcastToRecruiters(developerId, {
        type: 'developer_online',
        developerId,
        timestamp: new Date().toISOString()
    });
}

function notifyConnectionUpdate(recruiterId, developerId) {
    const payload = { type: 'connection_updated', recruiterId, developerId, timestamp: new Date().toISOString() };
    if (recruiterId) sendToUser(recruiterId, payload);
    if (developerId) sendToUser(developerId, payload);
}

module.exports = {
    attachWebSocketServer,
    isDeveloperOnline,
    notifyTelemetryUpdate,
    notifyConnectionUpdate
};