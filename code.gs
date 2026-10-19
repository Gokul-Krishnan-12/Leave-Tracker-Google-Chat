/**
 * =========================================================
 * Pixcity Leave Tracker (High-Performance Optimized)
 * =========================================================
 *
 * Requires:
 *  - Google Apps Script
 *  - OAuth2 library
 *  - Script Property: SERVICE_ACCOUNT_KEY
 */

/**
 * =========================================================
 * CONFIGURATION
 * =========================================================
 */
const CONFIG = {
  SPREADSHEET_ID: "1oUG64p88KWdlFmHGSYvf1wOSb14uUzcgWflxU3IJ788",
  SHEET_NAME: "Requests",
  TEAM_SHEET_PREFIX: "Leave_",
  BOT_USERS_SHEET_NAME: "BotUsers",
  HR_NOTIFICATION_SETTINGS_SHEET_NAME: "Settings",
  HOLIDAY_YEAR: Number(
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy")
  ),
  HOLIDAYS_SHEET_NAME: "Holidays",
  DEFAULT_TOTAL_LEAVES: 20,
  MAX_CARRY_FORWARD: 5,
  CARRY_FORWARD_EXPIRY_MONTH: 9, // September (End of Q3)
  CARRY_FORWARD_EXPIRY_DAY: 30
};

/**
 * =========================================================
 * REQUEST SHEET COLUMNS
 * =========================================================
 */
const COL_REQUEST_ID = 1;
const COL_EMPLOYEE = 2;
const COL_EMAIL = 3;
const COL_DATE = 4;
const COL_LEAVE_TYPE = 5;
const COL_DAYS = 6;
const COL_REASON = 7;
const COL_APPROVALS = 8;
const COL_FINAL = 9;
const COL_A1 = 8;
const COL_A2 = 9;

/**
 * =========================================================
 * BOT USERS COLUMNS
 * =========================================================
 */
const BOT_COL_EMAIL = 1;
const BOT_COL_NAME = 2;
const BOT_COL_USER_ID = 3;
const BOT_COL_SPACE = 4;
const BOT_COL_APPROVER = 5;
const BOT_COL_CARRY_FORWARD = 6;
const BOT_COL_INITIAL_TAKEN = 7;
const BOT_COL_ANNUAL_QUOTA = 8;
const BOT_COL_ROLE = 9; // Role
const ROLE_ADMIN = "ROLE_ADMIN";
const ROLE_MANAGER = "ROLE_MANAGER";

/**
 * =========================================================
 * DYNAMIC TEAM / ROLE HELPERS
 * Settings!A:B supports: TEAMS | DEV,GH,SEO
 * Team request sheets are created automatically as Leave_DEV, Leave_GH, etc.
 * BotUsers.Role stores comma-separated roles, e.g. ROLE_DEV,ROLE_DEV_APPROVER.
 * =========================================================
 */
