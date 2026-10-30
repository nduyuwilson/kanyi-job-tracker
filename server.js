import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import db from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));

const PORT = process.env.PORT || 3000;

function reloadEnv() {
  dotenv.config();
  return {
    user: (process.env.GMAIL_USER || '').trim(),
    pass: (process.env.GMAIL_APP_PASSWORD || '').trim(),
    name: (process.env.SENDER_NAME || '').trim()
  };
}

function hasCreds() {
  const { user, pass } = reloadEnv();
  return Boolean(user && pass);
}

function requireCreds() {
  if (!hasCreds()) {
    const err = new Error('Set GMAIL_USER and GMAIL_APP_PASSWORD in your .env file first. See README.md.');
    err.status = 400;
    throw err;
  }
}

function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[m]));
}

function parseEmailStatus(text) {
  const lower = (text || '').toLowerCase();
  if (/(unfortunately|not moving forward|other candidates|decided to proceed with|will not be moving|not be extending|position has been filled)/.test(lower)) {
    return 'Rejected';
  } else if (/(pleased to offer|extend an offer|offer of employment|welcome to the team|excited to offer|formal offer)/.test(lower)) {
    return 'Offer';
  } else if (/(interview|schedule a call|next steps|speak with|chat with you|meet with|zoom meeting|phone screen|discussion)/.test(lower)) {
    return 'Interviewing';
  } else if (/(thank you for applying|application received|we.?ve received your application|application has been received|thank you for your interest)/.test(lower)) {
    return 'Applied';
  }
  return null;
}

// Strip quoted/sent email thread from replies so only the new reply text is shown
function cleanReplyText(text) {
  if (!text) return '';
  let cleaned = text;

  // Cut off at common reply quote markers
  const cutMarkers = [
    /\r?\n\s*On\s+.+?wrote:\s*$/im,
    /\r?\n\s*-----Original Message-----/i,
    /\r?\n\s*_{8,}/,
    /\r?\n\s*From:\s+.+?\nSent:\s+/i,
    /\r?\n\s*From:\s+.+?\nDate:\s+/i
  ];
  for (const marker of cutMarkers) {
    const match = cleaned.match(marker);
    if (match && match.index > 0) {
      cleaned = cleaned.slice(0, match.index);
    }
  }

  // Strip lines starting with quote mark '>'
  const lines = cleaned.split(/\r?\n/);
  const remaining = [];
  for (const line of lines) {
    if (line.trim().startsWith('>')) continue;
    remaining.push(line);
  }
  cleaned = remaining.join('\n').trim();
  return cleaned || text.trim().slice(0, 500);
}

// Simple, natural email HTML without unusual styling, borders, or footers
function generateEmailHtml({ body, senderName }) {
  const paragraphs = (body || '')
    .split(/\n\s*\n/)
    .map(p => `<p style="margin: 0 0 14px 0; font-size: 14.5px; line-height: 1.6; color: #1e293b;">${escapeHtml(p).replace(/\n/g, '<br/>')}</p>`)
    .join('');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
</head>
<body style="margin: 0; padding: 12px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14.5px; line-height: 1.6; color: #1e293b; background: #ffffff;">
  ${paragraphs}
</body>
</html>
  `.trim();
}

// Save a base64 file to uploads directory & database
function saveAttachmentFile(jobId, { fileName, fileType, fileData }) {
  if (!fileData || !fileName) return null;
  const id = randomUUID();
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const diskFileName = `${id}-${safeName}`;
  const diskPath = path.join(uploadsDir, diskFileName);

  const base64Content = fileData.includes(';base64,') ? fileData.split(';base64,')[1] : fileData;
  const buffer = Buffer.from(base64Content, 'base64');
  fs.writeFileSync(diskPath, buffer);

  const relativePath = path.join('uploads', diskFileName);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO attachments (id, jobId, fileName, fileSize, fileType, filePath, uploadedAt)
    VALUES (@id, @jobId, @fileName, @fileSize, @fileType, @filePath, @uploadedAt)
  `).run({
    id,
    jobId,
    fileName: safeName,
    fileSize: buffer.length,
    fileType: fileType || 'application/octet-stream',
    filePath: relativePath,
    uploadedAt: now
  });

  return {
    id,
    jobId,
    fileName: safeName,
    fileSize: buffer.length,
    fileType: fileType || 'application/octet-stream',
    filePath: relativePath,
    uploadedAt: now
  };
}

