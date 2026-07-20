const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'coderlens-dev-secret-change-in-production';

function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) return res.status(401).json({ error: 'No token provided' });

    try {
        req.user = jwt.verify(token, SECRET); // { id, email, role }
        next();
    } catch {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

function requireRole(role) {
    return (req, res, next) => {
        if (!req.user || req.user.role !== role) {
            return res.status(403).json({ error: `Requires role: ${role}` });
        }
        next();
    };
}

function signToken(user) {
    return jwt.sign(
        { id: user.id, email: user.email, role: user.role },
        SECRET,
        { expiresIn: '7d' }
    );
}

module.exports = { requireAuth, requireRole, signToken };