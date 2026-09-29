(function () {
  'use strict';

  // Thin adapter that exposes the existing Platform Core data contract unchanged,
  // so the new AgentOffice-themed UI can consume it without modifying js/data.js.
  function loadProjects() {
    return window.Data.loadProjects();
  }

  function getProjectById(id) {
    return window.Data.getProjectById(id);
  }

  function updateProjectStatus(id, status) {
    return window.Data.updateProjectStatus(id, status);
  }

  window.AgentOfficeData = {
    loadProjects: loadProjects,
    getProjectById: getProjectById,
    updateProjectStatus: updateProjectStatus
  };
})();