// Save a briefcase document (global master resume, certificate, etc.)
function saveBriefcaseFile({ fileName, fileType, fileData, category, notes }) {
  if (!fileData || !fileName) return null;
  const id = randomUUID();
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const diskFileName = `briefcase-${id}-${safeName}`;
  const diskPath = path.join(uploadsDir, diskFileName);

  const base64Content = fileData.includes(';base64,') ? fileData.split(';base64,')[1] : fileData;
  const buffer = Buffer.from(base64Content, 'base64');
  fs.writeFileSync(diskPath, buffer);

  const relativePath = path.join('uploads', diskFileName);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO briefcase_documents (id, fileName, fileSize, fileType, filePath, category, notes, uploadedAt)
    VALUES (@id, @fileName, @fileSize, @fileType, @filePath, @category, @notes, @uploadedAt)
  `).run({
    id,
    fileName: safeName,
    fileSize: buffer.length,
    fileType: fileType || 'application/octet-stream',
    filePath: relativePath,
    category: category || 'Resume',
    notes: notes || '',
    uploadedAt: now
  });

  return {
    id,
    fileName: safeName,
    fileSize: buffer.length,
    fileType: fileType || 'application/octet-stream',
    filePath: relativePath,
    category: category || 'Resume',
    notes: notes || '',
    uploadedAt: now
  };
}

// Clean up any old incoming messages that were actually sent by the user
if (process.env.GMAIL_USER) {
  try {
    db.prepare("DELETE FROM messages WHERE direction = 'incoming' AND LOWER(sender) = LOWER(?)").run(process.env.GMAIL_USER);
  } catch (e) {}
}

/* ---------------- Configuration ---------------- */

app.get('/api/config', (req, res) => {
  const env = reloadEnv();
  let defaultName = env.name;
  if (!defaultName && env.user) {
    const local = env.user.split('@')[0];
    defaultName = local.replace(/[._+-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
  res.json({
    email: env.user,
    senderName: defaultName || 'Job Applicant',
    hasCreds: Boolean(env.user && env.pass)
  });
});

/* ---------------- Jobs CRUD ---------------- */

app.get('/api/jobs', (req, res) => {
  const rows = db.prepare(`
    SELECT j.*,
      (SELECT count(*) FROM messages m WHERE m.jobId = j.id AND m.isRead = 0) as unreadCount,
      (SELECT count(*) FROM attachments a WHERE a.jobId = j.id) as attachmentsCount,
      (SELECT body FROM messages m WHERE m.jobId = j.id ORDER BY timestamp DESC LIMIT 1) as latestMsgBody,
      (SELECT subject FROM messages m WHERE m.jobId = j.id ORDER BY timestamp DESC LIMIT 1) as latestMsgSubject,
      (SELECT direction FROM messages m WHERE m.jobId = j.id ORDER BY timestamp DESC LIMIT 1) as latestMsgDirection,
      (SELECT timestamp FROM messages m WHERE m.jobId = j.id ORDER BY timestamp DESC LIMIT 1) as latestMsgTime
    FROM jobs j
    ORDER BY COALESCE(latestMsgTime, dateApplied, updatedAt) DESC
  `).all();

  const enriched = rows.map(r => {
    let snippet = r.lastMessageSnippet;
    if (!snippet && r.latestMsgSubject) {
      snippet = (r.latestMsgDirection === 'outgoing' ? 'You: ' : '') + r.latestMsgSubject;
    }
    return {
      ...r,
      lastMessageSnippet: snippet || r.notes?.slice(0, 60) || 'No messages yet',
      lastMessageTime: r.latestMsgTime || r.lastMessageTime || r.dateApplied || r.updatedAt
    };
  });

  res.json(enriched);
});

app.post('/api/jobs', (req, res) => {
  const j = req.body || {};
  const id = j.id || randomUUID();
  const now = new Date().toISOString();

  db.prepare(`INSERT INTO jobs
    (id, company, role, dateApplied, status, url, location, salary, contact, notes, updatedAt, lastMessageSnippet, lastMessageTime)
    VALUES (@id,@company,@role,@dateApplied,@status,@url,@location,@salary,@contact,@notes,@updatedAt,@lastMessageSnippet,@lastMessageTime)`
  ).run({
    id,
    company: j.company || '', role: j.role || '', dateApplied: j.dateApplied || now.slice(0, 10),
    status: j.status || 'Applied', url: j.url || '', location: j.location || '',
    salary: j.salary || '', contact: j.contact || '', notes: j.notes || '', updatedAt: now,
    lastMessageSnippet: `Applied: ${j.role || 'Role'}`,
    lastMessageTime: now
  });

  // Attach any uploaded documents
  if (Array.isArray(j.attachments)) {
    for (const att of j.attachments) {
      saveAttachmentFile(id, att);
    }
  }

  // Create initial system message in WhatsApp thread
  db.prepare(`
    INSERT INTO messages (id, jobId, direction, sender, recipient, subject, body, timestamp, isRead)
    VALUES (@id, @jobId, 'system', 'System', '', 'Application Created', @body, @timestamp, 1)
  `).run({
    id: randomUUID(),
    jobId: id,
    body: `Application created for ${j.role || 'Role'} at ${j.company || 'Company'}`,
    timestamp: now
  });

  res.json({ id });
});

app.put('/api/jobs/:id', (req, res) => {
  const j = req.body || {};
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);

  db.prepare(`UPDATE jobs SET company=@company, role=@role, dateApplied=@dateApplied, status=@status,
    url=@url, location=@location, salary=@salary, contact=@contact, notes=@notes, updatedAt=@updatedAt
    WHERE id=@id`
  ).run({
    id: req.params.id,
    company: j.company || '', role: j.role || '', dateApplied: j.dateApplied || '',
    status: j.status || 'Applied', url: j.url || '', location: j.location || '',
    salary: j.salary || '', contact: j.contact || '', notes: j.notes || '', updatedAt: now
  });

  // If status changed, log milestone in messages
  if (existing && existing.status !== j.status) {
    db.prepare(`
      INSERT INTO messages (id, jobId, direction, sender, recipient, subject, body, timestamp, statusHint, isRead)
      VALUES (@id, @jobId, 'system', 'System', '', 'Status Updated', @body, @timestamp, @statusHint, 1)
    `).run({
      id: randomUUID(),
      jobId: req.params.id,
      body: `Status changed from ${existing.status} to ${j.status}`,
      timestamp: now,
      statusHint: j.status
    });
  }

  res.json({ ok: true });
});

app.delete('/api/jobs/:id', (req, res) => {
  // Delete attachments on disk
  const atts = db.prepare('SELECT * FROM attachments WHERE jobId=?').all(req.params.id);
  for (const a of atts) {
    const full = path.join(__dirname, a.filePath);
    if (fs.existsSync(full)) {
      try { fs.unlinkSync(full); } catch {}
    }
  }
  db.prepare('DELETE FROM attachments WHERE jobId=?').run(req.params.id);
  db.prepare('DELETE FROM messages WHERE jobId=?').run(req.params.id);
  db.prepare('DELETE FROM jobs WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/jobs', (req, res) => {
  const atts = db.prepare('SELECT * FROM attachments').all();
  for (const a of atts) {
    const full = path.join(__dirname, a.filePath);
    if (fs.existsSync(full)) {
      try { fs.unlinkSync(full); } catch {}
    }
  }
  db.prepare('DELETE FROM attachments').run();
  db.prepare('DELETE FROM messages').run();
  db.prepare('DELETE FROM jobs').run();
  res.json({ ok: true });
});

/* ---------------- Attachments Endpoints ---------------- */

app.get('/api/jobs/:id/attachments', (req, res) => {
  const rows = db.prepare('SELECT * FROM attachments WHERE jobId=? ORDER BY uploadedAt ASC').all(req.params.id);
  res.json(rows);
});

app.post('/api/jobs/:id/attachments', (req, res) => {
  const { fileName, fileType, fileData } = req.body || {};
  if (!fileName || !fileData) {
    return res.status(400).json({ error: 'fileName and fileData are required.' });
  }
  const att = saveAttachmentFile(req.params.id, { fileName, fileType, fileData });
  res.json({ ok: true, attachment: att });
});

app.delete('/api/attachments/:id', (req, res) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id=?').get(req.params.id);
  if (att) {
    const full = path.join(__dirname, att.filePath);
    if (fs.existsSync(full)) {
      try { fs.unlinkSync(full); } catch {}
    }
    db.prepare('DELETE FROM attachments WHERE id=?').run(req.params.id);
  }
  res.json({ ok: true });
});

app.patch('/api/attachments/:id/rename', (req, res) => {
  const { newFileName } = req.body || {};
  if (!newFileName || !newFileName.trim()) {
    return res.status(400).json({ error: 'newFileName is required.' });
  }
  const att = db.prepare('SELECT * FROM attachments WHERE id=?').get(req.params.id);
  if (!att) return res.status(404).json({ error: 'Attachment not found.' });

  let cleanName = newFileName.trim().replace(/[^a-zA-Z0-9._ -]/g, '_').trim();
  const origExt = path.extname(att.fileName);
  if (origExt && !path.extname(cleanName)) {
    cleanName += origExt;
  }

  db.prepare('UPDATE attachments SET fileName=? WHERE id=?').run(cleanName, req.params.id);
  res.json({ ok: true, fileName: cleanName });
});

app.post('/api/jobs/:id/attach-briefcase', (req, res) => {
  const { briefcaseId, fileName } = req.body || {};
  if (!briefcaseId) {
    return res.status(400).json({ error: 'briefcaseId is required.' });
  }
  const job = db.prepare('SELECT id FROM jobs WHERE id=?').get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found.' });
  }
  const doc = db.prepare('SELECT * FROM briefcase_documents WHERE id=?').get(briefcaseId);
  if (!doc) {
    return res.status(404).json({ error: 'Briefcase document not found.' });
  }

  const fullSource = path.join(__dirname, doc.filePath);
  if (!fs.existsSync(fullSource)) {
    return res.status(404).json({ error: 'Source file does not exist on disk.' });
  }

  const id = randomUUID();
  let cleanName = (fileName && fileName.trim()) ? fileName.trim() : doc.fileName;
  cleanName = cleanName.replace(/[^a-zA-Z0-9._ -]/g, '_').trim();
  const origExt = path.extname(doc.fileName);
  if (origExt && !path.extname(cleanName)) {
    cleanName += origExt;
  }

  const diskFileName = `${id}-${cleanName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const diskPath = path.join(uploadsDir, diskFileName);
  fs.copyFileSync(fullSource, diskPath);

  const relativePath = path.join('uploads', diskFileName);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO attachments (id, jobId, fileName, fileSize, fileType, filePath, uploadedAt)
    VALUES (@id, @jobId, @fileName, @fileSize, @fileType, @filePath, @uploadedAt)
  `).run({
    id,
    jobId: req.params.id,
    fileName: cleanName,
    fileSize: doc.fileSize,
    fileType: doc.fileType,
    filePath: relativePath,
    uploadedAt: now
  });

  res.json({
    ok: true,
    attachment: {
      id,
      jobId: req.params.id,
      fileName: cleanName,
      fileSize: doc.fileSize,
      fileType: doc.fileType,
      filePath: relativePath,
      uploadedAt: now
    }
  });
});

app.get('/api/attachments/:id/download', (req, res) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id=?').get(req.params.id);
  if (!att) return res.status(404).send('Attachment not found');
  const full = path.join(__dirname, att.filePath);
  if (!fs.existsSync(full)) return res.status(404).send('File not found');
  res.download(full, att.fileName);
});

/* ---------------- Briefcase (Master Documents) Endpoints ---------------- */

app.get('/api/briefcase', (req, res) => {
  const rows = db.prepare('SELECT * FROM briefcase_documents ORDER BY uploadedAt DESC').all();
  res.json(rows);
});

app.post('/api/briefcase', (req, res) => {
  const { fileName, fileType, fileData, category, notes } = req.body || {};
  if (!fileName || !fileData) {
    return res.status(400).json({ error: 'fileName and fileData are required.' });
  }
  const doc = saveBriefcaseFile({ fileName, fileType, fileData, category, notes });
  res.json({ ok: true, document: doc });
});

app.delete('/api/briefcase/:id', (req, res) => {
  const doc = db.prepare('SELECT * FROM briefcase_documents WHERE id=?').get(req.params.id);
  if (doc) {
    const full = path.join(__dirname, doc.filePath);
    if (fs.existsSync(full)) {
      try { fs.unlinkSync(full); } catch {}
    }
    db.prepare('DELETE FROM briefcase_documents WHERE id=?').run(req.params.id);
  }
  res.json({ ok: true });
});

app.get('/api/briefcase/:id/download', (req, res) => {
  const doc = db.prepare('SELECT * FROM briefcase_documents WHERE id=?').get(req.params.id);
  if (!doc) return res.status(404).send('Document not found');
  const full = path.join(__dirname, doc.filePath);
  if (!fs.existsSync(full)) return res.status(404).send('File not found');
  res.download(full, doc.fileName);
});

app.get('/api/briefcase/:id/base64', (req, res) => {
  const doc = db.prepare('SELECT * FROM briefcase_documents WHERE id=?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  const full = path.join(__dirname, doc.filePath);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'File not found on disk' });
  const buffer = fs.readFileSync(full);
  const base64 = buffer.toString('base64');
  res.json({
    id: doc.id,
    fileName: doc.fileName,
    fileType: doc.fileType || 'application/octet-stream',
    fileSize: doc.fileSize,
    fileData: `data:${doc.fileType || 'application/octet-stream'};base64,${base64}`
  });
});

/* ---------------- Messages (WhatsApp thread) ---------------- */

app.get('/api/jobs/:id/messages', (req, res) => {
  const rows = db.prepare('SELECT * FROM messages WHERE jobId=? ORDER BY timestamp ASC').all(req.params.id);
  res.json(rows);
});

app.post('/api/jobs/:id/messages', (req, res) => {
  const { direction, sender, recipient, subject, body, html, statusHint } = req.body || {};
  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO messages (id, jobId, direction, sender, recipient, subject, body, html, timestamp, statusHint, isRead)
    VALUES (@id, @jobId, @direction, @sender, @recipient, @subject, @body, @html, @timestamp, @statusHint, 1)
  `).run({
    id,
    jobId: req.params.id,
    direction: direction || 'outgoing',
    sender: sender || 'You',
    recipient: recipient || '',
    subject: subject || 'Note',
    body: body || '',
    html: html || null,
    timestamp: now,
    statusHint: statusHint || null
  });

  db.prepare('UPDATE jobs SET lastMessageSnippet=?, lastMessageTime=?, updatedAt=? WHERE id=?').run(
    (direction === 'outgoing' ? 'You: ' : '') + (subject || body?.slice(0, 40)),
    now,
    now,
    req.params.id
  );

  res.json({ ok: true, id });
});