function normalizeTeam_(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function getConfiguredTeams_() {
  const settings = getSettingsValues_();
  const candidates = [];
  const raw = settings.TEAMS || settings.TEAM_LIST || "DEV,GH";
  String(raw).split(/[;,\n\r]+/).forEach(function (team) { candidates.push(team); });

  // Also allow one setting per team, e.g. TEAM_SEO = TRUE, so adding a team
  // does not require changing code or maintaining one long comma-separated value.
  Object.keys(settings).forEach(function (key) {
    if (!/^TEAM_[A-Z0-9_]+$/.test(key)) return;
    const value = String(settings[key] == null ? "" : settings[key]).trim();
    if (!value || /^(FALSE|NO|0|DISABLED)$/i.test(value)) return;
    candidates.push(key.substring(5));
  });

  const seen = new Set();
  return candidates.map(normalizeTeam_).filter(function (team) {
    if (!team || seen.has(team)) return false;
    seen.add(team);
    return true;
  });
}

function teamRole_(team) { return "ROLE_" + normalizeTeam_(team); }
function teamApproverRole_(team) { return teamRole_(team) + "_APPROVER"; }
function parseRoles_(rawRole) {
  return String(rawRole || "").split(/[;,\n\r]+/).map(function (role) {
    return role.trim().toUpperCase().replace(/\s+/g, "_");
  }).filter(Boolean);
}
function getUserRoles_(identifier) {
  const user = getEmployeeBotUserData_(identifier);
  return user ? parseRoles_(user.rawRole) : [];
}
function getUserTeamsFromRoles_(roles) {
  const configured = getConfiguredTeams_();
  return configured.filter(function (team) { return roles.indexOf(teamRole_(team)) !== -1; });
}
function getUserTeam_(identifier) {
  const roles = getUserRoles_(identifier);
  const teams = getUserTeamsFromRoles_(roles);
  return teams.length ? teams[0] : "";
}
function getTeamSheetName_(team) {
  const normalized = normalizeTeam_(team);
  if (!normalized || getConfiguredTeams_().indexOf(normalized) === -1) {
    throw new Error("Unknown team: " + team);
  }
  return CONFIG.TEAM_SHEET_PREFIX + normalized;
}
function getTeamRequestData_(team) {
  const sheetName = getTeamSheetName_(team);
  ensureSheet_(sheetName, ["Request ID", "Employee", "Email", "Date / Range", "Leave Type", "No of Days", "Reason / Comment", "Approvals", "Final Status"]);
  return getSheetData_(sheetName);
}
function getRequestDataForUser_(identifier) {
  const team = getUserTeam_(identifier);
  if (!team) return [];
  return getTeamRequestData_(team);
}
function getAllTeamRequestSheets_() {
  return getConfiguredTeams_().map(function (team) { return { team: team, sheetName: getTeamSheetName_(team) }; });
}
function getTeamPickerCard_(userName, userEmail, userId, title) {
  const teams = getConfiguredTeams_();
  const widgets = [{ textParagraph: { text: "Choose your team to finish setting up Pixcity Leave Tracker. Your leave requests and approvals will be stored separately for that team." } }];
  if (!teams.length) {
    widgets.push({ textParagraph: { text: "No teams are configured. Add a <code>TEAMS</code> setting in the <code>Settings</code> sheet, for example <code>DEV,GH,SEO</code>." } });
  } else {
    widgets.push({ buttonList: { buttons: teams.map(function (team) {
      return actionButton_(team, "chooseTeam", [{ key: "team", value: team }]);
    }) } });
  }
  return { cardsV2: [{ cardId: "chooseTeam", card: { header: { title: title || "👥 Choose Your Team", subtitle: "Welcome " + (userName || "to Pixcity Leave Tracker") }, sections: [{ widgets: widgets }] } }] };
}
function userNeedsTeamSelection_(identifier) {
  const user = getEmployeeBotUserData_(identifier);
  if (!user) return true;
  const roles = parseRoles_(user.rawRole);
  if (roles.indexOf(ROLE_ADMIN) !== -1 || roles.indexOf(ROLE_MANAGER) !== -1) return false;
  if (roles.some(function (role) { return /_APPROVER$/.test(role); })) return false;
  return getUserTeamsFromRoles_(roles).length === 0;
}
function setUserTeam_(email, team) {
  const normalizedEmail = normalizeEmail_(email);
  const normalizedTeam = normalizeTeam_(team);
  if (!normalizedEmail) throw new Error("Cannot set team: user email is unavailable.");
  if (getConfiguredTeams_().indexOf(normalizedTeam) === -1) throw new Error("This team is not configured: " + normalizedTeam);
  const data = getSheetData_(CONFIG.BOT_USERS_SHEET_NAME);
  if (!data || data.length < 2) throw new Error("User is not registered in BotUsers.");
  const cols = getBotUserColumns_(data[0]);
  for (let i = 1; i < data.length; i++) {
    if (normalizeEmail_(data[i][cols.email - 1]) !== normalizedEmail) continue;
    const row = i + 1;
    const roles = parseRoles_(cols.role > 0 ? data[i][cols.role - 1] : "");
    const oldTeams = getUserTeamsFromRoles_(roles);
    if (oldTeams.length && oldTeams.indexOf(normalizedTeam) === -1) {
      throw new Error("You already belong to " + oldTeams.join(", ") + ". Ask an administrator to change your team.");
    }
  
    if (roles.indexOf(teamRole_(normalizedTeam)) === -1) roles.push(teamRole_(normalizedTeam));
    if (cols.role <= 0) throw new Error("BotUsers sheet needs a Role column.");
    setSheetCell_(CONFIG.BOT_USERS_SHEET_NAME, row, cols.role, Array.from(new Set(roles)).join(","));
    clearSheetCache_(CONFIG.BOT_USERS_SHEET_NAME);
    return normalizedTeam;
  }
  throw new Error("User is not registered in BotUsers.");
}
function isTeamApprover_(emailOrUserId, fallbackUserId, team) {
  if (isAdmin_(emailOrUserId, fallbackUserId)) return true;
  const roles = getUserRoles_(emailOrUserId || fallbackUserId);
  return roles.indexOf(teamApproverRole_(team)) !== -1;
}

/**
 * =========================================================
 * IN-MEMORY REQUEST-SCOPED CACHES (90% LATENCY REDUCTION)
 * =========================================================
 */
let _sheetDataCache = {};
let _existingSheets = new Set();
let _cachedSettings = null;
let _cachedHolidays = null;
let _currentSessionUser = { email: "", id: "", name: "" };

function setSessionUser_(email, userId, name) {
  _currentSessionUser = {
    email: normalizeEmail_(email),
    id: String(userId || "").trim(),
    name: String(name || "").trim()
  };
}

function clearSheetCache_(sheetName) {
  if (sheetName) {
    delete _sheetDataCache[sheetName];
  } else {
    _sheetDataCache = {};
  }
}

/**
 * =========================================================
 * GOOGLE CHAT RESPONSE HELPERS
 * =========================================================
 */
function reply_(message) {
  return {
    hostAppDataAction: {
      chatDataAction: {
        createMessageAction: {
          message: message
        }
      }
    }
  };
}

function update_(message) {
  return {
    hostAppDataAction: {
      chatDataAction: {
        updateMessageAction: {
          message: message
        }
      }
    }
  };
}

function chip_(label, action, parameters, interaction) {
  const params = [{ key: "action", value: action }];
  if (Array.isArray(parameters)) {
    parameters.forEach(function (p) {
      params.push(p);
    });
  }
  const actionObj = {
    function: "onCardClick",
    parameters: params
  };
  if (interaction) {
    actionObj.interaction = interaction;
  }
  return {
    label: label,
    text: label,
    onClick: {
      action: actionObj
    }
  };
}

function actionButton_(label, action, parameters, interaction) {
  const params = [{ key: "action", value: action }];
  if (Array.isArray(parameters)) {
    parameters.forEach(function (p) {
      params.push(p);
    });
  }
  const actionObj = {
    function: "onCardClick",
    parameters: params
  };
  if (interaction) {
    actionObj.interaction = interaction;
  }
  return {
    text: label,
    onClick: {
      action: actionObj
    }
  };
}

function getQuickActionChipsWidget_(userEmail, userId) {
  const email = normalizeEmail_(userEmail || (_currentSessionUser && _currentSessionUser.email));
  const id = String(userId || (_currentSessionUser && _currentSessionUser.id) || "").trim();

  const chips = [
    chip_("📝 Apply Leave", "applyLeave"),
    chip_("🌴 My Leaves", "myLeaves"),
    chip_("📋 My Requests", "myRequests"),
    chip_("🎉 Holidays", "holidays"),
    chip_("🗓️ Team Calendar", "openCalendar", [{ key: "monthOffset", value: "0" }])
  ];

  if ((email || id) && isApprover_(email, id)) {
    chips.push(chip_("⏳ Pending Approvals", "pendingApprovals"));
  }

  if ((email || id) && isAdmin_(email, id)) {
    chips.push(chip_("📊 Team Summary", "openTeamSummary", [{ key: "targetYear", value: String(new Date().getFullYear()) }]));
  }

  chips.push(chip_("❓ Help", "help"));

  return {
    chipList: {
      layout: "WRAPPED",
      chips: chips
    }
  };
}

function infoCard_(title, text, options) {
  const opts = options || {};
  const showChips = opts.hideChips !== true;

  const widgets = [
    {
      textParagraph: {
        text: text
      }
    }
  ];

  if (showChips) {
    widgets.push(getQuickActionChipsWidget_(opts.userEmail, opts.userId));
  }

  return {
    cardsV2: [
      {
        cardId: "info",
        card: {
          header: {
            title: title
          },
          sections: [
            {
              widgets: widgets
            }
          ]
        }
      }
    ]
  };
}

/**
 * =========================================================
 * BOT ADDED / REMOVED / APP HOME
 * =========================================================
 */
function onAddedToSpace(event) {
  try {
    registerBotUserFromEvent_(event);
  } catch (regErr) {
    console.error("registerBotUser error in onAddedToSpace: " + regErr);
  }

  const chat = (event && event.chat) || {};
  const messagePayload = chat.messagePayload || {};
  const user = chat.user || messagePayload.user || (event && event.user) || {};
  let displayName = user.displayName || "Employee";
  let userEmail = user.email ? user.email.toLowerCase().trim() : "";
  const userId = user.name || "";

  if (!userEmail && userId) {
    const existing = getEmployeeBotUserData_(userId);
    if (existing && existing.email) {
      userEmail = existing.email;
      if (existing.name && (!displayName || displayName === "Employee")) displayName = existing.name;
    }
  }

  setSessionUser_(userEmail, userId, displayName);
  if (userEmail && userNeedsTeamSelection_(userEmail)) {
    return reply_(getTeamPickerCard_(displayName, userEmail, userId));
  }
  return reply_(getWelcomeCard(displayName, userEmail, userId));
}

function onAddToSpace(event) {
  return onAddedToSpace(event);
}

function onRemoveFromSpace(event) {
  const spaceName = (event && event.space && event.space.name) ||
    (event && event.chat && event.chat.space && event.chat.space.name) ||
    "unknown";
  console.info("Bot removed from space: " + spaceName);
}

function onRemovedFromSpace(event) {
  return onRemoveFromSpace(event);
}

function onAppHome(event) {
  const chat = (event && event.chat) || {};
  const messagePayload = chat.messagePayload || {};
  const user = chat.user || messagePayload.user || (event && event.user) || {};
  let displayName = user.displayName || "Employee";
  let userEmail = user.email ? user.email.toLowerCase().trim() : "";
  const userId = user.name || "";

  if (!userEmail && userId) {
    const existing = getEmployeeBotUserData_(userId);
    if (existing && existing.email) {
      userEmail = existing.email;
      if (existing.name && (!displayName || displayName === "Employee")) displayName = existing.name;
    }
  }

  setSessionUser_(userEmail, userId, displayName);
  registerBotUserFromEvent_(event);
  if (userEmail && userNeedsTeamSelection_(userEmail)) {
    const picker = getTeamPickerCard_(displayName, userEmail, userId);
    const pickerCard = picker.cardsV2 && picker.cardsV2[0] ? picker.cardsV2[0].card : picker;
    return { action: { navigations: [{ pushCard: pickerCard }] } };
  }
  const welcome = getWelcomeCard(displayName, userEmail, userId);
  const cardObj = (welcome && welcome.cardsV2 && welcome.cardsV2[0] && welcome.cardsV2[0].card)
    ? welcome.cardsV2[0].card
    : welcome;
  return {
    action: {
      navigations: [{ pushCard: cardObj }]
    }
  };
}


/**
 * =========================================================
 * ADMIN SHEET LINKS, PROJECT DOCUMENTATION & ROLE MANAGEMENT
 * =========================================================
 */
function getSpreadsheetSheetUrl_(sheetName) {
  const base = "https://docs.google.com/spreadsheets/d/" + CONFIG.SPREADSHEET_ID + "/edit";
  try {
    const metadata = sheetsApiRequest_("get", "?fields=sheets(properties(sheetId,title))");
    const sheets = metadata.sheets || [];
    const found = sheets.find(function (item) {
      return item.properties && item.properties.title === sheetName;
    });
    return base + (found ? "#gid=" + found.properties.sheetId : "");
  } catch (err) {
    console.warn("Could not resolve sheet tab ID for " + sheetName + ": " + err);
    return base;
  }
}

function getAdminResourceCard_(kind, email, userId) {
  if (!isAdmin_(email, userId)) return getAdminAccessDeniedCard_(_currentSessionUser.name, email, userId);
  const settings = getSettingsValues_();
  const links = [];
  const add = function (label, sheetName) {
    links.push("<a href=\"" + getSpreadsheetSheetUrl_(sheetName) + "\">" + escapeCardHtml_(label) + "</a>");
  };
  const normalized = String(kind || "").toLowerCase();
  if (normalized === "users" || normalized === "all") add("BotUsers sheet", CONFIG.BOT_USERS_SHEET_NAME);
  if (normalized === "settings" || normalized === "all") add("Settings sheet", CONFIG.HR_NOTIFICATION_SETTINGS_SHEET_NAME);
  if (normalized === "teams" || normalized === "all") {
    getConfiguredTeams_().forEach(function (team) {
      add("Leave_" + team + " sheet", getTeamSheetName_(team));
    });
  }
  if (normalized === "document" || normalized === "all") {
    const docUrl = String(settings.PROJECT_DOCUMENT_URL || settings.PROJECT_DOC_URL || settings.DOCUMENTATION_URL || "").trim();
    if (docUrl && /^https:\/\/\S+/i.test(docUrl)) {
      links.push("<a href=\"" + docUrl.replace(/&/g, "&amp;").replace(/\"/g, "&quot;") + "\">Project documentation</a>");
    } else {
      links.push("<b>Project documentation:</b> Add its URL in Settings as <code>PROJECT_DOCUMENT_URL</code>.");
    }
  }
  return infoCard_("🔐 Admin Resources", links.length ? links.join("<br>") : "No matching resources were found.", {
    userEmail: email, userId: userId
  });
}

function getAdminRoleHelpText_() {
  return "<br><br><b>🔐 Admin tools (ROLE_ADMIN)</b><br>" +
    "<code>bot users sheet</code> — Open BotUsers sheet URL<br>" +
    "<code>settings sheet</code> — Open Settings sheet URL<br>" +
    "<code>team sheets</code> — List all configured team leave sheet URLs<br>" +
    "<code>project doc</code> — Open project documentation URL<br>" +
    "<code>admin links</code> — Show all sheet and documentation links<br>" +
    "<code>role add email@company.com ROLE_DEV</code> — Add a role<br>" +
    "<code>role set email@company.com ROLE_DEV,ROLE_DEV_APPROVER</code> — Replace roles<br>" +
    "<code>role remove email@company.com ROLE_DEV_APPROVER</code> — Remove a role<br>" +
    "<code>roles email@company.com</code> — View an employee's roles";
}

function getAllowedAdminRoles_() {
  const roles = [ROLE_ADMIN, ROLE_MANAGER];
  getConfiguredTeams_().forEach(function (team) {
    roles.push(teamRole_(team), teamApproverRole_(team));
  });
  return roles;
}

function manageEmployeeRoles_(command, actorEmail, actorId) {
  if (!isAdmin_(actorEmail, actorId)) {
    return getAdminAccessDeniedCard_(_currentSessionUser.name, actorEmail, actorId);
  }
  const match = String(command || "").trim().match(/^role\s+(add|set|remove)\s+([^\s]+)\s+(.+)$/i);
  if (!match) {
    return infoCard_("Role Management Usage",
      "<code>role add employee@company.com ROLE_DEV</code><br>" +
      "<code>role set employee@company.com ROLE_DEV,ROLE_DEV_APPROVER</code><br>" +
      "<code>role remove employee@company.com ROLE_DEV_APPROVER</code>",
      { userEmail: actorEmail, userId: actorId });
  }
  const operation = match[1].toLowerCase();
  const targetEmail = normalizeEmail_(match[2]);
  const requestedRoles = parseRoles_(match[3]);
  if (!targetEmail || targetEmail.indexOf("@") < 1) {
    return infoCard_("Invalid Email", "Provide the employee's email address.", { userEmail: actorEmail, userId: actorId });
  }
  const allowed = getAllowedAdminRoles_();
  const invalid = requestedRoles.filter(function (role) { return allowed.indexOf(role) === -1; });
  if (!requestedRoles.length || invalid.length) {
    return infoCard_("Invalid Role",
      "Allowed roles are: <code>" + allowed.join("</code>, <code>") + "</code>.<br>" +
      (invalid.length ? "Unknown/unconfigured role(s): <b>" + escapeCardHtml_(invalid.join(", ")) + "</b>." : ""),
      { userEmail: actorEmail, userId: actorId });
  }

  const data = getSheetData_(CONFIG.BOT_USERS_SHEET_NAME);
  if (!data || data.length < 2) {
    return infoCard_("Employee Not Found", "No employees are registered in BotUsers yet.", { userEmail: actorEmail, userId: actorId });
  }
  const cols = getBotUserColumns_(data[0]);
  if (!cols.role || cols.role < 1) {
    return infoCard_("Role Column Missing", "Add a <code>Role</code> column to BotUsers first.", { userEmail: actorEmail, userId: actorId });
  }
  for (let i = 1; i < data.length; i++) {
    if (normalizeEmail_(data[i][cols.email - 1]) !== targetEmail) continue;
    const rowNumber = i + 1;
    const currentRoles = parseRoles_(data[i][cols.role - 1]);
    let nextRoles;
    if (operation === "set") {
      nextRoles = Array.from(new Set(requestedRoles));
    } else if (operation === "add") {
      nextRoles = Array.from(new Set(currentRoles.concat(requestedRoles)));
    } else {
      nextRoles = currentRoles.filter(function (role) { return requestedRoles.indexOf(role) === -1; });
    }
    setSheetCell_(CONFIG.BOT_USERS_SHEET_NAME, rowNumber, cols.role, nextRoles.join(","));
    clearSheetCache_(CONFIG.BOT_USERS_SHEET_NAME);
    _cachedSettings = null;
    return infoCard_("Employee Roles Updated",
      "<b>Employee:</b> " + escapeCardHtml_(targetEmail) + "<br>" +
      "<b>Previous:</b> " + escapeCardHtml_(currentRoles.join(", ") || "(none)") + "<br>" +
      "<b>Current:</b> " + escapeCardHtml_(nextRoles.join(", ") || "(none)"),
      { userEmail: actorEmail, userId: actorId });
  }
  return infoCard_("Employee Not Found", "No BotUsers entry matches <b>" + escapeCardHtml_(targetEmail) + "</b>. The employee must first register with the bot.", {
    userEmail: actorEmail, userId: actorId
  });
}

function getEmployeeRolesCard_(command, actorEmail, actorId) {
  if (!isAdmin_(actorEmail, actorId)) return getAdminAccessDeniedCard_(_currentSessionUser.name, actorEmail, actorId);
  const match = String(command || "").trim().match(/^roles\s+([^\s]+)$/i);
  if (!match) return infoCard_("Role Lookup", "Usage: <code>roles employee@company.com</code>", { userEmail: actorEmail, userId: actorId });
  const target = normalizeEmail_(match[1]);
  const user = getEmployeeBotUserData_(target);
  if (!user) return infoCard_("Employee Not Found", "No BotUsers entry matches <b>" + escapeCardHtml_(target) + "</b>.", { userEmail: actorEmail, userId: actorId });
  return infoCard_("Employee Roles", "<b>" + escapeCardHtml_(user.name || target) + "</b><br>" + escapeCardHtml_(user.rawRole || "(no roles assigned)"), { userEmail: actorEmail, userId: actorId });
}

/**
 * =========================================================
 * MAIN MESSAGE HANDLER (FAST & OPTIMIZED)
 * =========================================================
 */
function onMessage(event) {
  // Keep these outside try so the catch handler can safely use them.
  let senderName = "Employee";
  let senderEmail = "";
  let senderUserId = "";

  try {
    const chat = (event && event.chat) || {};
    const messagePayload = chat.messagePayload || {};
    const user = chat.user || messagePayload.user || (event && event.user) || {};
    senderName = user.displayName || "Employee";
    senderEmail = user.email ? user.email.toLowerCase().trim() : "";
    senderUserId = user.name || "";

    // If Google Chat omitted email, resolve it from BotUsers sheet via senderUserId
    if (!senderEmail && senderUserId) {
      const existingUser = getEmployeeBotUserData_(senderUserId);
      if (existingUser && existingUser.email) {
        senderEmail = existingUser.email;
        if (existingUser.name && (!senderName || senderName === "Employee")) {
          senderName = existingUser.name;
        }
      }
    }

    setSessionUser_(senderEmail, senderUserId, senderName);
    registerBotUserFromEvent_(event);

    if (senderEmail && userNeedsTeamSelection_(senderEmail)) {
      return reply_(getTeamPickerCard_(senderName, senderEmail, senderUserId));
    }

    let messageText =
      (event && event.chat && event.chat.messagePayload && event.chat.messagePayload.message &&
        (event.chat.messagePayload.message.argumentText || event.chat.messagePayload.message.text)) ||
      (event && event.message && (event.message.argumentText || event.message.text)) ||
      "";

    messageText = messageText.replace(/^<users\/[^>]+>\s*/i, "");
    messageText = messageText.replace(/^@[\w\s.-]+?\s+(?=(?:leaves?|calendar|leave|holidays?|hi|hello|hey|help|welcome|configure|setup|summary|status|requests?|pending|approvals?|cancel))/i, "");

    const normalizedText = messageText.trim().replace(/\s+/g, " ");

    // Admin-only sheet/document links and employee role administration.
    if (/^(?:bot\s+users(?:\s+sheet)?|users\s+sheet)$/i.test(normalizedText)) {
      return reply_(getAdminResourceCard_("users", senderEmail, senderUserId));
    }
    if (/^(?:settings(?:\s+sheet)?|settings\s+url)$/i.test(normalizedText)) {
      return reply_(getAdminResourceCard_("settings", senderEmail, senderUserId));
    }
    if (/^(?:team\s+sheets?|leave\s+sheets?|teams\s+leave\s+sheets?)$/i.test(normalizedText)) {
      return reply_(getAdminResourceCard_("teams", senderEmail, senderUserId));
    }
    if (/^(?:project\s+doc(?:umentation)?|documentation|project\s+document)$/i.test(normalizedText)) {
      return reply_(getAdminResourceCard_("document", senderEmail, senderUserId));
    }
    if (/^(?:admin\s+links|all\s+sheet\s+links)$/i.test(normalizedText)) {
      return reply_(getAdminResourceCard_("all", senderEmail, senderUserId));
    }
    if (/^role\s+(?:add|set|remove)\b/i.test(normalizedText)) {
      return reply_(manageEmployeeRoles_(normalizedText, senderEmail, senderUserId));
    }
    if (/^roles\b/i.test(normalizedText)) {
      return reply_(getEmployeeRolesCard_(normalizedText, senderEmail, senderUserId));
    }

    if (!normalizedText || /^(hi|hello|hey|welcome|\/welcome|start|\/start|configure|\/configure|setup|\/setup)$/i.test(normalizedText)) {
      return reply_(getWelcomeCard(senderName, senderEmail, senderUserId));
    }
    if (/^(help|\/help|info)$/i.test(normalizedText)) {
      return reply_(getHelpCard(senderName, false, senderEmail, senderUserId));
    }
    if (/^(holidays|\/holidays)$/i.test(normalizedText)) {
      return reply_(getUpcomingHolidaysCard(senderEmail, senderUserId));
    }

    // -------------------------------------------------------------
    // FEATURE 1: VIEW APPLIED LEAVE REQUESTS & STATUS
    // -------------------------------------------------------------
    if (/^(?:\/)?(?:status|my\s+status|my\s+requests?|requests?|applied\s+leaves?)$/i.test(normalizedText)) {
      return reply_(getMyLeaveRequestsCard_(senderEmail, senderName, senderUserId));
    }

    // -------------------------------------------------------------
    // FEATURE 2: CANCEL APPLIED LEAVE REQUEST
    // -------------------------------------------------------------
    const cancelMatch = normalizedText.match(/^(?:\/)?cancel(?:\s+(?:request|leave))?(?:\s+(LR-[\w-]+))?$/i);
    if (cancelMatch) {
      const targetRequestId = cancelMatch[1] ? cancelMatch[1].trim() : "";
      if (targetRequestId) {
        return reply_(handleCancelLeaveRequest_(targetRequestId, senderEmail, senderName, senderUserId));
      } else {
        return reply_(getMyLeaveRequestsCard_(senderEmail, senderName, senderUserId));
      }
    }

    // -------------------------------------------------------------
    // FEATURE 3: APPROVER PENDING REQUESTS DASHBOARD
    // -------------------------------------------------------------
    if (/^(?:\/)?(?:pending|approvals?|pending\s+approvals?|to\s+approve)$/i.test(normalizedText)) {
      if (!isApprover_(senderEmail, senderUserId)) {
        return reply_(infoCard_(
          "Not Authorized",
          "You are not configured as an approver in the leave tracker system.",
          { userEmail: senderEmail, userId: senderUserId }
        ));
      }
      return reply_(getPendingApprovalsCard_(senderEmail, senderName, senderUserId));
    }

    const calendarMatch = normalizedText.match(
      /^(?:\/)?(?:leaves?\s+|team\s+|holiday\s+|holidays\s+)?calendar(?:\s+(next|prev|previous|[+-]?\d+))?$/i
    );
    if (calendarMatch) {
      let offset = 0;
      const arg = calendarMatch[1] ? calendarMatch[1].toLowerCase() : "";
      if (arg === "next") offset = 1;
      else if (arg === "prev" || arg === "previous") offset = -1;
      else if (arg) offset = parseInt(arg, 10) || 0;
      return reply_(getApprovedLeaveCalendarCard_(offset, senderEmail, senderUserId));
    }

    if (/^(?:\/)?(?:leaves\s+|team\s+)?upcoming$/i.test(normalizedText)) {
      return reply_(getUpcomingApprovedLeavesCard_(senderEmail, senderUserId));
    }

    const summaryMatch = normalizedText.match(/^(\/)?(leaves|my\s+leaves|leave\s+count)(?:\s+(\d{4}))?$/i);
    if (summaryMatch) {
      const targetYear = summaryMatch[3] ? parseInt(summaryMatch[3], 10) : new Date().getFullYear();
      return reply_(getLeaveSummaryCard_(senderEmail, senderName, targetYear, senderUserId));
    }

    // -------------------------------------------------------------
    // ADMIN SUMMARY PRIVILEGE (EXCLUSIVE TO ROLE = ROLE_ADMIN)
    // -------------------------------------------------------------
    const isSummaryCmd = /^(?:\/)?(?:team\s+|leaves?\s+)?summary\b/i.test(normalizedText);
    if (isSummaryCmd) {
      if (!isAdmin_(senderEmail, senderUserId)) {
        return reply_(getAdminAccessDeniedCard_(senderName, senderEmail, senderUserId));
      }

      const yearMatch = normalizedText.match(/\b(20\d\d)\b/);
      const targetYear = yearMatch ? parseInt(yearMatch[1], 10) : new Date().getFullYear();

      const targetEmployee = findTargetEmployeeFromSummaryCommand_(normalizedText, event);
      if (targetEmployee) {
        return reply_(getManagerEmployeeDossierCard_(targetEmployee.email, targetEmployee.name, targetYear, senderEmail, senderUserId));
      }

      const queryName = extractTargetNameQuery_(normalizedText);
      if (queryName) {
        return reply_(infoCard_(
          "Employee Not Found",
          "Could not locate employee matching <b>\"" + escapeCardHtml_(queryName) + "\"</b> in the directory.<br><br>" +
          "Please check the spelling, use their email address, or @mention them directly.<br><br>" +
          "<i>Type <code>summary</code> to view the full team summary table.</i>",
          { userEmail: senderEmail, userId: senderUserId }
        ));
      }

      return reply_(getManagerTeamSummaryCard_(targetYear, senderEmail, senderUserId));
    }

    if (/^(?:\/)?(?:apply(?:\s+leave)?|request\s+leave)$/i.test(normalizedText)) {
      return reply_(getApplyLeaveCard_(senderName, senderEmail, senderUserId));
    }

    const leaveMatch = normalizedText.match(/^leave\s+on\s+(.+)$/i);
    if (!leaveMatch) {
      return reply_(getHelpCard(senderName, true, senderEmail, senderUserId));
    }

    let leaveInput = leaveMatch[1].trim();
    let leaveReason = "";
    let leaveType = "FULL DAY";

    if (leaveInput.includes("|")) {
      const parts = leaveInput.split("|").map(part => part.trim()).filter(Boolean);
      leaveInput = parts[0];
      const remainingParts = parts.slice(1);
      const halfDayIndex = remainingParts.findIndex(
        part => /^(HALF DAY|HALF-DAY|FIRST HALF|SECOND HALF|1ST HALF|2ND HALF)$/i.test(part.trim())
      );
      if (halfDayIndex !== -1) {
        const matched = remainingParts[halfDayIndex].trim().toUpperCase();
        leaveType = "HALF DAY";
        if (/FIRST HALF|1ST HALF/i.test(matched)) {
          remainingParts[halfDayIndex] = "First Half";
        } else if (/SECOND HALF|2ND HALF/i.test(matched)) {
          remainingParts[halfDayIndex] = "Second Half";
        } else {
          remainingParts.splice(halfDayIndex, 1);
        }
      }
      leaveReason = remainingParts.join(" | ").trim();
    }

    if (leaveType === "HALF DAY" && leaveInput.includes("-")) {
      return reply_(
        infoCard_(
          "Invalid Half Day Leave",
          "Half-day leave can only be requested for a single date.<br><br>" +
          "<code>leave on 02/10/2026 | HALF DAY</code><br>" +
          "<code>leave on 02/10/2026 | FIRST HALF | Morning dentist</code>",
          { userEmail: senderEmail, userId: senderUserId }
        )
      );
    }

    if (!isValidLeaveDate_(leaveInput)) {
      return reply_(
        infoCard_(
          "Invalid Leave Date",
          "Please use one of these formats:<br><br>" +
          "<code>leave on 02/10/2026</code> — Full day<br>" +
          "<code>leave on 02/10/2026 | HALF DAY</code><br>" +
          "<code>leave on 25/10/2026 - 28/10/2026</code> — Full day range",
          { userEmail: senderEmail, userId: senderUserId }
        )
      );
    }

    // Only allow leave dates within the current calendar year.
    if (!isLeaveDateWithinCurrentYear_(leaveInput)) {
      const currentYear = Utilities.formatDate(
        new Date(),
        Session.getScriptTimeZone(),
        "yyyy"
      );

      return reply_(
        infoCard_(
          "Leave Date Outside Current Year",
          "Leave requests can only be submitted for dates within <b>" +
            currentYear +
            "</b>.<br><br>" +
            "Please update your request so that the entire leave date or date range " +
            "falls within " + currentYear + ".<br><br>" +
            "<b>Example:</b> <code>leave on 25/10/" + currentYear + "</code>",
          { userEmail: senderEmail, userId: senderUserId }
        )
      );
    }

    const leaveDetails = getLeaveCalculationDetails_(leaveInput, leaveType);
    if (leaveDetails.workingDays <= 0) {
        let noLeaveMsg = "";
        const hasHolidays = Array.isArray(leaveDetails.holidayNames) && leaveDetails.holidayNames.length > 0;
        const holidayListStr = hasHolidays ? leaveDetails.holidayNames.join(", ") : "";
        const isWeekendOnly = leaveDetails.weekendDays > 0 && !hasHolidays;
        const isHolidayOnly = hasHolidays && (!leaveDetails.weekendDays || leaveDetails.weekendDays === 0);

       if (isHolidayOnly) {
        noLeaveMsg = "The requested date(s) fall on an official <b>company holiday</b>:<br><br>" +
          "🎊 <b>" + escapeCardHtml_(holidayListStr) + "</b><br><br>" +
          "No working days would be deducted, so a leave request is not required.";
      } else if (isWeekendOnly) {
        noLeaveMsg = "The requested date(s) fall entirely on a <b>weekend</b> (Saturday / Sunday).<br><br>" +
          "Leaves are only needed for standard working days (Monday to Friday). No leave deduction is required.";
      } else {
        noLeaveMsg = "The requested date(s) fall entirely on <b>weekends and/or company holidays</b>.<br><br>";
        if (hasHolidays) {
          noLeaveMsg += "🎊 <b>Holiday:</b> " + escapeCardHtml_(holidayListStr) + "<br><br>";
        }
        noLeaveMsg += "No working days would be deducted, so a leave request is not required.";
      }
      return reply_(infoCard_("No Leave Required", noLeaveMsg, { userEmail: senderEmail, userId: senderUserId }));
    }

    const overlappingRequests = findOverlappingLeaveRequests_(senderEmail, leaveInput, null, leaveType);
    if (overlappingRequests.length > 0) {
      let duplicateMsg = "You have already applied for leave covering the requested date(s):<br><br>";
      overlappingRequests.forEach(function (conflict) {
        duplicateMsg += "• <b>" + conflict.existingDate + "</b> (" + (conflict.leaveType || "FULL DAY") + ") — <b>Status:</b> " + conflict.status;
        if (conflict.requestId) duplicateMsg += " <i>(ID: " + conflict.requestId + ")</i>";
        duplicateMsg += "<br>";
      });
      return reply_(infoCard_("Duplicate Leave Request", duplicateMsg, { userEmail: senderEmail, userId: senderUserId }));
    }

    const requesterTeam = getUserTeam_(senderEmail);
    // Only the exact ROLE_ADMIN role gets automatic full approval.
    const isAdminRequester =
  getUserRoles_(senderEmail).indexOf("ROLE_ADMIN") !== -1;

    const approvers = getApprovers_(requesterTeam);
    if (!requesterTeam) return reply_(getTeamPickerCard_(senderName, senderEmail, senderUserId));
    if (approvers.length === 0 && !isAdminRequester) {
      return reply_(infoCard_("Approval Setup Error", "No approvers configured for team <b>" + escapeCardHtml_(requesterTeam) + "</b>. Add <code>ROLE_" + escapeCardHtml_(requesterTeam) + "_APPROVER</code> to an approver's Role in BotUsers.", { userEmail: senderEmail, userId: senderUserId }));
    }

    const requestId = createRequestId_();
    const saveResult = saveNewRequest({
      requestId: requestId,
      requesterName: senderName,
      requesterEmail: senderEmail,
      leaveDate: leaveInput,
      leaveReason: leaveReason,
      leaveType: leaveType,
      team: requesterTeam,
      days: leaveDetails.workingDays,
      approvers: approvers
    });

    if (saveResult && saveResult.isFullyApproved) {
      sendLeaveApprovedEmail({
        requestId: requestId,
        requesterName: senderName,
        requesterEmail: senderEmail,
        leaveDate: leaveInput,
        leaveType: leaveType,
        leaveReason: leaveReason
      });
      return reply_(
        infoCard_(
          "Leave Request Approved",
          "Your leave request has been automatically approved.<br><br>" +
          "<b>Date:</b> " + leaveInput +
          "<br><b>Duration:</b> " + leaveDetails.breakdownText +
          "<br><b>Leave Type:</b> " + leaveType +
          "<br><b>Status:</b> Approved (Auto-Approved)",
          { userEmail: senderEmail, userId: senderUserId }
        )
      );
    }

    const requiredApprovers = (saveResult && saveResult.requiredApprovers) || approvers;
    requiredApprovers.forEach(approver => {
      if (approver.dmSpace) {
        sendApprovalDm(approver.dmSpace, requestId, senderName, leaveInput, leaveType, leaveReason);
      }
    });

    const statusNote = (saveResult && saveResult.isRequesterApprover)
      ? "Auto-approved your own privilege. Pending approval from remaining approver(s)."
      : "Pending approval";

    return reply_(
      infoCard_(
        "Leave Request Submitted",
        "Your leave request has been submitted successfully.<br><br>" +
        "<b>Date:</b> " + leaveInput +
        "<br><b>Duration:</b> " + leaveDetails.breakdownText +
        "<br><b>Leave Type:</b> " + leaveType +
        "<br><b>Status:</b> " + statusNote,
        { userEmail: senderEmail, userId: senderUserId }
      )
    );
  } catch (error) {
    // Log the stack so the real failure is visible in Apps Script > Executions.
    console.error("onMessage error: " + (error && error.stack ? error.stack : error));
    try {
      return reply_(infoCard_(
        "Unable to process your request",
        "Something went wrong while processing your request. Please try again. If the issue continues, contact HR.",
        { userEmail: senderEmail, userId: senderUserId }
      ));
    } catch (cardError) {
      console.error("onMessage error-card failure: " + (cardError && cardError.stack ? cardError.stack : cardError));
      // Keep the fallback minimal so an error while building a card does not hide the original error.
      return { text: "Something went wrong while processing your request. Please try again." };
    }
  }
}

/**
 * =========================================================
 * WELCOME CARD
 * =========================================================
 */
function getWelcomeCard(userName, userEmail, userChatId) {
  const currentYear = new Date().getFullYear();
  let availableLeaves = CONFIG.DEFAULT_TOTAL_LEAVES || 20;
  let quota = CONFIG.DEFAULT_TOTAL_LEAVES || 20;
  let carryNote = "";

  try {
    const requestData = getRequestDataForUser_(userEmail);
    const cols = getRequestColumns_(requestData[0] || []);
    const balance = getEmployeeLeaveBalanceDetails_(
      userEmail, currentYear, requestData, getHolidayDates_(), cols
    );
    if (balance) {
      availableLeaves = balance.availableLeaves;
      quota = balance.totalAnnualQuota;
      carryNote = balance.carriedForward > 0 && !balance.isPastExpiry
        ? "Includes " + balance.remainingCarryForward + " carry-over days, valid until " + balance.expiryFormatted
        : balance.totalDaysTaken + " days taken this year";
    }
  } catch (err) {
    console.warn("Could not retrieve leave balance for welcome card: " + err);
  }

  return {
    text: "Welcome to Pixcity Leave Tracker. Apply for leave, check your balance, holidays, and team calendar below.",
    cardsV2: [{
      cardId: "welcomeCard",
      card: {
        header: {
          title: "👋 Hi " + (userName || "there") + "!",
          subtitle: "Pixcity Leave Tracker"
        },
        sections: [
          { widgets: [
            { decoratedText: {
              topLabel: "YOUR " + currentYear + " AVAILABLE LEAVE",
              text: "<b>" + availableLeaves + " days</b>",
              bottomLabel: carryNote || (quota + " days annual entitlement")
            }},
            getQuickActionChipsWidget_(userEmail, userChatId)
          ]},
          { header: "📝 Apply for Leave", widgets: [{ textParagraph: { text:
            "<b>Full day:</b> <code>leave on 25/10/2026</code> or with reason: <code>leave on 25/10/2026 | Vacation</code><br><br>" +
            "<b>Half day:</b> <code>leave on 25/10/2026 | HALF DAY</code><br><br>" +
            "<b>Date range:</b> <code>leave on 25/10/2026 - 28/10/2026</code><br><br>" +
            "<font color=\"#80868B\">Weekends and company holidays are automatically excluded.</font>"
          }}]},
          { header: "📅 Balance, Requests & Team Calendar", widgets: [{ textParagraph: { text:
            "<code>leaves</code> — Your leave balance<br>" +
            "<code>status</code> or <code>requests</code> — View your applied leave requests & status<br>" +
            "<code>cancel [ID]</code> — Cancel a pending leave request<br>" +
            "<code>holidays</code> — Company holidays<br>" +
            "<code>calendar</code> — Team calendar<br>" +
            "<code>upcoming</code> — Schedule for next 90 days<br>" +
            "<code>help</code> — Show this guide" +
            (isApprover_(userEmail, userChatId) ? "<br><br><b>⏳ Approver Privileges:</b><br>" +
              "<code>pending</code> — Review all pending leave requests waiting for your approval" : "") +
            (isAdmin_(userEmail, userChatId) ? "<br><br><b>👔 Admin Privileges (ROLE_ADMIN):</b><br>" +
              "<code>summary</code> — Annual team table & balance overview<br>" +
              "<code>summary [year]</code> — View team balance for specific year (e.g. <code>summary 2025</code>)<br>" +
              "<code>summary @employee</code> — Specific employee leave dates dossier" +
              getAdminRoleHelpText_() : "")
          }}]}
        ]
      }
    }]
  };
}

function getHelpCard(userName, isInvalidCommand, userEmail, userId) {
  const isManager = isAdmin_(userEmail, userId);
  const helpSections = [
    { header: "📝 How to apply", widgets: [{ textParagraph: { text:
      "<code>leave on 25/10/2026</code><br>" +
      "<code>leave on 25/10/2026 | Family function</code><br>" +
      "<code>leave on 25/10/2026 | HALF DAY</code><br>" +
      "<code>leave on 25/10/2026 - 28/10/2026</code>"
    }}]},
    { header: "📅 Balance, Requests & Calendar", widgets: [{ textParagraph: { text:
      "<code>leaves</code> — Your leave balance<br>" +
      "<code>status</code> or <code>requests</code> — View your applied leave requests & status<br>" +
      "<code>cancel [ID]</code> — Cancel a pending leave request<br>" +
      "<code>holidays</code> — Company holidays<br>" +
      "<code>calendar</code> — Team calendar"
    }}]}
  ];

  if (isApprover_(userEmail, userId)) {
    helpSections.push({
      header: "⏳ Approver Privileges",
      widgets: [{ textParagraph: { text:
        "<code>pending</code> — Review and action pending leave requests waiting for your approval"
      }}]
    });
  }

  if (isManager) {
    helpSections.push({
      header: "👔 Admin Privileges (ROLE_ADMIN)",
      widgets: [{ textParagraph: { text:
        "<code>summary</code> — Team leave summary table<br>" +
        "<code>summary 2026</code> — Historical / future year overview<br>" +
        "<code>summary @employee</code> — Individual leave dates dossier" +
        getAdminRoleHelpText_()
      }}]
    });
  }

  helpSections.push({ widgets: [getQuickActionChipsWidget_(userEmail, userId)] });

  return {
    cardsV2: [{
      cardId: "helpCard",
      card: {
        header: {
          title: isInvalidCommand ? "⚠️ Command not recognized" : "👋 Hi " + (userName || "there"),
          subtitle: "Leave Tracker — Quick Guide"
        },
        sections: helpSections
      }
    }]
  };
}

/**
 * =========================================================
 * SCHEMA & COLUMN RESOLUTION
 * =========================================================
 */
function getRequestColumns_(headerRow) {
  const cols = {
    requestId: COL_REQUEST_ID,
    employee: COL_EMPLOYEE,
    email: COL_EMAIL,
    date: COL_DATE,
    leaveType: COL_LEAVE_TYPE,
    days: COL_DAYS,
    reason: COL_REASON,
    approvals: COL_APPROVALS,
    final: COL_FINAL,
    a1: -1,
    a2: -1
  };
  if (!headerRow || !headerRow.length) return cols;

  let hasApprovals = false;
  headerRow.forEach(function (h, idx) {
    const text = String(h || "").toLowerCase().trim();
    if (text.includes("request id")) cols.requestId = idx + 1;
    else if (text === "employee") cols.employee = idx + 1;
    else if (text === "email") cols.email = idx + 1;
    else if (text.includes("date")) cols.date = idx + 1;
    else if (text.includes("leave type")) cols.leaveType = idx + 1;
    else if (text.includes("no of days") || text === "days" || text.includes("working days")) cols.days = idx + 1;
    else if (text.includes("reason") || text.includes("comment")) cols.reason = idx + 1;
    else if (text.includes("approval") || text.includes("approved by") || text.includes("approvers")) {
      cols.approvals = idx + 1;
      hasApprovals = true;
    } else if (text.includes("approver 1")) cols.a1 = idx + 1;
    else if (text.includes("approver 2")) cols.a2 = idx + 1;
    else if (text.includes("final")) cols.final = idx + 1;
  });

  if (!hasApprovals && cols.a1 !== -1) cols.approvals = cols.a1;
  return cols;
}

function parseApprovedEmails_(cellText) {
  if (!cellText) return [];
  const text = String(cellText);
  const parts = text.split(/Waiting:|Pending:/i);
  const approvedSection = parts[0] || "";
  const matches = approvedSection.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  const result = [];
  matches.forEach(function (e) {
    const norm = normalizeEmail_(e);
    if (!result.includes(norm)) result.push(norm);
  });
  return result;
}

/**
 * =========================================================
 * SAVE NEW REQUEST
 * =========================================================
 */

function saveNewRequest(record) {
  const team = normalizeTeam_(
    record.team || getUserTeam_(record.requesterEmail)
  );

  const requestSheet = getTeamSheetName_(team);

  ensureSheet_(requestSheet, [
    "Request ID",
    "Employee",
    "Email",
    "Date / Range",
    "Leave Type",
    "No of Days",
    "Reason / Comment",
    "Approvals",
    "Final Status"
  ]);

  const requesterEmail = normalizeEmail_(record.requesterEmail);
  const requesterRoles = getUserRoles_(requesterEmail);
  const isAdminRequester = requesterRoles.indexOf("ROLE_ADMIN") !== -1;

  const approvers = record.approvers || getApprovers_(team);

  const isRequesterApprover = approvers.some(function (approver) {
    return normalizeEmail_(approver.email) === requesterEmail;
  });

  const requiredApprovers = isAdminRequester
    ? []
    : approvers.filter(function (approver) {
        return normalizeEmail_(approver.email) !== requesterEmail;
      });

  let approvalsText = "";
  let finalStatus = "PENDING";

  if (isAdminRequester) {
    // ROLE_ADMIN bypasses all approval requirements.
    approvalsText = requesterEmail + " (ROLE_ADMIN Auto-Approved)";
    finalStatus = "APPROVED";

  } else if (isRequesterApprover) {
    // Preserve existing behavior for team approvers.
    if (requiredApprovers.length === 0) {
      approvalsText = requesterEmail + " (Auto-Approved)";
      finalStatus = "APPROVED";
    } else {
      approvalsText =
        requesterEmail +
        " (Auto-Approved) | Waiting: " +
        requiredApprovers.map(function (approver) {
          return approver.name || approver.email;
        }).join(", ");

      finalStatus = "PENDING";
    }

  } else {
    approvalsText =
      "Waiting: " +
      approvers.map(function (approver) {
        return approver.name || approver.email;
      }).join(", ");

    finalStatus = "PENDING";
  }

  const daysCount = record.days !== undefined
    ? record.days
    : getLeaveDays_(record.leaveDate, record.leaveType);

  appendSheetRow_(requestSheet, [
    record.requestId,
    record.requesterName,
    requesterEmail,
    record.leaveDate,
    record.leaveType || "FULL DAY",
    daysCount,
    record.leaveReason || "",
    approvalsText,
    finalStatus
  ]);

  return {
    isFullyApproved: finalStatus === "APPROVED",
    isAdminRequester: isAdminRequester,
    requiredApprovers: requiredApprovers,
    isRequesterApprover: isRequesterApprover,
    sheetName: requestSheet,
    team: team
  };
}


/**
 * =========================================================
 * HR NOTIFICATION SETTINGS
 * =========================================================
 */
function getSettingsValues_() {
  if (_cachedSettings) return _cachedSettings;
  ensureSheet_(CONFIG.HR_NOTIFICATION_SETTINGS_SHEET_NAME, ["Setting", "Value"]);
  const rows = getSheetData_(CONFIG.HR_NOTIFICATION_SETTINGS_SHEET_NAME);
  const settings = {};
  rows.slice(1).forEach(function (row) {
    const key = String(row[0] || "").trim().toUpperCase();
    if (key) settings[key] = row[1];
  });
  _cachedSettings = settings;
  return settings;
}

function getHrNotificationSettings_() {
  const settings = getSettingsValues_();
  function parseEmails(value) {
    const seen = new Set();
    return String(value || "")
      .split(/[;,\n\r]+/)
      .map(function (email) { return email.trim(); })
      .filter(function (email) {
        if (!email) return false;
        const normalized = normalizeEmail_(email);
        if (seen.has(normalized)) return false;
        seen.add(normalized);
        return true;
      });
  }
  return {
    to: parseEmails(settings.HR_NOTIFICATION_EMAILS),
    cc: parseEmails(settings.HR_NOTIFICATION_CC)
  };
}

function sendLeaveApprovedEmail(data) {
  try {
    const subject = "Leave Request : " + formatLeaveSubject_(data.leaveDate);
    const leaveTypeText = data.leaveType === "HALF DAY" ? "half-day leave" : "leave";
    const reasonSentence = data.leaveReason && data.leaveReason.trim()
      ? "due to " + data.leaveReason.trim() + "."
      : "for personal reasons.";

    const leaveDetails = getLeaveCalculationDetails_(data.leaveDate, data.leaveType);
    let durationText = "";
    if (leaveDetails.workingDays > 0) {
      durationText = " (" + leaveDetails.workingDays +
        (leaveDetails.workingDays === 1 ? " working day" : " working days") +
        (leaveDetails.breakdownNote ? ", " + leaveDetails.breakdownNote : "") +
        ")";
    }

    const body =
      "Dear Team,\n\n" +
      "I would like to request " + leaveTypeText + durationText + " for " +
      formatLeaveBodyDate_(data.leaveDate) + ", " + reasonSentence + "\n\n" +
      "I will ensure that any pending work is completed or handed over appropriately before my leave. " +
      "This leave request has been approved.\n\n" +
      "Thank you.\n\n" +
      "Best regards,\n" +
      data.requesterName;

    const hrSettings = getHrNotificationSettings_();
    if (hrSettings.to.length === 0) return;

    const options = {};
    const toSet = new Set(hrSettings.to.map(normalizeEmail_));
    const cc = hrSettings.cc.filter(email => !toSet.has(normalizeEmail_(email)));
    if (cc.length > 0) options.cc = cc.join(",");

    MailApp.sendEmail(hrSettings.to.join(","), subject, body, options);
  } catch (error) {
    console.error("sendLeaveApprovedEmail error:", error);
  }
}

/**
 * =========================================================
 * FAST USER REGISTRATION (ZERO-CALL NO-OP WHEN UNCHANGED)
 * =========================================================
 */
function registerBotUserFromEvent_(event) {
  event = event || {};
  const chat = event.chat || {};
  const messagePayload = chat.messagePayload || {};
  const user = chat.user || messagePayload.user || event.user || {};
  const space = chat.space || messagePayload.space || event.space || {};
  const email = normalizeEmail_(user.email);
  const name = user.displayName || "Employee";
  const userId = user.name || "";
  const spaceName = space.name || "";

  if (!email) return;
  registerUserDirectly_(email, name, userId, spaceName);
}

function getBotUserColumns_(headerRow) {
  const cols = {
    email: BOT_COL_EMAIL,
    name: BOT_COL_NAME,
    userId: BOT_COL_USER_ID,
    space: BOT_COL_SPACE,
    approver: BOT_COL_APPROVER,
    carryForward: BOT_COL_CARRY_FORWARD,
    initialTaken: BOT_COL_INITIAL_TAKEN,
    annualQuota: BOT_COL_ANNUAL_QUOTA,
    role: BOT_COL_ROLE
  };
  if (!headerRow || !headerRow.length) return cols;

  headerRow.forEach(function (h, idx) {
    const text = String(h || "").toLowerCase().trim();
    if (text === "email") cols.email = idx + 1;
    else if (text === "name" || text === "employee") cols.name = idx + 1;
    else if (text.includes("user id") || text.includes("chat user")) cols.userId = idx + 1;
    else if (text.includes("space") || text.includes("dm space")) cols.space = idx + 1;
    else if (text.includes("approver")) cols.approver = idx + 1;
    else if (text.includes("carry forward")) cols.carryForward = idx + 1;
    else if (text.includes("initial") || text.includes("initial taken")) cols.initialTaken = idx + 1;
    else if (text.includes("quota") || text.includes("entitlement")) cols.annualQuota = idx + 1;
    else if (text === "role" || text === "type" || text.includes("role") || text.includes("type")) cols.role = idx + 1;
  });
  return cols;
}

function registerUserDirectly_(email, name, userId, spaceName) {
  const normEmail = normalizeEmail_(email);
  if (!normEmail) return;

  ensureSheet_(CONFIG.BOT_USERS_SHEET_NAME, [
    "Email", "Name", "Chat User ID", "DM Space",
    "Carry Forward Leaves", "Initial Leaves Taken", "Annual Leave Quota", "Role"
  ]);

  const data = getSheetData_(CONFIG.BOT_USERS_SHEET_NAME);
  const headerRow = (data && data[0]) || [];
  const botCols = getBotUserColumns_(headerRow);

  if (data.length > 0 && !headerRow.some(h => /^(role|type)$/i.test(String(h || "").trim()))) {
    try {
      setSheetCell_(CONFIG.BOT_USERS_SHEET_NAME, 1, BOT_COL_ROLE, "Role");
    } catch (e) {}
  }

  for (let i = 1; i < data.length; i++) {
    const rowEmail = normalizeEmail_(data[i][botCols.email - 1]);
    if (rowEmail === normEmail) {
      const rowNumber = i + 1;
      const curName = String(data[i][botCols.name - 1] || "");
      const curUserId = String(data[i][botCols.userId - 1] || "");
      const curSpace = String(data[i][botCols.space - 1] || "");
      const curRole = botCols.role > 0 ? String(data[i][botCols.role - 1] || "").trim() : "";

      if ((name && name !== curName) || (userId && userId !== curUserId) || (spaceName && spaceName !== curSpace)) {
        if (name && name !== curName) setSheetCell_(CONFIG.BOT_USERS_SHEET_NAME, rowNumber, botCols.name, name);
        if (userId && userId !== curUserId) setSheetCell_(CONFIG.BOT_USERS_SHEET_NAME, rowNumber, botCols.userId, userId);
        if (spaceName && spaceName !== curSpace) setSheetCell_(CONFIG.BOT_USERS_SHEET_NAME, rowNumber, botCols.space, spaceName);
      }
      return;
    }
  }

  appendSheetRow_(CONFIG.BOT_USERS_SHEET_NAME, [
    normEmail, name || "Employee", userId || "", spaceName || "", 0, 0, "", ""
  ]);
}

function getEmployeeBotUserData_(identifier) {
  if (!identifier) return null;
  const data = getSheetData_(CONFIG.BOT_USERS_SHEET_NAME);
  if (!data || data.length < 2) return null;
  const cols = getBotUserColumns_(data[0]);

  const searchRaw = String(identifier || "").trim();
  const searchNormEmail = normalizeEmail_(searchRaw);
  const searchNormId = searchRaw.toLowerCase().replace(/^users\//, "");

  for (let i = 1; i < data.length; i++) {
    const rowEmail = normalizeEmail_(data[i][cols.email - 1]);
    const rowUserIdRaw = String(data[i][cols.userId - 1] || "").trim();
    const rowUserIdNorm = rowUserIdRaw.toLowerCase().replace(/^users\//, "");

    let matches = false;
    // 1. Match by email
    if (searchNormEmail && rowEmail && rowEmail === searchNormEmail) {
      matches = true;
    }
    // 2. Match by Chat user ID (with or without 'users/' prefix)
    else if (searchNormId && rowUserIdNorm && rowUserIdNorm === searchNormId) {
      matches = true;
    }

    if (matches) {
      const rawCarry = data[i][cols.carryForward - 1];
      const rawInitialTaken = data[i][cols.initialTaken - 1];
      const rawQuota = data[i][cols.annualQuota - 1];
      const rawRole = cols.role > 0 ? data[i][cols.role - 1] : "";
      const roleStr = String(rawRole || "").trim();
      const roles = parseRoles_(roleStr);
      const isAdmin = roles.indexOf("ROLE_ADMIN") !== -1 || roles.indexOf("ADMIN") !== -1 || roles.indexOf("ROLE_MANAGER") !== -1 || roles.indexOf("MANAGER") !== -1;
      const role = roles.length ? roles.join(",") : "";

      return {
        email: rowEmail,
        name: String(data[i][cols.name - 1] || ""),
        userId: rowUserIdRaw,
        dmSpace: String(data[i][cols.space - 1] || ""),
        role: role,
        rawRole: roleStr,
        isAdmin: isAdmin,
        isManager: isAdmin,
        carryForward: (rawCarry !== undefined && String(rawCarry).trim() !== "" && !isNaN(Number(rawCarry)))
          ? Number(rawCarry) : null,
        initialTaken: (rawInitialTaken !== undefined && String(rawInitialTaken).trim() !== "" && !isNaN(Number(rawInitialTaken)))
          ? Number(rawInitialTaken) : 0,
        rawQuota: (rawQuota !== undefined && rawQuota !== null && String(rawQuota).trim() !== "")
          ? String(rawQuota).trim() : null,
        customQuota: (rawQuota !== undefined && String(rawQuota).trim() !== "" && !isNaN(Number(rawQuota)))
          ? Number(rawQuota) : null
      };
    }
  }
  return null;
}

function getAllBotUsers_() {
  const data = getSheetData_(CONFIG.BOT_USERS_SHEET_NAME);
  const users = [];
  const seenEmails = new Set();

  if (data && data.length >= 2) {
    const cols = getBotUserColumns_(data[0]);
    for (let i = 1; i < data.length; i++) {
      const email = normalizeEmail_(data[i][cols.email - 1]);
      if (!email || seenEmails.has(email)) continue;
      seenEmails.add(email);

      const name = String(data[i][cols.name - 1] || "Employee").trim();
      const userId = String(data[i][cols.userId - 1] || "").trim();
      const space = String(data[i][cols.space - 1] || "").trim();
      const rawRole = cols.role > 0 ? data[i][cols.role - 1] : "";
      const roleStr = String(rawRole || "").trim();
      const roles = parseRoles_(roleStr);
      const isApprover = roles.some(function (roleName) { return /_APPROVER$/.test(roleName); });
      const isAdmin = roles.indexOf("ROLE_ADMIN") !== -1 || roles.indexOf("ADMIN") !== -1 || roles.indexOf("ROLE_MANAGER") !== -1 || roles.indexOf("MANAGER") !== -1;
      const role = roles.length ? roles.join(",") : "";

      users.push({
        email: email,
        name: name,
        userId: userId,
        space: space,
        isApprover: isApprover,
        role: role,
        rawRole: roleStr,
        isAdmin: isAdmin,
        isManager: isAdmin
      });
    }
  }


  users.sort((a, b) => a.name.localeCompare(b.name));
  return users;
}

function resolveEmployeeQuota_(botUserData, targetYear) {
  const defaultQuota = getTotalLeaveEntitlement_();
  if (!botUserData || !botUserData.rawQuota) return defaultQuota;

  const str = String(botUserData.rawQuota).trim();
  if (!str) return defaultQuota;

  const yearMatch = str.match(/(?:(\d{4})\s*[:=-]\s*(\d+(?:\.\d+)?))|(?:(\d+(?:\.\d+)?)\s*(?:\(|for\s+|in\s+)?\s*(\d{4})\)?)/i);
  if (yearMatch) {
    const specifiedYear = Number(yearMatch[1] || yearMatch[4]);
    const quotaVal = Number(yearMatch[2] || yearMatch[3]);
    if (targetYear === specifiedYear) return quotaVal;
    return defaultQuota;
  }

  const val = parseFloat(str);
  return !isNaN(val) ? val : defaultQuota;
}

function getApprovers_(team) {
  try {
    const normalizedTeam = normalizeTeam_(team);
    if (!normalizedTeam) return [];
    const data = getSheetData_(CONFIG.BOT_USERS_SHEET_NAME);
    const approvers = [];
    if (!data || data.length < 2) return [];
    const cols = getBotUserColumns_(data[0]);
    for (let i = 1; i < data.length; i++) {
      const roles = parseRoles_(cols.role > 0 ? data[i][cols.role - 1] : "");
      if (roles.indexOf(teamApproverRole_(normalizedTeam)) === -1) continue;
      const email = normalizeEmail_(data[i][cols.email - 1]);
      if (!email) continue;
      approvers.push({ email: email, name: String(data[i][cols.name - 1] || "").trim(), userId: String(data[i][cols.userId - 1] || "").trim(), dmSpace: String(data[i][cols.space - 1] || "").trim(), team: normalizedTeam });
    }
    return approvers;
  } catch (err) {
    console.warn("getApprovers_ error: " + err);
    return [];
  }
}

function createRequestId_() {
  return "LR-" + new Date().getTime() + "-" + Math.floor(Math.random() * 1000);
}

/**
 * =========================================================
 * DATE VALIDATION & CALCULATION
 * =========================================================
 */
function isValidLeaveDate_(value) {
  const singleDatePattern = /^\d{2}\/\d{2}\/\d{4}$/;
  const rangePattern = /^\d{2}\/\d{2}\/\d{4}\s*-\s*\d{2}\/\d{2}\/\d{4}$/;
  if (!singleDatePattern.test(value) && !rangePattern.test(value)) return false;

  const dates = value.split("-");
  for (let i = 0; i < dates.length; i++) {
    const parts = dates[i].trim().split("/");
    const day = Number(parts[0]);
    const month = Number(parts[1]);
    const year = Number(parts[2]);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return false;
    }
  }
  if (dates.length === 2 && parseLeaveDate_(dates[0].trim()) > parseLeaveDate_(dates[1].trim())) {
    return false;
  }
  return true;
}

/**
 * =========================================================
 * CURRENT CALENDAR YEAR VALIDATION
 * =========================================================
 * Allows only single dates or date ranges entirely within the
 * current calendar year. Both ends of a range are checked.
 */
function isLeaveDateWithinCurrentYear_(value) {
  const currentYear = Number(
    Utilities.formatDate(
      new Date(),
      Session.getScriptTimeZone(),
      "yyyy"
    )
  );

  const dates = String(value || "").split(/\s*-\s*/);
  if (dates.length < 1 || dates.length > 2) return false;

  for (let i = 0; i < dates.length; i++) {
    const parts = dates[i].trim().split("/");
    if (parts.length !== 3) return false;

    const day = Number(parts[0]);
    const month = Number(parts[1]);
    const year = Number(parts[2]);

    if (year !== currentYear) return false;

    // Reject impossible dates, e.g. 31/02/currentYear.
    const date = new Date(year, month - 1, day);
    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day
    ) {
      return false;
    }
  }

  return true;
}

function parseLeaveDate_(value) {
  if (!value) return new Date();
  if (value instanceof Date) return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const text = String(value).trim();
  let match = text.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (match) return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
  match = text.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/);
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const parsed = new Date(text);
  return !isNaN(parsed.getTime()) ? new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()) : new Date();
}

