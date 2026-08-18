const bcrypt = require('bcryptjs');
const { User } = require('../../config/db');
const { signToken } = require('./auth.middleware');

async function register(req, res) {
    const { name, email, password, role } = req.body;

    if (!name || !email || !password || !role)
        return res.status(400).json({ error: 'name, email, password, and role are required' });

    if (!['developer', 'recruiter'].includes(role))
        return res.status(400).json({ error: 'role must be developer or recruiter' });

    const existing = await User.findOne({ where: { email } });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 12);
    const user = await User.create({ name, email, password: hash, role });

    const { password: _, ...safeUser } = user.toJSON();
    return res.status(201).json({ token: signToken(safeUser), user: safeUser });
}

async function login(req, res) {
    const { email, password } = req.body;

    if (!email || !password)
        return res.status(400).json({ error: 'email and password are required' });

    const user = await User.findOne({ where: { email } });
    if (!user || !user.password)
        return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    await user.update({ last_seen: new Date() });

    const { password: _, ...safeUser } = user.toJSON();
    return res.json({ token: signToken(safeUser), user: safeUser });
}

async function me(req, res) {
    const user = await User.findOne({
        where: { id: req.user.id },
        attributes: ['id', 'name', 'email', 'role', 'avatar_url', 'created_at', 'last_seen'],
    });

    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json({ user: user.toJSON() });
}

module.exports = { register, login, me };