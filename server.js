require('dotenv').config();
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Simple JSON Database ───
const DB_PATH = process.env.DB_PATH || '/data/hiring.json';

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
    { id: 'tm', title: 'Team Member', type: 'hourly', pay_range: '$8-$10/hr',
      description: "Be the face of our cafe! Blend amazing smoothies, create great food, and make every guest's day better.",
      requirements: 'Must be 16+, no experience required — great attitude a must!', active: true },
  ];
}

// Init DB
let db = loadDB();
if (!db.positions || !db.positions.length) { db.positions = getDefaultPositions(); saveDB(db); }

// ─── Email via Resend ───
async function sendEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM || 'onboarding@resend.dev';
  if (!apiKey) { console.log('No RESEND_API_KEY — skipping email'); return; }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('Resend error:', err);
    }
  } catch(e) { console.error('Email error:', e.message); }
}

// ─── SMS via OpenPhone ───
async function sendSMS(to, text, fromOverride) {
  const apiKey = process.env.OPENPHONE_API_KEY;
  const from = fromOverride || process.env.OPENPHONE_NUMBER; // e.g. +13344891215
  if (!apiKey || !from) { console.log('OpenPhone not configured — skipping SMS'); return { ok: false, reason: 'not_configured' }; }

  // Normalize phone number to E.164
  const normalized = normalizePhone(to);
  if (!normalized) { console.log('Invalid phone number:', to); return { ok: false, reason: 'invalid_phone' }; }

  try {
    const res = await fetch('https://api.openphone.com/v1/messages', {
      method: 'POST',
      headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: [normalized], content: text }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('OpenPhone SMS error:', JSON.stringify(data));
      return { ok: false, reason: data.message || 'api_error', data };
    }
    console.log(`SMS sent to ${normalized}: ${data.data?.id}`);
    return { ok: true, id: data.data?.id };
  } catch(e) {
    console.error('SMS error:', e.message);
    return { ok: false, reason: e.message };
  }
}

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  if (digits.length > 10) return '+' + digits;
  return null;
}

// SMS templates
function interviewRequestSMS(firstName, position) {
  const posLabel = { gm: 'General Manager', am: 'Assistant Manager', tm: 'Team Member' }[position] || position;
  return `Hi ${firstName}! 🌴 Thanks for applying to Tropical Smoothie Cafe for the ${posLabel} position! We reviewed your application and would love to set up an interview. What days and times work best for you this week? Reply here and we'll get something scheduled!`;
}