function parseLeaveRange_(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const d = new Date(value.getFullYear(), value.getMonth(), value.getDate());
    return { start: d, end: d };
  }
  const text = String(value).trim();
  if (!text) return null;

  if (/^\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4}$/.test(text) || /^\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2}$/.test(text)) {
    const d = parseLeaveDate_(text);
    if (d && !isNaN(d.getTime())) return { start: d, end: d };
  }

  const rangeMatch = text.match(/^(.+?)\s*(?:-|–|—|\bto\b)\s*(.+)$/i);
  if (rangeMatch) {
    let start = parseLeaveDate_(rangeMatch[1].trim());
    let end = parseLeaveDate_(rangeMatch[2].trim());
    if (start && !isNaN(start.getTime()) && end && !isNaN(end.getTime())) {
      if (start > end) { const tmp = start; start = end; end = tmp; }
      return { start: start, end: end };
    }
  }

  const fallback = parseLeaveDate_(text);
  return (fallback && !isNaN(fallback.getTime())) ? { start: fallback, end: fallback } : null;
}

function findOverlappingLeaveRequests_(email, leaveDateStr, excludeRequestId, newLeaveType) {
  if (!email || !leaveDateStr) return [];
  const requestedRange = parseLeaveRange_(leaveDateStr);
  if (!requestedRange) return [];

  const normalizedEmail = normalizeEmail_(email);
  const data = getRequestDataForUser_(email);
  if (!data || data.length < 2) return [];

  const cols = getRequestColumns_(data[0]);
  const requestedType = String(newLeaveType || "FULL DAY").toUpperCase().trim();
  const requestedWeight = /^(HALF DAY|FIRST HALF|SECOND HALF)$/i.test(requestedType) ? 0.5 : 1.0;

  const dateMap = {};
  const cur = new Date(requestedRange.start.getFullYear(), requestedRange.start.getMonth(), requestedRange.start.getDate());
  const stop = new Date(requestedRange.end.getFullYear(), requestedRange.end.getMonth(), requestedRange.end.getDate());
  while (cur.getTime() <= stop.getTime()) {
    dateMap[formatCalendarDateKey_(cur)] = { date: new Date(cur), existingWeight: 0, existingRequests: [] };
    cur.setDate(cur.getDate() + 1);
  }

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (normalizeEmail_(row[cols.email - 1]) !== normalizedEmail) continue;

    const rowRequestId = String(row[cols.requestId - 1] || "").trim();
    if (excludeRequestId && rowRequestId === excludeRequestId) continue;

    const status = String(row[cols.final - 1] || "").trim().toUpperCase();
    if (status !== "PENDING" && status !== "APPROVED") continue;

    const existingDateStr = String(row[cols.date - 1] || "").trim();
    if (!existingDateStr) continue;

    const existingRange = parseLeaveRange_(existingDateStr);
    if (!existingRange) continue;

    const existingType = String(row[cols.leaveType - 1] || "FULL DAY").trim().toUpperCase();
    const existingWeight = /^(HALF DAY|FIRST HALF|SECOND HALF)$/i.test(existingType) ? 0.5 : 1.0;

    const existCur = new Date(existingRange.start.getFullYear(), existingRange.start.getMonth(), existingRange.start.getDate());
    const existStop = new Date(existingRange.end.getFullYear(), existingRange.end.getMonth(), existingRange.end.getDate());

    while (existCur.getTime() <= existStop.getTime()) {
      const key = formatCalendarDateKey_(existCur);
      if (dateMap[key]) {
        dateMap[key].existingWeight += existingWeight;
        dateMap[key].existingRequests.push({
          requestId: rowRequestId,
          status: status,
          existingDate: existingDateStr,
          leaveType: existingType,
          weight: existingWeight
        });
      }
      existCur.setDate(existCur.getDate() + 1);
    }
  }

  const conflicts = [];
  const seenRequestIds = {};

  Object.keys(dateMap).forEach(function (key) {
    const entry = dateMap[key];
    if (entry.existingWeight + requestedWeight > 1.0) {
      entry.existingRequests.forEach(function (req) {
        if (!seenRequestIds[req.requestId]) {
          seenRequestIds[req.requestId] = true;
          conflicts.push({
            requestId: req.requestId,
            status: req.status,
            existingDate: req.existingDate,
            leaveType: req.leaveType,
            existingWeightOnDate: entry.existingWeight,
            requestedWeight: requestedWeight
          });
        }
      });
    }
  });

  return conflicts;
}

