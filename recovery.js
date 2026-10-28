// YEBS Noodles — shared password recovery dialog.
//
// Usage (from an ES module on any login page):
//   import { openRecovery } from './recovery.js';
//   openRecovery('admin');   // or 'driver'
//
// The dialog talks to:
//   POST /api/auth/recovery/start   { role, identifier }
//   POST /api/auth/recovery/verify  { role, identifier, code, password }
//
// A code is delivered over WhatsApp when the server has the Cloud API
// configured. On a local machine the code is returned in the response and
// filled in automatically.

const STYLE_ID = 'yebs-recovery-styles';

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .yebs-recovery-overlay {
      position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center;
      justify-content: center; padding: 16px; background: rgba(9, 24, 18, .72);
      backdrop-filter: blur(6px); overflow-y: auto;
    }
    .yebs-recovery-card {
      width: min(430px, 100%); max-height: calc(100dvh - 32px); overflow-y: auto;
      background: #fffefa; color: #20251f; border-radius: 18px;
      box-shadow: 0 30px 70px rgba(0, 0, 0, .45); font-family: inherit;
      animation: yebsRecoveryIn .25s ease-out;
    }
    @keyframes yebsRecoveryIn {
      from { opacity: 0; transform: translateY(14px) scale(.98); }
      to { opacity: 1; transform: none; }
    }
    .yebs-recovery-head {
      background: #173d30; color: #f8f4e9; padding: 20px 22px; border-radius: 18px 18px 0 0;
      position: relative;
    }
    .yebs-recovery-head h3 { margin: 0 0 4px; padding-right: 38px; font-family: Georgia, serif; font-size: 1.25rem; color: #e9bd68; }
    .yebs-recovery-head p { margin: 0; font-size: .8rem; opacity: .85; line-height: 1.45; }
    .yebs-recovery-close {
      position: absolute; top: 10px; right: 12px; width: 34px; height: 34px; border: 0;
      border-radius: 50%; background: rgba(255,255,255,.14); color: #fff; font-size: 1.2rem;
      cursor: pointer; line-height: 1;
    }
    .yebs-recovery-close:hover { background: rgba(255,255,255,.26); }
    .yebs-recovery-body { padding: 20px 22px 24px; }
    .yebs-recovery-step {
      display: flex; gap: 8px; align-items: center; margin-bottom: 16px;
      font-size: .72rem; font-weight: 800; letter-spacing: .05em; text-transform: uppercase;
      color: #71766d;
    }
    .yebs-recovery-step span { display: inline-flex; align-items: center; gap: 6px; }
    .yebs-recovery-step b {
      width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center;
      background: #e8e5da; color: #4b5c4b; font-size: .7rem;
    }
    .yebs-recovery-step span.on { color: #173d30; }
    .yebs-recovery-step span.on b { background: #173d30; color: #fff; }
    .yebs-recovery-label {
      display: block; margin-bottom: 6px; font-size: .8rem; font-weight: 700; color: #343c34;
    }
    .yebs-recovery-input {
      width: 100%; min-height: 46px; padding: 11px 13px; margin-bottom: 12px;
      border: 1.5px solid #deded4; border-radius: 9px; background: #fff; color: #20251f;
      font: inherit; font-size: .92rem;
    }
    .yebs-recovery-input:focus { outline: 0; border-color: #52785b; box-shadow: 0 0 0 3px rgba(82,120,91,.15); }
    .yebs-recovery-code {
      letter-spacing: .4em; text-align: center; font-family: ui-monospace, monospace;
      font-size: 1.4rem; font-weight: 800;
    }
    .yebs-recovery-btn {
      width: 100%; min-height: 46px; border: 0; border-radius: 9px; cursor: pointer;
      background: #e57a45; color: #fff; font: inherit; font-weight: 800; font-size: .95rem;
      transition: background .15s, transform .15s;
    }
    .yebs-recovery-btn:hover { background: #d26532; transform: translateY(-1px); }
    .yebs-recovery-btn:disabled { opacity: .6; cursor: not-allowed; transform: none; }
    .yebs-recovery-link {
      display: block; width: 100%; margin-top: 12px; border: 0; background: transparent;
      color: #52785b; font: inherit; font-size: .82rem; font-weight: 700; cursor: pointer;
      text-decoration: underline; padding: 6px;
    }
    .yebs-recovery-note {
      margin: 0 0 12px; padding: 10px 12px; border-radius: 9px; font-size: .78rem;
      line-height: 1.5; background: #f4f7f0; color: #3f4a3f; border: 1px solid #dbe7d4;
    }
    .yebs-recovery-note.warn { background: #fff8ec; border-color: #f5d9a8; color: #7a5a18; }
    .yebs-recovery-status {
      min-height: 20px; margin: 10px 0 0; font-size: .8rem; font-weight: 600; line-height: 1.45;
    }
    .yebs-recovery-status.error { color: #b91c1c; }
    .yebs-recovery-status.ok { color: #166534; }
    .yebs-recovery-success { text-align: center; padding: 10px 0 4px; }
    .yebs-recovery-success .tick {
      width: 64px; height: 64px; margin: 0 auto 12px; border-radius: 50%;
      display: grid; place-items: center; font-size: 2rem; color: #fff; background: #16a34a;
      animation: yebsPop .45s cubic-bezier(.2,1.4,.5,1);
    }
    @keyframes yebsPop { from { transform: scale(.4); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    @media (max-width: 420px) {
      .yebs-recovery-overlay { padding: 10px; align-items: flex-start; }
      .yebs-recovery-card { border-radius: 14px; }
      .yebs-recovery-head, .yebs-recovery-body { padding-left: 16px; padding-right: 16px; }
    }
  `;
  document.head.appendChild(style);
}

function apiBase() {
  return (typeof window !== 'undefined' && window.location && window.location.origin) || '';
}

async function postJson(path, body) {
  const res = await fetch(apiBase() + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export function openRecovery(role = 'admin') {
  injectStyles();
  const isAdmin = role === 'admin';
  const roleLabel = isAdmin ? 'admin' : 'rider';
  const idLabel = isAdmin ? 'Admin username' : 'Rider username or phone number';
  const idPlaceholder = isAdmin ? 'e.g. your username' : 'e.g. 0541234567';

  let identifier = '';
  let stage = 1;

  const overlay = document.createElement('div');
  overlay.className = 'yebs-recovery-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', `Recover your ${roleLabel} password`);
  overlay.innerHTML = `
    <div class="yebs-recovery-card">
      <div class="yebs-recovery-head">
        <button type="button" class="yebs-recovery-close" data-close aria-label="Close">&times;</button>
        <h3>Recover your ${roleLabel} password</h3>
        <p>We will send a 6-digit code to the phone number on your YEBS account.</p>
      </div>
      <div class="yebs-recovery-body">
        <div class="yebs-recovery-step">
          <span class="on" data-step="1"><b>1</b> Request code</span>
          <span data-step="2"><b>2</b> New password</span>
        </div>
        <form data-form novalidate>
          <div data-panel="1">
            <label class="yebs-recovery-label" for="yebsRecoveryId">${idLabel}</label>
            <input class="yebs-recovery-input" id="yebsRecoveryId" name="identifier" autocomplete="username"
                   placeholder="${idPlaceholder}" required>
            <div class="yebs-recovery-note">
              ${isAdmin
                ? 'The code goes to the recovery phone saved on the admin account or in Admin &rarr; Settings. If no phone is saved, ask the shop owner to run <strong>npm run reset:password</strong> on the server.'
                : 'The code goes to the phone number you signed up with.'}
            </div>
            <button type="submit" class="yebs-recovery-btn" data-send>Send recovery code</button>
          </div>
          <div data-panel="2" hidden>
            <div class="yebs-recovery-note" data-delivery></div>
            <label class="yebs-recovery-label" for="yebsRecoveryCode">6-digit code</label>
            <input class="yebs-recovery-input yebs-recovery-code" id="yebsRecoveryCode" name="code"
                   inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" required>
            <label class="yebs-recovery-label" for="yebsRecoveryPassword">New password</label>
            <input class="yebs-recovery-input" id="yebsRecoveryPassword" name="password" type="password"
                   autocomplete="new-password" minlength="8" placeholder="At least 8 characters" required>
            <label class="yebs-recovery-label" for="yebsRecoveryConfirm">Confirm new password</label>
            <input class="yebs-recovery-input" id="yebsRecoveryConfirm" name="confirm" type="password"
                   autocomplete="new-password" minlength="8" placeholder="Repeat the password" required>
            <button type="submit" class="yebs-recovery-btn" data-reset>Set new password</button>
            <button type="button" class="yebs-recovery-link" data-back>Use a different username</button>
          </div>
        </form>
        <div class="yebs-recovery-success" data-success hidden>
          <div class="tick">✓</div>
          <h3 style="margin:0 0 6px; font-family:Georgia,serif; color:#173d30;">Password updated</h3>
          <p style="margin:0 0 14px; font-size:.86rem; color:#5b675c;" data-success-text>Sign in with your new password.</p>
          <button type="button" class="yebs-recovery-btn" data-done>Back to sign in</button>
        </div>
        <p class="yebs-recovery-status" data-status role="status" aria-live="polite"></p>
      </div>
    </div>
  `;

  const $ = (sel) => overlay.querySelector(sel);
  const form = $('[data-form]');
  const status = $('[data-status]');
  const panel1 = $('[data-panel="1"]');
  const panel2 = $('[data-panel="2"]');
  const success = $('[data-success]');
  const idInput = $('#yebsRecoveryId');
  const codeInput = $('#yebsRecoveryCode');
  const pwdInput = $('#yebsRecoveryPassword');
  const confirmInput = $('#yebsRecoveryConfirm');
  const sendBtn = $('[data-send]');
  const resetBtn = $('[data-reset]');

  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    document.body.style.overflow = '';
  }
  function onKey(e) { if (e.key === 'Escape') close(); }

  function setStatus(text, tone) {
    status.textContent = text || '';
    status.className = 'yebs-recovery-status' + (tone ? ' ' + tone : '');
  }

  function showStage(next) {
    stage = next;
    panel1.hidden = next !== 1;
    panel2.hidden = next !== 2;
    overlay.querySelectorAll('.yebs-recovery-step span').forEach(el => {
      el.classList.toggle('on', Number(el.dataset.step) <= next);
    });
    setStatus('');
  }

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  $('[data-close]').addEventListener('click', close);
  $('[data-done]').addEventListener('click', close);
  $('[data-back]').addEventListener('click', () => { showStage(1); idInput.focus(); });
  document.addEventListener('keydown', onKey);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (stage === 1) {
      const value = idInput.value.trim();
      if (!value) { setStatus('Enter your username or phone number.', 'error'); return; }
      identifier = value;
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending…';
      setStatus('');
      try {
        const { ok, data } = await postJson('/api/auth/recovery/start', { role, identifier });
        if (!ok || !data.success) {
          setStatus(data.message || 'Could not send a recovery code. Try again.', 'error');
          return;
        }
        const delivery = $('[data-delivery]');
        if (data.delivered) {
          delivery.className = 'yebs-recovery-note';
          delivery.innerHTML = `Code sent to <strong>${data.phoneHint || 'the phone on file'}</strong>. It expires in ${data.expiresInMinutes || 10} minutes.`;
        } else if (data.canSelfRecover) {
          delivery.className = 'yebs-recovery-note warn';
          delivery.innerHTML = `We could not reach WhatsApp for <strong>${data.phoneHint || 'the phone on file'}</strong>. Ask the shop owner to read the code from the server log, or run <strong>npm run reset:password</strong>.`;
        } else {
          delivery.className = 'yebs-recovery-note warn';
          delivery.innerHTML = 'No recovery phone is saved for this account. Ask the shop owner to run <strong>npm run reset:password</strong> on the server, or add a recovery phone in Admin &rarr; Settings.';
        }
        showStage(2);
        if (data.code) {
          codeInput.value = String(data.code);
          setStatus('Local development: the code was filled in automatically.', 'ok');
          pwdInput.focus();
        } else {
          codeInput.focus();
        }
      } catch (err) {
        setStatus('Cannot reach the YEBS server. Check your connection and try again.', 'error');
      } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send recovery code';
      }
      return;
    }

    const code = codeInput.value.replace(/\D/g, '');
    const password = pwdInput.value;
    if (code.length !== 6) { setStatus('Enter the 6-digit code from the message.', 'error'); return; }
    if (password.length < 8) { setStatus('Choose a password with at least 8 characters.', 'error'); return; }
    if (password !== confirmInput.value) { setStatus('The two passwords do not match.', 'error'); return; }

    resetBtn.disabled = true;
    resetBtn.textContent = 'Updating…';
    setStatus('');
    try {
      const { ok, data } = await postJson('/api/auth/recovery/verify', { role, identifier, code, password });
      if (!ok || !data.success) {
        setStatus(data.message || 'Could not reset the password. Try again.', 'error');
        return;
      }
      form.hidden = true;
      $('.yebs-recovery-step').hidden = true;
      success.hidden = false;
      $('[data-success-text]').textContent = `Sign in as ${data.username || identifier} with your new password.`;
    } catch (err) {
      setStatus('Cannot reach the YEBS server. Check your connection and try again.', 'error');
    } finally {
      resetBtn.disabled = false;
      resetBtn.textContent = 'Set new password';
    }
  });

  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';
  setTimeout(() => idInput.focus(), 60);
  return { close };
}
