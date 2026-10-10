# Port2You MSDC paperwork (experimental)

This branch introduces a **disabled-by-default** MSDC history monitor in the Windows Electron main process.
It reads `%USERPROFILE%\\.multi_stop_dispatch_companion\\history.json` and sends each completed BOL record to a central receiver.

## Oracle setup (not deployed by this pull request)

Install Python and `pip install reportlab`, then launch `oracle/paperwork_receiver.py` under a dedicated service account.
Set `P2Y_TOKENS_JSON` to e.g. `{"lucky":"<random-long-driver-token>"}`, `P2Y_DISCORD_WEBHOOK` to a private Discord webhook URL, and `P2Y_DB_PATH` to a persistent writable SQLite file.
The receiver binds to `127.0.0.1:8788` only. Put an HTTPS-enabled reverse proxy in front of `/api/paperwork` with request-body limits and rate limiting. **Do not publicly expose port 8788.** Rotate compromised tokens.

## Driver configuration

After installation, DriverNav creates its private configuration on the first settings change at Electron `app.getPath("userData")/paperwork-config.json`.
It is disabled by default. Set `enabled` true, `endpoint` to the full HTTPS URL ending in `/api/paperwork`, `driverToken` to that driver's assigned token, and `driverName` to their display name.
Restart DriverNav. Never commit credentials. The monitor runs every 15 seconds, and retries failures on subsequent scans.

### Important safety / operational notes

- Use the new Electron IPC `get-paperwork-status`, `get-paperwork-config`, and `update-paperwork-config` to build the future settings UI. Config should be shown with the token masked, not exposed by general-purpose browser pages.
- Existing history will upload after enabling. For first testing, use a controlled Discord channel and a test account/token.
- Server deduplication uses event ID; client also remembers uploaded event IDs. Repeated jobs with a new completion timestamp get new IDs.
- No live secrets, deployment, or automatic enabling are included.
- PDF values intentionally omit ambiguous MSDC fuel unit calculations until units are validated.
- Concurrent server requests with the same event ID could both post before database insertion; use a single receiver instance initially.