function applicationReceivedSMS(firstName) {
  return `Hi ${firstName}! Thanks for applying to Tropical Smoothie Cafe 🌴 We received your application and will review it within 2-3 business days. We'll text you here if we'd like to schedule an interview!`;
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
    score += 20;
    if (data.food_service_experience === 'yes') score += 15;
    if (data.available_start === 'immediately') score += 5;
  }

  // Answer quality
  if (data.why_tsc && data.why_tsc.length > 60) score += 5;
  if ((data.conflict_example || data.customer_service_example || '').length > 80) score += 5;
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
      hired: false, notes: '', interview_date: null,
      sms_sent: false, sms_log: [],
      ...data
    };

    db = loadDB();
    db.applications.push(application);
    saveDB(db);

    // ── SMS Logic ──
    if (!disqualified && data.phone) {
      if (status === 'hot') {
        // Hot: immediately ask for interview availability
        const smsResult = await sendSMS(data.phone, interviewRequestSMS(data.first_name, data.position));
        const idx = db.applications.findIndex(a => a.id === id);
        if (idx !== -1) {
          db.applications[idx].sms_sent = smsResult.ok;
          db.applications[idx].sms_log = [{ type: 'interview_request', sent_at: new Date().toISOString(), ok: smsResult.ok, reason: smsResult.reason }];
          saveDB(db);
        }
      } else if (status === 'review' || status === 'low') {
        // Review/low: send confirmation text only
        const smsResult = await sendSMS(data.phone, applicationReceivedSMS(data.first_name));
        const idx = db.applications.findIndex(a => a.id === id);
        if (idx !== -1) {
          db.applications[idx].sms_sent = smsResult.ok;
          db.applications[idx].sms_log = [{ type: 'confirmation', sent_at: new Date().toISOString(), ok: smsResult.ok, reason: smsResult.reason }];
          saveDB(db);
        }
      }
    }

    // ── Email notify owner ──
    if (process.env.NOTIFY_EMAIL) {
      await sendEmail(process.env.NOTIFY_EMAIL,
        `🆕 New ${posLabel} Application — ${data.first_name} ${data.last_name} (Score: ${score})`,
        `<h2>New Application!</h2>
         <p><b>Position:</b> ${posLabel}</p>
         <p><b>Name:</b> ${data.first_name} ${data.last_name}</p>
         <p><b>Phone:</b> ${data.phone}</p>
         <p><b>Email:</b> ${data.email}</p>
         <p><b>Score:</b> ${score}/100</p>
         <p><b>Status:</b> ${disqualified ? '❌ DISQUALIFIED — '+disqualifyReason : score >= 70 ? '🔥 HOT — interview request SMS sent' : score >= 45 ? '👀 WORTH REVIEWING — confirmation SMS sent' : '📋 LOW PRIORITY'}</p>
         <p><b>Hours/wk:</b> ${data.hours_available} | Weekends: ${data.can_work_weekends}</p>
         <hr><p><a href="${process.env.APP_URL||'http://localhost:3000'}/admin">View in Dashboard →</a></p>`
      );
    }

    // ── Email confirm applicant ──
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

