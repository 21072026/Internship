const { chromium } = require('./node_modules/playwright');
const fs = require('fs');

const ADMIN = { email: 'admin@test.com', password: 'Admin123!' };
const MENTOR = { email: 'mentor.aylin@demo.example.com', password: 'DemoPass123!' };
const MENTEE = { email: 'mentee.deniz@demo.example.com', password: 'DemoPass123!' };
const BASE = 'http://localhost:3000';

async function login(page, creds, role) {
  // Go to sign in page
  await page.goto(BASE + '/auth/signin', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('input[name="email"]', { timeout: 15000 });
  await page.fill('input[name="email"]', creds.email);
  await page.fill('input[name="password"]', creds.password);
  
  // Wait for submit and the navigation
  await Promise.all([
    page.waitForResponse(resp => resp.url().includes('/api/auth/'), { timeout: 15000 }),
    page.click('button[type="submit"]'),
  ]);
  
  await page.waitForTimeout(3000);
  const url = page.url();
  console.log(`  ${role} login result: ${url.replace(BASE, '')}`);
  return url;
}

async function checkPage(page, url, name) {
  try {
    const res = await page.goto(BASE + url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(1500);
    const status = res?.status() || 'unknown';
    const title = await page.title();
    const finalUrl = page.url();
    const headings = await page.$$eval('h1, h2', els => els.slice(0,4).map(e => e.textContent?.trim()?.substring(0,80)));
    const visible404 = await page.$$eval('h1, h2', els => els.some(e => e.textContent?.includes('404') || e.textContent?.toLowerCase().includes('not found')));
    fs.mkdirSync('/tmp/screenshots', { recursive: true });
    await page.screenshot({ path: `/tmp/screenshots/${name}.png`, fullPage: true });
    const redirected = (!finalUrl.includes(url) && url !== '/') ? ` → ${finalUrl.replace(BASE,'')}` : '';
    const flag = (status !== 200 || visible404) ? '⚠️' : '✅';
    console.log(`  ${flag} [${status}] ${name}${redirected}`);
    return { url, name, status, title, finalUrl, headings, redirected: !!redirected, visible404 };
  } catch(e) {
    console.log(`  ❌ ${name}: ${e.message.substring(0,100)}`);
    return { url, name, error: e.message };
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const results = [];

  console.log('\n=== PUBLIC pages ===');
  const ctx0 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p0 = await ctx0.newPage();
  for (const [url, name] of [
    ['/', 'landing'],
    ['/features', 'features'],
    ['/privacy', 'privacy'],
    ['/terms', 'terms'],
    ['/auth/signin', 'signin'],
    ['/auth/register', 'register'],
    ['/release-notes', 'release-notes'],
  ]) {
    results.push(await checkPage(p0, url, name));
  }
  await ctx0.close();

  console.log('\n=== ADMIN pages ===');
  const ctxAdmin = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pAdmin = await ctxAdmin.newPage();
  const adminLoginUrl = await login(pAdmin, ADMIN, 'admin');
  if (!adminLoginUrl.includes('/admin') && !adminLoginUrl.includes('/auth/signin')) {
    console.log('  Warning: Unexpected redirect:', adminLoginUrl);
  }
  for (const [url, name] of [
    ['/admin', 'admin-dashboard'],
    ['/admin/candidates', 'admin-candidates'],
    ['/admin/mentors', 'admin-mentors'],
    ['/admin/mentorship', 'admin-mentorship'],
    ['/admin/companies', 'admin-companies'],
    ['/admin/users', 'admin-users'],
    ['/admin/invite', 'admin-invite'],
    ['/admin/analytics', 'admin-analytics'],
    ['/admin/settings', 'admin-settings'],
    ['/admin/activity', 'admin-activity'],
    ['/admin/board', 'admin-board'],
    ['/admin/calendar', 'admin-calendar'],
    ['/admin/cohorts', 'admin-cohorts'],
    ['/admin/meetings', 'admin-meetings'],
    ['/admin/announcements', 'admin-announcements'],
    ['/admin/documents', 'admin-documents'],
    ['/admin/projects', 'admin-projects'],
    ['/admin/sources', 'admin-sources'],
    ['/admin/retention', 'admin-retention'],
    ['/admin/integrations', 'admin-integrations'],
    ['/admin/support', 'admin-support'],
    ['/admin/api-docs', 'admin-api-docs'],
    ['/admin/organizations', 'admin-organizations'],
    ['/admin/mentee-activity', 'admin-mentee-activity'],
  ]) {
    results.push(await checkPage(pAdmin, url, name));
  }
  await ctxAdmin.close();

  console.log('\n=== MENTOR pages ===');
  const ctxMentor = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pMentor = await ctxMentor.newPage();
  await login(pMentor, MENTOR, 'mentor');
  for (const [url, name] of [
    ['/mentor', 'mentor-dashboard'],
    ['/mentor/mentees', 'mentor-mentees'],
    ['/mentor/interactions', 'mentor-interactions'],
    ['/mentor/meetings', 'mentor-meetings'],
    ['/mentor/calendar', 'mentor-calendar'],
    ['/mentor/email', 'mentor-email'],
    ['/mentor/board', 'mentor-board'],
    ['/mentor/projects', 'mentor-projects'],
    ['/mentor/availability', 'mentor-availability'],
    ['/mentor/mentee-activity', 'mentor-mentee-activity'],
    ['/account', 'account'],
    ['/messages', 'messages'],
  ]) {
    results.push(await checkPage(pMentor, url, name));
  }
  await ctxMentor.close();

  console.log('\n=== MENTEE pages ===');
  const ctxMentee = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pMentee = await ctxMentee.newPage();
  await login(pMentee, MENTEE, 'mentee');
  for (const [url, name] of [
    ['/portal', 'portal-dashboard'],
    ['/portal/profile', 'portal-profile'],
    ['/portal/interactions', 'portal-interactions'],
    ['/portal/messages', 'portal-messages'],
    ['/portal/notes', 'portal-notes'],
  ]) {
    results.push(await checkPage(pMentee, url, name));
  }
  await ctxMentee.close();

  await browser.close();
  fs.writeFileSync('/tmp/browse-results.json', JSON.stringify(results, null, 2));
  console.log('\n✅ Done!');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
