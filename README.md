# MailBlaster

A browser-first Gmail campaign sender. Users connect their own Gmail account, upload a CSV, personalise a message, and send one email per recipient using the Gmail API.

## Current MVP

- CSV import with `Email` and optional `Name` columns
- Duplicate removal and address validation
- `{{name}}` and `{{email}}` personalisation
- Gmail OAuth using the `gmail.send` scope
- Individual messages sent through Gmail API
- Progress and per-recipient failure counts
- CSV processing and OAuth access token stay in the browser session
- Campaign cap of 50 recipients per run and paced sending
- Permission confirmation before sending

## Setup required before Gmail sending works

1. In Google Cloud Console, create/select a project and enable **Gmail API**.
2. Configure the OAuth consent screen. Since this is intended for public users, check Google's current verification and scope requirements for `https://www.googleapis.com/auth/gmail.send`. Until verification is complete, access may be limited to test users.
3. Create an OAuth Client ID of type **Web application**.
4. Add the deployed site's exact origin under **Authorized JavaScript origins**. For GitHub Pages, this will be `https://rohitfcg123-arch.github.io`.
5. Copy the Web Client ID into `config.js` as `GOOGLE_CLIENT_ID`.
6. Push to `main` and wait for the GitHub Pages workflow to finish.

No client secret belongs in this repository or in browser code. The app uses Google Identity Services' browser token flow. Access tokens are kept in memory and are not written to localStorage.

## CSV format

```csv
Name,Email
Rahul,rahul@example.com
Priya,priya@example.com
```

## Important limits and responsible use

- Only send to recipients who have explicitly agreed to receive the messages. Do not use purchased, scraped, or unsolicited mailing lists.
- This is not an unlimited email service. Google account sending limits, API quotas, OAuth verification, anti-abuse controls, spam complaints, and deliverability all apply.
- Gmail API acceptance does not guarantee inbox delivery.
- The app does not track opens or clicks.
- The current MVP does not provide server-side campaign persistence, scheduled/background sending, unsubscribe-link generation, or a server-side suppression list. Add these before using it as a commercial email marketing service.
- A browser tab must remain open while sending.

## Hosting

GitHub Actions deploys the static site to GitHub Pages. No server or file storage is required for the current client-side MVP.
