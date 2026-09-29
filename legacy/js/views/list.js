(function () {
  'use strict';

  function renderList(container) {
    UI.renderLoading(container);

    Data.loadProjects().then(function (projects) {
      if (!projects || projects.length === 0) {
        UI.renderEmpty(container);
        return;
      }
      container.innerHTML = buildList(projects);
      attachListListeners(container);
    }).catch(function () {
      UI.renderError(container, 'Could not load projects.');
    });
  }

  function buildList(projects) {
    var rows = projects.map(function (p) {
      return (
        '<tr class="project-row" data-id="' + p.id + '">' +
          '<td class="cell-name">' + UI.escapeHtml(p.name) + '</td>' +
          '<td>' + UI.statusBadge(p.status) + '</td>' +
          '<td class="cell-number">' + UI.formatCurrency(p.budgetRemaining) + '</td>' +
          '<td class="cell-number">' + p.agentCount + '</td>' +
          '<td>' + UI.escapeHtml(p.activeRoles.join(', ')) + '</td>' +
        '</tr>'
      );
    }).join('');

    return (
      '<section class="project-list">' +
        '<header class="page-header"><h1>Projects</h1><p class="lede">All projects in one place.</p></header>' +
        '<div class="table-wrap">' +
          '<table class="data-table">' +
            '<thead><tr><th>Name</th><th>Status</th><th>Budget left</th><th>Agents</th><th>Roles</th></tr></thead>' +
            '<tbody>' + rows + '</tbody>' +
          '</table>' +
        '</div>' +
      '</section>'
    );
  }

  function attachListListeners(container) {
    container.querySelectorAll('.project-row').forEach(function (row) {
      row.addEventListener('click', function () {
        Router.navigate('project/' + row.dataset.id);
      });
    });
  }

  window.Views = window.Views || {};
  window.Views.renderList = renderList;
})();
