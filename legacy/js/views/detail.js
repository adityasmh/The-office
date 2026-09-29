(function () {
  'use strict';

  function renderDetail(container, id) {
    UI.renderLoading(container);

    Data.loadProjects().then(function () {
      var project = Data.getProjectById(id);
      if (!project) {
        UI.renderError(container, 'Project not found.');
        return;
      }
      container.innerHTML = buildDetail(project);
      attachDetailListeners(container, project);
    }).catch(function () {
      UI.renderError(container, 'Could not load project details.');
    });
  }

  function buildDetail(project) {
    var agents = project.agents.map(function (a) {
      return (
        '<tr>' +
          '<td>' + UI.escapeHtml(a.name) + '</td>' +
          '<td>' + UI.escapeHtml(a.role) + '</td>' +
          '<td>' + UI.statusBadge(a.status) + '</td>' +
        '</tr>'
      );
    }).join('');

    var roles = project.activeRoles.map(function (r) {
      return '<span class="chip">' + UI.escapeHtml(r) + '</span>';
    }).join('');

    var budgetPct = Math.round((project.budgetRemaining / project.totalBudget) * 100);

    var statusOptions = ['on-track', 'active', 'at-risk', 'paused', 'complete'].map(function (s) {
      return '<option value="' + s + '"' + (s === project.status ? ' selected' : '') + '>' + UI.escapeHtml(s) + '</option>';
    }).join('');

    return (
      '<section class="project-detail">' +
        '<a href="#/projects" class="back-link">← Back to projects</a>' +
        '<header class="detail-header">' +
          '<h1>' + UI.escapeHtml(project.name) + '</h1>' +
          UI.statusBadge(project.status) +
        '</header>' +
        '<div class="detail-grid">' +
          '<div class="panel">' +
            '<h2>Health</h2>' +
            '<div class="metrics">' +
              '<div class="metric"><span class="metric-value">' + UI.formatCurrency(project.budgetRemaining) + '</span><span class="metric-label">Budget left</span></div>' +
              '<div class="metric"><span class="metric-value">' + budgetPct + '%</span><span class="metric-label">Of total budget</span></div>' +
              '<div class="metric"><span class="metric-value">' + project.agentCount + '</span><span class="metric-label">Active agents</span></div>' +
            '</div>' +
          '</div>' +
          '<div class="panel">' +
            '<h2>About</h2>' +
            '<p>' + UI.escapeHtml(project.description) + '</p>' +
            '<div class="roles"><h3>Roles</h3><div class="chips">' + roles + '</div></div>' +
          '</div>' +
        '</div>' +
        '<div class="panel">' +
          '<h2>Agents</h2>' +
          '<table class="data-table">' +
            '<thead><tr><th>Name</th><th>Role</th><th>Status</th></tr></thead>' +
            '<tbody>' + agents + '</tbody>' +
          '</table>' +
        '</div>' +
        '<div class="panel status-panel">' +
          '<h2>Update status</h2>' +
          '<label class="sr-only" for="status-select">Status</label>' +
          '<select id="status-select" class="select">' + statusOptions + '</select>' +
          '<button id="save-status" class="btn btn-primary">Save</button>' +
          '<span id="save-message" class="save-message" aria-live="polite"></span>' +
        '</div>' +
      '</section>'
    );
  }

  function attachDetailListeners(container, project) {
    var saveBtn = container.querySelector('#save-status');
    var select = container.querySelector('#status-select');
    var message = container.querySelector('#save-message');

    saveBtn.addEventListener('click', function () {
      var newStatus = select.value;
      Data.updateProjectStatus(project.id, newStatus).then(function () {
        message.textContent = 'Status updated';
        message.className = 'save-message success';
        var header = container.querySelector('.detail-header');
        if (header) {
          var badge = header.querySelector('.badge');
          if (badge) badge.outerHTML = UI.statusBadge(newStatus);
        }
      }).catch(function () {
        message.textContent = 'Update failed';
        message.className = 'save-message error';
      });
    });
  }

  window.Views = window.Views || {};
  window.Views.renderDetail = renderDetail;
})();
