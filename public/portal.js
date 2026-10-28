// Shared helpers for the customer + admin portal pages.
(function () {
  const API = window.location.origin + '/api';
  const PHONE_KEY = 'yebs_customer_phone';

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function money(value) {
    return 'GH\u20b5 ' + (Number(value) || 0).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function adminToken() {
    return sessionStorage.getItem('yebs_admin_token')
      || localStorage.getItem('yebs_admin_token_persist')
      || '';
  }

  function driverToken() {
    return sessionStorage.getItem('yebs_driver_token')
      || localStorage.getItem('yebs_driver_token_persist')
      || '';
  }

  function authHeaders(extra) {
    const token = adminToken() || driverToken();
    return token ? Object.assign({}, extra, { Authorization: 'Bearer ' + token }) : Object.assign({}, extra);
  }

  async function api(path, options) {
    const opts = Object.assign({ cache: 'no-store' }, options || {});
    opts.headers = Object.assign({}, opts.body ? { 'Content-Type': 'application/json' } : {}, opts.headers || {});
    const res = await fetch(API + path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || ('Request failed (' + res.status + ')'));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function getPhone() {
    return localStorage.getItem(PHONE_KEY) || '';
  }

  function setPhone(phone) {
    const clean = String(phone || '').trim();
    if (clean) localStorage.setItem(PHONE_KEY, clean);
    else localStorage.removeItem(PHONE_KEY);
  }

  function statusBadge(status, paymentStatus) {
    const s = String(status || 'pending').toLowerCase();
    const cls = s === 'delivered' ? 'green'
      : s === 'cancelled' ? 'red'
      : s === 'enroute' || s === 'arrived' ? 'blue'
      : '';
    const label = s === 'enroute' ? 'En route' : s.charAt(0).toUpperCase() + s.slice(1);
    const pay = paymentStatus === 'paid'
      ? ' <span class="badge green">Paid</span>'
      : ' <span class="badge grey">' + escapeHtml(paymentStatus || 'unpaid') + '</span>';
    return '<span class="badge ' + cls + '">' + escapeHtml(label) + '</span>' + pay;
  }

  function notice(el, message, kind) {
    if (!el) return;
    el.className = 'notice ' + (kind || 'info');
    el.textContent = message;
    el.style.display = 'block';
  }

  function clearNotice(el) {
    if (!el) return;
    el.style.display = 'none';
    el.textContent = '';
  }

  function when(value) {
    if (!value) return '';
    const d = new Date(value);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function logout() {
    const sessionKeys = ['yebs_admin_token', 'yebs_admin_user', 'yebs_admin_login_at', 'yebs_admin_photo',
      'yebs_driver_token', 'yebs_driver_user', 'yebs_driver_login_at', 'yebs_driver_photo'];
    const localKeys = ['yebs_admin_token_persist', 'yebs_admin_user_persist', 'yebs_admin_login_at_persist',
      'yebs_driver_token_persist', 'yebs_driver_user_persist', 'yebs_driver_login_at_persist'];
    sessionKeys.forEach(k => { try { sessionStorage.removeItem(k); } catch (e) {} });
    localKeys.forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
    window.location.href = '../index.html';
  }

  function installLogoutButton() {
    if (document.getElementById('yebsPortalLogout')) return;
    const nav = document.querySelector('header nav') || document.querySelector('.header-wrap');
    if (!nav) return;
    const btn = document.createElement('button');
    btn.id = 'yebsPortalLogout';
    btn.type = 'button';
    btn.textContent = 'Log out';
    btn.style.cssText = 'color:#fff;background:#b91c1c;border:1px solid rgba(255,255,255,0.25);padding:6px 12px;border-radius:6px;font-size:0.82rem;font-weight:700;cursor:pointer;';
    btn.addEventListener('click', () => { if (confirm('Log out of YEBS?')) logout(); });
    nav.appendChild(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installLogoutButton);
  } else {
    installLogoutButton();
  }

  window.YebsPortal = {
    API,
    escapeHtml,
    money,
    adminToken,
    driverToken,
    authHeaders,
    api,
    getPhone,
    setPhone,
    statusBadge,
    notice,
    clearNotice,
    when,
    logout
  };
})();