app.post('/api/jobs/:id/mark-read', (req, res) => {
  db.prepare('UPDATE messages SET isRead=1 WHERE jobId=?').run(req.params.id);
  res.json({ ok: true });
});

/* ---------------- Send email (Clean, natural layout with attachments) ---------------- */

app.post('/api/send-email', async (req, res) => {
  try {
    requireCreds();
    const env = reloadEnv();
    const { jobId, to, subject, body, senderName, attachmentIds, briefcaseDocIds } = req.body || {};
    if (!to || !subject || !body) {
      return res.status(400).json({ error: 'to, subject, and body are required.' });
    }

    const emailUser = env.user;
    const emailPass = env.pass;
    const finalSenderName = (senderName || env.name || '').trim();
    const fromAddress = finalSenderName
      ? `"${finalSenderName}" <${emailUser}>`
      : emailUser;

    const job = jobId ? db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId) : null;
    const finalHtml = generateEmailHtml({ body, senderName: finalSenderName });

    // Gather file attachments if selected (from job attachments and/or briefcase)
    const mailAttachments = [];
    const attachedFileNames = new Set();

    if (Array.isArray(attachmentIds) && attachmentIds.length > 0) {
      const idList = attachmentIds.map(item => (typeof item === 'object' && item && item.id) ? item.id : item);
      const customNames = {};
      attachmentIds.forEach(item => {
        if (typeof item === 'object' && item && item.id && item.fileName) {
          customNames[item.id] = item.fileName.trim();
        }
      });
      const placeholders = idList.map(() => '?').join(',');
      const attRows = db.prepare(`SELECT * FROM attachments WHERE id IN (${placeholders})`).all(...idList);
      for (const att of attRows) {
        const full = path.join(__dirname, att.filePath);
        if (fs.existsSync(full)) {
          const finalName = customNames[att.id] || att.fileName;
          mailAttachments.push({
            filename: finalName,
            path: full
          });
          attachedFileNames.add(finalName);
        }
      }
    }

    if (Array.isArray(briefcaseDocIds) && briefcaseDocIds.length > 0) {
      const idList = briefcaseDocIds.map(item => (typeof item === 'object' && item && item.id) ? item.id : item);
      const customNames = {};
      briefcaseDocIds.forEach(item => {
        if (typeof item === 'object' && item && item.id && item.fileName) {
          customNames[item.id] = item.fileName.trim();
        }
      });
      const placeholders = idList.map(() => '?').join(',');
      const bRows = db.prepare(`SELECT * FROM briefcase_documents WHERE id IN (${placeholders})`).all(...idList);
      for (const bDoc of bRows) {
        const finalName = customNames[bDoc.id] || bDoc.fileName;
        if (!attachedFileNames.has(finalName)) {
          const full = path.join(__dirname, bDoc.filePath);
          if (fs.existsSync(full)) {
            mailAttachments.push({
              filename: finalName,
              path: full
            });
            attachedFileNames.add(finalName);
          }
        }
      }
    }

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: emailUser, pass: emailPass }
    });

    await transporter.sendMail({
      from: fromAddress,
      to,
      subject,
      text: body,
      html: finalHtml,
      attachments: mailAttachments.length ? mailAttachments : undefined
    });

    const now = new Date().toISOString();

    // If linked to a job, log in messages table
    let messageId = null;
    if (jobId) {
      messageId = randomUUID();
      const attInfo = mailAttachments.map(a => a.filename).join(', ');
      const bodyWithAtt = attInfo ? `${body}\n\n📎 Attached: ${attInfo}` : body;
      const senderDisplay = finalSenderName ? `${finalSenderName} <${emailUser}>` : emailUser;

      db.prepare(`
        INSERT INTO messages (id, jobId, direction, sender, recipient, subject, body, html, timestamp, isRead)
        VALUES (@id, @jobId, 'outgoing', @sender, @recipient, @subject, @body, @html, @timestamp, 1)
      `).run({
        id: messageId,
        jobId,
        sender: senderDisplay,
        recipient: to,
        subject,
        body: bodyWithAtt,
        html: finalHtml,
        timestamp: now
      });

      const updatedNotes = (job.notes ? job.notes + '\n\n' : '') +
        `— Sent email ${new Date().toLocaleDateString()} —\nFrom: ${fromAddress}\nTo: ${to}\nSubject: ${subject}`;

      db.prepare('UPDATE jobs SET notes=?, lastMessageSnippet=?, lastMessageTime=?, updatedAt=? WHERE id=?').run(
        updatedNotes,
        `${finalSenderName || 'You'}: ${subject}`,
        now,
        now,
        jobId
      );
    }

    res.json({ ok: true, messageId });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/* ---------------- IMAP Core Reply Fetcher ---------------- */

