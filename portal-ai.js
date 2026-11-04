(function () {
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = '/portal-ai.css';
  document.head.appendChild(style);

  const path = location.pathname.toLowerCase();
  const role = path.includes('/admin') || path === '/admin.html' ? 'admin'
    : path.includes('/driver') || path === '/driver.html' ? 'driver'
      : 'customer';
  const labels = {
    admin: ['YEBS Admin AI', 'Orders, drivers, payments, reports…'],
    driver: ['YEBS Driver AI', 'Deliveries, routes, earnings, payouts…'],
    customer: ['YEBS Customer AI', 'Meals, orders, payment, delivery…']
  };
  const label = labels[role];
  const history = [];

  const root = document.createElement('section');
  root.className = 'yebs-portals-ai';
  root.innerHTML = `
    <button class="yebs-portals-ai-launcher" type="button" aria-label="Open ${label[0]}">✦</button>
    <div class="yebs-portals-ai-panel" role="dialog" aria-label="${label[0]}">
      <header><div><strong>${label[0]}</strong><small>${label[1]}</small></div><button type="button" aria-label="Close">×</button></header>
      <div class="yebs-portals-ai-messages">
        <div class="yebs-portals-ai-message">Hello. I can help with this ${role} panel and answer general questions too. What do you need?</div>
      </div>
      <form><input autocomplete="off" maxlength="1200" placeholder="${role === 'admin' ? 'Ask about a dashboard feature…' : role === 'driver' ? 'Ask about deliveries or earnings…' : 'Ask about meals or your order…'}"><button type="submit" aria-label="Send">➤</button></form>
    </div>`;
  document.body.appendChild(root);

  const launcher = root.querySelector('.yebs-portals-ai-launcher');
  const panel = root.querySelector('.yebs-portals-ai-panel');
  const close = panel.querySelector('header button');
  const form = panel.querySelector('form');
  const input = form.querySelector('input');
  const messages = panel.querySelector('.yebs-portals-ai-messages');

  function toggle(open) {
    panel.classList.toggle('open', open);
    launcher.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) input.focus();
  }
  launcher.addEventListener('click', () => toggle(!panel.classList.contains('open')));
  close.addEventListener('click', () => toggle(false));

  function add(text, user) {
    const node = document.createElement('div');
    node.className = 'yebs-portals-ai-message' + (user ? ' user' : '');
    node.textContent = text;
    messages.appendChild(node);
    messages.scrollTop = messages.scrollHeight;
    return node;
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    const question = input.value.trim();
    if (!question) return;
    input.value = '';
    add(question, true);
    const thinking = add('Thinking…', false);
    try {
      const response = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (
            role === 'admin' ? (sessionStorage.getItem('yebs_admin_token') || localStorage.getItem('yebs_admin_token_persist') || '')
              : role === 'driver' ? (sessionStorage.getItem('yebs_driver_token') || localStorage.getItem('yebs_driver_token_persist') || '')
                : ''
          )
        },
        body: JSON.stringify({ message: question, role, history: history.slice(-10) })
      });
      const data = await response.json();
      thinking.remove();
      const answer = data.reply || [data.message, data.reason].filter(Boolean).join(' ') ||
        'The AI service is unavailable. Please try again in a moment.';
      add(answer, false);
      if (response.ok && data.success !== false) {
        history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
      }
    } catch (_) {
      thinking.remove();
      add('The assistant could not connect. Please try again.', false);
    }
  });
})();
