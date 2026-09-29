(function () {
  'use strict';

  var PROJECTS = [
    {
      id: 'alpha',
      name: 'Alpha Platform',
      status: 'on-track',
      budgetRemaining: 124000,
      totalBudget: 250000,
      agentCount: 4,
      activeRoles: ['Tech Lead', 'Backend', 'SRE'],
      description: 'Migrate the legacy monolith to the new platform core.',
      agents: [
        { name: 'Alex Rivera', role: 'Tech Lead', status: 'active' },
        { name: 'Beth Chen', role: 'Backend', status: 'active' },
        { name: 'Carlos Diaz', role: 'SRE', status: 'active' },
        { name: 'Dana Lee', role: 'Backend', status: 'away' }
      ],
      updatedAt: '2026-09-28T14:00:00.000Z'
    },
    {
      id: 'data-pipeline',
      name: 'Data Pipeline',
      status: 'at-risk',
      budgetRemaining: 32000,
      totalBudget: 120000,
      agentCount: 2,
      activeRoles: ['Data Engineer', 'Analytics'],
      description: 'Improve event ingestion throughput and reliability.',
      agents: [
        { name: 'Erin Park', role: 'Data Engineer', status: 'active' },
        { name: 'Frank O\'Neil', role: 'Analytics', status: 'active' }
      ],
      updatedAt: '2026-09-27T09:30:00.000Z'
    },
    {
      id: 'security',
      name: 'Access Control',
      status: 'active',
      budgetRemaining: 86000,
      totalBudget: 100000,
      agentCount: 3,
      activeRoles: ['Security Lead', 'Backend'],
      description: 'Roll out new access-control policies across services.',
      agents: [
        { name: 'Grace Ho', role: 'Security Lead', status: 'active' },
        { name: 'Henry Kim', role: 'Backend', status: 'active' },
        { name: 'Ivy Nguyen', role: 'Backend', status: 'active' }
      ],
      updatedAt: '2026-09-28T18:45:00.000Z'
    },
    {
      id: 'reliability',
      name: 'Reliability Dashboard',
      status: 'paused',
      budgetRemaining: 54000,
      totalBudget: 80000,
      agentCount: 2,
      activeRoles: ['SRE', 'Frontend'],
      description: 'Reduce incident response time with unified monitoring.',
      agents: [
        { name: 'Jack Brown', role: 'SRE', status: 'active' },
        { name: 'Kelly Smith', role: 'Frontend', status: 'offline' }
      ],
      updatedAt: '2026-09-25T11:20:00.000Z'
    }
  ];

  function loadProjects() {
    return new Promise(function (resolve) {
      setTimeout(function () {
        resolve(PROJECTS.slice());
      }, 350);
    });
  }

  function getProjectById(id) {
    return PROJECTS.find(function (p) { return p.id === id; });
  }

  function updateProjectStatus(id, status) {
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        var project = getProjectById(id);
        if (!project) {
          reject(new Error('Project not found'));
          return;
        }
        project.status = status;
        project.updatedAt = new Date().toISOString();
        resolve(project);
      }, 150);
    });
  }

  window.Data = {
    loadProjects: loadProjects,
    getProjectById: getProjectById,
    updateProjectStatus: updateProjectStatus
  };
})();
