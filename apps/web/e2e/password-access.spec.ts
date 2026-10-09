import { expect, test } from './fixtures';

async function signedOut(page: import('@playwright/test').Page) {
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__xmatrixDisableMockAuth = true; });
  await page.route('**/api/auth/get-session', route => route.fulfill({ json: null }));
}

test('password sign-in reports refusal without leaving the form or leaking a handoff context', async ({page}) => {
  await signedOut(page);
  let attempts=0;
  await page.route('**/api/auth/sign-in/email', async route => {
    attempts++;expect(route.request().postDataJSON().email).toBe('reviewer@example.test');
    expect(route.request().headers().referer).toBeUndefined();
    await route.fulfill({status:401,json:{code:'INVALID_EMAIL_OR_PASSWORD',message:'Invalid email or password'}});
  });
  await page.goto('/login/password?client=ios');
  await page.getByLabel('Email address').fill('reviewer@example.test');
  await page.getByLabel('Password',{exact:true}).fill('fixture-only-long-password');
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Invalid email or password');
  await expect(page.getByRole('link',{name:'Use a login code or Google'})).toHaveAttribute('href','/login?client=ios');
  expect(attempts).toBe(1);
});

test('reset confirmation must match, and its private token is not copied into sign-in links', async ({page}) => {
  await signedOut(page);
  let writes=0;
  await page.route('**/api/auth/reset-password', route => {writes++;return route.fulfill({json:{status:true}});});
  await page.goto('/reset-password?token=isolated-fixture-token');
  await page.getByLabel('New password',{exact:true}).fill('fixture-only-long-password');
  await page.getByLabel('Confirm password').fill('different-fixture-password');
  await page.getByRole('button',{name:'Save password'}).click();
  await expect(page.getByRole('status')).toContainText('Passwords do not match');
  expect(writes).toBe(0);
  await expect(page.getByRole('link',{name:'Use a login code or Google'})).toHaveAttribute('href','/login');
  await page.getByLabel('Confirm password').fill('fixture-only-long-password');
  await page.getByRole('button',{name:'Save password'}).click();
  await expect(page.getByRole('status')).toContainText('Password saved');
  expect(writes).toBe(1);
});

test('a device handoff requires an explicit request check before password submission', async ({page}) => {
  await signedOut(page);
  await page.goto('/login/password?device_code=fixture-only&user_code=TEST-1234');
  await expect(page.getByText('TEST-1234',{exact:true})).toBeVisible();
  const submit=page.getByRole('button',{name:'Sign in',exact:true});
  await expect(submit).toBeDisabled();
  await page.getByRole('checkbox',{name:'I checked the request and code on my device.'}).check();
  await expect(submit).toBeEnabled();
});