function sendApprovalDm(spaceName, requestId, requesterName, leaveDate, leaveType, leaveReason) {
  const reasonText = leaveReason || "Not provided";
  const leaveDetails = getLeaveCalculationDetails_(leaveDate, leaveType);
  const durationText = leaveDetails.breakdownText || (leaveDetails.workingDays + " working days");

  postMessage_(spaceName, {
    cardsV2: [{
      cardId: "leaveApprovalCard",
      card: {
        header: { title: "Leave Approval Request", subtitle: "Submitted by " + requesterName },
        sections: [{
          widgets: [
            { decoratedText: { topLabel: "Employee", text: requesterName } },
            { decoratedText: { topLabel: "Requested Period", text: leaveDate } },
            { decoratedText: { topLabel: "Leave Duration", text: durationText } },
            { decoratedText: { topLabel: "Leave Type", text: leaveType || "FULL DAY" } },
            { decoratedText: { topLabel: "Reason / Comment", text: reasonText } },
            { buttonList: { buttons: [
              cardButton_("Approve", "approve", requestId),
              cardButton_("Reject", "reject", requestId)
            ]}}
          ]
        }]
      }
    }]
  });
}

function cardButton_(label, action, requestId) {
  return {
    text: label,
    onClick: {
      action: {
        function: "onCardClick",
        parameters: [
          { key: "action", value: action },
          { key: "requestId", value: requestId }
        ]
      }
    }
  };
}

function getApplyLeaveCard_(userName, userEmail, userId) {
  return {
    cardsV2: [{
      cardId: "applyLeaveCard",
      card: {
        header: { title: "📝 Apply for Leave", subtitle: "Apply directly by typing a command in chat" },
        sections: [{
          widgets: [
            { textParagraph: { text: "Type one of these commands directly in this chat:" } },
            { decoratedText: { topLabel: "FULL DAY", text: "<b>leave on DD/MM/YYYY</b>", bottomLabel: "leave on 25/10/2026 | Family function" } },
            { decoratedText: { topLabel: "RANGE", text: "<b>leave on DD/MM/YYYY - DD/MM/YYYY</b>", bottomLabel: "leave on 25/10/2026 - 28/10/2026 | Trip" } },
            { decoratedText: { topLabel: "HALF DAY", text: "<b>leave on DD/MM/YYYY | HALF DAY</b>" } },
            getQuickActionChipsWidget_(userEmail, userId)
          ]
        }]
      }
    }]
  };
}

function extractEventParameters_(event) {
  const result = {};
  if (!event) return result;
  const sources = [
    event.commonEventObject && event.commonEventObject.parameters,
    event.action && event.action.parameters,
    event.parameters,
    event.chat && event.chat.parameters
  ];
  sources.forEach(function (src) {
    if (Array.isArray(src)) {
      src.forEach(function (p) { if (p && p.key) result[p.key] = p.value; });
    } else if (src && typeof src === "object") {
      Object.assign(result, src);
    }
  });
  return result;
}

function onCardClick(event) {
  const lock = LockService.getScriptLock();
  try {
    const params = extractEventParameters_(event);
    const actionType = params.action || "";
    const requestId = params.requestId || "";
    const user = (event && event.chat && event.chat.user) || (event && event.user) || {};
    let clickerEmail = user.email ? user.email.toLowerCase().trim() : "";
    let clickerName = user.displayName || "Approver";
    const clickerUserId = user.name || "";

    if (!clickerEmail && clickerUserId) {
      const existingUser = getEmployeeBotUserData_(clickerUserId);
      if (existingUser && existingUser.email) {
        clickerEmail = existingUser.email;
        if (existingUser.name && (!clickerName || clickerName === "Approver")) {
          clickerName = existingUser.name;
        }
      }
    }
    setSessionUser_(clickerEmail, clickerUserId, clickerName);

    if (actionType === "chooseTeam") {
      const selectedTeam = setUserTeam_(clickerEmail, params.team || "");
      return reply_(infoCard_("Team Set Successfully", "You are now registered in <b>" + escapeCardHtml_(selectedTeam) + "</b>. " , { userEmail: clickerEmail, userId: clickerUserId }));
    }
    if (actionType === "openCalendar") {
      const monthOffset = parseInt(params.monthOffset || "0", 10);
      const team = normalizeTeam_(params.team || getUserTeam_(clickerEmail) || getConfiguredTeams_()[0]);
      return reply_(getApprovedLeaveCalendarCard_(monthOffset, clickerEmail, clickerUserId, team));
    }
    if (actionType === "navigateCalendar" || actionType === "selectCalendarTeam") {
      const monthOffset = parseInt(params.monthOffset || "0", 10);
      const team = normalizeTeam_(params.team || getUserTeam_(clickerEmail) || getConfiguredTeams_()[0]);
      return update_(getApprovedLeaveCalendarCard_(monthOffset, clickerEmail, clickerUserId, team));
    }
    if (actionType === "configure" || actionType === "setup" || actionType === "welcome") {
      return reply_(getWelcomeCard(clickerName, clickerEmail, clickerUserId));
    }
    if (actionType === "help") {
      return reply_(getHelpCard(clickerName, false, clickerEmail, clickerUserId));
    }
    if (actionType === "applyLeave") {
      return reply_(getApplyLeaveCard_(clickerName, clickerEmail, clickerUserId));
    }
    if (actionType === "myLeaves") {
      return reply_(getLeaveSummaryCard_(clickerEmail, clickerName, new Date().getFullYear(), clickerUserId));
    }
    if (actionType === "holidays") {
      return reply_(getUpcomingHolidaysCard(clickerEmail, clickerUserId));
    }
    if (actionType === "openTeamSummary") {
      if (!isAdmin_(clickerEmail, clickerUserId)) {
        return reply_(getAdminAccessDeniedCard_(clickerName, clickerEmail, clickerUserId));
      }
      const targetYear = parseInt(params.targetYear || String(new Date().getFullYear()), 10);
      return reply_(getManagerTeamSummaryCard_(targetYear, clickerEmail, clickerUserId, params.team || getUserTeam_(clickerEmail) || getConfiguredTeams_()[0]));
    }
    if (actionType === "teamSummary") {
      if (!isAdmin_(clickerEmail, clickerUserId)) {
        return reply_(getAdminAccessDeniedCard_(clickerName, clickerEmail, clickerUserId));
      }
      const targetYear = parseInt(params.targetYear || String(new Date().getFullYear()), 10);
      return update_(getManagerTeamSummaryCard_(targetYear, clickerEmail, clickerUserId, params.team || getUserTeam_(clickerEmail) || getConfiguredTeams_()[0]));
    }
    if (actionType === "viewEmployeeSummary") {
      if (!isAdmin_(clickerEmail, clickerUserId)) {
        return reply_(getAdminAccessDeniedCard_(clickerName, clickerEmail, clickerUserId));
      }
      const targetEmail = params.targetEmail || "";
      const targetYear = parseInt(params.targetYear || String(new Date().getFullYear()), 10);
      return update_(getManagerEmployeeDossierCard_(targetEmail, "", targetYear, clickerEmail, clickerUserId));
    }
    if (actionType === "myRequests" || actionType === "status") {
      return reply_(getMyLeaveRequestsCard_(clickerEmail, clickerName, clickerUserId));
    }
    if (actionType === "pendingApprovals") {
      if (!isApprover_(clickerEmail, clickerUserId)) {
        return reply_(infoCard_("Not Authorized", "You are not configured as an approver.", { userEmail: clickerEmail, userId: clickerUserId }));
      }
      return reply_(getPendingApprovalsCard_(clickerEmail, clickerName, clickerUserId));
    }
    if (actionType === "cancelLeaveRequest") {
      const targetRequestId = params.requestId || "";
      if (!targetRequestId) {
        return update_(infoCard_("Error", "❌ Missing request ID to cancel.", { userEmail: clickerEmail, userId: clickerUserId }));
      }
      return update_(handleCancelLeaveRequest_(targetRequestId, clickerEmail, clickerName, clickerUserId));
    }

    if (!actionType || !requestId) {
      return update_(infoCard_("Error", "❌ Incomplete interaction parameters.", { userEmail: clickerEmail, userId: clickerUserId }));
    }

    lock.waitLock(15000);
    const request = getRequestById_(requestId);
    if (!request) return update_(infoCard_("Request Not Found", "The leave request could not be found.", { userEmail: clickerEmail, userId: clickerUserId }));
    if (!isTeamApprover_(clickerEmail, clickerUserId, request.team)) {
      return reply_(infoCard_("Not Authorized", "You are not an approver for the <b>" + escapeCardHtml_(request.team) + "</b> team.", { userEmail: clickerEmail, userId: clickerUserId }));
    }

    const requesterEmail = normalizeEmail_(request.requesterEmail);
    if (normalizeEmail_(clickerEmail) === requesterEmail) {
      return update_(infoCard_("Self Approval", "Your own approval is already recorded. Waiting for other approver(s).", { userEmail: clickerEmail, userId: clickerUserId }));
    }
    if (request.finalStatus === "CANCELLED") {
      return update_(infoCard_("Already Cancelled", "This request has been cancelled by the employee.", { userEmail: clickerEmail, userId: clickerUserId }));
    }
    if (request.finalStatus === "REJECTED") {
      return update_(infoCard_("Already Rejected", "This request has already been rejected.", { userEmail: clickerEmail, userId: clickerUserId }));
    }
    if (request.finalStatus === "APPROVED") {
      return update_(infoCard_("Already Approved", "This request has already been fully approved.", { userEmail: clickerEmail, userId: clickerUserId }));
    }

    const sheetData = getSheetData_(request.sheetName);
    const cols = getRequestColumns_(sheetData[0]);
    const row = request.row;
    const currentApprovalsText = String((sheetData[row - 1] && sheetData[row - 1][cols.approvals - 1]) || "");
    const approvedEmails = parseApprovedEmails_(currentApprovalsText);

    if (actionType === "reject") {
      const rejectNote = "REJECTED by " + (clickerName ? (clickerName + " (" + clickerEmail + ")") : clickerEmail);
      setSheetCell_(request.sheetName, row, cols.approvals, currentApprovalsText ? (currentApprovalsText + " | " + rejectNote) : rejectNote);
      setSheetCell_(request.sheetName, row, cols.final, "REJECTED");
      notifyRequester_(request, "REJECTED");
      return update_(infoCard_("Leave Rejected", "The leave request for <b>" + escapeCardHtml_(request.requesterName) + "</b> (" + escapeCardHtml_(request.leaveDate) + ") has been rejected.", { userEmail: clickerEmail, userId: clickerUserId }));
    }

    if (actionType === "approve") {
      if (approvedEmails.includes(clickerEmail)) {
        return update_(infoCard_("Already Approved", "You have already approved this leave request.", { userEmail: clickerEmail, userId: clickerUserId }));
      }
      approvedEmails.push(clickerEmail);

      const approvers = getApprovers_(request.team);
      const isRequesterApprover = approvers.some(a => normalizeEmail_(a.email) === requesterEmail);
      const requiredApprovers = isRequesterApprover ? approvers.filter(a => normalizeEmail_(a.email) !== requesterEmail) : approvers;
      const pendingApprovers = requiredApprovers.filter(a => !approvedEmails.includes(normalizeEmail_(a.email)));

      const approvedList = [];
      if (isRequesterApprover) approvedList.push(requesterEmail + " (Auto-Approved)");
      requiredApprovers.forEach(a => {
        const norm = normalizeEmail_(a.email);
        if (approvedEmails.includes(norm)) approvedList.push(a.name ? (a.name + " (" + norm + ")") : norm);
      });
      if (!approvedList.some(item => item.includes(clickerEmail))) {
        approvedList.push(clickerName ? (clickerName + " (" + clickerEmail + ")") : clickerEmail);
      }

      let updatedApprovals = "";
      if (pendingApprovers.length === 0) {
        updatedApprovals = "Approved: " + approvedList.join(", ");
      } else {
        const waitingNames = pendingApprovers.map(a => a.name || a.email).join(", ");
        updatedApprovals = (approvedList.length > 0 ? "Approved: " + approvedList.join(", ") + " | " : "") + "Waiting: " + waitingNames;
      }

      setSheetCell_(request.sheetName, row, cols.approvals, updatedApprovals);

      if (pendingApprovers.length === 0) {
        setSheetCell_(request.sheetName, row, cols.final, "APPROVED");
        sendLeaveApprovedEmail({
          requestId: request.requestId,
          requesterName: request.requesterName,
          requesterEmail: request.requesterEmail,
          leaveDate: request.leaveDate,
          leaveType: request.leaveType,
          leaveReason: request.leaveReason
        });
        notifyRequester_(request, "APPROVED");
        return update_(infoCard_("Leave Approved", "Leave request for <b>" + escapeCardHtml_(request.requesterName) + "</b> (" + escapeCardHtml_(request.leaveDate) + ") has been approved.", { userEmail: clickerEmail, userId: clickerUserId }));
      }

      const waitingNames = pendingApprovers.map(a => a.name || a.email).join(", ");
      return update_(infoCard_("Approval Recorded", "Your approval for <b>" + escapeCardHtml_(request.requesterName) + "</b> (" + escapeCardHtml_(request.leaveDate) + ") has been recorded. Waiting for: " + waitingNames + ".", { userEmail: clickerEmail, userId: clickerUserId }));
    }

    return update_(infoCard_("Invalid Action", "Unknown approval action."));
  } catch (error) {
    console.error("onCardClick error:", error);
    return update_(infoCard_("Error", "Something went wrong while processing the approval."));
  } finally {
    try { lock.releaseLock(); } catch (error) {}
  }
}