// ─── Admin: Manual SMS trigger ───
app.post('/api/admin/applications/:id/sms', adminAuth, async (req, res) => {
  db = loadDB();
  const idx = db.applications.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const application = db.applications[idx];
  const { type = 'interview_request' } = req.body;

  let text;
  if (type === 'interview_request') {
    text = interviewRequestSMS(application.first_name, application.position);
  } else if (type === 'custom' && req.body.message) {
    text = req.body.message;
  } else {
    return res.status(400).json({ error: 'Invalid type' });
  }

  const result = await sendSMS(application.phone, text);
  if (!db.applications[idx].sms_log) db.applications[idx].sms_log = [];
  db.applications[idx].sms_log.push({ type, sent_at: new Date().toISOString(), ok: result.ok, reason: result.reason, text });
  db.applications[idx].sms_sent = true;
  saveDB(db);
  res.json({ success: result.ok, ...result });
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
  const found = db.applications.find(a => a.id === req.params.id);
  if (!found) return res.status(404).json({ error: 'Not found' });
  res.json(found);
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
app.get(['/rainsoft', '/rainsoft-careers', '/rainsoft/careers'], (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'rainsoft-careers.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ TSC Hiring App running on port ${PORT}`));

// ─────────────────────────────────────────────
// INBOUND SMS BOT — Conversational Text Hiring
// ─────────────────────────────────────────────

// In-memory conversation state (persisted to DB)
function getConversation(phone) {
  db = loadDB();
  if (!db.conversations) db.conversations = {};
  return db.conversations[phone] || null;
}

function saveConversation(phone, state) {
  db = loadDB();
  if (!db.conversations) db.conversations = {};
  db.conversations[phone] = state;
  saveDB(db);
}

function clearConversation(phone) {
  db = loadDB();
  if (db.conversations) delete db.conversations[phone];
  saveDB(db);
}

// Bot steps
const BOT_STEPS = {
  START: 'start',
  GET_NAME: 'get_name',
  GET_POSITION: 'get_position',
  GET_AVAILABILITY: 'get_availability',
  GET_HOURS: 'get_hours',
  GET_EXPERIENCE: 'get_experience',
  GET_START: 'get_start',
  DONE: 'done',
};

function parsePosition(text) {
  const t = text.toLowerCase();
  if (t.includes('general') || t.includes('gm') || t === '1') return 'gm';
  if (t.includes('assistant') || t.includes('am') || t === '2') return 'am';
  if (t.includes('team') || t.includes('crew') || t.includes('member') || t === '3') return 'tm';
  return null;
}

// Returns reply text without sending (for TwiML use)
async function handleInboundSMSText(from, body) {
  let captured = null;
  const origSend = sendSMS;
  // Monkey-patch sendSMS temporarily
  const fakeSend = async (to, text) => { captured = text; return { ok: true }; };
  // Inline the bot logic but use fakeSend
  const text = (body || '').trim();
  let conv = getConversation(from);
  const isStart = !conv || ['hi','hello','hey','job','jobs','hiring','apply','start','yes'].includes(text.toLowerCase());

  if (!conv || isStart) {
    const newConv = { step: BOT_STEPS.GET_NAME, phone: from, data: {}, started_at: new Date().toISOString() };
    saveConversation(from, newConv);
    return "Hi! 🌴 Thanks for your interest in joining Tropical Smoothie Cafe! I'm going to ask you a few quick questions.\n\nFirst — what's your first and last name?";
  }

  const step = conv.step;
  if (step === BOT_STEPS.GET_NAME) {
    const parts = text.split(' ');
    conv.data.first_name = parts[0];
    conv.data.last_name = parts.slice(1).join(' ') || '';
    conv.step = BOT_STEPS.GET_POSITION;
    saveConversation(from, conv);
    return `Nice to meet you, ${conv.data.first_name}! 👋\n\nWhich position?\n1 General Manager\n2 Assistant Manager\n3 Team Member`;
  }
  if (step === BOT_STEPS.GET_POSITION) {
    const pos = parsePosition(text);
    if (!pos) return "Reply 1 for General Manager, 2 for Assistant Manager, or 3 for Team Member.";
    conv.data.position = pos;
    conv.step = BOT_STEPS.GET_AVAILABILITY;
    saveConversation(from, conv);
    return "Great! What days can you work?\n• Weekdays\n• Weekends\n• Both\n• Mornings only\n• Evenings only";
  }
  if (step === BOT_STEPS.GET_AVAILABILITY) {
    const t = text.toLowerCase();
    conv.data.can_work_weekends = (t.includes('weekend') || t.includes('both')) ? 'yes' : 'no';
    conv.data.can_work_mornings = (t.includes('morning') || t.includes('both') || t.includes('weekday')) ? 'yes' : 'no';
    conv.data.can_work_evenings = (t.includes('evening') || t.includes('both') || t.includes('weekday')) ? 'yes' : 'no';
    conv.step = BOT_STEPS.GET_HOURS;
    saveConversation(from, conv);
    return "Hours per week?\n1 Under 20 (part-time)\n2 20-30 hrs\n3 30-40 hrs\n4 40+ (full-time)";
  }
  if (step === BOT_STEPS.GET_HOURS) {
    const t = text.toLowerCase();
    let hours = 'under_20';
    if (t==='2'||t.includes('20-30')||t.includes('20')) hours='20-30';
    else if (t==='3'||t.includes('30-40')||t.includes('30')) hours='30-40';
    else if (t==='4'||t.includes('40')||t.includes('full')) hours='40+';
    conv.data.hours_available = hours;
    conv.step = BOT_STEPS.GET_EXPERIENCE;
    saveConversation(from, conv);
    return "Any food service experience?\n1 Yes\n2 No - first food service job";
  }
  if (step === BOT_STEPS.GET_EXPERIENCE) {
    const t = text.toLowerCase();
    conv.data.food_service_experience = (t==='1'||t.includes('yes')) ? 'yes' : 'no';
    conv.step = BOT_STEPS.GET_START;
    saveConversation(from, conv);
    return "When can you start?\n1 Immediately\n2 Within 1 week\n3 2 weeks notice\n4 About 1 month";
  }
  if (step === BOT_STEPS.GET_START) {
    const t = text.toLowerCase();
    let start = 'immediately';
    if (t==='2'||t.includes('1 week')) start='1_week';
    else if (t==='3'||t.includes('2 week')) start='2_weeks';
    else if (t==='4'||t.includes('month')) start='1_month';
    conv.data.available_start = start;
    conv.data.phone = from;
    conv.data.legally_authorized = 'yes';
    conv.data.over_18 = 'yes';
    const { score, disqualified, disqualifyReason, status } = scoreApplication(conv.data, conv.data.position);
    const posLabel = {gm:'General Manager',am:'Assistant Manager',tm:'Team Member'}[conv.data.position]||conv.data.position;
    const id = uuidv4();
    const application = { id, applied_at: new Date().toISOString(), status: disqualified?'disqualified':status, score, disqualified, disqualify_reason: disqualifyReason, hired:false, notes:'', interview_date:null, sms_sent:false, sms_log:[], source:'sms_inbound', ...conv.data };
    db = loadDB(); db.applications.push(application); saveDB(db);
    clearConversation(from);
    if (process.env.NOTIFY_EMAIL) {
      await sendEmail(process.env.NOTIFY_EMAIL, `📱 New SMS Application — ${conv.data.first_name} ${conv.data.last_name} (Score: ${score})`,
        `<h2>New SMS Application!</h2><p><b>Position:</b> ${posLabel}</p><p><b>Name:</b> ${conv.data.first_name} ${conv.data.last_name}</p><p><b>Phone:</b> ${from}</p><p><b>Score:</b> ${score}/100 — ${status.toUpperCase()}</p><hr><p><a href="${process.env.APP_URL||''}/admin">View in Dashboard</a></p>`);
    }
    if (disqualified) return `Thanks for your interest, ${conv.data.first_name}! Unfortunately we can't move forward at this time. 🌴`;
    if (status === 'hot') return `🎉 Great news, ${conv.data.first_name}! We'd love to schedule an interview. What days and times work best for you this week?`;
    return `Thanks ${conv.data.first_name}! We received your application for ${posLabel}. 🌴 We'll text you within 2-3 days if we'd like to interview!`;
  }
  return `Text JOBS to start a new application, or visit ${process.env.APP_URL||'our website'} to apply online.`;
}

async function handleInboundSMS(from, body) {
  const text = (body || '').trim();
  let conv = getConversation(from);

  // Fresh start or reset keywords
  const isStart = !conv || ['hi','hello','hey','job','jobs','hiring','apply','start','yes'].includes(text.toLowerCase());

  if (!conv || isStart) {
    const newConv = { step: BOT_STEPS.GET_NAME, phone: from, data: {}, started_at: new Date().toISOString() };
    saveConversation(from, newConv);
    return await sendSMS(from, "Hi! 🌴 Thanks for your interest in joining Tropical Smoothie Cafe! I'm going to ask you a few quick questions to get your application started.\n\nFirst — what's your first and last name?");
  }

  const step = conv.step;

  if (step === BOT_STEPS.GET_NAME) {
    const parts = text.split(' ');
    conv.data.first_name = parts[0];
    conv.data.last_name = parts.slice(1).join(' ') || '';
    conv.step = BOT_STEPS.GET_POSITION;
    saveConversation(from, conv);
    return await sendSMS(from, `Nice to meet you, ${conv.data.first_name}! 👋\n\nWhich position are you interested in?\n\n1️⃣ General Manager\n2️⃣ Assistant Manager\n3️⃣ Team Member\n\nReply with the number or name.`);
  }

  if (step === BOT_STEPS.GET_POSITION) {
    const pos = parsePosition(text);
    if (!pos) {
      return await sendSMS(from, "Sorry, I didn't catch that! Reply 1 for General Manager, 2 for Assistant Manager, or 3 for Team Member.");
    }
    conv.data.position = pos;
    conv.step = BOT_STEPS.GET_AVAILABILITY;
    saveConversation(from, conv);
    return await sendSMS(from, `Great choice! 💪\n\nWhat days are you available to work? (Reply with all that apply)\n\n• Weekdays\n• Weekends\n• Both\n• Mornings only\n• Evenings only`);
  }

  if (step === BOT_STEPS.GET_AVAILABILITY) {
    const t = text.toLowerCase();
    conv.data.can_work_weekends = (t.includes('weekend') || t.includes('both')) ? 'yes' : 'no';
    conv.data.can_work_mornings = (t.includes('morning') || t.includes('both') || t.includes('weekday')) ? 'yes' : 'no';
    conv.data.can_work_evenings = (t.includes('evening') || t.includes('both') || t.includes('weekday')) ? 'yes' : 'no';
    conv.step = BOT_STEPS.GET_HOURS;
    saveConversation(from, conv);
    return await sendSMS(from, `Got it! How many hours per week are you looking for?\n\n1️⃣ Less than 20 hrs (part-time)\n2️⃣ 20-30 hrs\n3️⃣ 30-40 hrs\n4️⃣ 40+ hrs (full-time)`);
  }

  if (step === BOT_STEPS.GET_HOURS) {
    const t = text.toLowerCase();
    let hours = 'under_20';
    if (t === '2' || t.includes('20-30') || t.includes('20')) hours = '20-30';
    else if (t === '3' || t.includes('30-40') || t.includes('30')) hours = '30-40';
    else if (t === '4' || t.includes('40') || t.includes('full')) hours = '40+';
    conv.data.hours_available = hours;
    conv.step = BOT_STEPS.GET_EXPERIENCE;
    saveConversation(from, conv);
    return await sendSMS(from, `Do you have any previous food service or restaurant experience?\n\n1️⃣ Yes\n2️⃣ No — this would be my first food service job`);
  }

  if (step === BOT_STEPS.GET_EXPERIENCE) {
    const t = text.toLowerCase();
    conv.data.food_service_experience = (t === '1' || t.includes('yes')) ? 'yes' : 'no';
    conv.step = BOT_STEPS.GET_START;
    saveConversation(from, conv);
    return await sendSMS(from, `Almost done! When could you start?\n\n1️⃣ Immediately\n2️⃣ Within 1 week\n3️⃣ 2 weeks notice\n4️⃣ About 1 month`);
  }

  if (step === BOT_STEPS.GET_START) {
    const t = text.toLowerCase();
    let start = 'immediately';
    if (t === '2' || t.includes('1 week')) start = '1_week';
    else if (t === '3' || t.includes('2 week')) start = '2_weeks';
    else if (t === '4' || t.includes('month')) start = '1_month';
    conv.data.available_start = start;
    conv.data.phone = from;
    conv.data.legally_authorized = 'yes'; // assumed for text applicants
    conv.data.over_18 = 'yes';

    // Score and save application
    const { score, disqualified, disqualifyReason, status } = scoreApplication(conv.data, conv.data.position);
    const posLabel = { gm: 'General Manager', am: 'Assistant Manager', tm: 'Team Member' }[conv.data.position] || conv.data.position;
    const id = uuidv4();

    const application = {
      id,
      applied_at: new Date().toISOString(),
      status: disqualified ? 'disqualified' : status,
      score, disqualified, disqualify_reason: disqualifyReason,
      hired: false, notes: '', interview_date: null,
      sms_sent: false, sms_log: [],
      source: 'sms_inbound',
      ...conv.data
    };

    db = loadDB();
    db.applications.push(application);
    saveDB(db);
    clearConversation(from);

    // Notify owner
    if (process.env.NOTIFY_EMAIL) {
      await sendEmail(process.env.NOTIFY_EMAIL,
        `📱 New SMS Application — ${conv.data.first_name} ${conv.data.last_name} (Score: ${score})`,
        `<h2>New SMS Application!</h2>
         <p><b>Via text to (334) 489-1215</b></p>
         <p><b>Position:</b> ${posLabel}</p>
         <p><b>Name:</b> ${conv.data.first_name} ${conv.data.last_name}</p>
         <p><b>Phone:</b> ${from}</p>
         <p><b>Score:</b> ${score}/100 — ${status.toUpperCase()}</p>
         <p><b>Hours:</b> ${conv.data.hours_available} | Weekends: ${conv.data.can_work_weekends} | Can start: ${start}</p>
         <hr><p><a href="${process.env.APP_URL||''}/admin">View in Dashboard →</a></p>`
      );
    }

    // Final response
    let finalMsg;
    if (disqualified) {
      finalMsg = `Thanks for your interest, ${conv.data.first_name}! Unfortunately we're not able to move forward at this time, but we appreciate you reaching out. 🌴`;
    } else if (status === 'hot') {
      finalMsg = `🎉 Great news, ${conv.data.first_name}! Your application looks strong. We'd love to schedule an interview!\n\nWhat days and times work best for you this week? We'll get something on the calendar ASAP!`;
    } else {
      finalMsg = `Thanks ${conv.data.first_name}! We received your application for the ${posLabel} position. 🌴\n\nWe review all applications within 2-3 business days and will text you here if we'd like to schedule an interview. Have a great day!`;
    }

    return await sendSMS(from, finalMsg);
  }

  // Fallback
  return await sendSMS(from, `Hi! Text "jobs" to start a new application for Tropical Smoothie Cafe, or visit ${process.env.APP_URL || 'our website'} to apply online.`);
}

// OpenPhone webhook — inbound messages
app.post('/webhook/openphone', async (req, res) => {
  res.sendStatus(200); // Acknowledge immediately
  try {
    const event = req.body;
    if (event.type !== 'message.received') return;
    const msg = event.data?.object;
    if (!msg || msg.direction !== 'incoming') return;
    const from = msg.from;
    const body = msg.body || '';
    console.log(`Inbound SMS from ${from}: ${body}`);
    await handleInboundSMS(from, body);
  } catch(e) {
    console.error('Webhook error:', e.message);
  }
});

// ─────────────────────────────────────────────
// TWILIO inbound SMS — replies via TwiML directly
// ─────────────────────────────────────────────
app.post('/webhook/twilio-sms', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body || '';
  console.log(`Twilio inbound SMS from ${from}: ${body}`);

  res.set('Content-Type', 'text/xml');

  try {
    const replyText = await handleInboundSMSText(from, body);
    if (replyText) {
      const escaped = replyText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      res.send(`<Response><Message>${escaped}</Message></Response>`);
    } else {
      res.send('<Response></Response>');
    }
  } catch(e) {
    console.error('Twilio SMS error:', e.message);
    res.send('<Response><Message>Hi! Text JOBS to start your application for Tropical Smoothie Cafe!</Message></Response>');
  }
});

// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// RAINSOFT CAREERS — OpenPhone inbound SMS handler
// Routes: +13344895815 (RainSoft Careers OpenPhone line)
// Auto-replies with job info + pushes every message to Telegram
// ─────────────────────────────────────────────
const RAINSOFT_CAREERS_FROM = '+13344895815';
const RAINSOFT_CAREERS_APPLY_URL = 'https://rainsoftgulfcoast.com/careers';
const RAINSOFT_CAREERS_VOICE_NUMBER = '(334) 489-5815';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8703100352:AAHEics63zNfXta-K4T7QFX9O9bQX4C7q0Q';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '6664842380';

async function notifyTelegram(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    });
  } catch(e) { console.error('Telegram notify error:', e.message); }
}

