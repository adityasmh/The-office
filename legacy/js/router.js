(function () {
  'use strict';

  var root = document.getElementById('root');

  function parseHash() {
    var hash = window.location.hash.replace(/^#\/?/, '') || 'overview';
    var parts = hash.split('/');
    return { name: parts[0], arg: parts.slice(1).join('/') };
  }

  function updateNav(activeName) {
    document.querySelectorAll('.nav-link').forEach(function (link) {
      var route = link.dataset.route;
      if (route === activeName || (activeName === 'project' && route === 'projects')) {
        link.classList.add('active');
      } else {
        link.classList.remove('active');
      }
    });
  }

  function render() {
    if (!root) return;

    var parsed = parseHash();
    var name = parsed.name;
    var arg = parsed.arg;

    switch (name) {
      case 'projects':
        updateNav('projects');
        window.Views.renderList(root);
        break;
      case 'project':
        updateNav('project');
        window.Views.renderDetail(root, arg);
        break;
      case 'overview':
      default:
        updateNav('overview');
        window.Views.renderOverview(root);
    }
  }

  function navigate(path) {
    window.location.hash = '#/' + path;
  }

  window.addEventListener('hashchange', render);
  window.addEventListener('DOMContentLoaded', render);

  window.Router = { navigate: navigate };
})();