function getRequestById_(requestId) {
  for (const entry of getAllTeamRequestSheets_()) {
    let data = [];
    try { data = getTeamRequestData_(entry.team); } catch (e) { continue; }
    if (!data || data.length < 2) continue;
    const cols = getRequestColumns_(data[0]);
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][cols.requestId - 1] || "").trim() !== requestId) continue;
      return {
        sheetName: entry.sheetName, team: entry.team, row: i + 1,
        requestId: String(data[i][cols.requestId - 1] || ""),
        requesterName: String(data[i][cols.employee - 1] || ""),
        requesterEmail: normalizeEmail_(data[i][cols.email - 1]),
        leaveDate: String(data[i][cols.date - 1] || ""),
        leaveType: String(data[i][cols.leaveType - 1] || "FULL DAY") || "FULL DAY",
        days: cols.days > 0 ? Number(data[i][cols.days - 1] || 0) : 0,
        leaveReason: String(data[i][cols.reason - 1] || ""),
        approvals: cols.approvals > 0 ? String(data[i][cols.approvals - 1] || "") : "",
        finalStatus: String(data[i][cols.final - 1] || "")
      };
    }
  }
  return null;
}

function notifyRequester_(request, status) {
  try {
    const data = getSheetData_(CONFIG.BOT_USERS_SHEET_NAME);
    let dmSpace = "";
    if (data && data.length > 1) {
      const cols = getBotUserColumns_(data[0]);
      for (let i = 1; i < data.length; i++) {
        if (normalizeEmail_(data[i][cols.email - 1]) === request.requesterEmail) {
          dmSpace = String(data[i][cols.space - 1] || "").trim();
          break;
        }
      }
    }
    if (!dmSpace) return;

    const title = status === "APPROVED" ? "Leave Approved" : "Leave Rejected";
    const message = status === "APPROVED"
      ? "Your leave request has been approved."
      : "Your leave request has been rejected.";

    const leaveDetails = getLeaveCalculationDetails_(request.leaveDate, request.leaveType);
    const durationInfo = leaveDetails.breakdownText ? "<br><b>Duration:</b> " + leaveDetails.breakdownText : "";

    postMessage_(
      dmSpace,
      infoCard_(
        title,
        message + "<br><b>Date:</b> " + request.leaveDate + durationInfo + "<br><b>Leave Type:</b> " + (request.leaveType || "FULL DAY"),
        { userEmail: request.requesterEmail }
      )
    );
  } catch (error) {
    console.error("notifyRequester_ error:", error);
  }
}

/**
 * =========================================================
 * POST GOOGLE CHAT MESSAGE
 * =========================================================
 */
function postMessage_(spaceName, message) {
  if (!spaceName) return;
  const service = getChatService_();
  if (!service || !service.hasAccess()) {
    console.error("Google Chat service has no access.");
    return;
  }
  UrlFetchApp.fetch("https://chat.googleapis.com/v1/" + spaceName + "/messages", {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + service.getAccessToken() },
    payload: JSON.stringify(message),
    muteHttpExceptions: true
  });
}

function getChatService_() {
  const properties = PropertiesService.getScriptProperties();
  const key = properties.getProperty("SERVICE_ACCOUNT_KEY");
  if (!key) throw new Error("SERVICE_ACCOUNT_KEY is not configured.");
  const serviceAccount = JSON.parse(key);
  return OAuth2.createService("GoogleChat")
    .setTokenUrl("https://oauth2.googleapis.com/token")
    .setPrivateKey(serviceAccount.private_key)
    .setIssuer(serviceAccount.client_email)
    .setPropertyStore(properties)
    .setParam("access_type", "offline")
    .setScope("https://www.googleapis.com/auth/chat.bot");
}

/**
 * =========================================================
 * LEAVE BALANCES
 * =========================================================
 */
function getEmployeeLeaveBalanceDetails_(email, targetYear, requestData, allHolidays, cols) {
  const year = Number(targetYear) || new Date().getFullYear();
  const prevYear = year - 1;
  const maxCarryForward = Number(CONFIG.MAX_CARRY_FORWARD !== undefined ? CONFIG.MAX_CARRY_FORWARD : 5);
  const expiryMonth = Number(CONFIG.CARRY_FORWARD_EXPIRY_MONTH || 9);
  const expiryDay = Number(CONFIG.CARRY_FORWARD_EXPIRY_DAY || 30);
  const expiryDate = new Date(year, expiryMonth - 1, expiryDay, 23, 59, 59, 999);
  const today = new Date();
  const isPastExpiry = today.getTime() > expiryDate.getTime() && today.getFullYear() >= year;

  const botUserData = getEmployeeBotUserData_(email);
  const totalAnnualQuota = resolveEmployeeQuota_(botUserData, year);
  const prevYearQuota = resolveEmployeeQuota_(botUserData, prevYear);

  let carriedForward = 0;
  let prevYearDaysTaken = 0;
  let hasPrevYearData = false;

  for (let i = 1; i < requestData.length; i++) {
    const rowEmail = normalizeEmail_(requestData[i][cols.email - 1]);
    const status = String(requestData[i][cols.final - 1] || "").toUpperCase().trim();
    if (rowEmail === email && status === "APPROVED") {
      const dateStr = String(requestData[i][cols.date - 1] || "");
      const typeStr = String(requestData[i][cols.leaveType - 1] || "FULL DAY");
      const days = getLeaveDaysInYear_(dateStr, typeStr, prevYear, allHolidays);
      if (days > 0) {
        prevYearDaysTaken += days;
        hasPrevYearData = true;
      }
    }
  }

  if (hasPrevYearData) {
    const prevYearUnused = Math.max(0, prevYearQuota - prevYearDaysTaken);
    carriedForward = Math.min(maxCarryForward, prevYearUnused);
  } else if (botUserData && botUserData.carryForward !== null) {
    carriedForward = Math.min(maxCarryForward, Math.max(0, botUserData.carryForward));
  } else {
    carriedForward = 0;
  }

  const launchYear = Number(CONFIG.HOLIDAY_YEAR || 2026);
  const initialTaken = (botUserData && botUserData.initialTaken && year === launchYear)
    ? botUserData.initialTaken : 0;

  let daysBeforeExpiry = initialTaken;
  let daysAfterExpiry = 0;
  let approvedRequests = initialTaken > 0 ? 1 : 0;
  const approvedLeaves = [];

  for (let i = 1; i < requestData.length; i++) {
    const rowEmail = normalizeEmail_(requestData[i][cols.email - 1]);
    const status = String(requestData[i][cols.final - 1] || "").toUpperCase().trim();
    if (rowEmail === email && status === "APPROVED") {
      const dateStr = String(requestData[i][cols.date - 1] || "");
      const typeStr = String(requestData[i][cols.leaveType - 1] || "FULL DAY");
      const reasonStr = String(requestData[i][cols.reason - 1] || "").trim();

      const daysInYear = getLeaveDaysInYear_(dateStr, typeStr, year, allHolidays);
      if (daysInYear > 0) {
        approvedRequests++;
        const dates = dateStr.split("-");
        const start = parseLeaveDate_(dates[0].trim());
        const end = dates.length > 1 ? parseLeaveDate_(dates[1].trim()) : new Date(start);

        if (isNaN(start.getTime()) || isNaN(end.getTime())) continue;

        let reqDaysBefore = 0;
        let reqDaysAfter = 0;

        const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
        const stop = new Date(end.getFullYear(), end.getMonth(), end.getDate());

        while (cur.getTime() <= stop.getTime()) {
          if (cur.getFullYear() === year) {
            const dayOfWeek = cur.getDay();
            const dateKey = formatCalendarDateKey_(cur);
            const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
            const isHoliday = allHolidays.some(h => formatCalendarDateKey_(h.date) === dateKey);

            if (!isWeekend && !isHoliday) {
              const dayValue = (typeStr === "HALF DAY") ? 0.5 : 1;
              if (cur.getTime() <= expiryDate.getTime()) reqDaysBefore += dayValue;
              else reqDaysAfter += dayValue;
            }
          }
          cur.setDate(cur.getDate() + 1);
        }

        daysBeforeExpiry += reqDaysBefore;
        daysAfterExpiry += reqDaysAfter;

        approvedLeaves.push({
          date: dateStr,
          leaveType: typeStr,
          daysInYear: daysInYear,
          reason: reasonStr,
          startDate: start
        });
      }
    }
  }

  approvedLeaves.sort((a, b) => a.startDate.getTime() - b.startDate.getTime());

  const carriedForwardUsed = Math.min(carriedForward, daysBeforeExpiry);
  const annualUsedBeforeExpiry = daysBeforeExpiry - carriedForwardUsed;
  const annualUsed = annualUsedBeforeExpiry + daysAfterExpiry;

  const unusedCarryForward = Math.max(0, carriedForward - carriedForwardUsed);
  const carriedForwardExpired = isPastExpiry ? unusedCarryForward : 0;
  const remainingCarryForward = isPastExpiry ? 0 : unusedCarryForward;
  const remainingAnnual = Math.max(0, totalAnnualQuota - annualUsed);

  const availableLeaves = remainingCarryForward + remainingAnnual;
  const totalDaysTaken = carriedForwardUsed + annualUsed;

  const totalEffectiveEntitlement = isPastExpiry ? totalAnnualQuota : (totalAnnualQuota + carriedForward);
  const usagePercentage = totalEffectiveEntitlement > 0
    ? Math.round((totalDaysTaken / totalEffectiveEntitlement) * 100) : 0;

  return {
    year: year,
    prevYear: prevYear,
    totalAnnualQuota: totalAnnualQuota,
    carriedForward: carriedForward,
    carriedForwardUsed: carriedForwardUsed,
    carriedForwardExpired: carriedForwardExpired,
    remainingCarryForward: remainingCarryForward,
    annualUsed: annualUsed,
    remainingAnnual: remainingAnnual,
    availableLeaves: availableLeaves,
    totalDaysTaken: totalDaysTaken,
    totalEffectiveEntitlement: totalEffectiveEntitlement,
    usagePercentage: usagePercentage,
    approvedRequests: approvedRequests,
    approvedLeaves: approvedLeaves,
    isPastExpiry: isPastExpiry,
    expiryFormatted: Utilities.formatDate(expiryDate, Session.getScriptTimeZone(), "dd MMM yyyy")
  };
}

function getLeaveSummaryCard_(email, employeeName, targetYear, userId) {
  const normalizedEmail = normalizeEmail_(email);
  if (!normalizedEmail) return infoCard_("Leave Summary", "Could not determine your email address.", { userEmail: email, userId: userId });

  const year = Number(targetYear) || new Date().getFullYear();
  const requestData = getRequestDataForUser_(normalizedEmail);
  const cols = getRequestColumns_(requestData[0] || []);
  const allHolidays = getHolidayDates_();

  const balance = getEmployeeLeaveBalanceDetails_(
    normalizedEmail, year, requestData, allHolidays, cols
  );

  let carryNote = "";
  if (balance.carriedForward > 0) {
    if (balance.isPastExpiry) {
      carryNote = balance.carriedForwardExpired > 0
        ? balance.carriedForwardExpired + " carry-over leaves from " + balance.prevYear + " expired on " + balance.expiryFormatted
        : "All " + balance.carriedForward + " carry-over leaves utilized";
    } else {
      carryNote = "Includes " + balance.remainingCarryForward + " carry-over days (valid until " + balance.expiryFormatted + ")";
    }
  } else {
    carryNote = balance.usagePercentage + "% of annual quota used";
  }

  const sections = [
    {
      widgets: [
        { textParagraph: { text: "<b>YOUR " + year + " LEAVE BALANCE</b>" } },
        { decoratedText: {
          topLabel: "AVAILABLE LEAVE (" + year + ")",
          text: "<b>" + balance.availableLeaves + " days</b>",
          bottomLabel: carryNote
        }}
      ]
    },
    {
      widgets: [
        { textParagraph: { text: "<b>" + year + " LEAVE OVERVIEW</b>" } },
        { columns: {
          columnItems: [
            {
              horizontalSizeStyle: "FILL_AVAILABLE_SPACE",
              widgets: [{ textParagraph: { text: "📋 <b>" + balance.totalAnnualQuota + "</b><br><font color=\"#80868B\">Annual quota</font>" } }]
            },
            {
              horizontalSizeStyle: "FILL_AVAILABLE_SPACE",
              widgets: [{ textParagraph: { text: "🔄 <b>" + balance.carriedForward + "</b><br><font color=\"#80868B\">Carried over</font>" } }]
            },
            {
              horizontalSizeStyle: "FILL_AVAILABLE_SPACE",
              widgets: [{ textParagraph: { text: "🌴 <b>" + balance.totalDaysTaken + "</b><br><font color=\"#80868B\">Taken in " + year + "</font>" } }]
            }
          ]
        }}
      ]
    }
  ];

  const leaveWidgets = [];
  if (balance.approvedLeaves.length === 0) {
    leaveWidgets.push({ textParagraph: { text: "<font color=\"#80868B\">🎉 No approved leaves taken in " + year + " yet.</font>" } });
  } else {
    balance.approvedLeaves.forEach(function (leave) {
      const typeBadge = leave.leaveType === "HALF DAY" ? "Half Day" : "Full Day";
      const daysText = leave.daysInYear + " " + (leave.daysInYear === 1 ? "working day" : "working days");
      leaveWidgets.push({
        decoratedText: {
          topLabel: "🌴 " + typeBadge.toUpperCase() + " · " + daysText,
          text: "<b>" + escapeCardHtml_(leave.date) + "</b>",
          bottomLabel: leave.reason ? "Reason: " + escapeCardHtml_(leave.reason) : "Approved"
        }
      });
    });
  }

  sections.push({
    header: "📋 Approved Leaves in " + year + " (" + balance.totalDaysTaken + " days taken)",
    widgets: leaveWidgets
  });

  sections.push({ widgets: [getQuickActionChipsWidget_(normalizedEmail, userId)] });

  return {
    cardsV2: [{
      cardId: "leaveSummary",
      card: {
        header: { title: "🌴 Leave Dashboard (" + year + ")", subtitle: employeeName || "Employee" },
        sections: sections
      }
    }]
  };
}

/**
 * =========================================================
 * ADMIN SUMMARY PRIVILEGE (EXCLUSIVE TO ROLE = ROLE_ADMIN)
 * =========================================================
 */
function isAdmin_(emailOrUserId, fallbackUserId) {
  if (!emailOrUserId && !fallbackUserId) return false;
  try {
    let user = null;
    if (emailOrUserId) {
      user = getEmployeeBotUserData_(emailOrUserId);
    }
    if (!user && fallbackUserId) {
      user = getEmployeeBotUserData_(fallbackUserId);
    }
    if (!user) return false;
    if (user.isAdmin === true || user.isManager === true) return true;
    const roleUpper = String(user.role || user.rawRole || "").trim().toUpperCase();
    return roleUpper === "ROLE_ADMIN" || roleUpper === "ADMIN" || roleUpper === "MANAGER" || roleUpper === "ROLE_MANAGER";
  } catch (err) {
    console.warn("isAdmin_ error: " + err);
    return false;
  }
}

// Full backwards compatibility alias
function isManager_(emailOrUserId, fallbackUserId) {
  return isAdmin_(emailOrUserId, fallbackUserId);
}

function isApprover_(emailOrUserId, fallbackUserId) {
  if (!emailOrUserId && !fallbackUserId) return false;
  if (isAdmin_(emailOrUserId, fallbackUserId)) return true;
  try {
    const roles = getUserRoles_(emailOrUserId || fallbackUserId);
    return roles.some(function (role) {
      return getConfiguredTeams_().some(function (team) { return role === teamApproverRole_(team); });
    });
  } catch (err) {
    console.warn("isApprover_ error: " + err);
    return false;
  }
}

function getAdminAccessDeniedCard_(userName, userEmail, userId) {
  return {
    cardsV2: [{
      cardId: "adminAccessDenied",
      card: {
        header: {
          title: "🔒 Admin Access Required",
          subtitle: "Pixcity Leave Tracker · Role Permission"
        },
        sections: [
          {
            widgets: [
              {
                textParagraph: {
                  text: "<b>Access Denied:</b> The team leave summary and detailed employee reporting views are reserved exclusively for <b>ROLE_ADMIN</b>."
                }
              },
              {
                decoratedText: {
                  topLabel: "CURRENT USER",
                  text: "<b>" + escapeCardHtml_(userName || "Employee") + "</b>",
                  bottomLabel: "Registered Role: ROLE_EMPLOYEE (" + escapeCardHtml_(userEmail || "No Email") + ")"
                }
              },
              {
                textParagraph: {
                  text: "<font color=\"#80868B\">If you require admin privileges to view team balances, please request your workspace administrator to update your role to <b>ROLE_ADMIN</b> in the <code>BotUsers</code> sheet.</font><br><br>" +
                        "💡 <i>To view your own personal leave balance, type <code>leaves</code>.</i>"
                }
              },
              getQuickActionChipsWidget_(userEmail, userId)
            ]
          }
        ]
      }
    }]
  };
}

function getManagerAccessDeniedCard_(userName, userEmail, userId) {
  return getAdminAccessDeniedCard_(userName, userEmail, userId);
}

function formatLeaveNum_(val) {
  const num = Number(val) || 0;
  return num.toFixed(1);
}