function rainsoftAutoReplyText(firstTime) {
  if (firstTime) {
    return `Hi! 👋 Thanks for texting RainSoft of the Wiregrass about our Service Admin opening!\n\nApply in 3 minutes — call or tap:\n📞 ${RAINSOFT_CAREERS_VOICE_NUMBER}\n🔗 ${RAINSOFT_CAREERS_APPLY_URL}\n\nOr reply here with your name, phone, and a little about your experience and we'll pass it straight to Rebecca!`;
  }
  return `Thanks! We've passed your message along to Rebecca — she'll get back to you personally. If you'd like to complete a full application, tap ${RAINSOFT_CAREERS_APPLY_URL} or call ${RAINSOFT_CAREERS_VOICE_NUMBER}. 🌊`;
}

app.post('/webhook/openphone-rainsoft', async (req, res) => {
  res.sendStatus(200);
  try {
    const event = req.body || {};
    if (event.type !== 'message.received') return;
    const msg = event.data?.object;
    if (!msg || msg.direction !== 'incoming') return;
    const from = msg.from;
    const to = (msg.to && msg.to[0]) || msg.to || RAINSOFT_CAREERS_FROM;
    const body = msg.body || msg.text || '';
    console.log(`[RainSoft] Inbound SMS from ${from} → ${to}: ${body}`);

    db = loadDB();
    if (!db.rainsoft_sms_conversations) db.rainsoft_sms_conversations = {};
    const seenBefore = !!db.rainsoft_sms_conversations[from];
    db.rainsoft_sms_conversations[from] = {
      last_message: body,
      last_at: new Date().toISOString(),
      messages: [...(db.rainsoft_sms_conversations[from]?.messages || []), { from, body, at: new Date().toISOString() }],
    };
    saveDB(db);

    // Notify Rebecca in Telegram
    await notifyTelegram(
      `📱 RainSoft Careers text\n` +
      `From: ${from}\n` +
      `Message: ${body}\n` +
      `${seenBefore ? '(continuing conversation)' : '(new contact)'}`
    );

    // Auto-reply
    await sendSMS(from, rainsoftAutoReplyText(!seenBefore), RAINSOFT_CAREERS_FROM);
  } catch(e) {
    console.error('RainSoft OpenPhone webhook error:', e.message);
  }
});

