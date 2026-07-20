const bcrypt = require('bcryptjs');
const db = require('../../config/db');
const { signToken } = require('./auth.middleware');

async function register(req, res) {
    const { name, email, password, role } = req.body;

    if (!name || !email || !password || !role)
        return res.status(400).json({ error: 'name, email, password, and role are required' });

    if (!['developer', 'recruiter'].includes(role))
        return res.status(400).json({ error: 'role must be developer or recruiter' });

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 12);
    const result = db.prepare(
        'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)'
    ).run(name, email, hash, role);

    const user = db.prepare('SELECT id, name, email, role, created_at FROM users WHERE id = ?')
        .get(result.lastInsertRowid);

    return res.status(201).json({ token: signToken(user), user });
}

async function login(req, res) {
    const { email, password } = req.body;

    if (!email || !password)
        return res.status(400).json({ error: 'email and password are required' });

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !user.password)
        return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    db.prepare("UPDATE users SET last_seen = datetime('now') WHERE id = ?").run(user.id);

    const { password: _, ...safeUser } = user;
    return res.json({ token: signToken(safeUser), user: safeUser });
}

function me(req, res) {
    const user = db.prepare(
        'SELECT id, name, email, role, avatar_url, created_at, last_seen FROM users WHERE id = ?'
    ).get(req.user.id);

    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json({ user });
}

module.exports = { register, login, me };