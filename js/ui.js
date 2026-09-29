(function () {
  'use strict';

  var STATUS_COLORS = {
    'on-track': 'success',
    'active': 'success',
    'complete': 'info',
    'paused': 'warning',
    'at-risk': 'danger'
  };

  function statusBadge(status) {
    var tone = STATUS_COLORS[status] || 'muted';
    return '<span class="badge badge-' + tone + '">' + escapeHtml(status) + '</span>';
  }

  function formatCurrency(value) {
    return '$' + Number(value).toLocaleString('en-US');
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderLoading(container) {
    container.innerHTML =
      '<div class="state state-loading">' +
        '<div class="spinner" aria-hidden="true"></div>' +
        '<p>Loading projects…</p>' +
      '</div>';
  }

  function renderEmpty(container) {
    container.innerHTML =
      '<div class="state state-empty">' +
        '<h2>No projects yet</h2>' +
        '<p>Add a project to see it here.</p>' +
      '</div>';
  }

  function renderError(container, message) {
    container.innerHTML =
      '<div class="state state-error">' +
        '<h2>Something went wrong</h2>' +
        '<p>' + escapeHtml(message || 'Could not load projects.') + '</p>' +
        '<button class="btn btn-primary" onclick="window.location.reload()">Retry</button>' +
      '</div>';
  }

  window.UI = {
    statusBadge: statusBadge,
    formatCurrency: formatCurrency,
    escapeHtml: escapeHtml,
    renderLoading: renderLoading,
    renderEmpty: renderEmpty,
    renderError: renderError
  };
})();
