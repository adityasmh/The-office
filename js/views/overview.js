(function () {
  'use strict';

  function renderOverview(container) {
    UI.renderLoading(container);

    Data.loadProjects().then(function (projects) {
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
        '<article class="project-card" data-id="' + p.id + '">' +
          '<div class="card-header">' +
            '<h3>' + UI.escapeHtml(p.name) + '</h3>' +
            UI.statusBadge(p.status) +
          '</div>' +
          '<div class="card-body">' +
            '<div class="metric"><span class="metric-value">' + UI.formatCurrency(p.budgetRemaining) + '</span><span class="metric-label">Budget left</span></div>' +
            '<div class="metric"><span class="metric-value">' + p.agentCount + '</span><span class="metric-label">Agents</span></div>' +
            '<div class="metric"><span class="metric-value">' + p.activeRoles.length + '</span><span class="metric-label">Roles</span></div>' +
          '</div>' +
          '<div class="card-footer">' + UI.escapeHtml(p.activeRoles.join(', ')) + '</div>' +
        '</article>'
      );
    }).join('');

    return (
      '<section class="overview">' +
        '<header class="page-header"><h1>Overview</h1><p class="lede">Every project and its health, at a glance.</p></header>' +
        '<div class="stats-bar">' +
          '<div class="stat"><span class="stat-value">' + stats.total + '</span><span class="stat-label">Projects</span></div>' +
          '<div class="stat"><span class="stat-value">' + stats.healthy + '</span><span class="stat-label">Healthy</span></div>' +
          '<div class="stat"><span class="stat-value">' + stats.atRisk + '</span><span class="stat-label">At risk</span></div>' +
        '</div>' +
        '<div class="section-header"><h2>Projects</h2><a href="#/projects" class="btn btn-secondary">View all</a></div>' +
        '<div class="project-grid">' + cards + '</div>' +
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
    container.querySelectorAll('.project-card').forEach(function (card) {
      card.addEventListener('click', function () {
        Router.navigate('project/' + card.dataset.id);
      });
    });
  }

  window.Views = window.Views || {};
  window.Views.renderOverview = renderOverview;
})();
