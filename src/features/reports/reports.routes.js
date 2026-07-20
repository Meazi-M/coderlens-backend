const express = require('express');
const router = express.Router();
const { dailyReport, weeklyReport, monthlyReport, calendarReport } = require('./reports.controller');
const { requireAuth } = require('../auth/auth.middleware');

router.use(requireAuth);

router.get('/daily/:devId',    dailyReport);
router.get('/weekly/:devId',   weeklyReport);
router.get('/monthly/:devId',  monthlyReport);
router.get('/calendar/:devId', calendarReport);

module.exports = router;