function findTargetEmployeeFromSummaryCommand_(normalizedText, event) {
  const allUsers = getAllBotUsers_();

  const annotations = (event && event.message && event.message.annotations) ||
    (event && event.chat && event.chat.messagePayload && event.chat.messagePayload.message && event.chat.messagePayload.message.annotations) || [];

  for (let i = 0; i < annotations.length; i++) {
    const ann = annotations[i];
    if (ann && ann.type === "USER_MENTION" && ann.userMention && ann.userMention.user) {
      const u = ann.userMention.user;
      const uName = String(u.name || "").trim();
      const uDisp = String(u.displayName || "").trim();

      for (let j = 0; j < allUsers.length; j++) {
        const emp = allUsers[j];
        if ((uName && emp.userId && emp.userId === uName) ||
            (uDisp && emp.name && emp.name.toLowerCase() === uDisp.toLowerCase())) {
          return emp;
        }
      }
      if (uDisp) {
        const matched = allUsers.find(e => e.name.toLowerCase().includes(uDisp.toLowerCase()));
        if (matched) return matched;
      }
    }
  }

  const emailMatch = normalizedText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) {
    const emailStr = normalizeEmail_(emailMatch[0]);
    const found = allUsers.find(u => u.email === emailStr);
    if (found) return found;
    return { email: emailStr, name: emailStr.split("@")[0], role: "", isAdmin: false };
  }

  const userTagMatch = normalizedText.match(/<users\/([^>]+)>/i);
  if (userTagMatch) {
    const tagId = "users/" + userTagMatch[1];
    const found = allUsers.find(u => u.userId === tagId || u.userId.includes(userTagMatch[1]));
    if (found) return found;
  }

  const query = extractTargetNameQuery_(normalizedText);
  if (query) {
    const qLower = query.toLowerCase();
    let found = allUsers.find(u => u.name.toLowerCase() === qLower);
    if (found) return found;
    found = allUsers.find(u => u.name.toLowerCase().includes(qLower) || u.email.includes(qLower));
    if (found) return found;
  }

  return null;
}

function extractTargetNameQuery_(normalizedText) {
  let cleaned = normalizedText
    .replace(/^(?:\/)?(?:team\s+|leaves?\s+)?summary\b/i, "")
    .trim();
  cleaned = cleaned.replace(/\b20\d\d\b/g, "").trim();
  cleaned = cleaned.replace(/@+/g, "").trim();
  cleaned = cleaned.replace(/<users\/[^>]+>/g, "").trim();
  cleaned = cleaned.replace(/^[-|:]+/, "").trim();
  cleaned = cleaned.replace(/^(?:for|of|employee)\s+/i, "").trim();

  return cleaned.length >= 2 ? cleaned : "";
}

function getManagerTeamSummaryCard_(targetYear, managerEmail, managerUserId, selectedTeam) {
  const year = Number(targetYear) || new Date().getFullYear();
  const team = normalizeTeam_(selectedTeam || getUserTeam_(managerEmail) || getConfiguredTeams_()[0]);
  const requestData = getTeamRequestData_(team);
  const cols = getRequestColumns_(requestData[0] || []);
  const allHolidays = getHolidayDates_();
  const allUsers = getAllBotUsers_().filter(function (user) { return getUserTeamsFromRoles_(parseRoles_(user.rawRole)).indexOf(team) !== -1; });

  let totalTeamEntitlement = 0;
  let totalTeamTaken = 0;
  let totalTeamAvailable = 0;

  const employeeStats = [];

  allUsers.forEach(function (user) {
    const balance = getEmployeeLeaveBalanceDetails_(
      user.email, year, requestData, allHolidays, cols
    );

    const avail = balance ? balance.availableLeaves : (CONFIG.DEFAULT_TOTAL_LEAVES || 20);
    const carry = balance ? balance.carriedForward : 0;
    const taken = balance ? balance.totalDaysTaken : 0;
    const quota = balance ? balance.totalAnnualQuota : (CONFIG.DEFAULT_TOTAL_LEAVES || 20);
    const approvedCount = balance ? balance.approvedLeaves.length : 0;
    const percent = (quota + carry) > 0 ? Math.round((taken / (quota + carry)) * 100) : 0;

    totalTeamEntitlement += (quota + carry);
    totalTeamTaken += taken;
    totalTeamAvailable += avail;

    employeeStats.push({
      email: user.email,
      name: user.name,
      role: user.role,
      availableLeaves: avail,
      carriedForward: carry,
      totalDaysTaken: taken,
      totalAnnualQuota: quota,
      approvedCount: approvedCount,
      usagePercentage: percent
    });
  });

  const teamUtilizationRate = totalTeamEntitlement > 0
    ? Math.round((totalTeamTaken / totalTeamEntitlement) * 100) : 0;

  const sections = [
    {
      header: "📊 " + escapeCardHtml_(team) + " Team Leave Overview (" + year + ")",
      widgets: [
        {
          columns: {
            columnItems: [
              {
                horizontalSizeStyle: "FILL_AVAILABLE_SPACE",
                widgets: [{ textParagraph: { text: "👥 <b>" + allUsers.length + "</b><br><font color=\"#80868B\">Employees</font>" } }]
              },
              {
                horizontalSizeStyle: "FILL_AVAILABLE_SPACE",
                widgets: [{ textParagraph: { text: "🌴 <b>" + totalTeamTaken + "d</b><br><font color=\"#80868B\">Taken in " + year + "</font>" } }]
              },
              {
                horizontalSizeStyle: "FILL_AVAILABLE_SPACE",
                widgets: [{ textParagraph: { text: "⏳ <b>" + totalTeamAvailable + "d</b><br><font color=\"#80868B\">Team Balance</font>" } }]
              },
              {
                horizontalSizeStyle: "FILL_AVAILABLE_SPACE",
                widgets: [{ textParagraph: { text: "📈 <b>" + teamUtilizationRate + "%</b><br><font color=\"#80868B\">Utilization</font>" } }]
              }
            ]
          }
        },
        {
          buttonList: {
            buttons: [
              actionButton_("◀ " + (year - 1), "teamSummary", [{ key: "targetYear", value: String(year - 1) }, { key: "team", value: team }]),
              actionButton_("🟢 " + year + " (Selected)", "teamSummary", [{ key: "targetYear", value: String(year) }, { key: "team", value: team }]),
              actionButton_((year + 1) + " ▶", "teamSummary", [{ key: "targetYear", value: String(year + 1) }, { key: "team", value: team }])
            ]
          }
        },
        { buttonList: { buttons: getConfiguredTeams_().map(function (availableTeam) {
          return actionButton_((availableTeam === team ? "✓ " : "") + availableTeam, "teamSummary", [
            { key: "targetYear", value: String(year) }, { key: "team", value: availableTeam }
          ]);
        }) } }
      ]
    }
  ];

  if (employeeStats.length === 0) {
    sections.push({
      header: "📋 Team Leave Balances (" + year + ")",
      widgets: [{ textParagraph: { text: "<font color=\"#80868B\">No employees currently registered in the <code>BotUsers</code> sheet.</font>" } }]
    });
  } else {
    const employeeWidgets = [];
    employeeStats.forEach(function (emp, index) {
      const isAdmin = (emp.role === "ROLE_ADMIN" || emp.isAdmin === true || emp.role === "Manager");
      const roleBadge = isAdmin
        ? "👑 ROLE_ADMIN"
        : "👤 " + (emp.role || "No team assigned");
      const carryStr = emp.carriedForward > 0 ? ("  |  Carry: <b>" + formatLeaveNum_(emp.carriedForward) + "d</b>") : "";

      employeeWidgets.push({
        decoratedText: {
          text: "<b>" + escapeCardHtml_(emp.name) + "</b>" + " · " + escapeCardHtml_(emp.email) ,
          bottomLabel: "Avail: <b>" + formatLeaveNum_(emp.availableLeaves) + "d</b>  |  Taken: <b>" + formatLeaveNum_(emp.totalDaysTaken) + "d</b>  |  Quota: <b>" + formatLeaveNum_(emp.totalAnnualQuota) + "d</b>" + carryStr + " | " + emp.usagePercentage + "% used",
          button: actionButton_("View Leave Dates", "viewEmployeeSummary", [
            { key: "targetEmail", value: emp.email },
            { key: "targetYear", value: String(year) }
          ])
        }
      });

       if (index < employeeStats.length - 1) {
          employeeWidgets.push({
            divider: {}
          });
        }
    });

    sections.push({
      header: "👥 Team Members & Balances (" + employeeStats.length + (employeeStats.length === 1 ? " Member" : " Members") + ")",
      widgets: employeeWidgets
    });
  }

  sections.push({
    widgets: [
      getQuickActionChipsWidget_(managerEmail, managerUserId)
    ]
  });

  return {
    cardsV2: [{
      cardId: "managerTeamSummary",
      card: {
        header: {
          title: "📊 " + escapeCardHtml_(team) + " Leave Summary (" + year + ")",
          subtitle: "Team: " + escapeCardHtml_(team) + " · Admin Executive Dossier · Pixcity"
        },
        sections: sections
      }
    }]
  };
}

function getManagerEmployeeDossierCard_(targetEmail, targetName, targetYear, managerEmail, managerUserId) {
  const normEmail = normalizeEmail_(targetEmail);
  const year = Number(targetYear) || new Date().getFullYear();
  const requestData = getRequestDataForUser_(normEmail);
  const cols = getRequestColumns_(requestData[0] || []);
  const allHolidays = getHolidayDates_();

  const botUserData = getEmployeeBotUserData_(normEmail) || {};
  const resolvedName = targetName || botUserData.name || normEmail.split("@")[0];
  const role = botUserData.role || "";

  const balance = getEmployeeLeaveBalanceDetails_(
    normEmail, year, requestData, allHolidays, cols
  );

  const availableLeaves = balance ? balance.availableLeaves : (CONFIG.DEFAULT_TOTAL_LEAVES || 20);
  const quota = balance ? balance.totalAnnualQuota : (CONFIG.DEFAULT_TOTAL_LEAVES || 20);
  const carry = balance ? balance.carriedForward : 0;
  const taken = balance ? balance.totalDaysTaken : 0;
  const approvedLeaves = balance ? balance.approvedLeaves : [];

  let carryNote = "";
  if (carry > 0) {
    if (balance.isPastExpiry) {
      carryNote = "Carried-over leaves expired on " + balance.expiryFormatted;
    } else {
      carryNote = "Includes " + balance.remainingCarryForward + " carry-over days (valid until " + balance.expiryFormatted + ")";
    }
  } else {
    carryNote = (quota > 0 ? Math.round((taken / quota) * 100) : 0) + "% of annual quota utilized";
  }

  const sections = [
    {
      header: "📊 Leave Balance Overview (" + year + ")",
      widgets: [
        {
          decoratedText: {
            topLabel: "AVAILABLE LEAVE (" + year + ")",
            text: "<b>" + availableLeaves + " working days</b>",
            bottomLabel: carryNote
          }
        },
        {
          columns: {
            columnItems: [
              {
                horizontalSizeStyle: "FILL_AVAILABLE_SPACE",
                widgets: [{ textParagraph: { text: "📋 <b>" + quota + "</b><br><font color=\"#80868B\">Annual Quota</font>" } }]
              },
              {
                horizontalSizeStyle: "FILL_AVAILABLE_SPACE",
                widgets: [{ textParagraph: { text: "🔄 <b>" + carry + "</b><br><font color=\"#80868B\">Carried Over</font>" } }]
              },
              {
                horizontalSizeStyle: "FILL_AVAILABLE_SPACE",
                widgets: [{ textParagraph: { text: "🌴 <b>" + taken + "</b><br><font color=\"#80868B\">Taken in " + year + "</font>" } }]
              }
            ]
          }
        },
        {
          buttonList: {
            buttons: [
              actionButton_("◀ " + (year - 1), "viewEmployeeSummary", [
                { key: "targetEmail", value: normEmail },
                { key: "targetYear", value: String(year - 1) }
              ]),
              actionButton_("🟢 " + year, "viewEmployeeSummary", [
                { key: "targetEmail", value: normEmail },
                { key: "targetYear", value: String(year) }
              ]),
              actionButton_((year + 1) + " ▶", "viewEmployeeSummary", [
                { key: "targetEmail", value: normEmail },
                { key: "targetYear", value: String(year + 1) }
              ]),
              actionButton_("📋 Team Summary Table", "teamSummary", [
                { key: "targetYear", value: String(year) }
              ])
            ]
          }
        }
      ]
    }
  ];

  const leaveWidgets = [];
  if (approvedLeaves.length === 0) {
    leaveWidgets.push({
      textParagraph: {
        text: "🎉 <font color=\"#80868B\">No approved leaves taken by <b>" + escapeCardHtml_(resolvedName) + "</b> in " + year + ".</font>"
      }
    });
  } else {
    approvedLeaves.forEach(function (leave, idx) {
      const typeBadge = leave.leaveType === "HALF DAY" ? "Half Day" : "Full Day";
      const daysText = leave.daysInYear + " " + (leave.daysInYear === 1 ? "working day" : "working days");
      leaveWidgets.push({
        decoratedText: {
          topLabel: "RECORD #" + (idx + 1) + " · 🌴 " + typeBadge.toUpperCase() + " · " + daysText,
          text: "<b>" + escapeCardHtml_(leave.date) + "</b>",
          bottomLabel: leave.reason ? "Reason: " + escapeCardHtml_(leave.reason) : "Approved leave"
        }
      });
    });
  }

  sections.push({
    header: "📅 Dates of Approved Leaves in " + year + " (" + taken + " days total · " + approvedLeaves.length + " records)",
    widgets: leaveWidgets
  });

  sections.push({
    widgets: [
      getQuickActionChipsWidget_(managerEmail, managerUserId)
    ]
  });

  return {
    cardsV2: [{
      cardId: "managerEmployeeDossier",
      card: {
        header: {
          title: "👤 " + escapeCardHtml_(resolvedName) + " — Leave Dossier",
          subtitle: escapeCardHtml_(normEmail)
        },
        sections: sections
      }
    }]
  };
}

/**
 * =========================================================
 * EMPLOYEE LEAVE REQUESTS & CANCELLATION (FEATURES 1 & 2)
 * =========================================================
 */
function getMyLeaveRequestsCard_(userEmail, userName, userId) {
  const normEmail = normalizeEmail_(userEmail);
  if (!normEmail) {
    return infoCard_("My Leave Requests", "Could not identify your email address. Please make sure your email is configured in your profile or the BotUsers sheet.", { userEmail: userEmail, userId: userId });
  }

  const data = getRequestDataForUser_(normEmail);
  if (!data || data.length < 2) {
    return {
      cardsV2: [{
        cardId: "myLeaveRequests",
        card: {
          header: {
            title: "📋 My Leave Requests",
            subtitle: "Status & History · " + (userName || "Employee")
          },
          sections: [
            {
              widgets: [
                { textParagraph: { text: "🎉 <font color=\"#80868B\">No leave requests found. You have not submitted any leave requests yet.</font>" } },
                getQuickActionChipsWidget_(userEmail, userId)
              ]
            }
          ]
        }
      }]
    };
  }

  const cols = getRequestColumns_(data[0]);
  const userRequests = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (normalizeEmail_(row[cols.email - 1]) === normEmail) {
      userRequests.push({
        row: i + 1,
        requestId: String(row[cols.requestId - 1] || "").trim(),
        employee: String(row[cols.employee - 1] || userName || "").trim(),
        email: normEmail,
        date: String(row[cols.date - 1] || "").trim(),
        leaveType: String(row[cols.leaveType - 1] || "FULL DAY").trim().toUpperCase(),
        days: cols.days > 0 ? Number(row[cols.days - 1] || 0) : 0,
        reason: String(row[cols.reason - 1] || "").trim(),
        approvals: cols.approvals > 0 ? String(row[cols.approvals - 1] || "").trim() : "",
        finalStatus: String(row[cols.final - 1] || "PENDING").trim().toUpperCase()
      });
    }
  }

  if (userRequests.length === 0) {
    return {
      cardsV2: [{
        cardId: "myLeaveRequests",
        card: {
          header: {
            title: "📋 My Leave Requests",
            subtitle: "Status & History · " + (userName || "Employee")
          },
          sections: [
            {
              widgets: [
                { textParagraph: { text: "🎉 <font color=\"#80868B\">No leave requests found for <b>" + escapeCardHtml_(normEmail) + "</b>.</font>" } },
                getQuickActionChipsWidget_(userEmail, userId)
              ]
            }
          ]
        }
      }]
    };
  }

  // Show newest requests first
  userRequests.reverse();
  const displayRequests = userRequests.slice(0, 15);

  const requestWidgets = [];
  displayRequests.forEach(function (req, index) {
    const isPending = req.finalStatus === "PENDING";
    const isApproved = req.finalStatus === "APPROVED";
    const isRejected = req.finalStatus === "REJECTED";
    const isCancelled = req.finalStatus === "CANCELLED";

    let statusBadge = "🟡 PENDING APPROVAL";
    if (isApproved) statusBadge = "🟢 APPROVED";
    else if (isRejected) statusBadge = "🔴 REJECTED";
    else if (isCancelled) statusBadge = "⚪ CANCELLED";

    const typeBadge = req.leaveType === "HALF DAY" ? "Half Day" : "Full Day";
    const daysLabel = req.days > 0 ? (req.days + (req.days === 1 ? " working day" : " working days")) : "";

    let bottomDetail = "";
    if (req.reason) {
      bottomDetail += "Reason: " + escapeCardHtml_(req.reason) + "<br>";
    }
    if (isPending) {
      bottomDetail += "<font color=\"#E37400\">" + (req.approvals ? escapeCardHtml_(req.approvals) : "Pending Review") + "</font>";
    } else if (isApproved) {
      bottomDetail += "<font color=\"#137333\">Approved</font> · <font color=\"#80868B\"><small>To cancel, contact your manager</small></font>";
    } else if (isRejected) {
      bottomDetail += "<font color=\"#C5221F\">" + (req.approvals ? escapeCardHtml_(req.approvals) : "Rejected") + "</font>";
    } else if (isCancelled) {
      bottomDetail += "<font color=\"#80868B\">Cancelled</font>";
    }

    const widgetObj = {
      decoratedText: {
        topLabel: statusBadge + " · " + typeBadge + (daysLabel ? " · " + daysLabel : "") + " · ID: " + escapeCardHtml_(req.requestId),
        text: "<b>" + escapeCardHtml_(req.date) + "</b>",
        bottomLabel: bottomDetail
      }
    };

    // If pending, allow employee to cancel right from this card!
    if (isPending) {
      widgetObj.decoratedText.button = actionButton_("❌ Cancel", "cancelLeaveRequest", [
        { key: "requestId", value: req.requestId }
      ]);
    }

    requestWidgets.push(widgetObj);
   
    if (index < displayRequests.length - 1) {
         requestWidgets.push({ divider: {} });
    }
    
  });

  const sections = [
    {
      header: "📋 Your Applied Leaves (" + userRequests.length + (userRequests.length === 1 ? " Request" : " Requests") + ")",
      widgets: requestWidgets
    },
    {
      widgets: [
        {
          textParagraph: {
            text: "<font color=\"#80868B\"><small>💡 <b>Cancellation Policy:</b> You can cancel any <b>PENDING</b> request directly using the <b>Cancel</b> button or typing <code>cancel [Request-ID]</code>. If a request has already been <b>APPROVED</b>, please contact your manager to cancel it.</small></font>"
          }
        },
        getQuickActionChipsWidget_(userEmail, userId)
      ]
    }
  ];

  return {
    cardsV2: [{
      cardId: "myLeaveRequests",
      card: {
        header: {
          title: "📋 My Leave Requests",
          subtitle: "Status & History · " + (userName || "Employee")
        },
        sections: sections
      }
    }]
  };
}

