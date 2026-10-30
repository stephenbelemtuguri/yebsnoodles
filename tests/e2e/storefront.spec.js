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

test('loads the operations portals without uncaught JavaScript errors', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  for (const [route, title] of [
    ['/admin.html', /YEBS Noodles \| Admin Dashboard/],
    ['/driver.html', /YEBS Noodles \| Driver Batch Dispatch/]
  ]) {
    await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await expect(page).toHaveTitle(title);
  }

  expect(pageErrors).toEqual([]);
});
