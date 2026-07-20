const express = require('express');
const router = express.Router();
const c = require('./connections.controller');
const { requireAuth } = require('../auth/auth.middleware');

router.use(requireAuth);

router.post('/request',         c.sendRequest);
router.post('/:id/respond',     c.respondToRequest);
router.patch('/:id/toggle',     c.toggleConnection);
router.delete('/:id',           c.terminateConnection);
router.get('/my-team',          c.getMyTeam);
router.get('/pending',          c.getPendingRequests);
router.get('/my-connections',   c.getMyConnections);

module.exports = router;