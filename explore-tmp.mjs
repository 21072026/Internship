import { chromium } from 'playwright';
import fs from 'fs';

const BASE = 'http://localhost:3000';
const issues = [];

function add(sev, label, title, url, body='') {
  issues.push({ sev, label, title, url, body });
  console.log(`  [${sev}] ${title}`);
}

async function goTo(p, url) {
  try { await p.goto(url, { waitUntil: 'networkidle', timeout: 25000 }); }
  catch(e) {
    try { await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }); await p.waitForTimeout(2000); }
    catch(e2) {}
  }
}

async function login(p, email, pw) {
  await p.goto(`${BASE}/auth/signin`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2000);
  await p.locator('input[type="email"]').fill(email);
  await p.locator('input[type="password"]').fill(pw);
  await Promise.all([
    p.waitForURL(/^(?!.*signin).*$/, { timeout: 15000 }),
    p.locator('button[type="submit"]').click()
  ]);
  await p.waitForTimeout(500);
}

async function txt(p) { try { return await p.locator('body').innerText(); } catch(e) { return ''; } }
async function html(p) { try { return await p.content(); } catch(e) { return ''; } }

const browser = await chromium.launch({ headless: true });
try {

// ===== LANDING =====
console.log('\n--- Landing ---');
const pub = await browser.newContext();
const pp = await pub.newPage();
await goTo(pp, BASE);
const landT = await txt(pp);
const landH = await html(pp);

// Check if there's a proper description / hero section
console.log('Landing text snippet:', landT.replace(/\n+/g,' ').slice(0, 400));

// Check for "Register" button
if (!landH.includes('Register') && !landH.includes('Sign Up')) {
  add('MEDIUM', 'ux', 'Landing: No self-registration / "Sign Up" CTA button visible', BASE);
}

// Check for testimonials/social proof
if (!/testimonial|review|customer|partner/i.test(landT)) {
  add('LOW', 'ux', 'Landing: No social proof / testimonials section', BASE);
}

// Check public features page content  
await goTo(pp, `${BASE}/features`);
const featT = await txt(pp);
console.log('Features page text:', featT.replace(/\n+/g,' ').slice(0, 300));

// Check release notes content
await goTo(pp, `${BASE}/release-notes`);
const releaseT = await txt(pp);
console.log('Release notes snippet:', releaseT.replace(/\n+/g,' ').slice(0, 200));

// Signin page
await goTo(pp, `${BASE}/auth/signin`);
const signinT = await txt(pp);
const signinH = await html(pp);
console.log('Signin form:', signinT.replace(/\n+/g,' ').slice(0, 300));

// Show/hide password toggle
if (!signinH.includes('show') && !signinH.includes('Show') && !(signinH.includes('type="button"') && signinH.includes('password'))) {
  add('LOW', 'ux', 'Signin: No show/hide password toggle on the login form', `${BASE}/auth/signin`);
}

// Forgot password flow (check that it exists)
await goTo(pp, `${BASE}/auth/forgot`);
const forgotT = await txt(pp);
console.log('Forgot password:', forgotT.replace(/\n+/g,' ').slice(0, 200));
if (forgotT.includes('404') || forgotT.includes('not found')) {
  add('HIGH', 'bug', 'Forgot password page returns 404', `${BASE}/auth/forgot`);
}

await pub.close();

// ===== ADMIN =====
console.log('\n--- Admin ---');
const aCtx = await browser.newContext();
const ap = await aCtx.newPage();
await login(ap, 'admin@test.com', 'Admin1234!');

// Admin dashboard
await goTo(ap, `${BASE}/admin`);
const adminT = await txt(ap);
console.log('Admin dashboard:', adminT.replace(/\n+/g,' ').slice(0, 400));

// Check for stats/KPI cards on dashboard
const statCards = await ap.locator('[class*="stat"], [class*="kpi"], [class*="metric"], .grid .card, .grid [class*="Card"]').count();
const summaryNumbers = await ap.locator('h2 ~ *, h3 ~ *').count(); // numbers after headings
console.log(`Dashboard stat cards: ${statCards}, summary elements: ${summaryNumbers}`);
if (adminT.toLowerCase().includes('loading') || adminT.replace(/\s/g,'').length < 200) {
  add('HIGH', 'bug', 'Admin dashboard appears to not render content properly', `${BASE}/admin`);
}

// Admin candidates
await goTo(ap, `${BASE}/admin/candidates`);
const candT = await txt(ap);
console.log('Candidates page:', candT.replace(/\n+/g,' ').slice(200, 600));

// Check export
const hasExport = (await ap.locator('button, a').allTextContents()).some(t => /export|csv|download/i.test(t));
if (!hasExport) add('MEDIUM', 'enhancement', 'Admin candidates list: no data export (CSV/Excel) functionality', `${BASE}/admin/candidates`);

// Check bulk ops
const checkboxes = await ap.locator('input[type="checkbox"]').count();
if (checkboxes < 2) add('MEDIUM', 'enhancement', 'Admin candidates list: no bulk-select/bulk-action support', `${BASE}/admin/candidates`);

// Pipeline filter
const pipelineFilter = await ap.locator('select, [role="combobox"], [data-testid*="filter"]').count();
console.log(`Candidates filter controls: ${pipelineFilter}`);

// Candidates detail
await goTo(ap, `${BASE}/admin/candidates`);
const detailLinks = await ap.locator('a[href*="/admin/candidates/"]').all();
if (detailLinks.length > 0) {
  const href = await detailLinks[0].getAttribute('href');
  await goTo(ap, BASE + href);
  const detailT = await txt(ap);
  console.log('Candidate detail:', detailT.replace(/\n+/g,' ').slice(0, 500));
  
  if (!/skill|skill/i.test(detailT) && !/technolog/i.test(detailT)) {
    add('LOW', 'ux', 'Candidate detail: skills/tech stack not prominently shown', BASE + href);
  }
}

// Analytics page
await goTo(ap, `${BASE}/admin/analytics`);
const analyticsT = await txt(ap);
const analyticsH = await html(ap);
console.log('Analytics:', analyticsT.replace(/\n+/g,' ').slice(0, 400));
const chartElems = await ap.locator('canvas, svg[class*="recharts"], [class*="chart"]').count();
if (chartElems === 0) add('MEDIUM', 'enhancement', 'Analytics page: no charts/visualizations (data only in tables?)', `${BASE}/admin/analytics`);
console.log(`Analytics charts: ${chartElems}`);

// Board page  
await goTo(ap, `${BASE}/admin/board`);
const boardT = await txt(ap);
console.log('Board:', boardT.replace(/\n+/g,' ').slice(0, 400));

// Calendar
await goTo(ap, `${BASE}/admin/calendar`);
const calT = await txt(ap);
console.log('Calendar:', calT.replace(/\n+/g,' ').slice(0, 200));
if (/coming soon|placeholder|not available/i.test(calT)) {
  add('MEDIUM', 'enhancement', 'Calendar: stub/placeholder page', `${BASE}/admin/calendar`);
}

// Documents
await goTo(ap, `${BASE}/admin/documents`);
const docsT = await txt(ap);
console.log('Documents:', docsT.replace(/\n+/g,' ').slice(0, 400));
if (/coming soon|placeholder|not available/i.test(docsT)) {
  add('MEDIUM', 'enhancement', 'Documents: stub/placeholder page', `${BASE}/admin/documents`);
}

// Integrations
await goTo(ap, `${BASE}/admin/integrations`);
const integT = await txt(ap);
console.log('Integrations:', integT.replace(/\n+/g,' ').slice(0, 400));
if (/coming soon|placeholder|not available/i.test(integT)) {
  add('MEDIUM', 'enhancement', 'Integrations: stub/placeholder page', `${BASE}/admin/integrations`);
}

// API docs
await goTo(ap, `${BASE}/admin/api-docs`);
const apiT = await txt(ap);
console.log('API Docs:', apiT.replace(/\n+/g,' ').slice(0, 400));

// Settings
await goTo(ap, `${BASE}/admin/settings`);
const setT = await txt(ap);
console.log('Settings:', setT.replace(/\n+/g,' ').slice(0, 600));
if (/coming soon|placeholder/i.test(setT)) {
  add('HIGH', 'enhancement', 'Settings page is a stub/placeholder', `${BASE}/admin/settings`);
}

// Organizations
await goTo(ap, `${BASE}/admin/organizations`);
const orgT = await txt(ap);
console.log('Organizations:', orgT.replace(/\n+/g,' ').slice(0, 300));
if (/coming soon|placeholder/i.test(orgT)) {
  add('MEDIUM', 'enhancement', 'Organizations page is a stub', `${BASE}/admin/organizations`);
}

// Sources
await goTo(ap, `${BASE}/admin/sources`);
const srcT = await txt(ap);
console.log('Sources:', srcT.replace(/\n+/g,' ').slice(0, 300));

// Support admin
await goTo(ap, `${BASE}/admin/support`);
const suppT = await txt(ap);
console.log('Support admin:', suppT.replace(/\n+/g,' ').slice(0, 300));

// Cohorts
await goTo(ap, `${BASE}/admin/cohorts`);
const cohT = await txt(ap);
console.log('Cohorts:', cohT.replace(/\n+/g,' ').slice(0, 300));

// Retention
await goTo(ap, `${BASE}/admin/retention`);
const retT = await txt(ap);
console.log('Retention:', retT.replace(/\n+/g,' ').slice(0, 300));

// Account page
await goTo(ap, `${BASE}/admin/account`);
const accT = await txt(ap);
console.log('Account:', accT.replace(/\n+/g,' ').slice(0, 400));
if (!/password|şifre/i.test(accT)) {
  add('MEDIUM', 'enhancement', 'Account/profile page: no password change capability visible', `${BASE}/admin/account`);
}

// Users (impersonation)
await goTo(ap, `${BASE}/admin/users`);
const usersT = await txt(ap);
console.log('Users:', usersT.replace(/\n+/g,' ').slice(0, 400));
if (!/impersonat/i.test(usersT) && !/pretend|as user/i.test(usersT)) {
  console.log('  [note] No impersonation UI visible in users list');
}

await aCtx.close();

// ===== MENTOR =====
console.log('\n--- Mentor ---');
const mCtx = await browser.newContext();
const mp = await mCtx.newPage();
await login(mp, 'mentor.aylin@demo.example.com', 'DemoPass123!');

await goTo(mp, `${BASE}/mentor`);
const mentorT = await txt(mp);
console.log('Mentor dashboard:', mentorT.replace(/\n+/g,' ').slice(0, 400));

// Notification bell check
const bellIcon = await mp.locator('[data-lucide="bell"], [class*="bell"]').count();
const notifBtn = await mp.locator('button[aria-label*="notif"], a[href*="notif"]').count();
const headerBtns = await mp.locator('header button, header a').count();
console.log(`Bells: ${bellIcon}, notif buttons: ${notifBtn}, header buttons: ${headerBtns}`);
// Actually check if notification link is in the nav
const notifLink = await mp.locator('a[href*="notif"]').count();
console.log(`Nav notification links: ${notifLink}`);
if (bellIcon === 0 && notifBtn === 0 && notifLink === 0) {
  add('HIGH', 'enhancement', 'Mentor portal: no in-app notification system (bell icon or notification center)', `${BASE}/mentor`);
}

// Mentee detail (mentor view)
await goTo(mp, `${BASE}/mentor/mentees`);
const mtLinks = await mp.locator('a[href*="/mentor/mentees/"]').all();
let mtHref = null;
for (const l of mtLinks) {
  const h = await l.getAttribute('href');
  if (h && !h.includes('new')) { mtHref = h; break; }
}
if (mtHref) {
  await goTo(mp, BASE + mtHref);
  const mtDetailT = await txt(mp);
  console.log('Mentee detail (mentor):', mtDetailT.replace(/\n+/g,' ').slice(0, 600));
  
  const addInteraction = await mp.locator('button').evaluateAll(btns => 
    btns.filter(b => /add|log|interaction|etkileşim|görüşme/i.test(b.textContent||'')).map(b => b.textContent?.trim())
  );
  console.log('Add interaction buttons:', addInteraction);
  if (addInteraction.length === 0) {
    add('MEDIUM', 'ux', 'Mentor mentee detail: "Add Interaction" button not prominent', BASE + mtHref);
  }
  
  // Check pipeline status edit
  const pipelineEditable = await mp.locator('select, [role="combobox"], button[aria-haspopup]').count();
  console.log(`Pipeline edit controls: ${pipelineEditable}`);
}

// Email compose
await goTo(mp, `${BASE}/mentor/email`);
const emailT = await txt(mp);
console.log('Mentor email:', emailT.replace(/\n+/g,' ').slice(0, 400));
if (/coming soon|not available|stub/i.test(emailT)) {
  add('HIGH', 'enhancement', 'Mentor email composer: stub/not functional', `${BASE}/mentor/email`);
}

// Availability
await goTo(mp, `${BASE}/mentor/availability`);
const availT = await txt(mp);
console.log('Availability:', availT.replace(/\n+/g,' ').slice(0, 300));
if (/coming soon|not available|stub/i.test(availT)) {
  add('MEDIUM', 'enhancement', 'Mentor availability: stub/not functional', `${BASE}/mentor/availability`);
}

// Interactions log (bulk)
await goTo(mp, `${BASE}/mentor/interactions`);
const interT = await txt(mp);
console.log('Interaction logs:', interT.replace(/\n+/g,' ').slice(0, 300));

await mCtx.close();

// ===== PORTAL =====
console.log('\n--- Portal (Mentee) ---');
const pCtx = await browser.newContext();
const portP = await pCtx.newPage();
await login(portP, 'mentee.deniz@demo.example.com', 'DemoPass123!');

await goTo(portP, `${BASE}/portal`);
const portalT = await txt(portP);
console.log('Portal main:', portalT.replace(/\n+/g,' ').slice(0, 600));

if (!/mentor/i.test(portalT)) add('HIGH', 'ux', 'Mentee portal: assigned mentor name/info not shown on main screen', `${BASE}/portal`);
if (!/pipeline|status|stage|APPLICATION|BASVURU/i.test(portalT)) add('HIGH', 'ux', 'Mentee portal: current pipeline status/stage not clearly shown', `${BASE}/portal`);
if (!/company|şirket/i.test(portalT)) add('MEDIUM', 'ux', 'Mentee portal: assigned company not shown', `${BASE}/portal`);

// Portal profile
await goTo(portP, `${BASE}/portal/profile`);
const profT = await txt(portP);
console.log('Portal profile:', profT.replace(/\n+/g,' ').slice(0, 400));

// Portal notes
await goTo(portP, `${BASE}/portal/notes`);
const notesT = await txt(portP);
console.log('Portal notes:', notesT.replace(/\n+/g,' ').slice(0, 300));
if (/coming soon|not available|stub/i.test(notesT)) {
  add('MEDIUM', 'enhancement', 'Portal notes: stub/not functional', `${BASE}/portal/notes`);
}

// Portal messages
await goTo(portP, `${BASE}/portal/messages`);
const msgT = await txt(portP);
console.log('Portal messages:', msgT.replace(/\n+/g,' ').slice(0, 300));

// Portal interactions (view only?)
await goTo(portP, `${BASE}/portal/interactions`);
const pInterT = await txt(portP);
console.log('Portal interactions:', pInterT.replace(/\n+/g,' ').slice(0, 300));

// Can mentee see/submit their own info?
// Check for any forms on portal
await goTo(portP, `${BASE}/portal/profile`);
const editInputs = await portP.locator('input:not([type="hidden"]):not([readonly]), textarea:not([readonly])').count();
const saveBtn = await portP.locator('button[type="submit"], button:has-text("Save"), button:has-text("Kaydet"), button:has-text("Update")').count();
console.log(`Portal profile - inputs: ${editInputs}, save buttons: ${saveBtn}`);
if (editInputs === 0) add('HIGH', 'ux', 'Portal profile: no editable fields — mentee cannot update their profile', `${BASE}/portal/profile`);

await pCtx.close();

// ===== MESSAGES =====
console.log('\n--- Messages ---');
const msgCtx = await browser.newContext();
const msgP2 = await msgCtx.newPage();
await login(msgP2, 'mentor.aylin@demo.example.com', 'DemoPass123!');

await goTo(msgP2, `${BASE}/messages`);
const messT = await txt(msgP2);
console.log('Messages main:', messT.replace(/\n+/g,' ').slice(0, 400));

await goTo(msgP2, `${BASE}/messages/support`);
const suppMsgT = await txt(msgP2);
console.log('Support messages:', suppMsgT.replace(/\n+/g,' ').slice(0, 400));

await msgCtx.close();

// ===== COMPANY ROLE =====
console.log('\n--- Company role ---');
// Check if company accounts can log in
const compCtx = await browser.newContext();
const compP = await compCtx.newPage();
// No company user seeded, just check the page exists
await goTo(compP, `${BASE}/company`);
console.log('Company page:', compP.url(), '→', (await txt(compP)).slice(0,100).replace(/\n/g,' '));
await compCtx.close();

} catch(err) {
  console.error('Error:', err.message, err.stack?.slice(0, 500));
} finally {
  await browser.close();
}

console.log('\n===== ISSUE LIST =====');
issues.forEach((f, i) => {
  console.log(`${i+1}. [${f.sev.toUpperCase()}] [${f.label}] ${f.title}`);
  console.log(`   URL: ${f.url}`);
});

fs.writeFileSync('/tmp/issues.json', JSON.stringify(issues, null, 2));
console.log(`Total: ${issues.length} issues`);
