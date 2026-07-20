const express = require('express');
const router = express.Router();
const { ingestActivity, getSummary } = require('./telemetry.controller');
const { requireAuth } = require('../auth/auth.middleware');

router.post('/', (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) return next();
    return requireAuth(req, res, next);
}, ingestActivity);

router.get('/summary', requireAuth, getSummary);

module.exports = router;