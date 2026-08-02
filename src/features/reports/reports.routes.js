const express = require('express');
const router = express.Router();
const { dailyReport, dailyReportMe, weeklyReport, monthlyReport, calendarReport } = require('./reports.controller');
const { requireAuth } = require('../auth/auth.middleware');

router.use(requireAuth);

// Self-serve endpoint — must be BEFORE /:devId routes to avoid 'me' matching as a devId
router.get('/daily/me',        dailyReportMe);

router.get('/daily/:devId',    dailyReport);
router.get('/weekly/:devId',   weeklyReport);
router.get('/monthly/:devId',  monthlyReport);
router.get('/calendar/:devId', calendarReport);

module.exports = router;