require('dotenv').config();
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Simple JSON Database ───
const DB_PATH = process.env.DB_PATH || './data.json';

function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch(e) {}
  return { applications: [], positions: getDefaultPositions() };
}

function saveDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function getDefaultPositions() {
  return [
    { id: 'gm', title: 'General Manager', type: 'management', pay_range: '$18-$24/hr + bonus',
      description: 'Lead our cafe to success! The GM is responsible for all day-to-day operations, team development, P&L management, guest experience, and hitting sales targets.',
      requirements: '2+ years food service management, P&L experience preferred, ServSafe a plus', active: true },
    { id: 'am', title: 'Assistant Manager', type: 'management', pay_range: '$15-$19/hr',
      description: 'Support the GM in running a high-energy, guest-first cafe. Help develop the team, manage shifts, and drive sales.',
      requirements: '1+ year food service experience, team leadership experience preferred', active: true },
    { id: 'tm', title: 'Team Member', type: 'hourly', pay_range: '$10-$13/hr',
      description: "Be the face of our cafe! Blend amazing smoothies, create great food, and make every guest's day better.",
      requirements: 'Must be 16+, no experience required — great attitude a must!', active: true },
  ];
}

// Init DB
let db = loadDB();
if (!db.positions || !db.positions.length) { db.positions = getDefaultPositions(); saveDB(db); }

// ─── Email Setup ───
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

async function sendEmail(to, subject, html) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return;
  try {
    await transporter.sendMail({
      from: `"${process.env.CAFE_NAME || 'Tropical Smoothie Cafe'}" <${process.env.SMTP_USER}>`,
      to, subject, html,
    });
  } catch(e) { console.error('Email error:', e.message); }
}

// ─── Scoring ───
function scoreApplication(data, position) {
  let score = 0;
  let disqualified = false;
  let disqualifyReason = '';

  if (data.legally_authorized === 'no') { disqualified = true; disqualifyReason = 'Not legally authorized to work in the US'; }
  if (data.over_18 === 'no' && position === 'gm') { disqualified = true; disqualifyReason = 'Must be 18+ for GM position'; }
  if (data.can_work_weekends === 'no' && data.can_work_mornings === 'no' && data.can_work_evenings === 'no') {
    disqualified = true; disqualifyReason = 'Insufficient availability (no weekends, mornings, or evenings)';
  }
  if (disqualified) return { score: 0, disqualified, disqualifyReason };

  // Availability
  const hoursScore = { 'under_20': 5, '20-30': 10, '30-40': 15, '40+': 20 };
  score += hoursScore[data.hours_available] || 0;
  if (data.can_work_weekends === 'yes') score += 10;
  if (data.can_work_mornings === 'yes') score += 5;
  if (data.can_work_evenings === 'yes') score += 5;
  if (data.can_work_holidays === 'yes') score += 5;

  // Experience
  if (position === 'gm') {
    const expScore = { 'none': 0, 'under_1': 0, '1-3': 10, '3-5': 20, '5+': 25 };
    score += expScore[data.years_experience] || 0;
    if (data.p_and_l_experience === 'yes') score += 15;
    if (data.inventory_experience === 'yes') score += 10;
    if (data.hiring_experience === 'yes') score += 10;
    if (data.management_experience === 'yes') score += 10;
    const teamSizeScore = { '1-4': 2, '5-9': 5, '10-19': 8, '20+': 10 };
    score += teamSizeScore[data.team_size_managed] || 0;
  } else if (position === 'am') {
    const expScore = { 'none': 0, 'under_1': 5, '1-3': 15, '3-5': 20, '5+': 20 };
    score += expScore[data.years_experience] || 0;
    if (data.management_experience === 'yes') score += 20;
    if (data.food_service_experience === 'yes') score += 15;
  } else {
    score += 20; // Base for showing up
    if (data.food_service_experience === 'yes') score += 15;
    if (data.available_start === 'immediately') score += 5;
  }

  // Answer quality
  if (data.why_tsc && data.why_tsc.length > 60) score += 5;
  if ((data.conflict_example || data.customer_service_example || '') .length > 80) score += 5;
  if (data.scenario_answer && data.scenario_answer.length > 60) score += 5;

  const finalScore = Math.min(score, 100);
  const status = finalScore >= 70 ? 'hot' : finalScore >= 45 ? 'review' : 'low';
  return { score: finalScore, disqualified: false, disqualifyReason: '', status };
}

