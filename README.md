# Google Chat Leave Tracker

A Google Chat-based employee leave management system built with **Google Apps Script** and **Google Sheets**. It streamlines leave applications, team-based approvals, leave balance tracking, and company holiday notifications through a conversational Google Chat interface.

---

## Overview

Google Chat Leave Tracker helps employees and approvers manage leave without having to work directly in spreadsheets.

Employees can submit leave requests, check balances, review their leave history, and cancel eligible requests. Approvers can review pending requests and manage team leave schedules. Administrators can manage employee roles, teams, and leave configuration.

The application uses Google Apps Script for its backend and automation, with Google Sheets as its data store.

## Features

### Leave management

- Apply for full-day or half-day leave.
- Submit leave for a single date or a date range.
- Include a reason with a leave request.
- View leave balances and leave history.
- Check available, taken, and carried-forward leave.
- Cancel eligible leave requests.
- Calculate leave against configured annual entitlements.
- Exclude weekends and configured company holidays from applicable leave calculations.

### Approval workflow

- Team-based approver roles.
- Multi-approver workflows.
- Approve or reject requests through Google Chat.
- Handle requests submitted by approvers.
- Automatically approve administrator requests.
- Restrict approval actions according to assigned roles.

### Leave balances and annual records

- Configurable annual leave entitlement.
- Carry-forward support with configurable limits and expiry.
- Separate annual leave records for each team.
- Create team/year leave sheets when required.
- View leave information for a selected year.

### Holiday management and notifications

- Centralized company holiday records.
- View company holidays through Google Chat.
- Individual holiday reminders.
- Global holiday announcements through Google Chat incoming webhooks.
- Scheduled notifications based on the configured timezone and holiday schedule.

### Email notifications

- Configurable leave approval emails.
- Configurable email subject and body.
- Support for notification recipients and CC addresses.

### Administration

- Employee records and Google Chat user mapping.
- Role assignment and team-based access.
- Administrative leave summaries.
- Annual team leave overview.
- Centralized configuration through the `Settings` sheet.

## Technology stack

| Technology | Usage |
|---|---|
| Google Apps Script | Application backend, business logic, and scheduled automation |
| Google Chat API | Chat bot integration and interactive messages |
| Google Sheets | Application data and configuration storage |
| Google Chat incoming webhooks | Global holiday announcements |
| Gmail / MailApp | Email notifications |
| JavaScript | Application implementation |

## Architecture

```text
                     Google Chat
                          |
                          v
                  Leave Tracker Bot
                          |
                          v
                  Google Apps Script
                          |
             +------------+------------+
             |            |            |
             v            v            v
          Requests      BotUsers     Settings
             |            |            |
             +------------+------------+
                          |
                     Google Sheets
                          |
                 +--------+--------+
                 |                 |
                 v                 v
          Leave workflows     Notifications
                                   |
                         +---------+---------+
                         |                   |
                         v                   v
                    Google Chat            Email
                     Webhooks
```

## Google Sheets structure

The application stores its data in Google Sheets. The following sheets are used by the application:

| Sheet | Purpose |
|---|---|
| `Requests` | Employee leave requests and approval statuses |
| `BotUsers` | Employee details, Google Chat user information, and assigned roles |
| `Holidays` | Company holiday records and related configuration |
| `Settings` | Application-wide configuration |
| `Leave_<TEAM>_<YEAR>` | Annual leave records for individual teams |

Team-specific annual sheets can be created dynamically when required.

> Keep the sheet names and column headers aligned with the application code.

## Configuration

Application settings are maintained in the `Settings` sheet rather than being scattered throughout the source code.

Examples of supported configuration keys include:

