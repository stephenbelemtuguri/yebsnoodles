const { test, expect } = require('@playwright/test');

test('places a menu-backed order through the storefront', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('dialog', dialog => dialog.accept());

  await page.goto('/index.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  const permissionSkip = page.locator('#custPermSkipBtn');
  if (await permissionSkip.isVisible()) await permissionSkip.click();
  await expect(page.locator('#menuGrid .menu-add-btn').first()).toBeVisible();
  await page.locator('#menuGrid .menu-add-btn').first().click();
  await page.locator('#customer').fill('Browser Test Customer');
  await page.locator('#phone').fill('0241234567');
  await page.locator('#payModeDelivery').check();

  const orderResponsePromise = page.waitForResponse(response =>
    response.url().endsWith('/api/orders') && response.request().method() === 'POST'
  );
  await page.locator('#submitOrderBtn').click();

  const orderResponse = await orderResponsePromise;
  expect(orderResponse.status()).toBe(201);
  const order = await orderResponse.json();
  expect(order).toMatchObject({
    customer: 'Browser Test Customer',
    fulfilment: 'Collection',
    paymentMode: 'cash',
    subtotal: 25,
    items: [{ menuId: 'e2e-noodles', name: 'E2E Test Noodles', price: 25, quantity: 1 }]
  });
  expect(order.trackingToken).toBeTruthy();
  await expect(page.locator('#formFeedback')).toContainText(`Order ${order.id} placed`);
  await page.locator('#thanksDoneBtn').click();
  await page.locator('#orderIdModalCloseBtn').click();
  await page.locator('#headerTrackInput').fill(order.id);
  await page.locator('#headerTrackSubmit').click();
  await expect(page.locator('#trackingOverlay')).toHaveClass(/active/);
  await expect(page.locator('#trackOrderIdDisplay')).toHaveText(order.id);
  await expect(page.locator('#trackSearchStatus')).toContainText(`Tracking order ${order.id}`);
  expect(pageErrors).toEqual([]);
});

test('restores a pending MoMo payment after the customer returns to the storefront', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('dialog', dialog => dialog.accept());

  await page.goto('/index.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  const permissionSkip = page.locator('#custPermSkipBtn');
  if (await permissionSkip.isVisible()) await permissionSkip.click();
  await expect(page.locator('#menuGrid .menu-add-btn').first()).toBeVisible();
  await page.locator('#menuGrid .menu-add-btn').first().click();
  await page.locator('#customer').fill('MoMo Return Test Customer');
  await page.locator('#phone').fill('0241234567');
  await page.locator('#payerPhone').fill('0241234567');

  const orderResponsePromise = page.waitForResponse(response =>
    response.url().endsWith('/api/orders') && response.request().method() === 'POST'
  );
  await page.locator('#submitOrderBtn').click();

  const orderResponse = await orderResponsePromise;
  expect(orderResponse.status()).toBe(201);
  const order = await orderResponse.json();
  await expect(page.locator('#payNowModal')).toBeVisible();
  const pendingPayment = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('yebs_pending_payment'))
  );
  expect(pendingPayment).toMatchObject({
    orderId: order.id,
    network: 'mtn',
    total: order.total
  });
  expect(pendingPayment.at).toEqual(expect.any(Number));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#payNowModal')).toBeVisible();
  await expect(page.locator('#payNowOrderId')).toHaveText(order.id);
  expect(pageErrors).toEqual([]);
});

test('rejects fabricated menu items at the API boundary', async ({ request }) => {
  const response = await request.post('/api/orders', {
    data: {
      customer: 'Browser Test Customer',
      phone: '0241234567',
      fulfilment: 'Collection',
      items: [{ menuId: 'not-a-real-item', name: 'Free meal', price: 0, quantity: 1 }]
    }
  });

  expect(response.status()).toBe(400);
  await expect(response.json()).resolves.toMatchObject({
    success: false,
    message: expect.stringContaining('unavailable')
  });
});

test('server order sync clears stale assignment and destination fields but keeps private PIN data', async ({ page }) => {
  await page.goto('/index.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  const merged = await page.evaluate(async () => {
    const { mergeServerOrders, getOrders } = await import('/shared.js');
    localStorage.setItem('yebs_noodles_orders_v2', JSON.stringify([{
      id: 'YB-SYNC01',
      pickupPin: '1234',
      driver: { id: 'drv-old', name: 'Old Rider' },
      mapPin: { lat: 5.6, lng: -0.2 },
      phone: '0240000000'
    }]));
    mergeServerOrders([{
      id: 'YB-SYNC01',
      driver: null,
      mapPin: null,
      phone: '0241111111',
      status: 'pending'
    }]);
    return getOrders()[0];
  });

  expect(merged).toMatchObject({
    id: 'YB-SYNC01',
    pickupPin: '1234',
    driver: null,
    mapPin: null,
    phone: '0241111111',
    status: 'pending'
  });
});

test('loads the operations portals without uncaught JavaScript errors', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  for (const [route, title] of [
    ['/admin.html', /YEBS Noodles \| Admin Dashboard/],
    ['/driver.html', /YEBS Noodles \| Driver Batch Dispatch/]
  ]) {
    await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await expect(page).toHaveTitle(title);
    if (route === '/admin.html') {
      await expect(page.locator('#adminForgotBtn')).toHaveCount(0);
    } else {
      await expect(page.locator('#driverForgotBtn')).toBeVisible();
    }
  }

  expect(pageErrors).toEqual([]);
});

test('opens the local database driver selfie-recovery flow instead of SMS recovery', async ({ page }) => {
  await page.goto('/driver.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.locator('#driverForgotBtn').click();

  await expect(page.getByRole('heading', { name: 'Recover your driver password' })).toBeVisible();
  await expect(page.getByText(/face match, and live-camera challenge/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Verify face and phone' })).toBeDisabled();
});
