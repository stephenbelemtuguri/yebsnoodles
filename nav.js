// YEBS Noodles — shared mobile navigation.
//
// Admin, rider and portal pages all use the same header markup (a brand plus a
// row of links). On a phone that row either overflowed or disappeared, so this
// script turns it into a proper drop-down panel with a hamburger button.
//
// It is deliberately tiny and dependency-free. The storefront has its own
// hamburger (#mobileNavToggle), so this script leaves that page alone.

(function () {
  'use strict';

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !/^https?:$/.test(window.location.protocol)) return;

    var hadController = Boolean(navigator.serviceWorker.controller);
    var updateNoticeShown = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController || updateNoticeShown) return;
      updateNoticeShown = true;

      var notice = document.createElement('div');
      notice.setAttribute('role', 'status');
      notice.setAttribute('aria-live', 'polite');
      notice.style.cssText = 'position:fixed;left:16px;right:16px;bottom:16px;z-index:1000000;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-radius:12px;background:#173d30;color:#fff;box-shadow:0 8px 28px rgba(0,0,0,.25);font:600 14px/1.4 system-ui,sans-serif;';

      var message = document.createElement('span');
      message.textContent = 'A YEBS update is ready. Refresh to load the latest fixes.';
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Refresh now';
      button.style.cssText = 'border:0;border-radius:8px;padding:8px 12px;background:#e9bd68;color:#173d30;font-weight:800;white-space:nowrap;cursor:pointer;';
      button.addEventListener('click', function () { window.location.reload(); });
      notice.append(message, button);
      document.body.appendChild(notice);
    });

    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then(function (registration) { return registration.update(); })
      .catch(function (error) { console.warn('Service worker update check failed:', error); });
  }

  function init() {
    // Storefront already has a working hamburger.
    if (document.getElementById('mobileNavToggle')) return;

    var header = document.querySelector('header');
    if (!header) return;
    var nav = header.querySelector('nav');
    if (!nav) return;
    if (!nav.querySelector('a, button')) return;

    var wrap = header.querySelector('.header-wrap') || header;

    document.documentElement.classList.add('has-mobile-nav');
    if (!nav.id) nav.id = 'yebsHeaderNav';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mobile-nav-toggle';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', nav.id);
    btn.setAttribute('aria-label', 'Open navigation menu');
    btn.innerHTML = '<span></span><span></span><span></span>';

    // Put the button at the end of the header row, after the brand.
    wrap.appendChild(btn);

    function setOpen(open) {
      nav.classList.toggle('nav-open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu');
    }

    function isOpen() {
      return nav.classList.contains('nav-open');
    }

    btn.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(!isOpen());
    });

    // Following a link (or pressing a nav action) closes the panel.
    nav.addEventListener('click', function (event) {
      var target = event.target;
      if (target && target.closest && target.closest('a')) setOpen(false);
    });

    document.addEventListener('click', function (event) {
      if (!isOpen()) return;
      if (nav.contains(event.target) || btn.contains(event.target)) return;
      setOpen(false);
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && isOpen()) setOpen(false);
    });

    window.addEventListener('resize', function () {
      if (window.innerWidth > 820 && isOpen()) setOpen(false);
    });

    // Expose for pages that add nav links after login/logout.
    window.yebsMobileNav = { close: function () { setOpen(false); }, toggle: function () { setOpen(!isOpen()); } };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  registerServiceWorker();
})();
