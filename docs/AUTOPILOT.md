# JobFinder AUTOPILOT

## Install the consolidated update

1. Download the Windows ZIP and select **Extract All**.
2. Open the extracted **JobFinder** folder and run **Update-JobFinder.bat**.
3. After the update checks pass, the controller opens. Type **AUTOPILOT** once to authorize applications after automatic preparation checks.

The updater checks every file, retains the previous version, restarts JobFinder and verifies the running application version. A failed update restores the previous application. Your CVs, browser session, answers and saved jobs remain in your existing user data folder.

## What runs automatically

- Searches across configured sources and locations continue hourly.
- Relevant jobs enter the Google Sheets queue with duplicate checks.
- Preparation checks use the same persistent Chrome session as sign-in.
- Each provider must pass its own preparation check before real applications start.
- Real applications follow the newest-first Sheet order, with up to 10 per cycle and 30 confirmed applications per day.
- A blocked provider pauses for that run. Untouched jobs remain queued, and automatic checks continue.
- Questions appear in **Interventions**. Answer known factual questions there once to unblock jobs.
- **Automation Health** shows each provider's latest check, prepared forms, confirmed applications and blockers.
- After a restart, the watchdog resumes the saved schedule. Searches continue after the daily application cap is reached.

Keep the laptop awake, online and signed into Windows. Use JobFinder's Chrome window to sign in when a portal requires it. CAPTCHA, OTP and account sign-in still require your interaction.

## Check or pause

Open **JobFinder 24x7 Control**. Option **1** shows schedule and qualified providers. Option **4** pauses automation and revokes future automatic promotion. Option **6** activates AUTOPILOT again.

## Coverage

Automated submission engines cover LinkedIn Easy Apply, Naukri on-site applications, Greenhouse, Lever and Workday. Other employer portals remain queued for their own application workflow. Email replies can be monitored by the existing mailbox integration; this release does not add automatic outbound application email.

## Verification boundary

Browser fixture tests cover form detection, preparation, CV attachment, required questions, final-submit protection, provider qualification and queue ordering. They use synthetic jobs and accounts. Your actual LinkedIn session is validated by the automatic preparation check after installation. A passing build or Windows installation check alone is not evidence of an application sent.