// ─── Routes ───
app.get('/api/positions', (req, res) => {
  db = loadDB();
  res.json(db.positions.filter(p => p.active));
});

app.post('/api/apply', async (req, res) => {
  try {
    const data = req.body;
    const id = uuidv4();
    const { score, disqualified, disqualifyReason, status } = scoreApplication(data, data.position);
    const posLabel = { gm: 'General Manager', am: 'Assistant Manager', tm: 'Team Member' }[data.position] || data.position;

    const application = {
      id,
      applied_at: new Date().toISOString(),
      status: disqualified ? 'disqualified' : status,
      score, disqualified, disqualify_reason: disqualifyReason,
      hired: false,
      notes: '',
      interview_date: null,
      ...data
    };

    db = loadDB();
    db.applications.push(application);
    saveDB(db);

    // Notify owner
    if (process.env.NOTIFY_EMAIL) {
      await sendEmail(process.env.NOTIFY_EMAIL,
        `🆕 New ${posLabel} Application — ${data.first_name} ${data.last_name} (Score: ${score})`,
        `<h2>New Application!</h2>
         <p><b>Position:</b> ${posLabel}</p>
         <p><b>Name:</b> ${data.first_name} ${data.last_name}</p>
         <p><b>Phone:</b> ${data.phone}</p>
         <p><b>Email:</b> ${data.email}</p>
         <p><b>Score:</b> ${score}/100</p>
         <p><b>Status:</b> ${disqualified ? '❌ DISQUALIFIED — '+disqualifyReason : score >= 70 ? '🔥 HOT CANDIDATE' : score >= 45 ? '👀 WORTH REVIEWING' : '📋 LOW PRIORITY'}</p>
         <p><b>Hours/wk:</b> ${data.hours_available} | Weekends: ${data.can_work_weekends}</p>
         <hr><p><a href="${process.env.APP_URL||'http://localhost:3000'}/admin">View in Dashboard →</a></p>`
      );
    }

    // Confirm to applicant
    if (data.email) {
      await sendEmail(data.email,
        `Thanks for applying to Tropical Smoothie Cafe — ${data.first_name}!`,
        `<h2>Thanks for applying, ${data.first_name}!</h2>
         <p>We received your application for the <b>${posLabel}</b> position at Tropical Smoothie Cafe.</p>
         <p>We review applications within 2-3 business days. If you're a great match, we'll be in touch to schedule an interview!</p>
         <br><p>Thanks,<br><b>The Tropical Smoothie Cafe Team</b></p>`
      );
    }

    res.json({ success: true, id, score, status: application.status });
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin ───
function adminAuth(req, res, next) {
  const t = req.headers['x-admin-token'] || req.query.token;
  if (t !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.get('/api/admin/applications', adminAuth, (req, res) => {
  db = loadDB();
  let apps = db.applications;
  if (req.query.position) apps = apps.filter(a => a.position === req.query.position);
  if (req.query.status) apps = apps.filter(a => a.status === req.query.status);
  apps = apps.sort((a, b) => b.score - a.score || new Date(b.applied_at) - new Date(a.applied_at));
  res.json(apps);
});

app.get('/api/admin/applications/:id', adminAuth, (req, res) => {
  db = loadDB();
  const app = db.applications.find(a => a.id === req.params.id);
  if (!app) return res.status(404).json({ error: 'Not found' });
  res.json(app);
});

app.patch('/api/admin/applications/:id', adminAuth, (req, res) => {
  db = loadDB();
  const idx = db.applications.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  Object.assign(db.applications[idx], req.body);
  saveDB(db);
  res.json({ success: true });
});

app.get('/api/admin/stats', adminAuth, (req, res) => {
  db = loadDB();
  const apps = db.applications;
  const byPos = {};
  apps.forEach(a => { byPos[a.position] = (byPos[a.position] || 0) + 1; });
  res.json({
    total: apps.length,
    hot: apps.filter(a => a.status === 'hot').length,
    review: apps.filter(a => a.status === 'review').length,
    disqualified: apps.filter(a => a.disqualified).length,
    hired: apps.filter(a => a.hired).length,
    byPosition: Object.entries(byPos).map(([position, count]) => ({ position, count })),
  });
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ TSC Hiring App running on port ${PORT}`));
