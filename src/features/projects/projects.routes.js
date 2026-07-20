const express = require('express');
const router = express.Router();
const { getProjects, addProject, updateProject, deleteProject } = require('./projects.controller');
const { requireAuth } = require('../auth/auth.middleware');

router.use(requireAuth);

router.get('/',       getProjects);
router.post('/',      addProject);
router.patch('/:id',  updateProject);
router.delete('/:id', deleteProject);

module.exports = router;