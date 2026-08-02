const express = require('express');
const router = express.Router();
const { ingestActivity, getSummary } = require('./telemetry.controller');
const { requireAuth } = require('../auth/auth.middleware');

// Telemetry ingestion requires a valid JWT — anonymous requests are rejected
// with 401 so the extension queues them offline until a token is configured.
router.post('/', requireAuth, ingestActivity);

router.get('/summary', requireAuth, getSummary);

module.exports = router;