function handleCancelLeaveRequest_(requestId, userEmail, userName, userId) {
  const normEmail = normalizeEmail_(userEmail);
  if (!requestId) {
    return infoCard_("Cancel Request Error", "Please specify a valid request ID to cancel, e.g. <code>cancel LR-123456</code>.", { userEmail: userEmail, userId: userId });
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    const request = getRequestById_(requestId);
    if (!request) {
      return infoCard_("Request Not Found", "Could not find leave request with ID: <code>" + escapeCardHtml_(requestId) + "</code>.", { userEmail: userEmail, userId: userId });
    }

    const requesterEmail = normalizeEmail_(request.requesterEmail);
    const isRequester = (normEmail && requesterEmail === normEmail);
    const userIsAdmin = isAdmin_(userEmail, userId);

    if (!isRequester && !userIsAdmin) {
      return infoCard_("Not Authorized", "🔒 You are only authorized to cancel your own leave requests.", { userEmail: userEmail, userId: userId });
    }

    const curStatus = String(request.finalStatus || "").trim().toUpperCase();

    if (curStatus === "CANCELLED") {
      return infoCard_(
        "Already Cancelled",
        "Leave request <b>" + escapeCardHtml_(requestId) + "</b> for <b>" + escapeCardHtml_(request.leaveDate) + "</b> has already been cancelled.",
        { userEmail: userEmail, userId: userId }
      );
    }

    if (curStatus === "REJECTED") {
      return infoCard_(
        "Cannot Cancel Rejected Request",
        "Leave request <b>" + escapeCardHtml_(requestId) + "</b> was already rejected and cannot be cancelled.",
        { userEmail: userEmail, userId: userId }
      );
    }

    if (curStatus === "APPROVED") {
      if (!userIsAdmin) {
        return {
          cardsV2: [{
            cardId: "cannotCancelApprovedCard",
            card: {
              header: {
                title: "🔒 Cannot Cancel Approved Leave",
                subtitle: "Manager Assistance Required"
              },
              sections: [
                {
                  widgets: [
                    {
                      decoratedText: {
                        topLabel: "REQUEST ID: " + escapeCardHtml_(requestId),
                        text: "<b>" + escapeCardHtml_(request.leaveDate) + "</b> (" + escapeCardHtml_(request.leaveType || "FULL DAY") + ")",
                        bottomLabel: "Status: 🟢 APPROVED (" + (request.days || "") + " working days)"
                      }
                    },
                    {
                      textParagraph: {
                        text: "This leave request has already been <b>fully approved</b> and booked into the tracker.<br><br>" +
                              "⚠️ <b>Employees cannot self-cancel approved leaves.</b><br><br>" +
                              "Please speak with your manager or workspace administrator (<b>ROLE_ADMIN</b>) to cancel this approved leave."
                      }
                    },
                    getQuickActionChipsWidget_(userEmail, userId)
                  ]
                }
              ]
            }
          }]
        };
      }
      // If userIsAdmin === true, admin override is permitted!
    }

    // Cancel the request in the Requests sheet
    const sheetData = getSheetData_(request.sheetName);
    const cols = getRequestColumns_(sheetData[0]);
    const row = request.row;
    const currentApprovalsText = String((sheetData[row - 1] && sheetData[row - 1][cols.approvals - 1]) || "");

    const actorRole = (userIsAdmin && !isRequester) ? "Admin" : "Employee";
    const cancelNote = "CANCELLED by " + actorRole + " " + (userName ? (userName + " (" + (userEmail || normEmail) + ")") : (userEmail || normEmail));
    const newApprovals = currentApprovalsText ? (currentApprovalsText + " | " + cancelNote) : cancelNote;

    setSheetCell_(request.sheetName, row, cols.approvals, newApprovals);
    setSheetCell_(request.sheetName, row, cols.final, "CANCELLED");

    return {
      cardsV2: [{
        cardId: "leaveCancelledCard",
        card: {
          header: {
            title: "✅ Leave Request Cancelled",
            subtitle: "Request ID: " + escapeCardHtml_(requestId)
          },
          sections: [
            {
              widgets: [
                {
                  decoratedText: {
                    topLabel: "CANCELLED REQUEST",
                    text: "<b>" + escapeCardHtml_(request.leaveDate) + "</b> (" + (request.leaveType || "FULL DAY") + ")",
                    bottomLabel: "Employee: " + escapeCardHtml_(request.requesterName) + " · " + (request.days || "") + " working days"
                  }
                },
                {
                  textParagraph: {
                    text: "The leave request for <b>" + escapeCardHtml_(request.leaveDate) + "</b> has been successfully <b>cancelled</b>.<br><br>" +
                          "🎉 No days will be deducted from your annual leave balance."
                  }
                },
                getQuickActionChipsWidget_(userEmail, userId)
              ]
            }
          ]
        }
      }]
    };
  } catch (err) {
    console.error("handleCancelLeaveRequest_ error: " + err);
    return infoCard_("Error", "An error occurred while cancelling your leave request: " + err, { userEmail: userEmail, userId: userId });
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

/**
 * =========================================================
 * APPROVER PENDING REQUESTS DASHBOARD (FEATURE 3)
 * =========================================================
 */
function getPendingApprovalsCard_(approverEmail, approverName, approverUserId) {
  const normApproverEmail = normalizeEmail_(approverEmail);
  const userIsAdmin = isAdmin_(approverEmail, approverUserId);
  const userIsApprover = isApprover_(approverEmail, approverUserId);

  if (!userIsApprover && !userIsAdmin) {
    return getAdminAccessDeniedCard_(approverName, approverEmail, approverUserId);
  }

  const data = [];
  getAllTeamRequestSheets_().forEach(function (entry) {
    const rows = getTeamRequestData_(entry.team);
    if (rows && rows.length > 1) {
      rows.slice(1).forEach(function (row, idx) { data.push({ row: row, team: entry.team, sheetName: entry.sheetName, rowNumber: idx + 2, headers: rows[0] }); });
    }
  });
  if (data.length === 0) {
    return {
      cardsV2: [{
        cardId: "pendingApprovalsCard",
        card: {
          header: {
            title: "⏳ Pending Approvals",
            subtitle: "Approver Dashboard · " + (approverName || "Approver")
          },
          sections: [
            {
              widgets: [
                { textParagraph: { text: "🎉 <b>All caught up!</b><br><br><font color=\"#80868B\">There are no leave requests currently waiting for approval.</font>" } },
                getQuickActionChipsWidget_(approverEmail, approverUserId)
              ]
            }
          ]
        }
      }]
    };
  }

  const pendingRequests = [];

  for (let i = 0; i < data.length; i++) {
    const entry = data[i];
    const row = entry.row;
    const cols = getRequestColumns_(entry.headers);
    if (!isTeamApprover_(approverEmail, approverUserId, entry.team)) continue;
    const status = String(row[cols.final - 1] || "").trim().toUpperCase();
    if (status !== "PENDING") continue;

    const reqId = String(row[cols.requestId - 1] || "").trim();
    const reqEmail = normalizeEmail_(row[cols.email - 1]);
    const reqName = String(row[cols.employee - 1] || "Employee").trim();
    const leaveDate = String(row[cols.date - 1] || "").trim();
    const leaveType = String(row[cols.leaveType - 1] || "FULL DAY").trim().toUpperCase();
    const days = cols.days > 0 ? Number(row[cols.days - 1] || 0) : 0;
    const reason = String(row[cols.reason - 1] || "").trim();
    const approvalsText = cols.approvals > 0 ? String(row[cols.approvals - 1] || "").trim() : "";

    // Check if this approver has already approved
    const approvedEmails = parseApprovedEmails_(approvalsText);
    if (normApproverEmail && approvedEmails.includes(normApproverEmail)) {
      continue; // This approver already approved it
    }

    // Check if the requester is this approver (self-approval already handled)
    if (normApproverEmail && reqEmail === normApproverEmail) {
      continue;
    }

    pendingRequests.push({
      team: entry.team,
      requestId: reqId,
      requesterName: reqName,
      requesterEmail: reqEmail,
      leaveDate: leaveDate,
      leaveType: leaveType,
      days: days,
      reason: reason,
      approvals: approvalsText,
      row: i + 1
    });
  }

  if (pendingRequests.length === 0) {
    return {
      cardsV2: [{
        cardId: "pendingApprovalsCard",
        card: {
          header: {
            title: "⏳ Pending Approvals",
            subtitle: "Approver Dashboard · " + (approverName || "Approver")
          },
          sections: [
            {
              widgets: [
                { textParagraph: { text: "🎉 <b>All caught up!</b><br><br><font color=\"#80868B\">There are no leave requests currently waiting for your approval.</font>" } },
                getQuickActionChipsWidget_(approverEmail, approverUserId)
              ]
            }
          ]
        }
      }]
    };
  }

  // Show newest first
  pendingRequests.reverse();

  const sections = [];
  sections.push({
    header: "⏳ Requests Waiting For Your Approval (" + pendingRequests.length + ")",
    widgets: [
      {
        textParagraph: {
          text: "<font color=\"#80868B\">You have <b>" + pendingRequests.length + "</b> leave " + (pendingRequests.length === 1 ? "request" : "requests") + " awaiting review. Click <b>Approve</b> or <b>Reject</b> on each item:</font>"
        }
      }
    ]
  });

  pendingRequests.forEach(function (req) {
    const typeBadge = req.leaveType === "HALF DAY" ? "Half Day" : "Full Day";
    const daysLabel = req.days > 0 ? (req.days + (req.days === 1 ? " working day" : " working days")) : "";
    let bottomText = "";
    if (req.reason) {
      bottomText += "Reason: " + escapeCardHtml_(req.reason) + "<br>";
    }
    bottomText += "<font color=\"#80868B\">" + escapeCardHtml_(req.approvals || "Waiting for approval") + "</font>";

    sections.push({
      widgets: [
        {
          decoratedText: {
            topLabel: "🌴 " + escapeCardHtml_(req.team) + " · " + typeBadge.toUpperCase() + (daysLabel ? " · " + daysLabel : "") + " · " + escapeCardHtml_(req.requesterEmail),
            text: "<b>" + escapeCardHtml_(req.requesterName) + "</b> — " + escapeCardHtml_(req.leaveDate),
            bottomLabel: bottomText
          }
        },
        {
          buttonList: {
            buttons: [
              cardButton_("✅ Approve", "approve", req.requestId),
              cardButton_("❌ Reject", "reject", req.requestId)
            ]
          }
        }
      ]
    });
  });

  sections.push({
    widgets: [
      getQuickActionChipsWidget_(approverEmail, approverUserId)
    ]
  });

  return {
    cardsV2: [{
      cardId: "pendingApprovalsCard",
      card: {
        header: {
          title: "⏳ Pending Approvals (" + pendingRequests.length + ")",
          subtitle: "Approver Dashboard · Pixcity Leave Tracker"
        },
        sections: sections
      }
    }]
  };
}

/**
 * =========================================================
 * CALENDAR & UPCOMING SCHEDULE
 * =========================================================
 */
function getApprovedLeaveEntries_(startDate, endDate, holidayDates, team) {
  const data = getTeamRequestData_(team || getConfiguredTeams_()[0]);
  if (!data || data.length < 2) return [];
  const cols = getRequestColumns_(data[0]);

  const entries = [];
  const seenKey = {};
  const holidays = Array.isArray(holidayDates) ? holidayDates : getHolidayDates_();
  const holidayMap = {};
  holidays.forEach(h => { if (h && h.date) holidayMap[formatCalendarDateKey_(h.date)] = true; });

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (String(row[cols.final - 1] || "").trim().toUpperCase() !== "APPROVED") continue;

    const employee = String(row[cols.employee - 1] || "Employee").trim();
    const leaveInput = String(row[cols.date - 1] || "").trim();
    const leaveType = String(row[cols.leaveType - 1] || "FULL DAY").trim().toUpperCase();
    const leaveReason = String(row[cols.reason - 1] || "").trim();
    if (!leaveInput) continue;

    const parts = leaveInput.split("-");
    const start = parseLeaveDate_(parts[0].trim());
    const end = parts.length > 1 ? parseLeaveDate_(parts[1].trim()) : new Date(start);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) continue;

    const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const stop = new Date(end.getFullYear(), end.getMonth(), end.getDate());

    while (cur.getTime() <= stop.getTime()) {
      const dateOnly = new Date(cur);
      dateOnly.setHours(0, 0, 0, 0);
      cur.setDate(cur.getDate() + 1);

      if (dateOnly < startDate || dateOnly > endDate) continue;
      if (dateOnly.getDay() === 0 || dateOnly.getDay() === 6) continue;

      const dateKey = formatCalendarDateKey_(dateOnly);
      if (holidayMap[dateKey]) continue;

      const uniqueEntryKey = employee.toLowerCase() + "_" + dateKey + "_" + leaveType;
      if (seenKey[uniqueEntryKey]) continue;
      seenKey[uniqueEntryKey] = true;

      entries.push({
        date: new Date(dateOnly),
        employee: employee,
        leaveType: leaveType,
        leaveReason: leaveReason,
        requestId: String(row[cols.requestId - 1] || "")
      });
    }
  }
  entries.sort((a, b) => a.date.getTime() - b.date.getTime() || a.employee.localeCompare(b.employee));
  return entries;
}

function escapeCardHtml_(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatCalendarDateKey_(date) {
  if (!date || !(date instanceof Date) || isNaN(date.getTime())) return "";
  return date.getFullYear() + "-" + ("0" + (date.getMonth() + 1)).slice(-2) + "-" + ("0" + date.getDate()).slice(-2);
}

function calendarNavButton_(label, targetOffset, team) {
  return {
    text: label,
    onClick: {
      action: {
        function: "onCardClick",
        parameters: [
          { key: "action", value: "navigateCalendar" },
          { key: "monthOffset", value: String(targetOffset) },
          { key: "team", value: normalizeTeam_(team || getConfiguredTeams_()[0]) }
        ]
      }
    }
  };
}

function getApprovedLeaveCalendarCard_(monthOffset, userEmail, userId, selectedTeam) {
  const team = normalizeTeam_(selectedTeam || getUserTeam_(userEmail) || getConfiguredTeams_()[0]);
  const offset = Number(monthOffset) || 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const monthStart = new Date(today.getFullYear(), today.getMonth() + offset, 1);
  const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0, 23, 59, 59, 999);
  const prevMonth = new Date(today.getFullYear(), today.getMonth() + offset - 1, 1);
  const nextMonth = new Date(today.getFullYear(), today.getMonth() + offset + 1, 1);

  const timezone = Session.getScriptTimeZone();
  const monthTitle = Utilities.formatDate(monthStart, timezone, "MMMM yyyy");

  const allHolidays = getHolidayDates_();
  const monthHolidays = allHolidays.filter(h => h.date >= monthStart && h.date <= monthEnd).sort((a, b) => a.date.getTime() - b.date.getTime());
  const leaveEntries = getApprovedLeaveEntries_(monthStart, monthEnd, allHolidays, team);

  const leavesByDate = {};
  leaveEntries.forEach(entry => {
    const key = formatCalendarDateKey_(entry.date);
    if (!leavesByDate[key]) leavesByDate[key] = [];
    leavesByDate[key].push(entry);
  });

  const holidaysByDate = {};
  monthHolidays.forEach(h => { holidaysByDate[formatCalendarDateKey_(h.date)] = h; });

  const markedDayKeys = Object.keys(Object.assign({}, leavesByDate, holidaysByDate)).sort();

  const sections = [{
    header: "🗓️ " + monthTitle + " Calendar",
    widgets: [
      {
        textParagraph: {
          text: "<font color=\"#80868B\">🌴 " + escapeCardHtml_(team) + ": " + leaveEntries.length + " leave entries · 🎊 " + monthHolidays.length + " holidays</font>"
        }
      },
      {
        buttonList: {
          buttons: [
            calendarNavButton_("◀ " + Utilities.formatDate(prevMonth, timezone, "MMM yyyy"), offset - 1, team),
            calendarNavButton_("🟢 Today", 0, team),
            calendarNavButton_(Utilities.formatDate(nextMonth, timezone, "MMM yyyy") + " ▶", offset + 1, team)
          ]
        }
      }
    ]
  }];

  if (markedDayKeys.length === 0) {
    sections.push({
      header: "🎉 Full Team Available",
      widgets: [{ textParagraph: { text: "<font color=\"#80868B\">No leaves or holidays scheduled for " + monthTitle + ".</font>" } }]
    });
  } else {
    markedDayKeys.forEach(key => {
      const parts = key.split("-");
      const dateObj = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      const dateFormatted = Utilities.formatDate(dateObj, timezone, "EEE, dd MMM yyyy");
      const dayHoliday = holidaysByDate[key];
      const dayLeaves = leavesByDate[key] || [];

      const items = [];
      dayLeaves.forEach(leave => {
        const typeBadge = leave.leaveType === "HALF DAY" ? "Half Day" : "Full Day";
        let desc = "🌴 <b>" + escapeCardHtml_(leave.employee) + "</b> (" + typeBadge + ")";
        if (leave.leaveReason) desc += "<br><font color=\"#80868B\">↳ Reason: " + escapeCardHtml_(leave.leaveReason) + "</font>";
        items.push(desc);
      });
      if (dayHoliday) items.push("🎊 <b>" + escapeCardHtml_(dayHoliday.name) + "</b> (Company Holiday)");

      if (items.length > 0) {
        sections.push({
          header: "📅 " + dateFormatted,
          widgets: [{ textParagraph: { text: items.join("<br><br>") } }]
        });
      }
    });
  }

  sections.push({ header: "👥 Choose Team", widgets: [{ buttonList: { buttons: getConfiguredTeams_().map(function (availableTeam) { return actionButton_((availableTeam === team ? "✓ " : "") + availableTeam, "selectCalendarTeam", [{ key: "monthOffset", value: String(offset) }, { key: "team", value: availableTeam }]); }) } }] });
  sections.push({ widgets: [getQuickActionChipsWidget_(userEmail, userId)] });

  return {
    cardsV2: [{
      cardId: "approvedLeaveCalendar",
      card: {
        header: { title: "🗓️ " + escapeCardHtml_(team) + " Leave Calendar", subtitle: monthTitle },
        sections: sections
      }
    }]
  };
}

function getUpcomingApprovedLeavesCard_(userEmail, userId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() + 90);
  const timezone = Session.getScriptTimeZone();

  const allHolidays = getHolidayDates_();
  const upcomingHolidays = allHolidays.filter(h => h.date >= today && h.date <= endDate).sort((a, b) => a.date.getTime() - b.date.getTime());
  const team = getUserTeam_(userEmail) || getConfiguredTeams_()[0];
  const leaveEntries = getApprovedLeaveEntries_(today, endDate, allHolidays, team);

  const leavesByDate = {};
  leaveEntries.forEach(entry => {
    const key = formatCalendarDateKey_(entry.date);
    if (!leavesByDate[key]) leavesByDate[key] = [];
    leavesByDate[key].push(entry);
  });

  const holidaysByDate = {};
  upcomingHolidays.forEach(h => { holidaysByDate[formatCalendarDateKey_(h.date)] = h; });

  const allKeys = Object.keys(Object.assign({}, leavesByDate, holidaysByDate)).sort();
  const widgets = [];

  if (allKeys.length === 0) {
    widgets.push({ textParagraph: { text: "🎉 <font color=\"#80868B\">No leave or holidays scheduled in next 90 days.</font>" } });
  } else {
    allKeys.forEach(key => {
      const parts = key.split("-");
      const dateObj = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      const dateFormatted = Utilities.formatDate(dateObj, timezone, "EEE, dd MMM yyyy");
      const h = holidaysByDate[key];
      const leaves = leavesByDate[key] || [];

      if (h) {
        widgets.push({
          decoratedText: { topLabel: "🎊 " + dateFormatted.toUpperCase(), text: "<b>" + h.name + "</b>", bottomLabel: "Company Holiday" }
        });
      }
      leaves.forEach(leave => {
        const typeBadge = leave.leaveType === "HALF DAY" ? "Half Day" : "Full Day";
        widgets.push({
          decoratedText: {
            topLabel: "🌴 " + dateFormatted.toUpperCase(),
            text: "<b>" + leave.employee + "</b> (" + typeBadge + ")",
            bottomLabel: leave.leaveReason ? "Reason: " + leave.leaveReason : "Leave approved"
          }
        });
      });
    });
  }

  return {
    cardsV2: [{
      cardId: "upcomingApprovedLeave",
      card: {
        header: { title: "📅 Upcoming Team Schedule", subtitle: "Next 90 days" },
        sections: [
          { header: "📅 Schedule (" + allKeys.length + " dates)", widgets: widgets },
          { widgets: [getQuickActionChipsWidget_(userEmail, userId)] }
        ]
      }
    }]
  };
}

/**
 * =========================================================
 * LEAVE DAYS COMPUTATION
 * =========================================================
 */
