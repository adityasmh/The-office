(function () {
  'use strict';

  var root = document.getElementById('root');

  function parseView() {
    var params = new URLSearchParams(window.location.search);
    return {
      view: params.get('view') || 'overview',
      id: params.get('id') || ''
    };
  }

  function updateNav(activeView) {
    document.querySelectorAll('.ao-nav-link[data-view]').forEach(function (link) {
      if (link.dataset.view === activeView) {
        link.classList.add('active');
      } else {
        link.classList.remove('active');
      }
    });
  }

  function navigate(view, id) {
    var url = new URL(window.location.href);
    url.searchParams.set('view', view);
    if (id) {
      url.searchParams.set('id', id);
    } else {
      url.searchParams.delete('id');
    }
    window.history.pushState({}, '', url.toString());
    render();
  }

  function render() {
    if (!root) return;
    var parsed = parseView();
    updateNav(parsed.view);

    switch (parsed.view) {
      case 'list':
        renderList(root);
        break;
      case 'detail':
        renderDetail(root, parsed.id);
        break;
      case 'overview':
      default:
        renderOverview(root);
    }
  }

  function renderOverview(container) {
    UI.renderLoading(container);

    AgentOfficeData.loadProjects().then(function (projects) {
      if (!projects || projects.length === 0) {
        UI.renderEmpty(container);
        return;
      }
      container.innerHTML = buildOverview(projects);
      attachOverviewListeners(container);
    }).catch(function () {
      UI.renderError(container, 'Could not load projects.');
    });
  }

  function buildOverview(projects) {
    var stats = computeStats(projects);
    var cards = projects.map(function (p) {
      return (
        '<article class="ao-card" data-id="' + p.id + '">' +
          '<div class="ao-card-header">' +
            '<img src="public/assets/characters/char_' + (hashIndex(p.id, 6)) + '.png" alt="" class="ao-avatar" />' +
            '<div class="ao-card-title">' + UI.escapeHtml(p.name) + '</div>' +
            UI.statusBadge(p.status) +
          '</div>' +
          '<div class="ao-card-body">' +
            '<div class="ao-metric"><span class="ao-metric-value">' + UI.formatCurrency(p.budgetRemaining) + '</span><span class="ao-metric-label">Budget left</span></div>' +
            '<div class="ao-metric"><span class="ao-metric-value">' + p.agentCount + '</span><span class="ao-metric-label">Agents</span></div>' +
            '<div class="ao-metric"><span class="ao-metric-value">' + p.activeRoles.length + '</span><span class="ao-metric-label">Roles</span></div>' +
          '</div>' +
          '<div class="ao-card-footer">' + UI.escapeHtml(p.activeRoles.join(', ')) + '</div>' +
        '</article>'
      );
    }).join('');

    return (
      '<section class="ao-overview">' +
        '<header class="ao-page-header"><h1>AgentOffice Overview</h1><p class="ao-lede">Every project and its health, at a glance.</p></header>' +
        '<div class="ao-stats-bar">' +
          '<div class="ao-stat"><span class="ao-stat-value">' + stats.total + '</span><span class="ao-stat-label">Projects</span></div>' +
          '<div class="ao-stat"><span class="ao-stat-value">' + stats.healthy + '</span><span class="ao-stat-label">Healthy</span></div>' +
          '<div class="ao-stat"><span class="ao-stat-value">' + stats.atRisk + '</span><span class="ao-stat-label">At risk</span></div>' +
        '</div>' +
        '<div class="ao-section-header"><h2>Projects</h2><a href="?view=list" class="ao-btn ao-btn-secondary">View all</a></div>' +
        '<div class="ao-project-grid">' + cards + '</div>' +
      '</section>'
    );
  }

  function computeStats(projects) {
    var healthy = 0;
    var atRisk = 0;
    projects.forEach(function (p) {
      if (p.status === 'at-risk') {
        atRisk++;
      } else if (p.status === 'on-track' || p.status === 'active' || p.status === 'complete') {
        healthy++;
      }
    });
    return { total: projects.length, healthy: healthy, atRisk: atRisk };
  }

  function attachOverviewListeners(container) {
    container.querySelectorAll('.ao-card').forEach(function (card) {
      card.addEventListener('click', function () {
        navigate('detail', card.dataset.id);
      });
    });
  }

  function renderList(container) {
    UI.renderLoading(container);

    AgentOfficeData.loadProjects().then(function (projects) {
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
        '<tr class="ao-row" data-id="' + p.id + '">' +
          '<td class="ao-cell-name"><img src="public/assets/characters/char_' + (hashIndex(p.id, 6)) + '.png" alt="" class="ao-row-avatar" /> ' + UI.escapeHtml(p.name) + '</td>' +
          '<td>' + UI.statusBadge(p.status) + '</td>' +
          '<td class="ao-cell-number">' + UI.formatCurrency(p.budgetRemaining) + '</td>' +
          '<td class="ao-cell-number">' + p.agentCount + '</td>' +
          '<td>' + UI.escapeHtml(p.activeRoles.join(', ')) + '</td>' +
        '</tr>'
      );
    }).join('');

    return (
      '<section class="ao-list">' +
        '<header class="ao-page-header"><h1>AgentOffice Projects</h1><p class="ao-lede">All projects in one place.</p></header>' +
        '<div class="ao-table-wrap">' +
          '<table class="ao-data-table">' +
            '<thead><tr><th>Name</th><th>Status</th><th>Budget left</th><th>Agents</th><th>Roles</th></tr></thead>' +
            '<tbody>' + rows + '</tbody>' +
          '</table>' +
        '</div>' +
      '</section>'
    );
  }

  function attachListListeners(container) {
    container.querySelectorAll('.ao-row').forEach(function (row) {
      row.addEventListener('click', function () {
        navigate('detail', row.dataset.id);
      });
    });
  }

  function renderDetail(container, id) {
    UI.renderLoading(container);

    AgentOfficeData.loadProjects().then(function () {
      var project = AgentOfficeData.getProjectById(id);
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
          '<td><img src="public/assets/characters/char_' + (hashIndex(a.name, 6)) + '.png" alt="" class="ao-row-avatar" /> ' + UI.escapeHtml(a.name) + '</td>' +
          '<td>' + UI.escapeHtml(a.role) + '</td>' +
          '<td>' + UI.statusBadge(a.status) + '</td>' +
        '</tr>'
      );
    }).join('');

    var roles = project.activeRoles.map(function (r) {
      return '<span class="ao-chip">' + UI.escapeHtml(r) + '</span>';
    }).join('');

    var budgetPct = Math.round((project.budgetRemaining / project.totalBudget) * 100);

    var statusOptions = ['on-track', 'active', 'at-risk', 'paused', 'complete'].map(function (s) {
      return '<option value="' + s + '"' + (s === project.status ? ' selected' : '') + '>' + UI.escapeHtml(s) + '</option>';
    }).join('');

    return (
      '<section class="ao-detail">' +
        '<a href="?view=list" class="ao-back-link">← Back to projects</a>' +
        '<header class="ao-detail-header">' +
          '<img src="public/assets/characters/char_' + (hashIndex(project.id, 6)) + '.png" alt="" class="ao-detail-avatar" />' +
          '<h1>' + UI.escapeHtml(project.name) + '</h1>' +
          UI.statusBadge(project.status) +
        '</header>' +
        '<div class="ao-detail-grid">' +
          '<div class="ao-panel">' +
            '<h2>Health</h2>' +
            '<div class="ao-metrics">' +
              '<div class="ao-metric"><span class="ao-metric-value">' + UI.formatCurrency(project.budgetRemaining) + '</span><span class="ao-metric-label">Budget left</span></div>' +
              '<div class="ao-metric"><span class="ao-metric-value">' + budgetPct + '%</span><span class="ao-metric-label">Of total budget</span></div>' +
              '<div class="ao-metric"><span class="ao-metric-value">' + project.agentCount + '</span><span class="ao-metric-label">Active agents</span></div>' +
            '</div>' +
          '</div>' +
          '<div class="ao-panel">' +
            '<h2>About</h2>' +
            '<p>' + UI.escapeHtml(project.description) + '</p>' +
            '<div class="ao-roles"><h3>Roles</h3><div class="ao-chips">' + roles + '</div></div>' +
          '</div>' +
        '</div>' +
        '<div class="ao-panel">' +
          '<h2>Agents</h2>' +
          '<table class="ao-data-table">' +
            '<thead><tr><th>Name</th><th>Role</th><th>Status</th></tr></thead>' +
            '<tbody>' + agents + '</tbody>' +
          '</table>' +
        '</div>' +
        '<div class="ao-panel ao-status-panel">' +
          '<h2>Update status</h2>' +
          '<label class="ao-sr-only" for="ao-status-select">Status</label>' +
          '<select id="ao-status-select" class="ao-select">' + statusOptions + '</select>' +
          '<button id="ao-save-status" class="ao-btn ao-btn-primary">Save</button>' +
          '<span id="ao-save-message" class="ao-save-message" aria-live="polite"></span>' +
        '</div>' +
      '</section>'
    );
  }

  function attachDetailListeners(container, project) {
    var saveBtn = container.querySelector('#ao-save-status');
    var select = container.querySelector('#ao-status-select');
    var message = container.querySelector('#ao-save-message');

    saveBtn.addEventListener('click', function () {
      var newStatus = select.value;
      AgentOfficeData.updateProjectStatus(project.id, newStatus).then(function () {
        message.textContent = 'Status updated';
        message.className = 'ao-save-message success';
        var header = container.querySelector('.ao-detail-header');
        if (header) {
          var badge = header.querySelector('.badge');
          if (badge) badge.outerHTML = UI.statusBadge(newStatus);
        }
      }).catch(function () {
        message.textContent = 'Update failed';
        message.className = 'ao-save-message error';
      });
    });
  }

  function hashIndex(str, max) {
    var h = 0;
    for (var i = 0; i < str.length; i++) {
      h = (h << 5) - h + str.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h) % max;
  }

  window.addEventListener('popstate', render);
  window.addEventListener('DOMContentLoaded', render);

  window.AgentOfficeApp = { navigate: navigate, render: render };
})();
