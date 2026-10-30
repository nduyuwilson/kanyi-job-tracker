# Application Ledger

A local job application tracker. Your data lives in a single portable SQLite
file (`jobs.db`) next to this project, and the app can send follow-up emails
and check your inbox for replies via your own Gmail account.

Everything runs on your machine — there's no external server involved besides
Gmail itself.

## 1. Install Node.js

You need [Node.js](https://nodejs.org) 18 or newer. Check with:

```
node -v
```

## 2. Install dependencies

In this folder, run:

```
npm install
```

## 3. Set up Gmail access (App Password)

Gmail no longer allows signing in with your normal account password from
apps like this one — and you shouldn't put your real password in a file
regardless. Instead, generate an **App Password**: a 16-character code that
only works for this app and can be revoked anytime without changing your
main password.

1. Turn on **2-Step Verification** on your Google account, if it isn't
   already: https://myaccount.google.com/signinoptions/two-step-verification
2. Go to https://myaccount.google.com/apppasswords
3. Create a new app password (name it something like "Job Ledger")
4. Copy the 16-character code it gives you

Then:

```
cp .env.example .env
```

Open `.env` and fill in:

```
GMAIL_USER=you@gmail.com
GMAIL_APP_PASSWORD=the16charactercode
```

**Keep `.env` private.** It's already listed in `.gitignore` so it won't be
committed if you put this project in git. Don't share this file or paste its
contents anywhere.

If you'd rather not set up email at all, you can skip this step — the ledger
(adding, editing, filtering applications) works fine without it. Only the
"Check inbox for replies" and "Send follow-up email" buttons need it.

## 4. Run it

```
npm start
```

Then open **http://localhost:3000** in your browser.

## Carrying your data to another machine

Your applications live in `jobs.db`, a single file created next to
`server.js` the first time you run the app. To move your data:

1. Copy the whole `job-tracker` folder (or just `jobs.db`) to the new machine
2. Run `npm install` there
3. Copy your `.env` over separately (don't commit it, don't email it)
4. `npm start`

## What each button does

- **+ New application** — add an entry manually
- **Paste an email** — paste any email's text and it'll guess the company,
  role, and status for you to review before saving
- **WhatsApp Chat View** — view conversations in authentic WhatsApp style
  with incoming & outgoing bubbles, timestamps, double blue checkmarks (✓✓),
  and custom wallpaper
- **Gmail Auto-check & Notifications** — runs background checks for replies
  every 90 seconds, alerts you via browser notifications, audio chimes, and
  unread chat badges
- **Email Drafting & Template Studio** — 6 rich templates with live HTML
  letterhead preview, variable tags (`{Company}`, `{Role}`, `{MyName}`), and
  Gmail sending
- **Application Dossier** — slide-out drawer to view and edit salary,
  location, URLs, recruiter contacts, and internal notes
- **Ledger / Pipeline View** — switch anytime between WhatsApp Chat Mode and
  full tabular Ledger view with pipeline metrics

## Security notes

- Your App Password is only ever read from `.env` on your own machine — it's
  never sent anywhere except directly to Gmail's servers over an encrypted
  connection.
- Revoke the app password anytime at
  https://myaccount.google.com/apppasswords if you stop using this tool.
- This app has no authentication of its own — anyone with access to
  `http://localhost:3000` on your machine (or network, if you expose it) can
  read and send from your Gmail. Don't expose this port beyond your own
  computer.