| Setting | Purpose |
|---|---|
| `HR_NOTIFICATION_EMAILS` | HR notification recipients |
| `HR_NOTIFICATION_CC` | CC recipients |
| `LEAVE_APPROVAL_EMAIL_ENABLED` | Enables or disables approval emails |
| `LEAVE_APPROVAL_EMAIL_SUBJECT` | Approval email subject template |
| `LEAVE_APPROVAL_EMAIL_BODY` | Approval email body template |
| `HOLIDAY_NOTIFICATION_WEBHOOK_URL` | Google Chat incoming webhook URL |
| `HOLIDAY_GLOBAL_NOTIFICATION` | Enables or disables global holiday announcements |
| `TEAMS` | Configures supported teams |
| `TOTAL_LEAVE_ENTITLEMENT` | Default annual leave entitlement |

Use the actual keys and values required by the deployed version of the application. Do not commit webhook URLs, credentials, or other secrets to the repository.

## Roles and permissions

Roles are assigned to employees through the `BotUsers` sheet.

Examples include:

- `ROLE_ADMIN`
- `ROLE_DEV_APPROVER`
- `ROLE_GH_APPROVER`

Team approver roles are based on the configured teams. This makes it possible to introduce additional teams by updating configuration and assigning the corresponding roles.

Administrative and approval commands are available only to users with the appropriate permissions.

## Google Chat commands

Employees interact with the application using text commands in a direct message with the bot.

| Command | Description |
|---|---|
| `hi` | Register or identify the employee and display the welcome message |
| `help` | Display available commands |
| `leave on DD/MM/YYYY` | Apply for leave |
| `leave on DD/MM/YYYY \| Reason` | Apply for leave with a reason |
| `leaves` | View leave information |
| `leave count` | View leave balance |
| `leaves 2027` | View leave information for a specified year |
| `holidays` | View company holidays |

Approver-only commands include:

| Command | Description |
|---|---|
| `leaves calendar` | View the leave calendar |
| `leaves calendar next` | View the upcoming leave calendar |
| `leaves upcoming` | View upcoming leave requests |

The available commands and actions depend on the user's assigned roles and the application's current configuration.

## Notifications

The application supports separate notification workflows:

- Leave-related Google Chat notifications.
- Email notifications for approved leave requests.
- Individual holiday reminders.
- Global holiday announcements through a configured Google Chat incoming webhook.

Scheduled tasks must be configured in Google Apps Script for the relevant automated notifications to run.

## Setup and deployment

### Prerequisites

- A Google account with access to Google Apps Script and Google Sheets.
- A Google Cloud project with the Google Chat API configured.
- A Google Chat app configured for the Apps Script deployment.
- An incoming Google Chat webhook, if global holiday announcements are required.
- The permissions and OAuth scopes required by the enabled application features.

### Deployment outline

1. Create a Google Spreadsheet to act as the application's data store.
2. Create or open the associated Google Apps Script project.
3. Add the application source files to the Apps Script project.
4. Create and configure the required sheets and column headers.
5. Populate the `Settings` sheet with the required configuration.
6. Configure the Google Cloud project and Google Chat app.
7. Configure the Apps Script deployment and authorize the required permissions.
8. Add the required time-driven triggers for scheduled tasks.
9. Add employees and assign their roles in `BotUsers`.
10. Test the bot in a direct Google Chat conversation.

> Deployment options, OAuth scopes, sheet headers, and trigger functions should be taken from the current source code. They may vary between versions.

## Security considerations

- Keep webhook URLs, credentials, and other secrets out of source control.
- Limit spreadsheet and Apps Script access to authorized maintainers.
- Assign approver and administrator roles only to authorized employees.
- Review OAuth scopes and deployment access before publishing changes.
- Avoid exposing employee leave information in public or unauthorized spaces.

## Contributing

Contributions and improvements should preserve the existing leave rules, approval permissions, and notification behavior.

Before submitting a change:

1. Test the affected workflow in a non-production spreadsheet or deployment.
2. Verify employee and approver permissions.
3. Check leave balance calculations and holiday/weekend handling.
4. Verify that scheduled notifications do not produce duplicate messages.
5. Document any new settings, commands, or deployment requirements.

## License

No license has been specified yet. Add a `LICENSE` file and update this section before distributing the project publicly.

---

*An automated approach to employee leave management.*
