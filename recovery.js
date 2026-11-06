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
// A code is delivered through configured channels. If admin delivery is
// unavailable, the owner can retrieve its short-lived code from restricted
// hosting logs; codes are never exposed in production API responses.

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

function openDriverRecovery() {
  injectStyles();
  const overlay = document.createElement('div');
  overlay.className = 'yebs-recovery-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Recover your driver password');
  overlay.innerHTML = `
    <div class="yebs-recovery-card">
      <div class="yebs-recovery-head">
        <button type="button" class="yebs-recovery-close" data-close aria-label="Close">&times;</button>
        <h3>Recover your driver password</h3>
        <p>YEBS reviews your live selfie against your driver registration photo. No SMS code or external face service is used.</p>
      </div>
      <div class="yebs-recovery-body">
        <section data-request>
          <label class="yebs-recovery-label" for="yebsDriverRecoveryPhone">Phone number used for registration</label>
          <input class="yebs-recovery-input" id="yebsDriverRecoveryPhone" type="tel" autocomplete="tel" inputmode="tel" placeholder="e.g. 0241234567" required>
          <p class="yebs-recovery-note">An administrator will compare the live camera photo below with your stored registration photo. Your selfie is kept in YEBS's database only while the request is open and is deleted after a decision or expiry.</p>
          <div class="webcam-stage" style="position:relative;min-height:220px;background:#102b22;border-radius:12px;overflow:hidden;">
            <video data-video autoplay playsinline muted style="display:none;width:100%;max-height:300px;object-fit:cover;"></video>
            <canvas data-canvas hidden></canvas>
            <img data-preview alt="Live selfie preview" style="display:none;width:100%;max-height:300px;object-fit:cover;">
            <div data-camera-prompt style="min-height:220px;display:grid;place-items:center;padding:20px;color:#fff;text-align:center;">Use the secure live camera to capture your face.</div>
          </div>
          <div style="display:flex;gap:8px;margin:10px 0;">
            <button type="button" class="yebs-recovery-btn" data-camera style="flex:1;">Start live camera</button>
            <button type="button" class="yebs-recovery-btn" data-capture disabled style="flex:1;">Capture selfie</button>
          </div>
          <button type="button" class="yebs-recovery-link" data-retake hidden>Retake selfie</button>
          <button type="button" class="yebs-recovery-btn" data-submit disabled>Submit for administrator review</button>
        </section>
        <section data-review hidden>
          <p class="yebs-recovery-note" data-review-message role="status" aria-live="polite"></p>
          <div class="yebs-recovery-status" data-review-status role="status" aria-live="polite">Checking review status…</div>
          <button type="button" class="yebs-recovery-link" data-restart>Start a new request</button>
        </section>
        <form data-password novalidate hidden>
          <p class="yebs-recovery-note">Your identity was approved by an administrator. Choose a new password to complete recovery.</p>
          <label class="yebs-recovery-label" for="yebsDriverNewPassword">New password</label>
          <input class="yebs-recovery-input" id="yebsDriverNewPassword" type="password" minlength="8" autocomplete="new-password" required>
          <label class="yebs-recovery-label" for="yebsDriverConfirmPassword">Confirm new password</label>
          <input class="yebs-recovery-input" id="yebsDriverConfirmPassword" type="password" minlength="8" autocomplete="new-password" required>
          <button type="submit" class="yebs-recovery-btn" data-reset>Save new password</button>
        </form>
        <section class="yebs-recovery-success" data-success hidden>
          <div class="tick">✓</div>
          <h3 style="margin:0 0 6px;font-family:Georgia,serif;color:#173d30;">Password updated</h3>
          <p style="margin:0 0 14px;font-size:.86rem;color:#5b675c;">Sign in to the driver portal with your new password.</p>
          <button type="button" class="yebs-recovery-btn" data-login>Continue to driver login</button>
        </section>
        <p class="yebs-recovery-status" data-status role="status" aria-live="polite"></p>
      </div>
    </div>
  `;

  const $ = selector => overlay.querySelector(selector);
  const requestPanel = $('[data-request]');
  const reviewPanel = $('[data-review]');
  const passwordForm = $('[data-password]');
  const successPanel = $('[data-success]');
  const phoneInput = $('#yebsDriverRecoveryPhone');
  const video = $('[data-video]');
  const canvas = $('[data-canvas]');
  const preview = $('[data-preview]');
  const cameraPrompt = $('[data-camera-prompt]');
  const cameraButton = $('[data-camera]');
  const captureButton = $('[data-capture]');
  const submitButton = $('[data-submit]');
  const retakeButton = $('[data-retake]');
  const status = $('[data-status]');
  let cameraStream = null;
  let selfiePhoto = '';
  let requestId = '';
  let accessToken = '';
  let pollTimer = null;
  let closed = false;

  function setStatus(message, tone = '') {
    status.textContent = message;
    status.className = `yebs-recovery-status${tone ? ` ${tone}` : ''}`;
  }

  function stopCamera() {
    if (cameraStream) cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
    video.srcObject = null;
  }

  function close() {
    closed = true;
    if (pollTimer) clearTimeout(pollTimer);
    stopCamera();
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    document.body.style.overflow = '';
  }
  function onKey(event) { if (event.key === 'Escape') close(); }
  function goToLogin() { window.location.href = '/driver.html'; }

  async function startCamera() {
    setStatus('');
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('Live camera recovery requires a secure HTTPS connection and a supported browser.', 'error');
      return;
    }
    cameraButton.disabled = true;
    cameraButton.textContent = 'Opening camera…';
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
      });
      video.srcObject = cameraStream;
      video.style.display = 'block';
      cameraPrompt.style.display = 'none';
      await video.play();
      captureButton.disabled = false;
      cameraButton.textContent = 'Camera ready';
    } catch (error) {
      stopCamera();
      cameraButton.disabled = false;
      cameraButton.textContent = 'Start live camera';
      setStatus(error.name === 'NotAllowedError'
        ? 'Allow camera access to continue with driver recovery.'
        : 'Could not open the camera. Close other camera apps and try again.', 'error');
    }
  }

  function captureSelfie() {
    if (!video.videoWidth || !video.videoHeight) {
      setStatus('Wait for the camera image, then capture your selfie.', 'error');
      return;
    }
    const side = Math.min(video.videoWidth, video.videoHeight);
    const left = Math.floor((video.videoWidth - side) / 2);
    const top = Math.floor((video.videoHeight - side) / 2);
    canvas.width = 360;
    canvas.height = 360;
    const context = canvas.getContext('2d');
    context.drawImage(video, left, top, side, side, 0, 0, 360, 360);
    selfiePhoto = canvas.toDataURL('image/jpeg', 0.62);
    preview.src = selfiePhoto;
    preview.style.display = 'block';
    video.style.display = 'none';
    cameraPrompt.style.display = 'none';
    stopCamera();
    captureButton.disabled = true;
    cameraButton.disabled = true;
    cameraButton.textContent = 'Live selfie captured';
    retakeButton.hidden = false;
    submitButton.disabled = !phoneInput.value.trim();
    setStatus('Selfie captured. Check the preview before submitting.', 'ok');
  }

  async function pollReviewStatus() {
    if (closed || !requestId || !accessToken) return;
    try {
      const response = await fetch(`${apiBase()}/api/auth/driver-recovery/${encodeURIComponent(requestId)}`, {
        headers: { 'X-Driver-Recovery-Token': accessToken },
        cache: 'no-store'
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 410) {
        $('[data-review-status]').textContent = data.message || 'This request expired. Start a new request.';
        return;
      }
      if (!response.ok || !data.success) {
        $('[data-review-status]').textContent = data.message || 'Could not check the review status. Retrying…';
      } else if (data.status === 'approved') {
        if (pollTimer) clearTimeout(pollTimer);
        reviewPanel.hidden = true;
        passwordForm.hidden = false;
        $('#yebsDriverNewPassword').focus();
        return;
      } else if (data.status === 'denied') {
        if (pollTimer) clearTimeout(pollTimer);
        $('[data-review-status]').textContent = data.message;
        $('[data-restart]').hidden = false;
        return;
      } else {
        $('[data-review-status]').textContent = data.message || 'Your request is waiting for administrator review.';
      }
    } catch (_) {
      $('[data-review-status]').textContent = 'Could not reach the server. Retrying the review check…';
    }
    pollTimer = setTimeout(pollReviewStatus, 4000);
  }

  cameraButton.addEventListener('click', startCamera);
  captureButton.addEventListener('click', captureSelfie);
  phoneInput.addEventListener('input', () => {
    submitButton.disabled = !phoneInput.value.trim() || !selfiePhoto;
  });
  retakeButton.addEventListener('click', async () => {
    selfiePhoto = '';
    preview.style.display = 'none';
    retakeButton.hidden = true;
    submitButton.disabled = true;
    cameraButton.disabled = false;
    cameraButton.textContent = 'Start live camera';
    await startCamera();
  });
  submitButton.addEventListener('click', async () => {
    const phone = phoneInput.value.trim();
    if (!phone || !selfiePhoto) {
      setStatus('Enter your registration phone number and capture a live selfie.', 'error');
      return;
    }
    submitButton.disabled = true;
    submitButton.textContent = 'Submitting securely…';
    setStatus('');
    try {
      const { ok, data } = await postJson('/api/auth/driver-recovery', { phone, selfiePhoto });
      if (!ok || !data.success) {
        setStatus(data.message || 'Could not submit the recovery request. Try again.', 'error');
        return;
      }
      requestId = data.requestId;
      accessToken = data.accessToken;
      requestPanel.hidden = true;
      reviewPanel.hidden = false;
      $('[data-review-message]').textContent = data.message;
      $('[data-review-status]').textContent = 'Checking the request and waiting for administrator review…';
      pollReviewStatus();
    } catch (_) {
      setStatus('Cannot reach the YEBS server. Check your connection and try again.', 'error');
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Submit for administrator review';
    }
  });
  $('[data-restart]').addEventListener('click', () => {
    if (pollTimer) clearTimeout(pollTimer);
    requestId = '';
    accessToken = '';
    selfiePhoto = '';
    reviewPanel.hidden = true;
    passwordForm.hidden = true;
    requestPanel.hidden = false;
    preview.style.display = 'none';
    cameraPrompt.style.display = 'grid';
    retakeButton.hidden = true;
    cameraButton.disabled = false;
    cameraButton.textContent = 'Start live camera';
    submitButton.disabled = true;
    phoneInput.focus();
    setStatus('');
  });
  passwordForm.addEventListener('submit', async event => {
    event.preventDefault();
    const password = $('#yebsDriverNewPassword').value;
    const confirmPassword = $('#yebsDriverConfirmPassword').value;
    if (password.length < 8) { setStatus('Choose a password with at least 8 characters.', 'error'); return; }
    if (password !== confirmPassword) { setStatus('The new passwords do not match.', 'error'); return; }
    const button = $('[data-reset]');
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      const response = await fetch(`${apiBase()}/api/auth/driver-recovery/${encodeURIComponent(requestId)}/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Driver-Recovery-Token': accessToken },
        body: JSON.stringify({ password, confirmPassword })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        setStatus(data.message || 'Could not update the password. Try again.', 'error');
        return;
      }
      passwordForm.hidden = true;
      successPanel.hidden = false;
      setStatus('');
      setTimeout(goToLogin, 1500);
    } catch (_) {
      setStatus('Cannot reach the YEBS server. Check your connection and try again.', 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Save new password';
    }
  });
  $('[data-login]').addEventListener('click', goToLogin);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  $('[data-close]').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';
  setTimeout(() => phoneInput.focus(), 60);
  return { close };
}

export function openRecovery(role = 'admin') {
  if (role === 'driver') return openDriverRecovery();
  injectStyles();
  const isAdmin = role === 'admin';
  const roleLabel = isAdmin ? 'admin' : 'rider';
  const idLabel = isAdmin ? 'Admin username, email, or phone' : 'Rider username, email, or phone number';
  const idPlaceholder = isAdmin ? 'e.g. your admin username or recovery phone' : 'e.g. your username, email, or 0541234567';

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
        <p>We will send a 6-digit code through the configured recovery channels. If admin delivery is unavailable, an authorized service owner can retrieve a short-lived fallback code from the hosting logs.</p>
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
                ? 'Enter your admin username, email, or recovery phone. When delivery services are unavailable, the one-time admin code is available only in restricted hosting logs.'
                : 'The code goes to the email and phone number you signed up with.'}
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
            <button type="button" class="yebs-recovery-link" data-back>Use a different account</button>
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
        const lines = [];
        if (data.emailDelivered) {
          lines.push(`✉️ <strong>Email code sent</strong> to <strong>${data.emailHint || 'your email'}</strong>.`);
        } else if (data.emailHint) {
          lines.push(`✉️ Email (${data.emailHint}): ${data.emailReason === 'smtp-not-configured' ? 'SMTP unconfigured' : (data.emailReason || 'Pending')}`);
        }
        if (data.smsDelivered) {
          lines.push(`📱 <strong>WhatsApp/SMS code sent</strong> to <strong>${data.phoneHint || 'your phone'}</strong>.`);
        } else if (data.phoneHint) {
          lines.push(`📱 Phone (${data.phoneHint}): ${data.smsReason === 'not-configured' ? 'Cloud API unconfigured' : (data.smsReason || 'Pending')}`);
        }

        if (data.delivered) {
          delivery.className = 'yebs-recovery-note';
          delivery.innerHTML = lines.join('<br>') + `<br><small style="color:#555">Code is valid for ${data.expiresInMinutes || 10} minutes.</small>`;
        } else if (data.code) {
          delivery.className = 'yebs-recovery-note';
          delivery.innerHTML = (lines.length ? lines.join('<br>') + '<br>' : '') + `⚡ Recovery code: <strong>${data.code}</strong> (autofilled below).`;
        } else if (data.ownerLogFallback) {
          delivery.className = 'yebs-recovery-note warn';
          delivery.textContent = 'Email and phone delivery are not configured. An authorized Render owner can find the one-time code in the service logs by searching for “Admin password recovery code”. It expires in 10 minutes. Do not share the code.';
        } else if (data.canSelfRecover) {
          delivery.className = 'yebs-recovery-note warn';
          delivery.innerHTML = (lines.length ? lines.join('<br>') + '<br>' : '') + 'No code was delivered. Contact the account administrator to restore email, SMS, or WhatsApp recovery delivery.';
        } else {
          delivery.className = 'yebs-recovery-note warn';
          delivery.innerHTML = 'No recovery email or phone was found for this account. Contact the administrator to update the account contact details.';
        }
        showStage(2);
        if (data.code) {
          codeInput.value = String(data.code);
          setStatus('Recovery code detected and filled in automatically.', 'ok');
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
