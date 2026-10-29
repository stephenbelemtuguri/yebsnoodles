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
})();