async function fetchRepliesForJobs(targetJobs = []) {
  if (!hasCreds() || !targetJobs.length) return [];

  const env = reloadEnv();
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: env.user, pass: env.pass },
    logger: false
  });

  const newReplies = [];
  const userEmail = (env.user || '').toLowerCase().trim();

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      for (const job of targetJobs) {
        if (!job.company && !job.contact) continue;

        const cleanContact = (job.contact || '').toLowerCase().trim();
        let uids = [];

        if (cleanContact) {
          // If job has a designated recruiter/contact, search only for emails from that contact
          try {
            uids = await client.search({ from: cleanContact }, { uid: true });
          } catch {
            uids = await client.search({ text: cleanContact }, { uid: true });
          }
        } else if (job.company) {
          uids = await client.search({ text: job.company }, { uid: true });
        }

        const recent = (uids || []).slice(-10).reverse();
        const existingJobMessages = db.prepare('SELECT * FROM messages WHERE jobId=?').all(job.id);

        for (const uid of recent) {
          const msg = await client.fetchOne(uid, { envelope: true, source: true }, { uid: true });
          if (!msg) continue;

          const from = (msg.envelope?.from?.[0]?.address || 'Recruiter').trim();
          const fromLower = from.toLowerCase();

          // EXCLUDE any email sent from the user's own address!
          if (userEmail && fromLower === userEmail) {
            continue;
          }

          // If contact email is known, STRICTLY require matching contact
          if (cleanContact && fromLower !== cleanContact) {
            continue;
          }

          const externalUid = `gmail-${uid}`;
          const rawCandidate = {
            uid: externalUid,
            externalUid,
            direction: 'incoming',
            subject: msg.envelope?.subject || 'Reply',
            timestamp: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : new Date().toISOString(),
            body: ''
          };

          // Check if already processed or duplicate
          const dup = isDuplicateMessage(existingJobMessages, rawCandidate);
          if (dup) continue;

          let rawText = '';
          if (msg.source) {
            try {
              const parsed = await simpleParser(msg.source);
              rawText = (parsed.text || '').trim();
            } catch { /* ignore parse error */ }
          }

          // Strip quoted/sent email thread from the reply snippet!
          const cleanSnippet = cleanReplyText(rawText);
          rawCandidate.body = cleanSnippet;
          if (isDuplicateMessage(existingJobMessages, rawCandidate)) continue;

          const subject = msg.envelope?.subject || 'Reply';
          const msgDate = msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : new Date().toISOString();
          const statusHint = parseEmailStatus(subject + '\n' + cleanSnippet);

          const newMsgId = randomUUID();
          db.prepare(`
            INSERT INTO messages (id, jobId, direction, sender, recipient, subject, body, html, timestamp, statusHint, isRead, externalUid)
            VALUES (@id, @jobId, 'incoming', @sender, @recipient, @subject, @body, @html, @timestamp, @statusHint, 0, @externalUid)
          `).run({
            id: newMsgId,
            jobId: job.id,
            sender: from,
            recipient: env.user || '',
            subject,
            body: cleanSnippet,
            html: null,
            timestamp: msgDate,
            statusHint,
            externalUid
          });

          existingJobMessages.push({
            id: newMsgId,
            jobId: job.id,
            direction: 'incoming',
            sender: from,
            subject,
            body: cleanSnippet,
            timestamp: msgDate,
            externalUid
          });

          // Update job snippet and time
          db.prepare('UPDATE jobs SET lastCheckedAt=?, lastMessageSnippet=?, lastMessageTime=?, updatedAt=? WHERE id=?').run(
            new Date().toISOString(),
            `${job.company}: ${subject}`,
            msgDate,
            new Date().toISOString(),
            job.id
          );

          newReplies.push({
            id: newMsgId,
            jobId: job.id,
            company: job.company,
            role: job.role,
            subject,
            from,
            date: msgDate,
            snippet: cleanSnippet,
            statusHint
          });
        }
      }
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (err) {
    console.error('[IMAP Error]', err.message);
  }

  return newReplies;
}