function getLeaveCalculationDetails_(leaveDate, leaveType, holidayDates, targetYear) {
  const normalizedType = String(leaveType || "FULL DAY").toUpperCase().trim();
  const isHalfDay = /^(HALF DAY|FIRST HALF|SECOND HALF)$/i.test(normalizedType);
  const filterYear = targetYear ? Number(targetYear) : null;

  const holidays = Array.isArray(holidayDates) ? holidayDates : getHolidayDates_();
  const holidayMap = {};
  holidays.forEach(h => { if (h && h.date) holidayMap[formatCalendarDateKey_(h.date)] = h.name || "Company Holiday"; });

  const dates = String(leaveDate || "").split("-");
  if (!dates[0] || !dates[0].trim()) {
    return { workingDays: 0, breakdownText: "0 days", breakdownNote: "", weekendDays: 0, holidayDays: 0, holidayNames: [] };
  }

  const start = parseLeaveDate_(dates[0].trim());
  const end = dates.length > 1 ? parseLeaveDate_(dates[1].trim()) : new Date(start);

  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) {
    return { workingDays: 0, breakdownText: "0 days", breakdownNote: "", weekendDays: 0, holidayDays: 0, holidayNames: [] };
  }

  if (isHalfDay) {
    if (filterYear && start.getFullYear() !== filterYear) {
      return { workingDays: 0, breakdownText: "0 days", breakdownNote: "", weekendDays: 0, holidayDays: 0, holidayNames: [] };
    }
    const dayOfWeek = start.getDay();
    const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
    const dateKey = formatCalendarDateKey_(start);
    const holidayName = holidayMap[dateKey];

    if (isWeekend) {
      return {
        workingDays: 0,
        breakdownText: "0 days (falls on weekend)",
        breakdownNote: "falls on weekend",
        weekendDays: 1,
        holidayDays: holidayName ? 1 : 0,
        holidayNames: holidayName ? [holidayName] : []
      };
    }
    if (holidayName) {
      return {
        workingDays: 0,
        breakdownText: "0 days (falls on holiday: " + holidayName + ")",
        breakdownNote: "falls on holiday: " + holidayName,
        weekendDays: 0,
        holidayDays: 1,
        holidayNames: [holidayName]
      };
    }
    return {
      workingDays: 0.5,
      breakdownText: "0.5 working day (Half Day)",
      breakdownNote: "Half Day",
      weekendDays: 0,
      holidayDays: 0,
      holidayNames: []
    };
  }

  let workingDays = 0;
  let weekendDays = 0;
  let holidayDays = 0;
  const holidayNames = [];

  const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const stop = new Date(end.getFullYear(), end.getMonth(), end.getDate());

  while (cur.getTime() <= stop.getTime()) {
    if (!filterYear || cur.getFullYear() === filterYear) {
      const dayOfWeek = cur.getDay();
      const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
      const dateKey = formatCalendarDateKey_(cur);
      const holidayName = holidayMap[dateKey];

      if (isWeekend) {
        weekendDays++;
        if (holidayName && !holidayNames.includes(holidayName)) {
          holidayNames.push(holidayName);
        }
      } else if (holidayName) {
        holidayDays++;
        if (!holidayNames.includes(holidayName)) {
          holidayNames.push(holidayName);
        }
      } else {
        workingDays++;
      }
    }
    cur.setDate(cur.getDate() + 1);
  }

  const excludedParts = [];
  if (weekendDays > 0) excludedParts.push(weekendDays + (weekendDays === 1 ? " weekend day" : " weekend days"));
  if (holidayDays > 0) excludedParts.push(holidayDays + (holidayDays === 1 ? " holiday" : " holidays"));

  const breakdownNote = excludedParts.length > 0 ? "excludes " + excludedParts.join(", ") : "";
  const dayUnit = workingDays === 1 ? "working day" : "working days";

  return {
    workingDays: workingDays,
    breakdownText: workingDays + " " + dayUnit + (breakdownNote ? " (" + breakdownNote + ")" : ""),
    breakdownNote: breakdownNote,
    weekendDays: weekendDays,
    holidayDays: holidayDays,
    holidayNames: holidayNames
  };
}


function getLeaveDays_(leaveDate, leaveType, targetYear, holidayDates) {
  return getLeaveCalculationDetails_(leaveDate, leaveType, holidayDates, targetYear).workingDays;
}

function getLeaveDaysInYear_(leaveDate, leaveType, targetYear, holidayDates) {
  return getLeaveCalculationDetails_(leaveDate, leaveType, holidayDates, targetYear).workingDays;
}

/**
 * =========================================================
 * HOLIDAYS
 * =========================================================
 */
function getUpcomingHolidaysCard(userEmail, userId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const holidays = getHolidayDates_().filter(h => h.date >= today).sort((a, b) => a.date.getTime() - b.date.getTime());

  if (holidays.length === 0) return infoCard_("Upcoming Holidays", "🎉 No upcoming holidays found.", { userEmail: userEmail, userId: userId });

  const timezone = Session.getScriptTimeZone();
  const nextHoliday = holidays[0];
  const nextDateFormatted = Utilities.formatDate(nextHoliday.date, timezone, "EEE, dd MMM yyyy");
  const remainingHolidays = holidays.slice(1, 7);
  const upcomingWidgets = [];

  remainingHolidays.forEach(holiday => {
    const date = Utilities.formatDate(holiday.date, timezone, "dd MMM");
    const day = Utilities.formatDate(holiday.date, timezone, "EEE");
    upcomingWidgets.push({
      textParagraph: { text: "<b>" + date + "</b>  <font color=\"#80868B\">" + day + "</font>  —  <b>" + holiday.name + "</b>" }
    });
  });

  const sections = [
    {
      widgets: [{
        textParagraph: {
          text: "<b>NEXT HOLIDAY</b><br>🎊 <b>" + nextHoliday.name + "</b><br><font color=\"#80868B\">" + nextDateFormatted + "</font>"
        }
      }]
    }
  ];

  if (remainingHolidays.length > 0) {
    sections.push({ header: "MORE HOLIDAYS", widgets: upcomingWidgets });
  }

  sections.push({ widgets: [getQuickActionChipsWidget_(userEmail, userId)] });

  return {
    cardsV2: [{
      cardId: "upcomingHolidays",
      card: {
        header: { title: "🎉 Upcoming Holidays", subtitle: holidays.length + " upcoming holidays" },
        sections: sections
      }
    }]
  };
}


/**
 * =========================================================
 * COMPANY HOLIDAY REMINDERS
 * Sends reminders 3 days and 1 day before each holiday.
 * =========================================================
 */
function sendHolidayReminders() {
  const timezone = Session.getScriptTimeZone();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const todayKey = Utilities.formatDate(today, timezone, "yyyy-MM-dd");
  const holidays = getHolidayDates_();
  const users = getAllBotUsers_();
  const properties = PropertiesService.getScriptProperties();

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  if (!holidays.length) {
    console.log("Holiday reminders: no holidays found.");
    return;
  }

  if (!users.length) {
    console.log("Holiday reminders: no registered users found.");
    return;
  }

  holidays.forEach(function (holiday) {
    const holidayDate = new Date(holiday.date.getTime());
    holidayDate.setHours(0, 0, 0, 0);

    const daysUntil = Math.round(
      (holidayDate.getTime() - today.getTime()) / 86400000
    );

    // Only send reminders 3 days and 1 day before a holiday.
    if (daysUntil !== 3 && daysUntil !== 1) return;

    const holidayDateKey = Utilities.formatDate(
      holidayDate, timezone, "yyyy-MM-dd"
    );

    const formattedDate = Utilities.formatDate(
      holidayDate, timezone, "EEE, dd MMM yyyy"
    );

    const reminderKey =
      "HOLIDAY_REMINDER_" + holidayDateKey + "_" + daysUntil;

    users.forEach(function (user) {
      if (!user.space) {
        skipped++;
        console.log(
          "Skipping " + user.email + ": no DM Space registered."
        );
        return;
      }

      // Prevent duplicate messages if the function runs more than once.
      const userKey = reminderKey + "_" + user.email;

      if (properties.getProperty(userKey) === todayKey) {
        skipped++;
        return;
      }

      const message = {
        text:
          "🎉 Company Holiday Reminder\n\n" +
          "Hi " + (user.name || "there") + "!\n\n" +
          "📅 " + holiday.name + "\n" +
          "🗓️ Date: " + formattedDate + "\n\n" +
          "⏰ This is a reminder that the company holiday is " +
          (daysUntil === 1 ? "tomorrow" : "in 3 days") +
          ". Enjoy your holiday!"
      };

      try {
        postHolidayReminderMessage_(user.space, message, userKey, todayKey);
        sent++;
      } catch (error) {
        failed++;
        console.error(
          "Failed to send holiday reminder to " + user.email +
          ": " + error
        );
      }
    });
  });

  console.log(
    "Holiday reminders completed. Sent: " + sent +
    ", skipped: " + skipped +
    ", failed: " + failed
  );
}

/**
 * Sends a reminder and records it only after Google Chat accepts it.
 */
function postHolidayReminderMessage_(spaceName, message, userKey, todayKey) {
  if (!spaceName) {
    throw new Error("Missing Google Chat DM space.");
  }

  const service = getChatService_();

  if (!service || !service.hasAccess()) {
    throw new Error("Google Chat service has no access.");
  }

  const response = UrlFetchApp.fetch(
    "https://chat.googleapis.com/v1/" + spaceName + "/messages",
    {
      method: "post",
      contentType: "application/json",
      headers: {
        Authorization: "Bearer " + service.getAccessToken()
      },
      payload: JSON.stringify(message),
      muteHttpExceptions: true
    }
  );

  const status = response.getResponseCode();

  if (status < 200 || status >= 300) {
    throw new Error(
      "Google Chat API returned HTTP " + status + ": " +
      response.getContentText()
    );
  }

  // Record successful delivery to avoid duplicate reminders.
  PropertiesService.getScriptProperties().setProperty(userKey, todayKey);
}

/**
 * Run once manually to install the daily reminder trigger.
 * The trigger runs around 9 AM in the script's timezone.
 */
function installHolidayReminderTrigger() {
  const handler = "sendHolidayReminders";

  // Avoid creating duplicate triggers for this function.
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === handler) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger(handler)
    .timeBased()
    .everyDays(1)
    .atHour(9)
    .create();

  console.log(
    "Holiday reminder trigger installed. " +
    "It will run daily around 9 AM (" +
    Session.getScriptTimeZone() + ")."
  );
}



function getTotalLeaveEntitlement_() {
  const settings = getSettingsValues_();
  const rawValue = Number(settings.TOTAL_LEAVE_ENTITLEMENT);
  return Number.isFinite(rawValue) && rawValue > 0 ? rawValue : (CONFIG.DEFAULT_TOTAL_LEAVES || 20);
}

function getHolidayDates_() {
  if (_cachedHolidays) return _cachedHolidays;
  ensureSheet_(CONFIG.HOLIDAYS_SHEET_NAME, ["Date", "Holiday"]);
  const values = getSheetData_(CONFIG.HOLIDAYS_SHEET_NAME);
  if (values.length < 2) return [];

  const holidays = [];
  values.slice(1).forEach(row => {
    const rawDate = row[0];
    const name = String(row[1] || "").trim();
    if (!rawDate) return;

    let date;
    if (rawDate instanceof Date) {
      date = new Date(rawDate.getTime());
    } else {
      const text = String(rawDate).trim();
      let match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (match) date = new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
      else {
        match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        date = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : new Date(text);
      }
    }
    if (!date || isNaN(date.getTime())) return;
    date.setHours(0, 0, 0, 0);
    holidays.push({ date: date, name: name || "Holiday" });
  });

  _cachedHolidays = holidays;
  return holidays;
}

/**
 * =========================================================
 * OAUTH RESET & AUTHORIZE
 * =========================================================
 */
function resetOAuthTokens() {
  const props = PropertiesService.getScriptProperties();
  try {
    OAuth2.createService("GoogleChat").setPropertyStore(props).reset();
    OAuth2.createService("GoogleSheets").setPropertyStore(props).reset();
    Logger.log("OAuth tokens cleared.");
  } catch (e) {
    Logger.warn("Reset note: " + e);
  }
}

function authorizeScript() {
  resetOAuthTokens();
  const sheetsService = getSheetsService_();
  const token = sheetsService.getAccessToken();
  if (!token) throw new Error("Could not acquire Google Sheets token. Check SERVICE_ACCOUNT_KEY.");

  const firstTeam = getConfiguredTeams_()[0];
  const data = firstTeam ? getTeamRequestData_(firstTeam) : [];
  Logger.log("Google Sheets connected! Team sheet rows: " + data.length);
  Logger.log("Authorization completed successfully for " + Session.getActiveUser().getEmail());
}

/**
 * =========================================================
 * GOOGLE SHEETS SERVICE ACCOUNT ACCESS
 * =========================================================
 */
function getSheetsService_() {
  const properties = PropertiesService.getScriptProperties();
  const key = properties.getProperty("SERVICE_ACCOUNT_KEY");
  if (!key) throw new Error("SERVICE_ACCOUNT_KEY is not configured.");
  const serviceAccount = JSON.parse(key);
  return OAuth2.createService("GoogleSheets")
    .setTokenUrl("https://oauth2.googleapis.com/token")
    .setPrivateKey(serviceAccount.private_key)
    .setIssuer(serviceAccount.client_email)
    .setPropertyStore(properties)
    .setParam("access_type", "offline")
    .setScope("https://www.googleapis.com/auth/spreadsheets");
}

function sheetsApiRequest_(method, path, payload) {
  const service = getSheetsService_();
  if (!service.hasAccess()) {
    throw new Error("Sheets service has no access: " + service.getLastError());
  }
  const options = {
    method: method,
    headers: { Authorization: "Bearer " + service.getAccessToken() },
    muteHttpExceptions: true
  };
  if (payload !== undefined) {
    options.contentType = "application/json";
    options.payload = JSON.stringify(payload);
  }
  const response = UrlFetchApp.fetch(
    "https://sheets.googleapis.com/v4/spreadsheets/" + CONFIG.SPREADSHEET_ID + path,
    options
  );
  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error("Google Sheets API error " + code + ": " + body);
  }
  return body ? JSON.parse(body) : {};
}

function getSheetData_(sheetName) {
  if (_sheetDataCache[sheetName]) return _sheetDataCache[sheetName];
  const encodedRange = encodeURIComponent("'" + sheetName.replace(/'/g, "''") + "'!A:Z");
  const result = sheetsApiRequest_("get", "/values/" + encodedRange);
  const values = result.values || [];
  _sheetDataCache[sheetName] = values;
  return values;
}

function ensureSheet_(sheetName, headers) {
  if (_existingSheets.has(sheetName)) return sheetName;
  try {
    const data = getSheetData_(sheetName);
    _existingSheets.add(sheetName);
    if (data.length === 0 && headers && headers.length) {
      appendSheetRow_(sheetName, headers);
    }
    return sheetName;
  } catch (e) {}

  const spreadsheet = sheetsApiRequest_("get", "?fields=sheets.properties");
  const sheets = spreadsheet.sheets || [];
  const exists = sheets.some(s => s.properties && s.properties.title === sheetName);
  if (!exists) {
    sheetsApiRequest_("post", ":batchUpdate", {
      requests: [{ addSheet: { properties: { title: sheetName } } }]
    });
  }
  _existingSheets.add(sheetName);
  if (headers && headers.length) {
    const data = getSheetData_(sheetName);
    if (data.length === 0) appendSheetRow_(sheetName, headers);
  }
  return sheetName;
}

function appendSheetRow_(sheetName, values) {
  clearSheetCache_(sheetName);
  const encodedRange = encodeURIComponent("'" + sheetName.replace(/'/g, "''") + "'!A:Z");
  return sheetsApiRequest_(
    "post",
    "/values/" + encodedRange + ":append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS",
    { values: [values] }
  );
}

function setSheetCell_(sheetName, row, column, value) {
  clearSheetCache_(sheetName);
  const cell = columnToLetter_(column) + row;
  const encodedRange = encodeURIComponent("'" + sheetName.replace(/'/g, "''") + "'!" + cell);
  return sheetsApiRequest_(
    "put",
    "/values/" + encodedRange + "?valueInputOption=USER_ENTERED",
    { values: [[value]] }
  );
}

function columnToLetter_(column) {
  let result = "";
  let n = column;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

function formatLeaveSubject_(leaveDate) {
  const dates = leaveDate.split("-");
  const start = parseLeaveDate_(dates[0].trim());
  if (dates.length === 1) return formatOrdinalDate_(start);
  return formatOrdinalDate_(start) + " and " + formatOrdinalDate_(parseLeaveDate_(dates[1].trim()));
}

function formatLeaveBodyDate_(leaveDate) {
  const dates = leaveDate.split("-");
  const start = parseLeaveDate_(dates[0].trim());
  if (dates.length === 1) return formatFullDate_(start);
  return formatFullDate_(start) + " to " + formatFullDate_(parseLeaveDate_(dates[1].trim()));
}

function formatOrdinalDate_(date) {
  const day = date.getDate();
  const month = Utilities.formatDate(date, Session.getScriptTimeZone(), "MMMM");
  return day + getOrdinalSuffix_(day) + " " + month;
}

function formatFullDate_(date) {
  const day = Utilities.formatDate(date, Session.getScriptTimeZone(), "EEEE");
  const dayNumber = date.getDate();
  const month = Utilities.formatDate(date, Session.getScriptTimeZone(), "MMMM");
  return day + ", " + dayNumber + getOrdinalSuffix_(dayNumber) + " " + month;
}

function getOrdinalSuffix_(day) {
  if (day >= 11 && day <= 13) return "th";
  switch (day % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}

function normalizeEmail_(email) {
  return String(email || "").toLowerCase().trim();
}

/**
 * =========================================================
 * WEB APP HANDLER (AUTO-REGISTERS USER UPON OAUTH COMPLETION)
 * =========================================================
 */
function doGet(e) {
  e = e || {};
  const params = e.parameter || {};
  const redirectUri = params.configCompleteRedirectUri || params.completeRedirectUri || "";

  // ⚡ AUTO-REGISTER: The moment OAuth succeeds in the browser, register the employee immediately!
  try {
    let authEmail = "";
    try { authEmail = Session.getActiveUser().getEmail(); } catch (err) {}
    if (!authEmail && params.email) authEmail = params.email;
    if (authEmail) {
      registerUserDirectly_(authEmail, "", "", params.space || "");
    }
  } catch (regErr) {
    console.warn("doGet user registration note: " + regErr);
  }

  let html = "<!DOCTYPE html><html><head><meta charset='utf-8'><title>Authorization Complete</title>";
  html += "<meta name='viewport' content='width=device-width, initial-scale=1'>";
  html += "<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#131314;color:#e3e3e3;text-align:center;padding:20px;box-sizing:border-box;}";
  html += ".card{background:#1e1f20;border:1px solid #333;padding:40px 30px;border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,0.4);max-width:440px;width:100%;}";
  html += "h2{color:#81c995;margin:0 0 12px;}p{color:#9aa0a6;font-size:15px;line-height:1.5;margin:0 0 20px;}";
  html += ".btn{display:inline-block;background:#1a73e8;color:white;padding:12px 24px;border-radius:24px;text-decoration:none;font-weight:600;}";
  html += "</style></head><body><div class='card'>";
  html += "<h2>✅ Authorization Complete!</h2>";
  html += "<p>Pixcity Leave Tracker is authorized and ready to use.</p>";

  if (redirectUri) {
    html += "<p><small style='color:#80868B;'>Redirecting back to Google Chat...</small></p>";
    html += "<a class='btn' href='" + redirectUri + "'>Return to Google Chat</a>";
    html += "<script>setTimeout(function(){ window.location.href = " + JSON.stringify(redirectUri) + "; }, 800);</script>";
  } else {
    html += "<p>You may now close this tab and return to Google Chat.</p>";
    html += "<a class='btn' href='https://chat.google.com' target='_top'>Open Google Chat</a>";
  }

  html += "</div></body></html>";
  return HtmlService.createHtmlOutput(html)
    .setTitle("Pixcity Leave Tracker - Authorization Complete")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput(JSON.stringify({ text: "Empty payload" }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    const event = JSON.parse(e.postData.contents);
    const eventType = (event && event.type) || "";
    let response = {};
    if (eventType === "ADDED_TO_SPACE") response = onAddedToSpace(event);
    else if (eventType === "MESSAGE") response = onMessage(event);
    else if (eventType === "CARD_CLICKED") response = onCardClick(event);
    else if (eventType === "REMOVED_FROM_SPACE") { onRemoveFromSpace(event); response = {}; }
    else {
      if (event && (event.message || (event.chat && event.chat.messagePayload))) response = onMessage(event);
      else response = getWelcomeCard("there", "", "");
    }
    return ContentService.createTextOutput(JSON.stringify(response)).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    console.error("doPost error: " + (err && err.stack ? err.stack : err));
    let errorResponse;
    try {
      errorResponse = infoCard_("Error", "Error processing request. Check Apps Script Executions for the error details.");
    } catch (cardError) {
      console.error("doPost error-card failure: " + (cardError && cardError.stack ? cardError.stack : cardError));
      errorResponse = { text: "Error processing request." };
    }
    return ContentService.createTextOutput(JSON.stringify(errorResponse))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
