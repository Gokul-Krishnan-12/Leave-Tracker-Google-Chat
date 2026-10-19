# Leave Management Bot

A Google Chat bot built with Google Apps Script and Google Sheets to help employees submit leave requests, check leave balances, view company holidays, and route requests to the appropriate team approvers.

## GitHub repository description

**Recommended description:**

> Google Chat leave-management bot built with Google Apps Script and Google Sheets, with team-based approvals, leave balances, holiday tracking, carry-forward support, and email notifications.

**Suggested topics:** `google-apps-script`, `google-chat-bot`, `leave-management`, `google-sheets`, `workflow-automation`, `hr-tools`

## Features

- **Google Chat interface** — employees interact with the bot using chat commands.
- **Leave requests** — submit full-day, half-day, or date-range requests, subject to the validation rules configured in the script.
- **Team-based configuration** — teams are read from the `TEAMS` setting. Team leave sheets use the configured team name and the `Leave_` prefix (for example, `Leave_DEV` when `DEV` is configured).
- **Role-based approvals** — approver roles follow a team-based naming convention, such as `ROLE_DEV_APPROVER`. A user can have multiple roles in `BotUsers`.
- **Leave balances** — view available and taken leave, with carry-forward information where configured.
- **Company holidays and calendars** — view holiday and calendar information supported by the bot.
- **Email notifications** — send approval-related notifications using values configured in the `Settings` sheet.
- **Admin and approver workflows** — additional commands are available according to the roles assigned in `BotUsers`.

> Available commands and administrative operations depend on the version of the Apps Script deployed to Google Chat. Keep this README in sync with the deployed script when commands change.

## How it works

1. An employee messages the bot in Google Chat.
2. The bot reads the user's details and roles from `BotUsers`.
3. The bot validates the leave request and determines the relevant team using the configured team data.
4. The request and approval information are recorded in Google Sheets.
5. The appropriate approver(s) are notified, and email notifications may be sent according to the `Settings` configuration.

## Google Sheets configuration

The bot uses the spreadsheet identified by `CONFIG.SPREADSHEET_ID` in the Apps Script source.

### `Settings`

The `Settings` sheet stores configuration as key/value rows, with setting names in column A and values in column B.

| Setting | Purpose | Example |
|---|---|---|
| `TEAMS` | Comma-separated list of configured teams | `DEV,GH` |
| `TOTAL_LEAVE_ENTITLEMENT` | Annual leave entitlement | `22` |
| `HR_NOTIFICATION_EMAILS` | HR notification recipient(s) | `hr@example.com` |
| `HR_NOTIFICATION_CC` | CC recipient(s), comma-separated | `manager@example.com` |
| `LEAVE_APPROVAL_EMAIL_ENABLED` | Enables or disables approval email notifications | `TRUE` |
| `LEAVE_APPROVAL_EMAIL_SUBJECT` | Subject template for approval emails | `Leave Approved - {employeeName} - {leaveDate}` |
| `LEAVE_APPROVAL_EMAIL_BODY` | Body template for approval emails | Configure the desired email body in the sheet |

Email templates may use placeholders such as `{employeeName}`, `{employeeEmail}`, `{team}`, `{leaveDate}`, `{leaveType}`, `{duration}`, `{reason}`, and `{requestId}` when supported by the deployed script.

Use comma-separated recipient lists and avoid duplicate addresses unless duplicates are intentional.

### `BotUsers`

`BotUsers` stores registered Chat users and their role information. Depending on the deployed version, columns include user identity and Chat information, leave-balance fields, and a `Role` column. Confirm the exact column headers in the spreadsheet before changing its schema.

Roles are stored as comma-separated values. Examples include:

- `ROLE_ADMIN` — administrator privileges.
- `ROLE_DEV` — team membership or team role for the `DEV` team, where used by the deployed script.
- `ROLE_DEV_APPROVER` — approver role for the `DEV` team.

For another configured team, use corresponding role names such as `ROLE_GH` and `ROLE_GH_APPROVER` if `GH` is listed in `TEAMS` and the deployed script follows this convention.

Do not add a `ROLE_EMPLOYEE` role unless the deployed code specifically requires it.

### Team leave sheets

The script uses the `Leave_` prefix to derive team leave-sheet names from the teams configured in `Settings`. For example, a configured team named `DEV` corresponds to `Leave_DEV`. Check the deployed script's sheet-creation and migration behavior before renaming or deleting existing sheets.

### Other data sheets

The spreadsheet may also contain request, holiday, and user data sheets expected by the deployed Apps Script. Keep existing headers intact unless you update the corresponding code at the same time.

## Common employee commands

The command names below reflect the project's documented interaction patterns. Exact aliases and availability may vary by deployment.

| Command | Purpose |
|---|---|
| `help` | Show the bot's command guide |
| `leave on DD/MM/YYYY` | Request a full day of leave |
| `leave on DD/MM/YYYY \| Reason` | Request leave with a reason |
| `leave on DD/MM/YYYY \| HALF DAY` | Request a half day |
| `leave on DD/MM/YYYY - DD/MM/YYYY` | Request leave for a date range |
| `leaves` | View leave balance |
| `status` or `requests` | View leave requests and their status |
| `cancel [ID]` | Cancel an eligible pending request |
| `holidays` | View company holidays |
| `calendar` | View calendar information |
| `upcoming` | View upcoming schedule information |

### Approver commands

| Command | Purpose |
|---|---|
| `pending` | Review pending requests assigned to the approver |

### Administrator commands

Administrator-only commands depend on the deployed version. Restrict administrative operations, including role management and access to configuration data, to trusted users with the appropriate administrator role. Verify exact command syntax against the deployed script before relying on it.

## Setup

1. Create or open the Google Apps Script project used by the bot.
2. Add the project's `.gs` source code to the Apps Script project.
3. Configure `CONFIG.SPREADSHEET_ID` and confirm the expected sheets and headers.
4. Create or update the `Settings` sheet with the required key/value entries.
5. Populate `BotUsers` with the appropriate user details and roles.
6. Configure the required Apps Script permissions and script properties. Check the source comments and deployed version for authentication dependencies, such as `SERVICE_ACCOUNT_KEY` or an OAuth2 library.
7. Configure the Google Chat API app to deliver events to the integration endpoint required by the project.
8. Deploy the Apps Script using the access settings required by the Google Chat integration.
9. Test with a non-production request and verify that requests, team leave sheets, approvals, and notifications behave as expected.

## Security and operational notes

- Do not commit service-account credentials, OAuth secrets, access tokens, or other secrets to GitHub.
- Store sensitive configuration in Apps Script Script Properties or an approved secret-management system.
- Limit administrator-role assignment to trusted users.
- Test role changes and approval workflows with a non-production account before rolling them out.
- Back up the spreadsheet before changing sheet headers, role formats, or team configuration.
- Review spreadsheet and Apps Script access permissions regularly.

## License

Add the license that applies to this project before distributing or reusing the code.