// ─────────────────────────────────────────────
// ElevenLabs post-call webhook
// Parses APPLICATION_DATA from transcript → saves to dashboard
// ─────────────────────────────────────────────
app.post('/webhook/elevenlabs-call', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    // Get transcript text
    const transcript = body?.data?.transcript || body?.transcript || '';
    const fullText = Array.isArray(transcript)
      ? transcript.map(t => t.content || t.message || '').join(' ')
      : String(transcript);

    // Parse APPLICATION_DATA line
    const match = fullText.match(/APPLICATION_DATA:\s*(\{.*?\})/);
    if (!match) { console.log('No APPLICATION_DATA in transcript'); return; }

    const data = JSON.parse(match[1]);
    data.legally_authorized = 'yes';
    data.over_18 = 'yes';
    data.source = 'phone_call';

    const { score, disqualified, disqualifyReason, status } = scoreApplication(data, data.position);
    const posLabel = { gm: 'General Manager', am: 'Assistant Manager', tm: 'Team Member' }[data.position] || data.position;
    const id = uuidv4();

    const application = {
      id,
      applied_at: new Date().toISOString(),
      status: disqualified ? 'disqualified' : status,
      score, disqualified, disqualify_reason: disqualifyReason,
      hired: false, notes: '', interview_date: null,
      sms_sent: false, sms_log: [],
      ...data
    };

    db = loadDB();
    db.applications.push(application);
    saveDB(db);
    console.log(`Phone application saved: ${data.first_name} ${data.last_name} — ${posLabel} — score ${score}`);

    if (process.env.NOTIFY_EMAIL) {
      await sendEmail(process.env.NOTIFY_EMAIL,
        `📞 New Phone Application — ${data.first_name} ${data.last_name} (Score: ${score})`,
        `<h2>New Phone Application!</h2>
         <p><b>Via call to (833) 349-4896</b></p>
         <p><b>Position:</b> ${posLabel}</p>
         <p><b>Name:</b> ${data.first_name} ${data.last_name}</p>
         <p><b>Phone:</b> ${data.phone}</p>
         <p><b>Score:</b> ${score}/100 — ${status.toUpperCase()}</p>
         <hr><p><a href="${process.env.APP_URL||''}/admin">View in Dashboard →</a></p>`
      );
    }
  } catch(e) {
    console.error('ElevenLabs webhook error:', e.message);
  }
});