/* ---------------- Check inbox for replies endpoint ---------------- */

app.get('/api/check-replies', async (req, res) => {
  const { company, jobId } = req.query;
  if (!company && !jobId) return res.status(400).json({ error: 'Provide a company name or jobId to search for.' });

  try {
    requireCreds();
    let job = null;
    if (jobId) {
      job = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
    } else {
      job = db.prepare('SELECT * FROM jobs WHERE company LIKE ? LIMIT 1').get(`%${company}%`);
    }

    if (!job) {
      job = { id: randomUUID(), company, role: '' };
    }

    const newReplies = await fetchRepliesForJobs([job]);
    const allJobMessages = db.prepare("SELECT * FROM messages WHERE jobId=? AND direction = 'incoming' ORDER BY timestamp DESC").all(job.id);

    res.json({
      results: allJobMessages.map(m => ({
        uid: m.externalUid?.replace('gmail-', '') || m.id,
        subject: m.subject || '',
        from: m.sender || '',
        date: m.timestamp,
        snippet: m.body || '',
        statusHint: m.statusHint
      })),
      newCount: newReplies.length
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/* ---------------- Conversation Thread Fetcher & Onboarding ---------------- */

function extractJobMetadata({ subject = '', body = '', email = '' }) {
  let company = '';
  let role = '';
  let status = parseEmailStatus(subject + '\n' + body) || 'Applied';

  const fullText = (subject + '\n' + body);

  // Try extracting role from subject or body
  const roleMatch = subject.match(/(?:for the|for|as|position:|role:)\s+([A-Za-z0-9 &\-\/]{2,50}?)(?:\s+(?:position|role|application|opening)|—|-|at|\n|$)/i) ||
                    fullText.match(/(?:for the|as a|as an)\s+([A-Za-z0-9 &\-\/]{2,50}?)\s+(?:position|role|opening|job)/i);
  if (roleMatch && roleMatch[1]) {
    role = roleMatch[1].trim();
  }

  // Try extracting company
  const companyMatch = subject.match(/(?:at|with|—|-)\s+([A-Z][A-Za-z0-9 &.\-]{1,35})$/i) ||
                       fullText.match(/(?:at|join|with|welcome to)\s+([A-Z][A-Za-z0-9 &.\-]{1,35})(?:[\.,!\n]|\s+Team|\s+Careers)/i);
  if (companyMatch && companyMatch[1]) {
    company = companyMatch[1].trim();
  }

  // If company not found, try domain from email
  if (!company && email && email.includes('@')) {
    const domain = email.split('@')[1].toLowerCase();
    const commonMail = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'proton.me', 'protonmail.com'];
    if (!commonMail.includes(domain)) {
      const namePart = domain.split('.')[0];
      company = namePart.charAt(0).toUpperCase() + namePart.slice(1);
    }
  }

  return { company, role, status };
}

function isDuplicateMessage(existingRows, m) {
  const extUid = m.uid || m.externalUid;

  // 1. Check exact externalUid
  if (extUid) {
    const match = existingRows.find(r => r.externalUid && r.externalUid === extUid);
    if (match) return match;
  }

  const normalizeSubject = (s) => (s || '').replace(/^(re|fwd|fw):\s*/gi, '').replace(/\s+/g, ' ').toLowerCase().trim();
  const mSubj = normalizeSubject(m.subject);
  const mTime = m.timestamp ? new Date(m.timestamp).getTime() : 0;
  const mBodySnippet = (m.body || '').replace(/\s+/g, ' ').toLowerCase().trim().slice(0, 50);

  for (const r of existingRows) {
    // Direction must match
    if (r.direction !== m.direction) continue;

    const rSubj = normalizeSubject(r.subject);
    const rTime = r.timestamp ? new Date(r.timestamp).getTime() : 0;
    const rBodySnippet = (r.body || '').replace(/\s+/g, ' ').toLowerCase().trim().slice(0, 50);

    // Subject match + timestamp within 20 minutes
    if (mSubj && rSubj && mSubj === rSubj) {
      if (Math.abs(mTime - rTime) <= 20 * 60 * 1000) {
        return r;
      }
      // Same subject and matching body prefix
      if (mBodySnippet && rBodySnippet && mBodySnippet.length >= 15 && (mBodySnippet.startsWith(rBodySnippet.slice(0, 20)) || rBodySnippet.startsWith(mBodySnippet.slice(0, 20)))) {
        return r;
      }
    }

    // Body snippet match (first 40+ chars) + same direction + same day
    if (mBodySnippet && rBodySnippet && mBodySnippet.length >= 25 && mBodySnippet === rBodySnippet) {
      if (Math.abs(mTime - rTime) <= 24 * 60 * 60 * 1000) {
        return r;
      }
    }
  }

  return null;
}

async function fetchConversationFromGmail({ contactEmail, company, maxResults = 35 }) {
  if (!hasCreds()) {
    throw new Error('Gmail credentials are not configured in .env');
  }

  const env = reloadEnv();
  const userEmail = (env.user || '').toLowerCase().trim();
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: env.user, pass: env.pass },
    logger: false
  });

  await client.connect();
  const lock = await client.getMailboxLock('[Gmail]/All Mail');

  const messages = [];
  const uidSet = new Set();
  const cleanEmail = (contactEmail || '').toLowerCase().trim();

  try {
    if (cleanEmail) {
      // STRICT SEARCH: ONLY search for emails sent to or from this contact email
      try {
        const uids1 = await client.search({ or: [{ from: cleanEmail }, { to: cleanEmail }] }, { uid: true });
        if (Array.isArray(uids1)) for (const u of uids1) uidSet.add(u);
      } catch (e) {
        try {
          const uidsText = await client.search({ text: cleanEmail }, { uid: true });
          if (Array.isArray(uidsText)) for (const u of uidsText) uidSet.add(u);
        } catch {}
      }
    } else {
      // ONLY search by company name if NO contact email is provided at all!
      const cleanCompany = (company || '').trim();
      if (cleanCompany && cleanCompany.length >= 2) {
        try {
          const uids2 = await client.search({ text: cleanCompany }, { uid: true });
          if (Array.isArray(uids2)) for (const u of uids2) uidSet.add(u);
        } catch {}
      }
    }

    // Sort UIDs ascending to process chronologically
    const allUids = Array.from(uidSet).sort((a, b) => a - b).slice(-maxResults);

    for (const uid of allUids) {
      try {
        const msg = await client.fetchOne(uid, { envelope: true, source: true }, { uid: true });
        if (!msg) continue;

        const fromAddr = (msg.envelope?.from?.[0]?.address || '').toLowerCase().trim();
        const toAddresses = (msg.envelope?.to || []).map(t => (t.address || '').toLowerCase().trim());
        const ccAddresses = (msg.envelope?.cc || []).map(c => (c.address || '').toLowerCase().trim());

        // STRICT RECIPIENT FILTER:
        // When cleanEmail is provided, MUST verify that cleanEmail is either the sender, recipient, or in CC!
        if (cleanEmail) {
          const isParticipant = fromAddr === cleanEmail ||
                                toAddresses.includes(cleanEmail) ||
                                ccAddresses.includes(cleanEmail);
          if (!isParticipant) {
            // Drop any email that is NOT with this recipient!
            continue;
          }
        }

        const toAddr = toAddresses[0] || '';
        const subject = msg.envelope?.subject || '(No Subject)';
        const dateIso = msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : new Date().toISOString();

        let rawText = '';
        if (msg.source) {
          try {
            const parsed = await simpleParser(msg.source);
            rawText = (parsed.text || '').trim();
          } catch {}
        }

        const cleanSnippet = cleanReplyText(rawText) || rawText.slice(0, 800);
        const statusHint = parseEmailStatus(subject + '\n' + cleanSnippet);
        const isFromUser = userEmail && fromAddr === userEmail;

        messages.push({
          uid: `gmail-${uid}`,
          direction: isFromUser ? 'outgoing' : 'incoming',
          sender: isFromUser ? (env.name ? `${env.name} <${userEmail}>` : userEmail) : (msg.envelope?.from?.[0]?.name ? `${msg.envelope.from[0].name} <${fromAddr}>` : fromAddr),
          recipient: isFromUser ? (toAddr || cleanEmail) : userEmail,
          subject,
          body: cleanSnippet,
          timestamp: dateIso,
          statusHint
        });
      } catch (e) {
        console.warn('Error fetching message UID', uid, e.message);
      }
    }
  } finally {
    lock.release();
  }

  await client.logout();

  // Sort messages chronologically
  messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  // Determine metadata
  let combinedSubject = '';
  let combinedBody = '';
  let detectedStatus = 'Applied';
  let dateApplied = new Date().toISOString().slice(0, 10);

  if (messages.length > 0) {
    dateApplied = new Date(messages[0].timestamp).toISOString().slice(0, 10);
    for (const m of messages) {
      combinedSubject += ' ' + m.subject;
      combinedBody += ' ' + m.body;
      if (m.statusHint) detectedStatus = m.statusHint;
    }
  }

  const meta = extractJobMetadata({
    subject: combinedSubject,
    body: combinedBody,
    email: contactEmail
  });

  return {
    messages,
    detectedCompany: company || meta.company,
    detectedRole: meta.role,
    detectedStatus: detectedStatus || meta.status || 'Applied',
    contact: contactEmail || (messages.find(m => m.direction === 'incoming')?.sender) || '',
    dateApplied
  };
}

app.post('/api/fetch-thread-by-email', async (req, res) => {
  const { email, company } = req.body || {};
  if (!email && !company) {
    return res.status(400).json({ error: 'Please provide a recipient email or company name to fetch.' });
  }

  try {
    requireCreds();
    const result = await fetchConversationFromGmail({ contactEmail: email, company });
    res.json({
      ok: true,
      ...result
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/onboard-job', async (req, res) => {
  const j = req.body || {};
  const id = j.id || randomUUID();
  const now = new Date().toISOString();
  const dateApplied = j.dateApplied || now.slice(0, 10);

  const messages = Array.isArray(j.messages) ? j.messages : [];
  let lastSnippet = `Applied: ${j.role || 'Role'}`;
  let lastTime = now;

  if (messages.length > 0) {
    const latest = messages[messages.length - 1];
    lastSnippet = (latest.direction === 'outgoing' ? 'You: ' : '') + (latest.subject || latest.body?.slice(0, 40));
    lastTime = latest.timestamp || now;
  }

  db.prepare(`INSERT INTO jobs
    (id, company, role, dateApplied, status, url, location, salary, contact, notes, updatedAt, lastMessageSnippet, lastMessageTime)
    VALUES (@id,@company,@role,@dateApplied,@status,@url,@location,@salary,@contact,@notes,@updatedAt,@lastMessageSnippet,@lastMessageTime)`
  ).run({
    id,
    company: j.company || '',
    role: j.role || '',
    dateApplied,
    status: j.status || 'Applied',
    url: j.url || '',
    location: j.location || '',
    salary: j.salary || '',
    contact: j.contact || '',
    notes: j.notes || '',
    updatedAt: now,
    lastMessageSnippet: lastSnippet,
    lastMessageTime: lastTime
  });

  // Insert conversation messages
  const insertStmt = db.prepare(`
    INSERT INTO messages (id, jobId, direction, sender, recipient, subject, body, html, timestamp, statusHint, isRead, externalUid)
    VALUES (@id, @jobId, @direction, @sender, @recipient, @subject, @body, @html, @timestamp, @statusHint, 1, @externalUid)
  `);

  const insertedRows = [];
  for (const m of messages) {
    const extUid = m.externalUid || m.uid || null;
    const dup = isDuplicateMessage(insertedRows, m);
    if (dup) continue;

    const msgId = randomUUID();
    insertStmt.run({
      id: msgId,
      jobId: id,
      direction: m.direction || 'outgoing',
      sender: m.sender || 'You',
      recipient: m.recipient || j.contact || '',
      subject: m.subject || 'Application Note',
      body: m.body || '',
      html: m.html || null,
      timestamp: m.timestamp || now,
      statusHint: m.statusHint || null,
      externalUid: extUid
    });

    insertedRows.push({
      id: msgId,
      jobId: id,
      direction: m.direction || 'outgoing',
      sender: m.sender || 'You',
      recipient: m.recipient || j.contact || '',
      subject: m.subject || '',
      body: m.body || '',
      timestamp: m.timestamp || now,
      externalUid: extUid
    });
  }

  // If syncGmail requested and creds present, sync any additional messages from Gmail
  let syncedFromGmail = 0;
  if (j.syncGmail && hasCreds() && j.contact) {
    try {
      const gmailResult = await fetchConversationFromGmail({ contactEmail: j.contact });
      for (const gm of gmailResult.messages) {
        const extUid = gm.uid || gm.externalUid;
        const dup = isDuplicateMessage(insertedRows, gm);
        if (dup) {
          if (!dup.externalUid && extUid) {
            db.prepare('UPDATE messages SET externalUid=? WHERE id=?').run(extUid, dup.id);
            dup.externalUid = extUid;
          }
          continue;
        }

        const newId = randomUUID();
        insertStmt.run({
          id: newId,
          jobId: id,
          direction: gm.direction,
          sender: gm.sender,
          recipient: gm.recipient,
          subject: gm.subject,
          body: gm.body,
          html: null,
          timestamp: gm.timestamp,
          statusHint: gm.statusHint,
          externalUid: extUid
        });

        insertedRows.push({
          id: newId,
          jobId: id,
          direction: gm.direction,
          sender: gm.sender,
          recipient: gm.recipient,
          subject: gm.subject,
          body: gm.body,
          timestamp: gm.timestamp,
          externalUid: extUid
        });

        syncedFromGmail++;
      }

      if (syncedFromGmail > 0) {
        const latestRow = db.prepare('SELECT * FROM messages WHERE jobId=? ORDER BY timestamp DESC LIMIT 1').get(id);
        if (latestRow) {
          db.prepare('UPDATE jobs SET lastMessageSnippet=?, lastMessageTime=? WHERE id=?').run(
            (latestRow.direction === 'outgoing' ? 'You: ' : '') + (latestRow.subject || latestRow.body?.slice(0, 40)),
            latestRow.timestamp,
            id
          );
        }
      }
    } catch (e) {
      console.warn('Gmail sync on onboard warning:', e.message);
    }
  }

  res.json({
    ok: true,
    id,
    messagesCount: insertedRows.length,
    syncedFromGmail
  });
});

app.post('/api/jobs/:id/sync-thread', async (req, res) => {
  try {
    requireCreds();
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const contactEmail = (req.body?.contact || job.contact || '').trim();
    const company = (req.body?.company || job.company || '').trim();
    if (!contactEmail && !company) {
      return res.status(400).json({ error: 'No contact email or company associated with this job.' });
    }

    // Pass contactEmail (and only company if contactEmail is absent)
    const result = await fetchConversationFromGmail({ contactEmail, company: contactEmail ? '' : company });
    const existingRows = db.prepare('SELECT * FROM messages WHERE jobId=?').all(job.id);

    const insertStmt = db.prepare(`
      INSERT INTO messages (id, jobId, direction, sender, recipient, subject, body, html, timestamp, statusHint, isRead, externalUid)
      VALUES (@id, @jobId, @direction, @sender, @recipient, @subject, @body, @html, @timestamp, @statusHint, 1, @externalUid)
    `);

    let newCount = 0;
    for (const m of result.messages) {
      const extUid = m.uid || m.externalUid;
      const dup = isDuplicateMessage(existingRows, m);
      if (dup) {
        // Link externalUid if existing record had null
        if (!dup.externalUid && extUid) {
          db.prepare('UPDATE messages SET externalUid=? WHERE id=?').run(extUid, dup.id);
          dup.externalUid = extUid;
        }
        continue;
      }

      const newId = randomUUID();
      insertStmt.run({
        id: newId,
        jobId: job.id,
        direction: m.direction,
        sender: m.sender,
        recipient: m.recipient,
        subject: m.subject,
        body: m.body,
        html: null,
        timestamp: m.timestamp,
        statusHint: m.statusHint,
        externalUid: extUid || null
      });

      existingRows.push({
        id: newId,
        jobId: job.id,
        direction: m.direction,
        sender: m.sender,
        recipient: m.recipient,
        subject: m.subject,
        body: m.body,
        timestamp: m.timestamp,
        externalUid: extUid
      });

      newCount++;
    }

    const latestRow = db.prepare('SELECT * FROM messages WHERE jobId=? ORDER BY timestamp DESC LIMIT 1').get(job.id);
    if (latestRow) {
      const newStatus = (latestRow.statusHint) ? latestRow.statusHint : job.status;
      db.prepare('UPDATE jobs SET lastMessageSnippet=?, lastMessageTime=?, status=?, updatedAt=? WHERE id=?').run(
        (latestRow.direction === 'outgoing' ? 'You: ' : '') + (latestRow.subject || latestRow.body?.slice(0, 40)),
        latestRow.timestamp,
        newStatus,
        new Date().toISOString(),
        job.id
      );
    }

    const totalMessages = db.prepare('SELECT count(*) as c FROM messages WHERE jobId=?').get(job.id)?.c || 0;

    res.json({
      ok: true,
      syncedCount: newCount,
      totalMessages,
      status: job.status
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/* ---------------- Check all replies endpoint (Fixed SQLite single-quotes) ---------------- */

app.post('/api/check-all-replies', async (req, res) => {
  try {
    requireCreds();
    const activeJobs = db.prepare("SELECT * FROM jobs WHERE status NOT IN ('Rejected','Ghosted') OR status IS NULL").all();
    const allJobs = activeJobs.length ? activeJobs : db.prepare('SELECT * FROM jobs').all();

    const newReplies = await fetchRepliesForJobs(allJobs);
    res.json({
      ok: true,
      checkedJobsCount: allJobs.length,
      newRepliesCount: newReplies.length,
      replies: newReplies
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/* ---------------- Notification Poll Endpoint ---------------- */

let autocheckEnabled = true;
let autocheckIntervalSeconds = 90;
let lastAutoCheckTime = null;
let isAutoChecking = false;

app.get('/api/notifications', (req, res) => {
  const unreadRows = db.prepare(`
    SELECT m.*, j.company, j.role
    FROM messages m
    JOIN jobs j ON j.id = m.jobId
    WHERE m.direction = 'incoming' AND m.isRead = 0
    ORDER BY m.timestamp DESC
    LIMIT 20
  `).all();

  const totalUnread = db.prepare(`
    SELECT count(*) as c FROM messages WHERE direction = 'incoming' AND isRead = 0
  `).get()?.c || 0;

  res.json({
    unreadCount: totalUnread,
    latestReplies: unreadRows,
    lastAutoCheckTime,
    autocheckEnabled,
    hasCreds: hasCreds()
  });
});

app.get('/api/autocheck-status', (req, res) => {
  res.json({
    enabled: autocheckEnabled,
    intervalSeconds: autocheckIntervalSeconds,
    lastAutoCheckTime,
    isAutoChecking,
    hasCreds: hasCreds()
  });
});

app.post('/api/autocheck-toggle', (req, res) => {
  autocheckEnabled = !autocheckEnabled;
  res.json({ enabled: autocheckEnabled });
});

/* ---------------- Background Auto-Check Worker (Fixed SQLite single-quotes) ---------------- */

async function runAutoCheckCycle() {
  if (!autocheckEnabled || isAutoChecking || !hasCreds()) return;
  isAutoChecking = true;
  try {
    const jobsToCheck = db.prepare("SELECT * FROM jobs WHERE status NOT IN ('Rejected', 'Ghosted')").all();
    if (jobsToCheck.length > 0) {
      const found = await fetchRepliesForJobs(jobsToCheck);
      lastAutoCheckTime = new Date().toISOString();
      if (found.length > 0) {
        console.log(`[Auto-Check] Received ${found.length} new replies across ${jobsToCheck.length} jobs.`);
      }
    }
  } catch (err) {
    console.warn('[Auto-Check Warning]', err.message);
  } finally {
    isAutoChecking = false;
  }
}

// Start recurring background autocheck every 90 seconds
setInterval(runAutoCheckCycle, autocheckIntervalSeconds * 1000);
// Run first check 10 seconds after server startup
setTimeout(runAutoCheckCycle, 10000);

app.listen(PORT, () => {
  console.log(`Job tracker running at http://localhost:${PORT}`);
});
