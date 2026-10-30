import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Single portable database file — copy jobs.db to another machine
// (alongside this project) to carry your data with you.
const db = new Database(path.join(__dirname, 'jobs.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    company TEXT,
    role TEXT,
    dateApplied TEXT,
    status TEXT,
    url TEXT,
    location TEXT,
    salary TEXT,
    contact TEXT,
    notes TEXT,
    updatedAt TEXT
  )
`);

// Ensure new columns exist on jobs
const tableInfo = db.prepare("PRAGMA table_info(jobs)").all();
const columnNames = new Set(tableInfo.map(c => c.name));

if (!columnNames.has('lastCheckedAt')) {
  db.exec("ALTER TABLE jobs ADD COLUMN lastCheckedAt TEXT");
}
if (!columnNames.has('lastMessageSnippet')) {
  db.exec("ALTER TABLE jobs ADD COLUMN lastMessageSnippet TEXT");
}
if (!columnNames.has('lastMessageTime')) {
  db.exec("ALTER TABLE jobs ADD COLUMN lastMessageTime TEXT");
}

// Create messages table for WhatsApp-style thread history
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    jobId TEXT NOT NULL,
    direction TEXT NOT NULL, -- 'outgoing', 'incoming', 'system'
    sender TEXT,
    recipient TEXT,
    subject TEXT,
    body TEXT,
    html TEXT,
    timestamp TEXT NOT NULL,
    statusHint TEXT,
    isRead INTEGER DEFAULT 1,
    externalUid TEXT,
    FOREIGN KEY(jobId) REFERENCES jobs(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_messages_jobId ON messages(jobId);
  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
  CREATE INDEX IF NOT EXISTS idx_messages_uid ON messages(externalUid);

  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    jobId TEXT NOT NULL,
    fileName TEXT NOT NULL,
    fileSize INTEGER,
    fileType TEXT,
    filePath TEXT NOT NULL,
    uploadedAt TEXT NOT NULL,
    FOREIGN KEY(jobId) REFERENCES jobs(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_attachments_jobId ON attachments(jobId);

  CREATE TABLE IF NOT EXISTS briefcase_documents (
    id TEXT PRIMARY KEY,
    fileName TEXT NOT NULL,
    fileSize INTEGER,
    fileType TEXT,
    filePath TEXT NOT NULL,
    category TEXT DEFAULT 'Resume',
    notes TEXT,
    uploadedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_briefcase_uploadedAt ON briefcase_documents(uploadedAt);
`);

// Migration helper: initialize messages from notes if empty
try {
  const existingJobs = db.prepare("SELECT * FROM jobs").all();
  const insertMsg = db.prepare(`
    INSERT INTO messages (id, jobId, direction, sender, recipient, subject, body, timestamp, isRead)
    VALUES (@id, @jobId, @direction, @sender, @recipient, @subject, @body, @timestamp, @isRead)
  `);

  for (const job of existingJobs) {
    const msgCount = db.prepare("SELECT count(*) as c FROM messages WHERE jobId = ?").get(job.id)?.c || 0;
    if (msgCount === 0) {
      const sentMatch = (job.notes || '').match(/— Sent email (.*?) —\s*\nTo:\s*(.*?)\s*\nSubject:\s*(.*)/i);
      const time = job.updatedAt || new Date().toISOString();
      if (sentMatch) {
        const to = sentMatch[2].trim();
        const subj = sentMatch[3].trim();
        insertMsg.run({
          id: 'migrated-' + job.id,
          jobId: job.id,
          direction: 'outgoing',
          sender: 'You',
          recipient: to,
          subject: subj,
          body: `Following up regarding the ${job.role || 'application'} role at ${job.company}.`,
          timestamp: time,
          isRead: 1
        });
        db.prepare("UPDATE jobs SET lastMessageSnippet = ?, lastMessageTime = ? WHERE id = ?").run(
          `You: ${subj}`,
          time,
          job.id
        );
      } else {
        insertMsg.run({
          id: 'sys-' + job.id,
          jobId: job.id,
          direction: 'system',
          sender: 'System',
          recipient: '',
          subject: 'Application Logged',
          body: `Application logged for ${job.role || 'Role'} at ${job.company}`,
          timestamp: job.dateApplied || time,
          isRead: 1
        });
        db.prepare("UPDATE jobs SET lastMessageSnippet = ?, lastMessageTime = ? WHERE id = ?").run(
          `Applied: ${job.role || 'Role'}`,
          job.dateApplied || time,
          job.id
        );
      }
    }
  }
} catch (err) {
  console.warn('Migration note:', err.message);
}

export default db;

