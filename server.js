require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const http       = require('http');
const passport   = require('./src/config/passport');
const { attachWebSocketServer } = require('./src/websocket/wsServer');

const authRoutes        = require('./src/features/auth/auth.routes');
const telemetryRoutes   = require('./src/features/telemetry/telemetry.routes');
const connectionsRoutes = require('./src/features/connections/connections.routes');
const projectsRoutes    = require('./src/features/projects/projects.routes');
const reportsRoutes     = require('./src/features/reports/reports.routes');

const app = express();
const PORT = process.env.PORT || 5000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json());
app.use(passport.initialize());

// REST routes
app.use('/api/auth',        authRoutes);
app.use('/api/activity',    telemetryRoutes);   // extension posts here
app.use('/api/telemetry',   telemetryRoutes);   // frontend reads here
app.use('/api/connections', connectionsRoutes);
app.use('/api/projects',    projectsRoutes);
app.use('/api/reports',     reportsRoutes);

// Google OAuth
app.get('/api/auth/google', (req, res, next) => {
    passport.authenticate('google', {
        scope: ['profile', 'email'],
        state: req.query.role || 'developer',
        session: false,
    })(req, res, next);
});
app.get('/api/auth/google/callback',
    passport.authenticate('google', { session: false, failureRedirect: `${FRONTEND_URL}/login?error=oauth` }),
    (req, res) => res.redirect(`${FRONTEND_URL}/oauth-success?token=${req.user.token}`)
);

// GitHub OAuth
app.get('/api/auth/github', (req, res, next) => {
    passport.authenticate('github', {
        scope: ['user:email'],
        state: req.query.role || 'developer',
        session: false,
    })(req, res, next);
});
app.get('/api/auth/github/callback',
    passport.authenticate('github', { session: false, failureRedirect: `${FRONTEND_URL}/login?error=oauth` }),
    (req, res) => res.redirect(`${FRONTEND_URL}/oauth-success?token=${req.user.token}`)
);

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Start server + attach WebSocket
const httpServer = http.createServer(app);
attachWebSocketServer(httpServer);

httpServer.listen(PORT, () => {
    console.log(`\n🚀 CoderLens API  →  http://localhost:${PORT}`);
    console.log(`🔌 WebSocket      →  ws://localhost:${PORT}/ws`);
    console.log(`🌐 Frontend URL   →  ${FRONTEND_URL}\n`);
});