

require("dotenv").config();

const { Telegraf, session, Markup } = require("telegraf");
const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID || 0);
const DB_FILE = path.join(__dirname, "db.json");

function getLtcUsdPrice() {
  return new Promise((resolve, reject) => {
    const url =
      "https://api.coingecko.com/api/v3/simple/price" +
      "?ids=litecoin&vs_currencies=usd&include_last_updated_at=true";

    const request = https.get(url, {
      headers: {
        "User-Agent": "TrafficPilot/1.0"
      },
      timeout: 8000
    }, response => {
      let body = "";

      response.setEncoding("utf8");
      response.on("data", chunk => {
        body += chunk;
      });

      response.on("end", () => {
        if (response.statusCode !== 200) {
          return reject(
            new Error("LTC price service returned HTTP " +
              response.statusCode)
          );
        }

        try {
          const data = JSON.parse(body);
          const price = Number(data?.litecoin?.usd);
          const updatedAt = Number(data?.litecoin?.last_updated_at);

          if (
            !Number.isFinite(price) ||
            price <= 0 ||
            !Number.isFinite(updatedAt) ||
            Date.now() / 1000 - updatedAt > 300 ||
            updatedAt > Date.now() / 1000 + 60
          ) {
            return reject(
              new Error("LTC price is missing, invalid, or stale.")
            );
          }

          resolve(price);
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error("LTC price request timed out."));
    });

    request.on("error", reject);
  });
}


if (!TOKEN || TOKEN === "PASTE_YOUR_TELEGRAM_BOT_TOKEN_HERE") {
  throw new Error("BOT_TOKEN is missing from your .env file.");
}

const bot = new Telegraf(TOKEN);

bot.use(session({
  defaultSession: () => ({
    wizard: null,
    taskSubmission: null,
    paymentFlow: null
  })
}));
// ---------- DATABASE ----------
function loadDB() {
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return {
  users: data.users || {},
  campaigns: data.campaigns || [],
  submissions: data.submissions || [],
  transactions: data.transactions || [],
  deposits: data.deposits || [],
  withdrawals: data.withdrawals || [],
  taskVerifications: data.taskVerifications || []
};
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const initial = {
  users: {},
  campaigns: [],
  submissions: [],
  transactions: [],
  deposits: [],
  withdrawals: [],
  taskVerifications: []
};
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
}

let db = loadDB();

function saveDB() {
  const temp = DB_FILE + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(db, null, 2));
  fs.renameSync(temp, DB_FILE);
}

function getUser(from) {
  const id = String(from.id);

  if (!db.users[id]) {
    db.users[id] = {
      id: from.id,
      username: from.username || "",
      firstName: from.first_name || "",
      credits: 20,
      createdAt: new Date().toISOString()
    };

    db.transactions.push({
      id: Date.now().toString(),
      userId: from.id,
      amount: 20,
      type: "welcome_bonus",
      createdAt: new Date().toISOString()
    });
    saveDB();
  } else {
    db.users[id].username = from.username || "";
    db.users[id].firstName = from.first_name || "";
  }

  return db.users[id];
}

// ---------- MENUS ----------
function mainMenu() {
  return Markup.keyboard([
    ["🏠 Home", "📋 Available Tasks"],
    ["📝 Submit Task", "📚 Task History"],
    ["💰 My Wallet", "👥 Invite Friends"],
    ["📊 My Statistics", "📜 Transaction History"],
    ["🆘 Support", "📢 Advertiser Menu"]
  ]).resize();
}

function advertiserMenu() {
  return Markup.keyboard([
    
    ["➕ Create Campaign", "📣 My Campaigns"],
    ["ABA Deposit"],
    ["💵 Deposit USDT", "📤 Withdraw Credits"],
    ["🪙 Deposit LTC", "📤 Withdraw LTC"],

    ["🏠 Main Menu"]
  ]).resize();
}
function isCampaignOpen(campaign) {
  const limit = Number(campaign.completions);
  const completed = Number(campaign.completed) || 0;
  return campaign.status === "approved" &&
    Number.isFinite(limit) &&
    limit > 0 &&
    completed < limit;
}


// ---------- TASK TIMER / CAPTCHA / KEYWORD HELPERS ----------
function getTaskWaitSeconds(campaign) {
  const type = String(campaign?.type || "").toLowerCase();
  // Default: 60 seconds for websites/articles; 120 seconds for videos.
  return type.includes("video") ? 120 : 60;
}

function getTaskVerification(userId, campaignId) {
  if (!Array.isArray(db.taskVerifications)) {
    db.taskVerifications = [];
  }

  return [...db.taskVerifications].reverse().find(item =>
    String(item.userId) === String(userId) &&
    String(item.campaignId) === String(campaignId) &&
    !["used", "expired", "failed"].includes(item.status)
  ) || null;
}
function hashTaskKeyword(value) {
  return crypto.createHash("sha256")
    .update(String(value).trim().toUpperCase())
    .digest("hex");
}

function makeTaskCaptcha() {
  const a = crypto.randomInt(2, 10);
  const b = crypto.randomInt(1, 10);
  const subtract = crypto.randomInt(0, 2) === 1;
  if (subtract) {
    const high = Math.max(a, b);
    const low = Math.min(a, b);
    return { question: `${high} - ${low}`, answer: String(high - low) };
  }
  return { question: `${a} + ${b}`, answer: String(a + b) };
}


/* ---------- TASK WEBSITE API ---------- */
const express = require("express");
const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

function findWebsiteVerification(token, campaignId) {
  if (typeof token !== "string" || token.length < 32 || token.length > 200) {
    return null;
  }

  const tokenHash = crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

  return db.taskVerifications.find(item =>
    item.websiteTokenHash === tokenHash &&
    String(item.campaignId) === String(campaignId) &&
    Number(item.websiteTokenExpiresAt || 0) > Date.now()
  ) || null;
}

app.post("/api/task/start", (req, res) => {
  const { campaignId, token } = req.body || {};
  const verification = findWebsiteVerification(token, campaignId);

  if (!verification) {
    return res.status(401).json({ error: "Task link expired or invalid. Return to Telegram and select the task again." });
  }

  const campaign = db.campaigns.find(c =>
    String(c.id) === String(campaignId)
  );

  if (!campaign || !isCampaignOpen(campaign)) {
    return res.status(400).json({ error: "This campaign is no longer available." });
  }

  if (verification.status !== "website_ready") {
    return res.status(409).json({ error: "This task link has already been started or used." });
  }

  verification.status = "waiting";
  verification.startedAt = Date.now();
  verification.waitSeconds = getTaskWaitSeconds(campaign);
  verification.attempts = 0;
  verification.captchaAnswer = null;
  verification.captchaQuestion = null;
  verification.keywordHash = null;
  verification.keywordExpiresAt = null;

  saveDB();

  return res.json({
    startedAt: verification.startedAt,
    waitSeconds: verification.waitSeconds
  });
});

app.post("/api/task/captcha", (req, res) => {
  const { campaignId, token } = req.body || {};
  const verification = findWebsiteVerification(token, campaignId);

  if (!verification) {
    return res.status(401).json({ error: "Task link expired. Return to Telegram and restart." });
  }

  if (verification.status === "captcha_pending") {
    return res.json({ question: verification.captchaQuestion });
  }

  if (verification.status !== "waiting") {
    return res.status(409).json({ error: "Timer is not active. Restart the task from Telegram." });
  }

  const elapsed = Date.now() - Number(verification.startedAt || 0);
  const required = Number(verification.waitSeconds || 0) * 1000;

  if (elapsed < required) {
    return res.status(400).json({
      error: "Please wait for the timer to finish.",
      remainingSeconds: Math.ceil((required - elapsed) / 1000)
    });
  }

  const captcha = makeTaskCaptcha();
  verification.status = "captcha_pending";
  verification.captchaQuestion = captcha.question;
  verification.captchaAnswer = hashTaskKeyword(captcha.answer);
  verification.captchaExpiresAt = Date.now() + 10 * 60 * 1000;
  verification.attempts = 0;

  saveDB();

  return res.json({ question: captcha.question });
});

app.post("/api/task/verify", (req, res) => {
  const { campaignId, token, answer } = req.body || {};
  const verification = findWebsiteVerification(token, campaignId);

  if (!verification) {
    return res.status(401).json({ error: "Task link expired. Return to Telegram and restart." });
  }

  if (verification.status !== "captcha_pending" ||
      Number(verification.captchaExpiresAt || 0) < Date.now()) {
    verification.status = "expired";
    saveDB();
    return res.status(400).json({ error: "Verification expired. Restart the task from Telegram." });
  }

  verification.attempts = Number(verification.attempts || 0) + 1;

  if (hashTaskKeyword(String(answer ?? "")) !== verification.captchaAnswer) {
    if (verification.attempts >= 3) {
      verification.status = "failed";
      saveDB();
      return res.status(429).json({ error: "Too many incorrect answers. Restart the task from Telegram." });
    }

    saveDB();
    return res.status(400).json({
      error: "Incorrect answer. Please try again.",
      attemptsLeft: 3 - verification.attempts
    });
  }

  const keyword = crypto.randomBytes(4).toString("hex").toUpperCase();

  verification.status = "keyword_issued";
  verification.keywordHash = hashTaskKeyword(keyword);
  verification.keywordExpiresAt = Date.now() + 15 * 60 * 1000;
  verification.keywordIssuedAt = new Date().toISOString();
  verification.captchaAnswer = null;
  verification.captchaQuestion = null;

  saveDB();

  return res.json({ keyword });
});

app.get("/health", (_req, res) => {
  res.json({ success: true, name: "TrafficPilot Task Website", status: "online" });
});

const TASK_WEB_PORT = Number(process.env.PORT || process.env.TASK_WEB_PORT || 3000);

app.listen(TASK_WEB_PORT, "0.0.0.0", () => {
  console.log("TrafficPilot task website listening on port " + TASK_WEB_PORT);
});
/* ---------- END TASK WEBSITE API ---------- */


function startTaskCountdownDisplay(botInstance, chatId, messageId, verification) {
  const interval = setInterval(async () => {
    try {
      const current = Date.now();
      const elapsed = Math.floor((current - Number(verification.startedAt)) / 1000);
      const remaining = Math.max(0, Number(verification.waitSeconds) - elapsed);
      const text = remaining > 0
        ? `⏳ TASK TIMER\n\nTime remaining: ${remaining} seconds\n\nKeep the task open and return when the timer finishes. Then tap Check Timer.`
        : `✅ TIMER FINISHED\n\nYour required wait is complete. Tap Check Timer to solve the verification challenge and receive your keyword.`;
      await botInstance.telegram.editMessageText(
        chatId,
        messageId,
        undefined,
        text,
        Markup.inlineKeyboard([[
          Markup.button.callback("Check Timer / Continue", `tasktimercheck:${verification.campaignId}`)
        ]])
      );
      if (remaining <= 0) clearInterval(interval);
    } catch (error) {
      // The message may have been edited or the bot restarted; server-side timestamps remain authoritative.
      clearInterval(interval);
    }
  }, 5000);
}
// ---------- END TASK TIMER HELPERS ----------

function formatCampaign(campaign) {
  const limit = Number(campaign.completions);
  const completed = Number(campaign.completed) || 0;
  const reward = Number(campaign.effectiveReward || campaign.reward) || 0;

  return [
    `Campaign #${campaign.id}`,
    `Title: ${campaign.title || "Untitled"}`,
    `Type: ${campaign.type || "Not specified"}`,
    `URL: ${campaign.url || "Not specified"}`,
    `Tier: ${campaign.tier || "Not specified"}`,
    `Reward pack: ${campaign.pack || "Custom/legacy"}`,
    `Worker reward: ${reward} credits`,
    `Completions: ${completed}/${Number.isFinite(limit) ? limit : "Not set"}`,
    `Status: ${campaign.status || "unknown"}`
  ].join("\n");
}

// ---------- TASK LIST ----------
async function showAvailableTasks(ctx) {
  const userId = String(ctx.from.id);
  const alreadySubmitted = new Set(
    db.submissions
      .filter(s =>
        String(s.userId) === userId &&
        ["pending_review", "approved"].includes(s.status)
      )
      .map(s => String(s.campaignId))
  );

  const available = db.campaigns.filter(c =>
    isCampaignOpen(c) &&
    String(c.userId) !== userId &&
    !alreadySubmitted.has(String(c.id))
  );

  if (!available.length) {
    return ctx.reply(
      "📋 No new tasks are available right now.\n\nUse 📚 Task History to check your submissions.",
      mainMenu()
    );
  }

  await ctx.reply(
    "📋 AVAILABLE TASKS\n\nOnly tasks you have not already submitted are shown.",
    mainMenu()
  );

  for (const campaign of available.slice(0, 10)) {
    await ctx.reply(
      formatCampaign(campaign),
      Markup.inlineKeyboard([[
        Markup.button.callback("Select Campaign", `taskselect:${campaign.id}`)
      ]])
    );
  }
}

// ---------- TASK HISTORY ----------
async function showTaskHistory(ctx) {
  const submissions = db.submissions
    .filter(s => String(s.userId) === String(ctx.from.id))
    .sort((a, b) =>
      new Date(b.submittedAt || 0).getTime() -
      new Date(a.submittedAt || 0).getTime()
    );

  if (!submissions.length) {
    return ctx.reply(
      "📚 TASK HISTORY\n\nYou have not submitted any tasks yet.",
      mainMenu()
    );
  }

  const entries = submissions.slice(0, 20).map(s => {
    const campaign = db.campaigns.find(
      c => String(c.id) === String(s.campaignId)
    );
    const labels = {
      pending_review: "⏳ Pending advertiser review",
      approved: "✅ Approved",
      rejected: "❌ Rejected"
    };
    const reward = s.status === "approved"
      ? (Number(s.reward || campaign?.effectiveReward || campaign?.reward) || 0)
      : 0;

    return [
      `Campaign: ${campaign?.title || "Campaign unavailable"}`,
      `Submission ID: ${s.id}`,
      `Status: ${labels[s.status] || s.status}`,
      ...(s.status === "approved" ? [`Reward: +${reward} credits`] : []),
      `Submitted: ${s.submittedAt || "Unknown"}`,
      ...(s.reviewNote ? [`Review note: ${s.reviewNote}`] : [])
    ].join("\n");
  });

  await ctx.reply(
    "📚 TASK HISTORY (latest 20)\n\n" +
    entries.join("\n\n──────────\n\n"),
    mainMenu()
  );
}

// ---------- COMMANDS ----------
bot.start(async ctx => {
  const user = getUser(ctx.from);
  ctx.session.wizard = null;
  ctx.session.taskSubmission = null;

  await ctx.reply(
    `👋 Welcome to TrafficPilot, ${user.firstName || "user"}!\n\n` +
    `💰 Balance: ${user.credits} credits\n\nChoose an option below.`,
    mainMenu()
  );
});

bot.command("tasks", async ctx => {
  getUser(ctx.from);
  await showAvailableTasks(ctx);
});

bot.command("help", async ctx => {
  await ctx.reply(
    "/start - Main menu\n/tasks - Available tasks\n/history - Task history\n/cancel - Cancel current action\n/help - Help",
    mainMenu()
  );
});

bot.command("history", async ctx => {
  await showTaskHistory(ctx);
});

bot.command("cancel", async ctx => {
  ctx.session.wizard = null;
  ctx.session.taskSubmission = null;
  await ctx.reply("Current action cancelled.", mainMenu());
});

bot.command("addcredits", async ctx => {
  if (!ADMIN_ID || ctx.from.id !== ADMIN_ID) {
    return ctx.reply("Access denied. Admin only.");
  }

  const amount = Number(ctx.message.text.split(/\s+/)[1]);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100000) {
    return ctx.reply(
      "Usage: /addcredits AMOUNT\nExample: /addcredits 100\nAllowed amount: 1–100000 credits."
    );
  }

  const user = getUser(ctx.from);
  user.credits = (Number(user.credits) || 0) + amount;
  db.transactions.push({
    id: Date.now().toString(),
    userId: ctx.from.id,
    type: "admin_credit",
    amount,
    description: "Administrator test credit adjustment",
    createdAt: new Date().toISOString()
  });
  saveDB();

  return ctx.reply(
    `Test credits added successfully!\n\nAdded: ${amount} credits\nNew balance: ${user.credits} credits`
  );
});

// ---------- MAIN MENU BUTTONS ----------
bot.hears(["🏠 Home", "⬅️ Main Menu"], async ctx => {
  const user = getUser(ctx.from);
  ctx.session.wizard = null;
  ctx.session.taskSubmission = null;
  await ctx.reply(`🏠 TrafficPilot Home\nBalance: ${user.credits} credits`, mainMenu());
});

bot.hears("📋 Available Tasks", async ctx => {
  getUser(ctx.from);
  await showAvailableTasks(ctx);
});

bot.hears("📝 Submit Task", async ctx => {
  getUser(ctx.from);
  await showAvailableTasks(ctx);
});

bot.hears("💰 My Wallet", async ctx => {
  const user = getUser(ctx.from);
  await ctx.reply(
    `💰 My Wallet\n\nAvailable credits: ${user.credits}\n` +
    "Exchange reference: 10,000 credits = $1\n\n" +
    "USDT deposits and withdrawals are not active until payment verification is configured.",
    mainMenu()
  );
});

bot.hears("👥 Invite Friends", async ctx => {
  const me = await ctx.telegram.getMe();
  const link = `https://t.me/${me.username}?start=ref_${ctx.from.id}`;
  await ctx.reply(
    `👥 Invite Friends\n\nYour referral link:\n${link}\n\nReferral rewards are not activated yet.`,
    mainMenu()
  );
});

bot.hears("📊 My Statistics", async ctx => {
  const user = getUser(ctx.from);
  const campaigns = db.campaigns.filter(c => String(c.userId) === String(ctx.from.id));
  const submissions = db.submissions.filter(s => String(s.userId) === String(ctx.from.id));
  await ctx.reply(
    `📊 My Statistics\n\nCredits: ${user.credits}\nCampaigns created: ${campaigns.length}\nTask submissions: ${submissions.length}`,
    mainMenu()
  );
});

bot.hears("📜 Transaction History", async ctx => {
  const transactions = db.transactions
    .filter(t => String(t.userId) === String(ctx.from.id))
    .slice(-10)
    .reverse();

  if (!transactions.length) {
    return ctx.reply("No transactions yet.", mainMenu());
  }

  await ctx.reply(
    transactions.map(t =>
      `${t.type}: ${Number(t.amount) > 0 ? "+" : ""}${t.amount} credits`
    ).join("\n"),
    mainMenu()
  );
});

bot.hears("📚 Task History", async ctx => {
  await showTaskHistory(ctx);
});

bot.hears("🆘 Support", async ctx => {
  await ctx.reply("🆘 Please contact the TrafficPilot administrator for help.", mainMenu());
});

bot.hears("📢 Advertiser Menu", async ctx => {
  getUser(ctx.from);
  await ctx.reply("📢 Advertiser Menu", advertiserMenu());
});

// ---------- CAMPAIGN CREATION ----------
bot.hears("➕ Create Campaign", async ctx => {
  getUser(ctx.from);
  ctx.session.taskSubmission = null;
  ctx.session.wizard = { step: "campaign_title", campaign: {} };
  await ctx.reply("➕ CREATE CAMPAIGN\n\nEnter a short campaign title:", Markup.removeKeyboard());
});

bot.hears("📣 My Campaigns", async ctx => {
  getUser(ctx.from);
  const campaigns = db.campaigns
    .filter(c => String(c.userId) === String(ctx.from.id))
    .slice(-20)
    .reverse();

  if (!campaigns.length) {
    return ctx.reply("You have not created any campaigns yet.", advertiserMenu());
  }

  for (const campaign of campaigns) {
    await ctx.reply(formatCampaign(campaign), advertiserMenu());
  }
});

// ---------- ABA MANUAL DEPOSIT ----------
bot.hears("ABA Deposit", async ctx => {
  const accountName = process.env.ABA_ACCOUNT_NAME;
  const accountNumber = process.env.ABA_ACCOUNT_NUMBER;
  const qrImage = process.env.ABA_QR_IMAGE_PATH || "aba-qr.png";

  if (!accountName || !accountNumber) {
    return ctx.reply(
      "ABA deposits are not configured yet. Please contact the administrator.",
      advertiserMenu()
    );
  }

  ctx.session.paymentFlow = {
    type: "aba_deposit_amount"
  };

  const message =
    "🏦 ABA BANK MANUAL DEPOSIT\n\n" +
    "Account holder: " + accountName + "\n" +
    "Account number: " + accountNumber + "\n" +
    "Currency: USD\n\n" +
    "1. Transfer money using ABA Mobile.\n" +
    "2. Confirm the transfer is successful.\n" +
    "3. Enter the amount you transferred.\n\n" +
    "Your deposit will remain pending until the administrator verifies receipt of the money.\n\n" +
    "Type /cancel to cancel.";

  try {
    const fs = require("fs");
    if (fs.existsSync(qrImage)) {
      await ctx.replyWithPhoto(
        { source: qrImage },
        { caption: message, ...Markup.removeKeyboard() }
      );
      return;
    }
  } catch (error) {
    console.error("Could not load ABA QR image:", error.message);
  }

  return ctx.reply(message, Markup.removeKeyboard());
});
// ---------- END ABA MANUAL DEPOSIT ----------
bot.hears("💵 Deposit USDT", async ctx => {
  const receiveAddress = process.env.TON_RECEIVE_ADDRESS;

  if (!receiveAddress) {
    return ctx.reply(
      "Deposits are temporarily unavailable because the receiving address is not configured.",
      advertiserMenu()
    );
  }

  ctx.session.paymentFlow = {
    type: "deposit_amount"
  };

  await ctx.reply(
    "💵 USDT Deposit\n\n" +
    "Network: TON\n" +
    "Receiving address:\n" +
    receiveAddress + "\n\n" +
    "⚠️ Do not send funds until you have confirmed the token and network.\n" +
    "Your deposit will not receive credits until an admin verifies the transfer.\n\n" +
    "Enter the amount of USDT you intend to deposit (for example: 1 or 2.5).",
    Markup.removeKeyboard()
  );
});


bot.hears("🪙 Deposit LTC", async ctx => {
  const receiveAddress = process.env.LTC_RECEIVE_ADDRESS;

  if (!receiveAddress) {
    return ctx.reply(
      "LTC deposits are unavailable because the receiving address is not configured.",
      advertiserMenu()
    );
  }

  ctx.session.paymentFlow = {
    type: "ltc_deposit_amount"
  };

  return ctx.reply(
    "Litecoin (LTC) Deposit\n\n" +
    "Network: Litecoin mainnet\n" +
    "Receiving address:\n" + receiveAddress + "\n\n" +
    "Only send LTC on the Litecoin network. Do not send USDT here.\n" +
    "Your deposit will remain pending until an admin verifies the transaction.\n\n" +
    "Enter the amount of LTC you intend to deposit (for example: 0.1).",
    Markup.removeKeyboard()
  );
});



bot.hears("📤 Withdraw Credits", async ctx => {
  const minWithdraw = Number(process.env.MIN_WITHDRAW_CREDITS || 5000);
  const user = getUser(ctx.from);

  ctx.session.paymentFlow = {
    type: "withdraw_amount"
  };

  return ctx.reply(
    "📤 Withdraw Credits\n\n" +
    "Your current balance: " + Number(user.credits || 0) + " credits\n" +
    "Minimum withdrawal: " + minWithdraw + " credits\n" +
    "Rate: " + Number(process.env.CREDITS_PER_USDT || 10000) +
    " credits = 1 USDT\n\n" +
    "Enter the number of credits you want to withdraw.",
    Markup.removeKeyboard()
  );
});

bot.hears("📤 Withdraw LTC", async ctx => {
  const user = getUser(ctx.from);
  const minWithdraw = Number(
    process.env.MIN_WITHDRAW_CREDITS || 5000
  );

  ctx.session.paymentFlow = {
    type: "ltc_withdraw_amount"
  };

  return ctx.reply(
    "📤 Withdraw LTC\n\n" +
    "Your current balance: " +
    Number(user.credits || 0) + " credits\n" +
    "Minimum withdrawal: " + minWithdraw + " credits\n\n" +
    "The LTC payout will be calculated using the live LTC/USD price.\n" +
    "Enter the number of credits you want to withdraw.",
    Markup.removeKeyboard()
  );
});

// ---------- TIER SELECTION ----------
bot.action(/^tier:(tier1|tier2|tier3)$/, async ctx => {
  const wizard = ctx.session.wizard;
  if (!wizard || wizard.step !== "campaign_tier") {
    return ctx.answerCbQuery("Start creating a campaign first.");
  }

  const tiers = {
    tier1: { name: "Tier 1", bonus: 0.15 },
    tier2: { name: "Tier 2", bonus: 0.10 },
    tier3: { name: "Tier 3", bonus: 0.05 }
  };

  wizard.campaign.tier = tiers[ctx.match[1]].name;
  wizard.campaign.bonus = tiers[ctx.match[1]].bonus;
  wizard.step = "campaign_reward";

  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  await ctx.reply(
    `Selected: ${wizard.campaign.tier}\nTier bonus: ${wizard.campaign.bonus * 100}%\n\nSelect a reward pack:`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback("🥉 Bronze 5", "pack:5"),
        Markup.button.callback("🥈 Silver 10", "pack:10")
      ],
      [
        Markup.button.callback("🥇 Gold 20", "pack:20"),
        Markup.button.callback("💎 Platinum 30", "pack:30")
      ],
      [Markup.button.callback("💠 Diamond 60", "pack:60")]
    ])
  );
});

// ---------- REWARD PACK SELECTION ----------
bot.action(/^pack:(5|10|20|30|60)$/, async ctx => {
  const wizard = ctx.session.wizard;
  if (!wizard || wizard.step !== "campaign_reward") {
    return ctx.answerCbQuery("Start creating a campaign first.");
  }

  const reward = Number(ctx.match[1]);
  const packs = {
    5: "Bronze 5",
    10: "Silver 10",
    20: "Gold 20",
    30: "Platinum 30",
    60: "Diamond 60"
  };

  wizard.campaign.reward = reward;
  wizard.campaign.pack = packs[reward];
  wizard.campaign.effectiveReward = Math.ceil(
    reward * (1 + Number(wizard.campaign.bonus || 0))
  );
  wizard.step = "campaign_completions";

  await ctx.answerCbQuery("Reward pack selected.");
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  await ctx.reply(
    `Selected pack: ${packs[reward]}\nBase reward: ${reward} credits\n` +
    `Tier-adjusted reward: ${wizard.campaign.effectiveReward} credits per completion\n\n` +
    "Enter the number of completions, from 10 to 5000."
  );
});

// ---------- CAMPAIGN TYPE SELECTION ----------
bot.action("campaign_type_visit", async ctx => {
  const wizard = ctx.session.wizard;
  if (!wizard || wizard.step !== "campaign_type") {
    return ctx.answerCbQuery("Start creating a campaign first.");
  }

  wizard.campaign.type = "Visit and read content";
  wizard.step = "campaign_url";
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  await ctx.reply("Enter the public URL of the content:");
});

bot.action("campaign_type_video", async ctx => {
  const wizard = ctx.session.wizard;
  if (!wizard || wizard.step !== "campaign_type") {
    return ctx.answerCbQuery("Start creating a campaign first.");
  }

  wizard.campaign.type = "Watch video";
  wizard.step = "campaign_url";
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  await ctx.reply("Enter the public video URL (YouTube or another publicly accessible video page):");
});

bot.action("campaign_type_social", async ctx => {
  const wizard = ctx.session.wizard;
  if (!wizard || wizard.step !== "campaign_type") {
    return ctx.answerCbQuery("Start creating a campaign first.");
  }

  wizard.campaign.type = "Social engagement";
  wizard.step = "campaign_url";
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  await ctx.reply(
    "Enter the public URL of the page or post. Campaigns must use genuine, voluntary engagement. Do not require fake clicks or artificial engagement."
  );
});


 // ---------- PAYMENT INPUT HANDLER ----------
bot.on("text", async (ctx, next) => {
  const flow = ctx.session.paymentFlow;

  if (!flow) return next();

  const text = ctx.message.text.trim();

  if (text === "/cancel") {
    ctx.session.paymentFlow = null;
    return ctx.reply("Payment request cancelled.");
  }

  if (text.startsWith("/")) return next();

  
  // ---------- ABA DEPOSIT AMOUNT ----------
  if (flow.type === "aba_deposit_amount") {
    if (!/^\d+(\.\d{1,2})?$/.test(text)) {
      return ctx.reply(
        "Enter a valid USD amount, such as 1 or 5.50. Type /cancel to stop."
      );
    }

    const amount = Number(text);

    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
      return ctx.reply(
        "Enter an amount greater than 0 and no more than 100,000 USD."
      );
    }

    ctx.session.paymentFlow = {
      type: "aba_deposit_reference",
      amount: amount.toFixed(2)
    };

    return ctx.reply(
      "Amount: " + amount.toFixed(2) + " USD\n\n" +
      "Now enter the ABA transaction reference from your successful transfer.\n" +
      "Your deposit will remain pending until the administrator verifies receipt of the money.\n\n" +
      "Type /cancel to stop."
    );
  }

  // ---------- ABA DEPOSIT REFERENCE ----------
  if (flow.type === "aba_deposit_reference") {
    if (text.length < 3 || text.length > 120) {
      return ctx.reply(
        "Enter a valid ABA transaction reference (3–120 characters), or type /cancel."
      );
    }

    db = loadDB();

    if (!Array.isArray(db.deposits)) db.deposits = [];

    const reference = text.trim().toLowerCase();

    const duplicate = db.deposits.some(deposit =>
      String(deposit.txHash || "").trim().toLowerCase() === reference
    );

    if (duplicate) {
      ctx.session.paymentFlow = null;
      return ctx.reply(
        "This transaction reference has already been submitted. Contact the administrator if you need help."
      );
    }

    const deposit = {
      id: String(Date.now()),
      userId: String(ctx.from.id),
      currency: "ABA_USD",
      network: "ABA Bank",
      amount: flow.amount,
      txHash: text.trim(),
      bankReference: text.trim(),
      status: "pending_review",
      createdAt: new Date().toISOString()
    };

    db.deposits.push(deposit);
    saveDB(db);
    ctx.session.paymentFlow = null;

    if (ADMIN_ID) {
      try {
        await ctx.telegram.sendMessage(
          ADMIN_ID,
          "ABA BANK DEPOSIT — MANUAL REVIEW REQUIRED\n\n" +
          "User ID: " + deposit.userId + "\n" +
          "Amount claimed: " + deposit.amount + " USD\n" +
          "ABA reference: " + deposit.bankReference + "\n" +
          "Deposit ID: " + deposit.id + "\n\n" +
          "IMPORTANT: Check your actual ABA account and verify the received amount and transaction reference before approving.",
          Markup.inlineKeyboard([
            [
              Markup.button.callback(
                "Approve ABA Deposit",
                "depositapprove:" + deposit.id
              ),
              Markup.button.callback(
                "Reject ABA Deposit",
                "depositreject:" + deposit.id
              )
            ]
          ])
        );
      } catch (error) {
        console.error(
          "Could not notify admin about ABA deposit:",
          error.message
        );
      }
    }

    return ctx.reply(
      "Your ABA deposit request has been submitted.\n\n" +
      "Amount: " + deposit.amount + " USD\n" +
      "Status: Pending admin review\n\n" +
      "Credits will only be added after the administrator verifies the transfer."
    );
  }

  // LTC deposit amount
  if (flow.type === "ltc_deposit_amount") {
    if (!/^\d+(\.\d{1,8})?$/.test(text)) {
      return ctx.reply(
        "Enter a valid LTC amount, such as 0.1 or 0.025. Type /cancel to stop."
      );
    }

    const amount = Number(text);

    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
      return ctx.reply(
        "Enter an LTC amount greater than 0 and no more than 1,000,000."
      );
    }

    ctx.session.paymentFlow = {
      type: "ltc_deposit_hash",
      amount: amount.toFixed(8)
    };

    return ctx.reply(
      "Amount received: " + amount.toFixed(8) + " LTC\\n\\n" +
      "Now send the transaction ID (hash) for this Litecoin deposit.\\n" +
      "The deposit remains pending until an admin verifies it.\\n\\n" +
      "Type /cancel to stop."
    );
  }

 

  // Step 1: Collect the intended USDT deposit amount
  if (flow.type === "deposit_amount") {
    const amountText = text;

    if (!/^\d+(\.\d{1,6})?$/.test(amountText)) {
      return ctx.reply(
        "Enter a valid USDT amount, such as 1 or 2.5. Type /cancel to stop."
      );
    }

    const amount = Number(amountText);

    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
      return ctx.reply("Enter an amount greater than 0 and no more than 1,000,000 USDT.");
    }

    ctx.session.paymentFlow = {
      type: "deposit_hash",
      amount: amountText
    };

    return ctx.reply(
      "Amount received: " + amountText + " USDT\n\n" +
      "Now send the TON transaction hash for this deposit.\n" +
      "Your deposit will remain unverified until an admin checks it.\n\n" +
      "Type /cancel to stop."
    );
  }

   
  // LTC deposit transaction submission
  if (flow.type === "ltc_deposit_hash") {
    if (!/^[a-fA-F0-9]{64}$/.test(text)) {
      return ctx.reply(
        "Enter the 64-character Litecoin transaction ID (hash), or type /cancel to stop."
      );
    }

    db = loadDB();

    if (!Array.isArray(db.deposits)) db.deposits = [];

    const duplicate = db.deposits.some(deposit =>
      String(deposit.txHash || "").toLowerCase() === text.toLowerCase()
    );

    if (duplicate) {
      ctx.session.paymentFlow = null;
      return ctx.reply(
        "This transaction hash has already been submitted. Contact support if you believe this is an error."
      );
    }

    const deposit = {
      id: String(Date.now()),
      userId: String(ctx.from.id),
      currency: "LTC",
      network: "Litecoin",
      amount: flow.amount,
      txHash: text,
      status: "pending_review",
      createdAt: new Date().toISOString()
    };

    db.deposits.push(deposit);
    saveDB();
    ctx.session.paymentFlow = null;

    if (ADMIN_ID) {
      try {
        await ctx.telegram.sendMessage(
          ADMIN_ID,
          "LTC DEPOSIT NEEDS MANUAL REVIEW\n\n" +
          "User ID: " + deposit.userId + "\n" +
          "Amount claimed: " + deposit.amount + " LTC\n" +
          "Network: Litecoin mainnet\n" +
          "Transaction ID: " + deposit.txHash + "\n" +
          "Deposit ID: " + deposit.id + "\n\n" +
          "Verify the transaction on a trusted Litecoin blockchain explorer. Confirm the transaction succeeded, the recipient matches LTC_RECEIVE_ADDRESS, the amount is correct, and the transaction is sufficiently confirmed before approving.",
          Markup.inlineKeyboard([
            [
              Markup.button.callback(
                "Approve LTC Deposit",
                "depositapprove:" + deposit.id
              ),
              Markup.button.callback(
                "Reject LTC Deposit",
                "depositreject:" + deposit.id
              )
            ]
          ])
        );
      } catch (error) {
        console.error(
          "Could not notify admin about LTC deposit:",
          error.message
        );
      }
    }

    return ctx.reply(
      "Your LTC deposit request has been submitted for manual review.\n\n" +
      "Amount: " + deposit.amount + " LTC\n" +
      "Network: Litecoin\n" +
      "Status: Pending review\n\n" +
      "Credits will not be added until an admin verifies the transfer."
    );
  }


  // Step 2: Collect a transaction hash
  if (flow.type === "deposit_hash") {
    if (text.length < 20 || text.length > 200) {
      return ctx.reply(
        "That transaction hash length looks invalid. Please send the hash again, or type /cancel."
      );
    }

    db = loadDB();

    if (!Array.isArray(db.deposits)) db.deposits = [];

    const duplicate = db.deposits.some(deposit =>
      String(deposit.txHash || "").toLowerCase() === text.toLowerCase()
    );

    if (duplicate) {
      ctx.session.paymentFlow = null;
      return ctx.reply(
        "This transaction hash has already been submitted. Please contact support if you think this is an error."
      );
    }

    const deposit = {
      id: String(Date.now()),
      userId: String(ctx.from.id),
      amount: flow.amount,
      txHash: text,
      status: "pending_review",
      createdAt: new Date().toISOString()
    };

    db.deposits.push(deposit);
    saveDB(db);
    ctx.session.paymentFlow = null;

    if (ADMIN_ID) {
      try {
        
await ctx.telegram.sendMessage(
  ADMIN_ID,
  "DEPOSIT NEEDS MANUAL REVIEW\n\n" +
  "User ID: " + deposit.userId + "\n" +
  "Amount claimed: " + deposit.amount + " USDT\n" +
  "Transaction hash: " + deposit.txHash + "\n" +
  "Deposit ID: " + deposit.id + "\n\n" +
  "Verify the transaction on the TON blockchain explorer. Confirm the actual USDT token contract, recipient address, transaction success, and amount before approving.",
  Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "Approve Deposit",
        "depositapprove:" + deposit.id
      ),
      Markup.button.callback(
        "Reject Deposit",
        "depositreject:" + deposit.id
      )
    ]
  ])
);

      } catch (error) {
        console.error("Could not notify admin about deposit:", error.message);
      }
    }

    return ctx.reply(
      "Your deposit request has been submitted for manual review.\n\n" +
      "Amount: " + deposit.amount + " USDT\n" +
      "Status: Pending review\n\n" +
      "Credits will not be added until an admin verifies the transfer."
    );
  }


  // ---------- WITHDRAWAL AMOUNT ----------
  
if (flow.type === "withdraw_amount") {
  if (!/^\d+$/.test(text)) {
    return ctx.reply(
      "Enter a whole number of credits, or type /cancel to stop."
    );
  }

  const credits = Number(text);
  const minWithdraw = Number(process.env.MIN_WITHDRAW_CREDITS || 5000);
  const user = getUser(ctx.from);

  if (!Number.isSafeInteger(credits) || credits < minWithdraw) {
    return ctx.reply(
      "The minimum withdrawal is " + minWithdraw + " credits."
    );
  }

  if (credits > Number(user.credits || 0)) {
    return ctx.reply(
      "You do not have enough credits. Your balance is " +
      Number(user.credits || 0) + " credits."
    );
  }

  ctx.session.paymentFlow = {
    type: "withdraw_method",
    credits: credits
  };

  return ctx.reply(
    "You requested to withdraw " + credits + " credits.\n\n" +
    "Choose your payout method:",
    Markup.keyboard([
      ["USDT (TON)"],
      ["LTC"],
      ["ABA Bank"],
      ["🏠 Main Menu"]
    ]).resize()
  );
}

  
  // ---------- WITHDRAWAL METHOD ----------
  if (flow.type === "withdraw_method") {
    const method = text.trim();

    let currency;
    let prompt;

    if (method === "USDT (TON)") {
      currency = "USDT_TON";
      prompt =
        "Enter your TON-compatible USDT wallet address.\n" +
        "Check it carefully before submitting.";
    
} else if (method === "LTC") {
  const credits = Number(flow.credits);
  const creditsPerUsdt = Number(
    process.env.CREDITS_PER_USDT || 10000
  );

  if (
    !Number.isSafeInteger(credits) ||
    credits <= 0 ||
    !Number.isFinite(creditsPerUsdt) ||
    creditsPerUsdt <= 0
  ) {
    ctx.session.paymentFlow = null;
    return ctx.reply("Invalid withdrawal amount or conversion rate.");
  }

  try {
    const ltcPrice = await getLtcUsdPrice();
    const estimatedLtc = credits / (ltcPrice * creditsPerUsdt);

    if (
      !Number.isFinite(ltcPrice) ||
      ltcPrice <= 0 ||
      !Number.isFinite(estimatedLtc) ||
      estimatedLtc <= 0
    ) {
      throw new Error("Invalid LTC estimate.");
    }

    ctx.session.paymentFlow = {
      type: "ltc_withdraw_wallet",
      credits: credits,
      ltcUsdPrice: ltcPrice,
      estimatedLtc: estimatedLtc
    };

    return ctx.reply(
      "LTC withdrawal estimate\n\n" +
      "Credits: " + credits + "\n" +
      "LTC/USD price: $" + ltcPrice.toFixed(2) + "\n" +
      "Estimated payout: " + estimatedLtc.toFixed(8) + " LTC\n\n" +
      "Enter your Litecoin mainnet wallet address, or type /cancel."
    );
  } catch (error) {
    console.error("LTC withdrawal price error:", error.message);
    ctx.session.paymentFlow = null;
    return ctx.reply(
      "Live LTC pricing is unavailable. No withdrawal was created. Try again later."
    );
    }
    } else if (method === "ABA Bank") {
      currency = "ABA_BANK";
      prompt =
        "Enter your ABA account holder name and account number " +
        "on one line, separated by |.\n\n" +
        "Example format: Account Name | Account Number\n" +
        "Do not enter your PIN, password, or OTP.";
    } else {
      return ctx.reply(
        "Please choose USDT (TON), LTC, or ABA Bank."
      );
    }

    ctx.session.paymentFlow = {
      type: "withdraw_wallet",
      credits: flow.credits,
      currency: currency
    };

    return ctx.reply(prompt, Markup.removeKeyboard());
  }
  // ---------- END WITHDRAWAL METHOD ----------


  // ---------- WITHDRAWAL WALLET ----------
  if (flow.type === "withdraw_wallet") {
    const wallet = text.trim();

    
if (flow.currency === "ABA_BANK") {
  const parts = wallet.split("|").map(part => part.trim());

  if (
    parts.length !== 2 ||
    parts[0].length < 2 ||
    parts[0].length > 100 ||
    parts[1].length < 3 ||
    parts[1].length > 50
  ) {
    return ctx.reply(
      "Enter your ABA account holder name and account number separated by |.\n\n" +
      "Example format: Account Name | Account Number\n" +
      "Do not enter your PIN, password, or OTP.\n" +
      "Type /cancel to stop."
    );
  }
} else if (flow.currency === "USDT_TON") {
  if (!/^(0:)?[a-fA-F0-9]{64}$|^EQ[A-Za-z0-9_-]{46}$|^UQ[A-Za-z0-9_-]{46}$/.test(wallet)) {
    return ctx.reply(
      "That does not look like a supported TON wallet address. Check it and try again, or type /cancel."
    );
  }
} else {
  return ctx.reply(
    "Unsupported withdrawal method. Please start again."
  );
}


    const credits = Number(flow.credits);
    const minWithdraw = Number(process.env.MIN_WITHDRAW_CREDITS || 5000);
    const user = getUser(ctx.from);

    if (
      !Number.isSafeInteger(credits) ||
      credits < minWithdraw ||
      credits > Number(user.credits || 0)
    ) {
      ctx.session.paymentFlow = null;
      return ctx.reply(
        "Your withdrawal could not be submitted because your balance or requested amount is invalid. Please start again."
      );
    }

    if (!Array.isArray(db.withdrawals)) {
      db.withdrawals = [];
    }

    
const withdrawal = {
  id: String(Date.now()),
  userId: String(ctx.from.id),
  credits: credits,
  currency: flow.currency || "USDT_TON",
  method: flow.currency || "USDT_TON",
  wallet: wallet,
  accountDetails: flow.currency === "ABA_BANK" ? wallet : null,
  status: "pending_review",
  createdAt: new Date().toISOString()
};


    // Reserve the credits before requesting admin review.
    user.credits = Number(user.credits || 0) - credits;

    db.withdrawals.push(withdrawal);

    db.transactions.push({
      id: Date.now().toString() + "_withdrawal",
      userId: withdrawal.userId,
      type: "withdrawal_reserved",
      amount: -credits,
      withdrawalId: withdrawal.id,
      createdAt: new Date().toISOString()
    });

    saveDB();
    ctx.session.paymentFlow = null;

    if (ADMIN_ID) {
      try {
        await ctx.telegram.sendMessage(
          ADMIN_ID,
          "WITHDRAWAL NEEDS REVIEW\n\n" +
          "User ID: " + withdrawal.userId + "\n" +
          "Credits: " + credits + "\n" +
          
          "Payment method: " + withdrawal.method + "\n" +
          "Recipient details: " + wallet + "\n" +

          "Withdrawal ID: " + withdrawal.id + "\n\n" +
          "Verify the request before processing the payout.",
          Markup.inlineKeyboard([
            [
              Markup.button.callback(
                "Mark Paid",
                "withdrawpaid:" + withdrawal.id
              ),
              Markup.button.callback(
                "Reject & Refund",
                "withdrawreject:" + withdrawal.id
              )
            ]
          ])
        );
      } catch (error) {
        console.error(
          "Could not notify admin about withdrawal:",
          error.message
        );
      }
    }

    return ctx.reply(
      "Your withdrawal request has been submitted for review.\n\n" +
      "Credits reserved: " + credits + "\n" +
      "Status: Pending review\n" +
      "Your remaining balance: " + Number(user.credits || 0) + " credits\n\n" +
      "Method: " + withdrawal.method + "\n" +
      "Payout is not automatic. The administrator must review and process it."
    );
  }

  
  // ---------- LTC WITHDRAWAL INPUT ----------
  if (flow.type === "ltc_withdraw_amount") {
    const credits = Number(text);
    const minWithdraw = Number(process.env.MIN_WITHDRAW_CREDITS || 5000);
    const user = getUser(ctx.from);
    const balance = Number(user.credits || 0);

    if (!Number.isSafeInteger(credits) || credits < minWithdraw) {
      return ctx.reply(
        "Enter a whole number of credits. Minimum: " +
        minWithdraw +
        ". Type /cancel to stop."
      );
    }

    if (credits > balance) {
      return ctx.reply(
        "Insufficient balance. Available: " + balance + " credits."
      );
    }

    try {
      const ltcPrice = await getLtcUsdPrice();
      const creditsPerUsdt = Number(
        process.env.CREDITS_PER_USDT || 10000
      );

      if (!Number.isFinite(creditsPerUsdt) || creditsPerUsdt <= 0) {
        throw new Error("Invalid credit conversion rate.");
      }

      const estimatedLtc = credits / (ltcPrice * creditsPerUsdt);

      if (!Number.isFinite(estimatedLtc) || estimatedLtc <= 0) {
        throw new Error("Invalid LTC estimate.");
      }

      ctx.session.paymentFlow = {
        type: "ltc_withdraw_wallet",
        credits,
        ltcUsdPrice: ltcPrice,
        estimatedLtc
      };

      return ctx.reply(
        "LTC withdrawal estimate\n\n" +
        "Credits: " + credits + "\n" +
        "LTC/USD price: $" + ltcPrice.toFixed(2) + "\n" +
        "Estimated payout: " + estimatedLtc.toFixed(8) + " LTC\n\n" +
        "Enter your Litecoin mainnet wallet address, or type /cancel."
      );
    } catch (error) {
      console.error("LTC withdrawal price error:", error.message);
      return ctx.reply(
        "Live LTC pricing is unavailable. No withdrawal was created. Try again later."
      );
    }
  }

  if (flow.type === "ltc_withdraw_wallet") {
    const wallet = text.trim();

    // Basic format check; this does not verify the address on the blockchain.
    if (!/^(ltc1[ac-hj-np-z02-9]{20,}|[LM3][1-9A-HJ-NP-Za-km-z]{25,})$/.test(wallet)) {
      return ctx.reply(
        "That does not look like a valid Litecoin mainnet address. Check it and try again, or type /cancel."
      );
    }

    const credits = Number(flow.credits);
    const estimatedLtc = Number(flow.estimatedLtc);
    const ltcPrice = Number(flow.ltcUsdPrice);
    const minWithdraw = Number(process.env.MIN_WITHDRAW_CREDITS || 5000);

    db = loadDB();
    const user = getUser(ctx.from);

    if (
      !Number.isSafeInteger(credits) ||
      credits < minWithdraw ||
      credits > Number(user.credits || 0) ||
      !Number.isFinite(estimatedLtc) ||
      estimatedLtc <= 0 ||
      !Number.isFinite(ltcPrice) ||
      ltcPrice <= 0
    ) {
      ctx.session.paymentFlow = null;
      return ctx.reply(
        "Withdrawal details or balance are invalid. Please start again.",
        advertiserMenu()
      );
    }

    if (!Array.isArray(db.withdrawals)) db.withdrawals = [];
    if (!Array.isArray(db.transactions)) db.transactions = [];

    const withdrawal = {
      id: String(Date.now()),
      userId: String(ctx.from.id),
      credits,
      wallet,
      currency: "LTC",
      network: "Litecoin",
      amountLTC: estimatedLtc,
      ltcUsdPrice: ltcPrice,
      status: "pending_review",
      createdAt: new Date().toISOString()
    };

    // Reserve credits once, when the request is submitted.
    user.credits = Number(user.credits || 0) - credits;
    db.withdrawals.push(withdrawal);
    db.transactions.push({
      id: withdrawal.id + "_ltc_withdrawal",
      userId: withdrawal.userId,
      type: "withdrawal_reserved",
      amount: -credits,
      withdrawalId: withdrawal.id,
      currency: "LTC",
      createdAt: new Date().toISOString()
    });

    saveDB();
    ctx.session.paymentFlow = null;

    try {
      await ctx.reply(
        "LTC withdrawal submitted for admin review.\n\n" +
        "Credits reserved: " + credits + "\n" +
        "Estimated payout: " + estimatedLtc.toFixed(8) + " LTC\n" +
        "Status: Pending review.\n\n" +
        "The payout is manual, not automatic.",
        advertiserMenu()
      );

      if (ADMIN_ID) {
        await ctx.telegram.sendMessage(
          ADMIN_ID,
          "LTC WITHDRAWAL NEEDS REVIEW\n\n" +
          "User ID: " + withdrawal.userId + "\n" +
          "Credits reserved: " + credits + "\n" +
          "Estimated payout: " + estimatedLtc.toFixed(8) + " LTC\n" +
          "LTC/USD price used: $" + ltcPrice.toFixed(2) + "\n" +
          "Litecoin address: " + wallet + "\n" +
          "Withdrawal ID: " + withdrawal.id + "\n\n" +
          "Verify the address, amount, and available balance before sending. Only mark paid after the actual transfer is completed.",
          Markup.inlineKeyboard([
            [
              Markup.button.callback("Mark Paid", "withdrawpaid:" + withdrawal.id),
              Markup.button.callback("Reject & Refund", "withdrawreject:" + withdrawal.id)
            ]
          ])
        );
      }
    } catch (error) {
      console.error("LTC withdrawal notification error:", error.message);
    }

    return;
  }
  // ---------- END LTC WITHDRAWAL INPUT ----------


  // Other payment steps will be added after this section.
  return next();
});
// ---------- END PAYMENT INPUT HANDLER ----------


// ---------- CAMPAIGN TEXT WIZARD ----------
bot.on("text", async (ctx, next) => {
  const message = ctx.message.text.trim();
  if (message.startsWith("/")) return next();

  const wizard = ctx.session.wizard;
  if (!wizard) return next();
  const campaign = wizard.campaign;

  if (wizard.step === "campaign_title") {
    if (message.length < 3 || message.length > 80) {
      return ctx.reply("Title must contain 3–80 characters. Try again.");
    }

    campaign.title = message;
    wizard.step = "campaign_type";
    return ctx.reply(
      "Choose your campaign type:",
      Markup.inlineKeyboard([
        [Markup.button.callback("Visit Website / Read Article", "campaign_type_visit")],
        [Markup.button.callback("Watch Video", "campaign_type_video")],
        [Markup.button.callback("Social Engagement", "campaign_type_social")]
      ])
    );
  }

  if (wizard.step === "campaign_url") {
    let parsed;
    try {
      parsed = new URL(message);
    } catch {
      return ctx.reply("Please enter a valid URL beginning with https://");
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return ctx.reply("Only HTTP or HTTPS URLs are allowed.");
    }

    campaign.url = parsed.href;
    wizard.step = "campaign_tier";
    return ctx.reply(
      "Choose a country traffic tier:",
      Markup.inlineKeyboard([
        [Markup.button.callback("Tier 1 (+15%)", "tier:tier1")],
        [Markup.button.callback("Tier 2 (+10%)", "tier:tier2")],
        [Markup.button.callback("Tier 3 (+5%)", "tier:tier3")]
      ])
    );
  }

  if (wizard.step === "campaign_completions") {
    const completions = Number(message);
    if (!Number.isInteger(completions) || completions < 10 || completions > 5000) {
      return ctx.reply("Completions must be a whole number from 10 to 5000.");
    }

    campaign.completions = completions;
    campaign.completed = 0;
    campaign.effectiveReward = Number(campaign.effectiveReward || campaign.reward);
    // Earner reward stays unchanged; platform targets a 10% margin.
campaign.advertiserPricePerCompletion = Math.ceil(
  campaign.effectiveReward / 0.90
);

campaign.reservedBudget =
  campaign.advertiserPricePerCompletion * completions;

    if (!Number.isSafeInteger(campaign.reservedBudget) || campaign.reservedBudget < 1) {
      ctx.session.wizard = null;
      return ctx.reply("Invalid campaign budget. Please start again.", mainMenu());
    }

    const user = getUser(ctx.from);
    if ((Number(user.credits) || 0) < campaign.reservedBudget) {
      ctx.session.wizard = null;
      return ctx.reply(
        `❌ Not enough credits.\nRequired: ${campaign.reservedBudget}\nYour balance: ${user.credits}\n\nPlease add credits or create a smaller campaign.`,
        mainMenu()
      );
    }

    campaign.id = Date.now().toString();
    campaign.userId = ctx.from.id;
    campaign.status = "pending_review";
    campaign.createdAt = new Date().toISOString();

    user.credits -= campaign.reservedBudget;
    db.campaigns.push(campaign);
    db.transactions.push({
      id: (Date.now() + 1).toString(),
      userId: ctx.from.id,
      type: "campaign_budget_reserved",
      amount: -campaign.reservedBudget,
      campaignId: campaign.id,
      createdAt: new Date().toISOString()
    });

    saveDB();
    ctx.session.wizard = null;

    
await ctx.reply(
  "✅ Campaign submitted for admin review!\n\n" +
  `Campaign ID: ${campaign.id}\n` +
  `Title: ${campaign.title}\n` +
  `Pack: ${campaign.pack}\n` +
  `Tier: ${campaign.tier} (+${campaign.bonus * 100}%)\n\n` +
  `Earner reward per completion: ${campaign.effectiveReward} credits\n` +
  `Advertiser charge per completion: ${campaign.advertiserPricePerCompletion} credits\n` +
  `Platform profit per completion: ${campaign.advertiserPricePerCompletion - campaign.effectiveReward} credits\n` +
  `Completions: ${campaign.completions}\n` +
  `Total budget reserved: ${campaign.reservedBudget} credits\n` +
  `New balance: ${user.credits} credits\n\n` +
  "Your campaign will appear in available tasks after admin approval.",
  mainMenu()
);


    if (ADMIN_ID) {
      try {
        await ctx.telegram.sendMessage(
          ADMIN_ID,
          "🆕 CAMPAIGN REVIEW\n\n" +
          formatCampaign(campaign) +
          `\nReserved budget: ${campaign.reservedBudget} credits`,
          Markup.inlineKeyboard([[
            Markup.button.callback("✅ Approve", `campaignapprove:${campaign.id}`),
            Markup.button.callback("❌ Reject", `campaignreject:${campaign.id}`)
          ]])
        );
      } catch (error) {
        console.error("Could not notify admin about campaign:", error.message);
      }
    }
    return;
  }

  return next();
});


 // ---------- ADMIN DEPOSIT REVIEW ----------
bot.action(/^depositapprove:(\d+)$/, async ctx => {
  if (!ADMIN_ID || Number(ctx.from.id) !== ADMIN_ID) {
    return ctx.answerCbQuery("Admin only.", { show_alert: true });
  }

  const deposit = db.deposits.find(
    d => String(d.id) === String(ctx.match[1])
  );

  if (!deposit) {
    return ctx.answerCbQuery("Deposit not found.", { show_alert: true });
  }

  if (deposit.status !== "pending_review") {
    return ctx.answerCbQuery(
      "This deposit is already " + deposit.status + ".",
      { show_alert: true }
    );
  }

  const txHash = String(deposit.txHash || "").toLowerCase();
  if (!Array.isArray(db.transactions)) {
  db.transactions = [];
}
  const alreadyCredited = db.transactions.some(t =>
    t.type === "deposit_credit" &&
    (
      String(t.depositId) === String(deposit.id) ||
      String(t.txHash || "").toLowerCase() === txHash
    )
  );

  if (alreadyCredited) {
    deposit.status = "approved";
    deposit.reviewedAt = new Date().toISOString();
    deposit.reviewedBy = ctx.from.id;
    saveDB();

    return ctx.answerCbQuery(
      "A credit transaction already exists. No additional credits added.",
      { show_alert: true }
    );
  }

  
  const amount = Number(deposit.amount);
  const currency = String(deposit.currency || "USDT").toUpperCase();

  let credits;
  let ltcPriceUsed = null;

  if (currency === "LTC") {
    try {
      ltcPriceUsed = await getLtcUsdPrice();

      const creditsPerUsdt = Number(
        process.env.CREDITS_PER_USDT || 10000
      );

      if (
        !Number.isFinite(creditsPerUsdt) ||
        creditsPerUsdt <= 0
      ) {
        throw new Error("Invalid CREDITS_PER_USDT configuration.");
      }

      credits = Math.floor(
        amount * ltcPriceUsed * creditsPerUsdt
      );
    } catch (error) {
      console.error("LTC deposit pricing failed:", error.message);

      return ctx.answerCbQuery(
        "Cannot approve LTC: live price unavailable or invalid. Try again later.",
        { show_alert: true }
      );
    }
  
} else if (currency === "USDT") {
    const rate = Number(process.env.CREDITS_PER_USDT || 10000);

    if (!Number.isFinite(rate) || rate <= 0) {
      return ctx.answerCbQuery(
        "Invalid USDT credit rate. No credits added.",
        { show_alert: true }
      );
    }

    credits = Math.floor(amount * rate);
  } else if (currency === "ABA_USD") {
    const rate = Number(process.env.ABA_CREDITS_PER_USD || 10000);

    if (!Number.isFinite(rate) || rate <= 0) {
      return ctx.answerCbQuery(
        "Invalid ABA credit rate. No credits added.",
        { show_alert: true }
      );
    }

    credits = Math.floor(amount * rate);
  } else {

    return ctx.answerCbQuery(
      "Unsupported deposit currency. No credits added.",
      { show_alert: true }
    );
  }

  const user = db.users[String(deposit.userId)];

if (!user) {
  return ctx.answerCbQuery(
    "Cannot approve deposit: user record not found. No credits added.",
    { show_alert: true }
  );
}

  user.credits = (Number(user.credits) || 0) + credits;

  db.transactions.push({
    id: Date.now().toString(),
    userId: deposit.userId,
    type: "deposit_credit",
    amount: credits,
    depositId: deposit.id,
    txHash: deposit.txHash,
    currency: currency,
    ltcUsdPrice: ltcPriceUsed,
    createdAt: new Date().toISOString()
  });

  deposit.status = "approved";
  deposit.creditedAmount = credits;
    deposit.currency = currency;
  if (currency === "LTC") {
    deposit.ltcUsdPrice = ltcPriceUsed;
  }
  deposit.reviewedAt = new Date().toISOString();
  deposit.reviewedBy = ctx.from.id;

  saveDB();

  await ctx.answerCbQuery("Deposit approved and credits added.");
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

  try {
    await ctx.telegram.sendMessage(
      deposit.userId,
      "Your deposit was approved.\n" +
            "Amount: " + deposit.amount + " " + currency + "\n" +
      "Credits added: " + credits
    );
  } catch (error) {
    console.error("Could not notify deposit user:", error.message);
  }
});

bot.action(/^depositreject:(\d+)$/, async ctx => {
  if (!ADMIN_ID || Number(ctx.from.id) !== ADMIN_ID) {
    return ctx.answerCbQuery("Admin only.", { show_alert: true });
  }

  const deposit = db.deposits.find(
    d => String(d.id) === String(ctx.match[1])
  );

  if (!deposit) {
    return ctx.answerCbQuery("Deposit not found.", { show_alert: true });
  }

  if (deposit.status !== "pending_review") {
    return ctx.answerCbQuery(
      "This deposit is already " + deposit.status + ".",
      { show_alert: true }
    );
  }

  deposit.status = "rejected";
  deposit.reviewedAt = new Date().toISOString();
  deposit.reviewedBy = ctx.from.id;

  saveDB();

  await ctx.answerCbQuery("Deposit rejected.");
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

  try {
    await ctx.telegram.sendMessage(
      deposit.userId,
      "Your deposit request was rejected. No credits were added. Please contact the administrator if you believe this is an error."
    );
  } catch (error) {
    console.error("Could not notify deposit user:", error.message);
  }
});
// ---------- END ADMIN DEPOSIT REVIEW ----------


 // ---------- ADMIN WITHDRAWAL REVIEW ----------

bot.action(/^withdrawpaid:(\d+)$/, async ctx => {
  if (!ADMIN_ID || Number(ctx.from.id) !== ADMIN_ID) {
    return ctx.answerCbQuery("Admin access only.", { show_alert: true });
  }

  db = loadDB();
  if (!Array.isArray(db.withdrawals)) db.withdrawals = [];
  if (!Array.isArray(db.transactions)) db.transactions = [];

  const withdrawal = db.withdrawals.find(
    item => String(item.id) === String(ctx.match[1])
  );

  if (!withdrawal) {
    return ctx.answerCbQuery("Withdrawal not found.", { show_alert: true });
  }

  if (withdrawal.status !== "pending_review") {
    return ctx.answerCbQuery(
      "This withdrawal has already been reviewed.",
      { show_alert: true }
    );
  }

  // IMPORTANT: Send the payout manually before pressing Mark Paid.
  // This callback does not transfer cryptocurrency.
  withdrawal.status = "paid";
  withdrawal.paidAt = new Date().toISOString();
  withdrawal.paidBy = String(ctx.from.id);

  db.transactions.push({
    id: String(Date.now()) + "_withdrawal_paid",
    userId: String(withdrawal.userId),
    type: "withdrawal_paid",
    amount: 0,
    withdrawalId: String(withdrawal.id),
    createdAt: new Date().toISOString()
  });

  saveDB();

  try {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  } catch (error) {
    console.error("Could not remove withdrawal buttons:", error.message);
  }

  await ctx.answerCbQuery("Withdrawal marked as paid.");

  try {
    await ctx.telegram.sendMessage(
      Number(withdrawal.userId),
      "Your withdrawal has been marked as paid by the administrator.\n\n" +
      "Credits: " + withdrawal.credits + "\n" +
      
(
  String(withdrawal.currency || "USDT_TON").toUpperCase() === "LTC"
    ? "Litecoin wallet: " + withdrawal.wallet + "\n\n"
    : String(withdrawal.currency || "USDT_TON").toUpperCase() === "ABA_BANK"
      ? "ABA account details: " +
        (withdrawal.accountDetails || withdrawal.wallet) + "\n\n"
      : "TON wallet: " + withdrawal.wallet + "\n\n"
) +

      "Please check your wallet for the actual transfer."
    );
  } catch (error) {
    console.error("Could not notify withdrawal user:", error.message);
  }

  return ctx.reply(
    "Withdrawal " + withdrawal.id +
    " marked as paid. Ensure the manual payout was actually sent."
  );
});

bot.action(/^withdrawreject:(\d+)$/, async ctx => {
  if (!ADMIN_ID || Number(ctx.from.id) !== ADMIN_ID) {
    return ctx.answerCbQuery("Admin access only.", { show_alert: true });
  }

  db = loadDB();
  if (!Array.isArray(db.withdrawals)) db.withdrawals = [];
  if (!Array.isArray(db.transactions)) db.transactions = [];

  const withdrawal = db.withdrawals.find(
    item => String(item.id) === String(ctx.match[1])
  );

  if (!withdrawal) {
    return ctx.answerCbQuery("Withdrawal not found.", { show_alert: true });
  }

  if (withdrawal.status !== "pending_review") {
    return ctx.answerCbQuery(
      "This withdrawal has already been reviewed.",
      { show_alert: true }
    );
  }

  const user = db.users[String(withdrawal.userId)];

  if (!user) {
    return ctx.answerCbQuery(
      "User record not found. No refund was made.",
      { show_alert: true }
    );
  }

  const alreadyRefunded = db.transactions.some(
    item =>
      item.type === "withdrawal_refund" &&
      String(item.withdrawalId) === String(withdrawal.id)
  );

  if (alreadyRefunded) {
    return ctx.answerCbQuery(
      "A refund record already exists. Please investigate the database.",
      { show_alert: true }
    );
  }

  const credits = Number(withdrawal.credits);

  if (!Number.isSafeInteger(credits) || credits <= 0) {
    return ctx.answerCbQuery(
      "Invalid withdrawal amount. No refund was made.",
      { show_alert: true }
    );
  }

  const balance = Number(user.credits || 0);

  if (!Number.isSafeInteger(balance) || balance < 0 ||
      !Number.isSafeInteger(balance + credits)) {
    return ctx.answerCbQuery(
      "Invalid user balance. No refund was made.",
      { show_alert: true }
    );
  }

  user.credits = balance + credits;

  db.transactions.push({
    id: String(Date.now()) + "_withdrawal_refund",
    userId: String(withdrawal.userId),
    type: "withdrawal_refund",
    amount: credits,
    withdrawalId: String(withdrawal.id),
    createdAt: new Date().toISOString()
  });

  withdrawal.status = "rejected";
  withdrawal.reviewedAt = new Date().toISOString();
  withdrawal.reviewedBy = String(ctx.from.id);
  withdrawal.refunded = true;

  saveDB();

  try {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  } catch (error) {
    console.error("Could not remove withdrawal buttons:", error.message);
  }

  await ctx.answerCbQuery("Withdrawal rejected and credits refunded.");

  try {
    await ctx.telegram.sendMessage(
      Number(withdrawal.userId),
      "Your withdrawal request was rejected.\n\n" +
      "Refunded credits: " + credits + "\n" +
      "Your updated balance: " + user.credits + " credits"
    );
  } catch (error) {
    console.error("Could not notify withdrawal user:", error.message);
  }

  return ctx.reply(
    "Withdrawal " + withdrawal.id +
    " rejected. " + credits + " credits refunded."
  );
});

// ---------- END ADMIN WITHDRAWAL REVIEW ----------


// ---------- ADMIN CAMPAIGN REVIEW ----------
bot.action(/^campaignapprove:(\d+)$/, async ctx => {
  if (!ADMIN_ID || ctx.from.id !== ADMIN_ID) {
    return ctx.answerCbQuery("Admin only.", { show_alert: true });
  }

  const campaign = db.campaigns.find(c => String(c.id) === String(ctx.match[1]));
  if (!campaign) return ctx.answerCbQuery("Campaign not found.", { show_alert: true });
  if (campaign.status !== "pending_review") {
    return ctx.answerCbQuery(`Already ${campaign.status}.`, { show_alert: true });
  }

  campaign.status = "approved";
  campaign.reviewedAt = new Date().toISOString();
  campaign.reviewedBy = ctx.from.id;
  saveDB();

  await ctx.answerCbQuery("Campaign approved.");
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply(`✅ Campaign ${campaign.id} approved.`);

  try {
    await ctx.telegram.sendMessage(
      campaign.userId,
      `✅ Your campaign "${campaign.title}" has been approved and is now available for tasks.`
    );
  } catch (error) {
    console.error("Could not notify campaign owner:", error.message);
  }
});

bot.action(/^campaignreject:(\d+)$/, async ctx => {
  if (!ADMIN_ID || ctx.from.id !== ADMIN_ID) {
    return ctx.answerCbQuery("Admin only.", { show_alert: true });
  }

  const campaign = db.campaigns.find(c => String(c.id) === String(ctx.match[1]));
  if (!campaign) return ctx.answerCbQuery("Campaign not found.", { show_alert: true });
  if (campaign.status !== "pending_review") {
    return ctx.answerCbQuery(`Already ${campaign.status}.`, { show_alert: true });
  }

  campaign.status = "rejected";
  campaign.reviewedAt = new Date().toISOString();
  campaign.reviewedBy = ctx.from.id;

  if (!campaign.budgetRefunded) {
    const owner = db.users[String(campaign.userId)];
    if (owner) {
      owner.credits = (Number(owner.credits) || 0) + (Number(campaign.reservedBudget) || 0);
    }
    db.transactions.push({
      id: Date.now().toString(),
      userId: campaign.userId,
      type: "campaign_budget_refund",
      amount: Number(campaign.reservedBudget) || 0,
      campaignId: campaign.id,
      createdAt: new Date().toISOString()
    });
    campaign.budgetRefunded = true;
  }

  saveDB();
  await ctx.answerCbQuery("Campaign rejected and budget refunded.");
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply(`❌ Campaign ${campaign.id} rejected and budget refunded.`);

  try {
    await ctx.telegram.sendMessage(
      campaign.userId,
      `❌ Your campaign "${campaign.title}" was rejected. Reserved budget refunded: ${campaign.reservedBudget || 0} credits.`
    );
  } catch (error) {
    console.error("Could not notify campaign owner:", error.message);
  }
});


 // ---------- TASK SELECTION ----------

bot.action(/^taskselect:(\d+)$/, async ctx => {
  const campaignId = String(ctx.match[1]);
  const campaign = db.campaigns.find(c => String(c.id) === campaignId);

  if (!campaign || !isCampaignOpen(campaign)) {
    return ctx.answerCbQuery("This campaign is no longer available.", { show_alert: true });
  }

  if (String(campaign.userId) === String(ctx.from.id)) {
    return ctx.answerCbQuery("You cannot complete your own campaign.", { show_alert: true });
  }

  const duplicate = db.submissions.some(s =>
    String(s.userId) === String(ctx.from.id) &&
    String(s.campaignId) === campaignId &&
    ["pending_review", "approved"].includes(s.status)
  );

  if (duplicate) {
    return ctx.answerCbQuery("You have already submitted this campaign.", { show_alert: true });
  }

  if (!Array.isArray(db.taskVerifications)) {
    db.taskVerifications = [];
  }

  for (const item of db.taskVerifications) {
    if (
      String(item.userId) === String(ctx.from.id) &&
      String(item.campaignId) === campaignId &&
      item.status !== "used"
    ) {
      item.status = "expired";
      item.websiteTokenHash = null;
      item.websiteTokenExpiresAt = 0;
    }
  }

  const websiteToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256")
    .update(websiteToken)
    .digest("hex");

  const waitSeconds = getTaskWaitSeconds(campaign);

  db.taskVerifications.push({
    id: crypto.randomBytes(8).toString("hex"),
    userId: String(ctx.from.id),
    campaignId,
    status: "website_ready",
    websiteTokenHash: tokenHash,
    websiteTokenExpiresAt: Date.now() + 30 * 60 * 1000,
    waitSeconds,
    attempts: 0,
    createdAt: new Date().toISOString()
  });

  saveDB();

  ctx.session.taskSubmission = {
    campaignId,
    proofType: null,
    keywordVerified: false,
    awaitingCaptchaAnswer: false,
    awaitingKeyword: true
  };

  const baseUrl = String(
    process.env.TASK_WEB_BASE_URL || "http://localhost:3000"
  ).replace(/\/+$/, "");

  const websiteUrl =
    `${baseUrl}/task.html?campaign=${encodeURIComponent(campaignId)}` +
    `&token=${encodeURIComponent(websiteToken)}`;

  await ctx.answerCbQuery();

  return ctx.reply(
    "📋 TASK INSTRUCTIONS\n\n" +
    `Campaign: ${campaign.title}\n` +
    `Type: ${campaign.type || "Website"}\n` +
    `Required timer: ${waitSeconds} seconds\n` +
    `Reward: ${campaign.effectiveReward || campaign.reward} credits\n\n` +
    "1. Open the verification page.\n" +
    "2. Start the timer on the webpage.\n" +
    "3. Solve the CAPTCHA when the timer finishes.\n" +
    "4. Send the keyword displayed on the webpage in this chat.\n" +
    "5. Submit your proof for manual review.\n\n" +
    "The verification link expires in 30 minutes.",
    Markup.inlineKeyboard([
      [Markup.button.url("🔐 Open Verification Page", websiteUrl)],
      [Markup.button.url("🔗 Open Campaign", campaign.url)]
    ])
  );
});

// ---------- TASK TIMER START ----------
bot.action(/^tasktimerstart:(\d+)$/, async ctx => {
  const campaignId = String(ctx.match[1]);
  const campaign = db.campaigns.find(c => String(c.id) === campaignId);
  const state = ctx.session.taskSubmission;

  if (!campaign || !isCampaignOpen(campaign) || !state || String(state.campaignId) !== campaignId) {
    return ctx.answerCbQuery("Please select an available campaign again.", { show_alert: true });
  }
  if (String(campaign.userId) === String(ctx.from.id)) {
    return ctx.answerCbQuery("You cannot complete your own campaign.", { show_alert: true });
  }

  if (!Array.isArray(db.taskVerifications)) db.taskVerifications = [];
  let verification = db.taskVerifications.find(item =>
    String(item.userId) === String(ctx.from.id) &&
    String(item.campaignId) === campaignId &&
    item.status !== "used"
  );

  if (verification && ["keyword_issued", "verified"].includes(verification.status) &&
      Number(verification.keywordExpiresAt || 0) > Date.now()) {
    await ctx.answerCbQuery("You already have an active keyword for this task.");
    return ctx.reply("Enter your task keyword in this chat to continue, or type /cancel to restart the task.");
  }

  if (verification && verification.status === "waiting" &&
      Date.now() - Number(verification.startedAt) < Number(verification.waitSeconds) * 1000) {
    const remaining = Math.ceil((Number(verification.startedAt) + Number(verification.waitSeconds) * 1000 - Date.now()) / 1000);
    await ctx.answerCbQuery(`Timer is already running: ${remaining}s left.`, { show_alert: true });
    return;
  }

  if (verification) {
    verification.status = "waiting";
    verification.startedAt = Date.now();
    verification.waitSeconds = getTaskWaitSeconds(campaign);
    verification.captchaAnswer = null;
    verification.captchaQuestion = null;
    verification.keywordHash = null;
    verification.keywordExpiresAt = null;
    verification.attempts = 0;
  } else {
    verification = {
      id: crypto.randomBytes(8).toString("hex"),
      userId: String(ctx.from.id),
      campaignId,
      status: "waiting",
      startedAt: Date.now(),
      waitSeconds: getTaskWaitSeconds(campaign),
      attempts: 0,
      createdAt: new Date().toISOString()
    };
    db.taskVerifications.push(verification);
  }
  saveDB();
  await ctx.answerCbQuery("Countdown started.");
  const sent = await ctx.reply(
    `⏳ TASK TIMER\n\nTime remaining: ${verification.waitSeconds} seconds\n\nKeep the task open and return when the timer finishes. Then tap Check Timer.`,
    Markup.inlineKeyboard([[
      Markup.button.callback("Check Timer / Continue", `tasktimercheck:${campaignId}`)
    ]])
  );
  startTaskCountdownDisplay(bot, ctx.chat.id, sent.message_id, verification);
});

// ---------- TASK TIMER CHECK AND CAPTCHA ----------
bot.action(/^tasktimercheck:(\d+)$/, async ctx => {
  const campaignId = String(ctx.match[1]);
  const campaign = db.campaigns.find(c => String(c.id) === campaignId);
  const verification = getTaskVerification(ctx.from.id, campaignId);
  const state = ctx.session.taskSubmission;

  if (!campaign || !state || String(state.campaignId) !== campaignId || !verification) {
    return ctx.answerCbQuery("Task session not found. Select the campaign again.", { show_alert: true });
  }
  if (verification.status !== "waiting") {
    if (verification.status === "captcha_pending") {
      await ctx.answerCbQuery("Verification question already issued.");
      return ctx.reply(`🧩 Solve this verification question: ${verification.captchaQuestion} = ?\n\nType the answer here.`);
    }
    if (["keyword_issued", "verified"].includes(verification.status)) {
      await ctx.answerCbQuery("Your keyword verification is in progress.");
      return ctx.reply("Enter your task keyword in this chat to continue.");
    }
    return ctx.answerCbQuery("Please start the task timer again.", { show_alert: true });
  }

  const elapsed = Math.floor((Date.now() - Number(verification.startedAt)) / 1000);
  const remaining = Number(verification.waitSeconds) - elapsed;
  if (remaining > 0) {
    return ctx.answerCbQuery(`Please wait ${remaining} more seconds.`, { show_alert: true });
  }

  const captcha = makeTaskCaptcha();
  verification.status = "captcha_pending";
  verification.captchaQuestion = captcha.question;
  verification.captchaAnswer = hashTaskKeyword(captcha.answer);
  verification.captchaExpiresAt = Date.now() + 10 * 60 * 1000;
  verification.attempts = 0;
  saveDB();

  state.awaitingCaptchaAnswer = true;
  state.awaitingKeyword = false;
  state.keywordVerified = false;
  await ctx.answerCbQuery("Timer completed.");
  return ctx.reply(
    "✅ TIMER COMPLETED\n\n" +
    "🧩 Anti-bot verification: solve this question\n\n" +
    `${captcha.question} = ?\n\n` +
    "Type the answer in this chat. You have 10 minutes."
  );
});

// ---------- CHOOSE TASK PROOF TYPE ----------
bot.action(/^taskproof:(url|photo|text)$/, async ctx => {
  const state = ctx.session.taskSubmission;

  if (!state) {
    return ctx.answerCbQuery(
      "Your task session expired. Please select the campaign again.",
      { show_alert: true }
    );
  }

  state.proofType = ctx.match[1];
  await ctx.answerCbQuery();

  const instructions = {
    url: "🔗 Send the public URL as your proof.",
    photo: "📸 Send your screenshot as a photo in this chat.",
    text: "📝 Type your proof as a text message."
  };

  await ctx.reply(
    instructions[state.proofType] +
    "\n\nSend /cancel to cancel."
  );
});


 // ---------- TASK PROOF SUBMISSION: SEND TO ADVERTISER ----------
async function saveTaskProof(ctx, proof, proofType) {
  const state = ctx.session.taskSubmission;
  if (!state) return false;

  const verification = getTaskVerification(ctx.from.id, state.campaignId);
  if (!state.keywordVerified || !verification || verification.status !== "verified" ||
      Number(verification.keywordExpiresAt || 0) < Date.now()) {
    ctx.session.taskSubmission = null;
    await ctx.reply("❌ A valid, unused keyword is required before submitting proof. Please select the task and verify again.", mainMenu());
    return true;
  }

  const campaign = db.campaigns.find(
    c => String(c.id) === String(state.campaignId)
  );

  if (!campaign || !isCampaignOpen(campaign)) {
    ctx.session.taskSubmission = null;
    await ctx.reply(
      "This campaign is no longer available.",
      mainMenu()
    );
    return true;
  }

  const duplicate = db.submissions.some(s =>
    String(s.userId) === String(ctx.from.id) &&
    String(s.campaignId) === String(campaign.id) &&
    ["pending_review", "approved"].includes(s.status)
  );

  if (duplicate) {
    ctx.session.taskSubmission = null;
    await ctx.reply(
      "You have already submitted proof for this campaign.",
      mainMenu()
    );
    return true;
  }

  const submission = {
    id: Date.now().toString(),
    userId: ctx.from.id,
    campaignId: String(campaign.id),
    proof,
    proofType,
    keywordVerified: true,
    verificationId: verification.id,
    status: "pending_review",
    submittedAt: new Date().toISOString()
  };

  db.submissions.push(submission);
  verification.status = "used";
  verification.usedAt = new Date().toISOString();
  verification.submissionId = submission.id;
  saveDB();
  ctx.session.taskSubmission = null;

  await ctx.reply(
    "✅ Your proof has been submitted!\n\n" +
    `Submission ID: ${submission.id}\n` +
    "Proof type: " + proofType + "\n" +
    "Keyword: Verified\n" +
    "Status: Pending advertiser review\n\n" +
    "Your reward is added only after the advertiser approves your proof.",
    mainMenu()
  );

  const advertiserId = Number(campaign.userId);

  if (advertiserId) {
    try {
      if (proofType === "Screenshot") {
        await ctx.telegram.sendPhoto(
          advertiserId,
          proof,
          {
            caption:
              "📩 NEW TASK SUBMISSION TO REVIEW\n\n" +
              `Campaign: ${campaign.title}\n` +
              `Campaign ID: ${campaign.id}\n` +
              `Submission ID: ${submission.id}\n` +
              `Worker ID: ${submission.userId}\n` +
              `Worker username: ${ctx.from.username || "Not provided"}\n` +
              "Proof type: Screenshot\n" +
              "Keyword: VERIFIED\n\nPlease review this submission.",
            ...Markup.inlineKeyboard([[
              Markup.button.callback(
                "✅ Approve Proof",
                `taskapprove:${submission.id}`
              ),
              Markup.button.callback(
                "❌ Reject Proof",
                `taskreject:${submission.id}`
              )
            ]])
          }
        );
      } else {
        await ctx.telegram.sendMessage(
          advertiserId,
          "📩 NEW TASK SUBMISSION TO REVIEW\n\n" +
          `Campaign: ${campaign.title}\n` +
          `Campaign ID: ${campaign.id}\n` +
          `Submission ID: ${submission.id}\n` +
          `Worker ID: ${submission.userId}\n` +
          `Worker username: ${ctx.from.username || "Not provided"}\n` +
          `Proof type: ${proofType}\n` +
          "Keyword: VERIFIED\n\n" +
          `Proof:\n${proof}\n\nPlease review this submission.`,
          Markup.inlineKeyboard([[
            Markup.button.callback(
              "✅ Approve Proof",
              `taskapprove:${submission.id}`
            ),
            Markup.button.callback(
              "❌ Reject Proof",
              `taskreject:${submission.id}`
            )
          ]])
        );
      }
    } catch (error) {
      console.error(
        "Could not notify campaign advertiser:",
        error.message
      );

      await ctx.telegram.sendMessage(
        ctx.from.id,
        "⚠️ Your proof was saved, but Telegram could not notify the advertiser. Please contact support."
      ).catch(() => {});
    }
  }

  return true;
}

// Handle text proof and URL proof
bot.on("text", async (ctx, next) => {
  const state = ctx.session.taskSubmission;

  if (!state) return next();

  // Let active payment and withdrawal flows handle their own messages.
  if (ctx.session.paymentFlow) return next();

  const text = ctx.message.text.trim();

  if (text.startsWith("/")) return next();

  if (state.awaitingCaptchaAnswer) {
    const verification = getTaskVerification(ctx.from.id, state.campaignId);
    if (!verification || verification.status !== "captcha_pending" ||
        Number(verification.captchaExpiresAt || 0) < Date.now()) {
      if (verification) verification.status = "expired";
      saveDB();
      ctx.session.taskSubmission = null;
      return ctx.reply("Your verification expired. Please select the task and start again.", mainMenu());
    }

    verification.attempts = Number(verification.attempts || 0) + 1;
    if (hashTaskKeyword(text) !== verification.captchaAnswer) {
      if (verification.attempts >= 3) {
        verification.status = "failed";
        saveDB();
        ctx.session.taskSubmission = null;
        return ctx.reply("❌ Too many incorrect answers. Please select the task and restart verification.", mainMenu());
      }
      saveDB();
      return ctx.reply(`Incorrect answer. Attempts left: ${3 - verification.attempts}. Try again.`);
    }

    const keyword = crypto.randomBytes(4).toString("hex").toUpperCase();
    verification.status = "keyword_issued";
    verification.keywordHash = hashTaskKeyword(keyword);
    verification.keywordExpiresAt = Date.now() + 15 * 60 * 1000;
    verification.keywordIssuedAt = new Date().toISOString();
    verification.captchaAnswer = null;
    state.awaitingCaptchaAnswer = false;
    state.awaitingKeyword = true;
    saveDB();
    return ctx.reply(
      "✅ Verification passed!\n\n" +
      "Your task keyword is:\n" +
      keyword + "\n\n" +
      "Copy it and send the keyword in this chat to unlock proof submission.\n" +
      "It expires in 15 minutes and can only be used for this task."
    );
  }

  
if (state.awaitingKeyword) {
  const verification = getTaskVerification(ctx.from.id, state.campaignId);

  if (
    !verification ||
    verification.status !== "keyword_issued" ||
    Number(verification.keywordExpiresAt || 0) < Date.now()
  ) {
    if (verification && verification.status === "keyword_issued") {
      verification.status = "expired";
    }

    saveDB();
    ctx.session.taskSubmission = null;

    return ctx.reply(
      "Your keyword expired or is invalid. Please select the task and verify again.",
      mainMenu()
    );
  }

  if (hashTaskKeyword(text) !== verification.keywordHash) {
    return ctx.reply(
      "❌ Incorrect keyword. Please enter the exact keyword shown on the verification webpage."
    );
  }

  verification.status = "verified";
  verification.keywordVerifiedAt = new Date().toISOString();

  state.awaitingKeyword = false;
  state.keywordVerified = true;

  saveDB();

  return ctx.reply(
    "✅ KEYWORD VERIFIED\n\nChoose the proof type you want to submit:",
    Markup.inlineKeyboard([
      [Markup.button.callback("🔗 Submit URL", "taskproof:url")],
      [Markup.button.callback("📸 Submit Screenshot", "taskproof:photo")],
      [Markup.button.callback("📝 Submit Text", "taskproof:text")]
    ])
  );
}

  if (!state.proofType) {
    return ctx.reply("Please complete the timer, solve the verification question, and enter your keyword first.");
  }

  if (state.proofType === "photo") {
    return ctx.reply("You selected Screenshot. Please send a screenshot photo.");
  }

  if (text.length < 3 || text.length > 2000) {
    return ctx.reply("Please send proof containing 3–2000 characters.");
  }

  if (state.proofType === "url") {
    if (!/^https?:\/\/\S+$/i.test(text)) {
      return ctx.reply("Please send a valid public URL beginning with https:// or http://.");
    }
    return saveTaskProof(ctx, text, "URL");
  }

  return saveTaskProof(ctx, text, "Text");
});

// Handle screenshot/photo proof
bot.on("photo", async (ctx, next) => {
  const state = ctx.session.taskSubmission;

  if (!state) return next();

  if (ctx.session.paymentFlow) return next();

  if (!state.proofType) {
    return ctx.reply("Please choose Submit Screenshot first, then send your screenshot.");
  }

  if (state.proofType !== "photo") {
    return ctx.reply("You selected a different proof type. Please send the proof you selected.");
  }

  const photos = ctx.message.photo;
  const bestPhoto = photos[photos.length - 1];

  return saveTaskProof(ctx, bestPhoto.file_id, "Screenshot");
});
// ---------- END TASK PROOF SUBMISSION ----------

// ---------- ADVERTISER: APPROVE TASK PROOF ----------
bot.action(/^taskapprove:(\d+)$/, async ctx => {
  const submission = db.submissions.find(s => String(s.id) === String(ctx.match[1]));
  if (!submission) return ctx.answerCbQuery("Submission not found.", { show_alert: true });

  const campaign = db.campaigns.find(c => String(c.id) === String(submission.campaignId));
  if (!campaign) return ctx.answerCbQuery("Campaign not found.", { show_alert: true });

  if (String(ctx.from.id) !== String(campaign.userId)) {
    return ctx.answerCbQuery("Only this campaign's advertiser can approve.", { show_alert: true });
  }

  if (submission.status !== "pending_review") {
    return ctx.answerCbQuery(`Already ${submission.status}.`, { show_alert: true });
  }

  const limit = Number(campaign.completions);
  const completed = Number(campaign.completed) || 0;

  if (
    campaign.status !== "approved" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    completed >= limit
  ) {
    submission.status = "rejected";
    submission.reviewNote = "Campaign limit reached or campaign unavailable.";
    submission.reviewedAt = new Date().toISOString();
    submission.reviewedBy = ctx.from.id;
    saveDB();

    await ctx.answerCbQuery("Campaign is no longer available.", { show_alert: true });
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await ctx.telegram.sendMessage(
      submission.userId,
      "❌ Your submission was not approved because the campaign is no longer available."
    ).catch(() => {});
    return;
  }

  const alreadyPaid = db.transactions.some(t =>
    String(t.submissionId) === String(submission.id) &&
    t.type === "task_reward"
  );

  if (alreadyPaid) {
    return ctx.answerCbQuery("Reward transaction already exists.", { show_alert: true });
  }

  const worker = db.users[String(submission.userId)];
  if (!worker) return ctx.answerCbQuery("Worker account not found.", { show_alert: true });

  const reward = Number(campaign.effectiveReward || campaign.reward);
  if (!Number.isSafeInteger(reward) || reward < 1) {
    return ctx.answerCbQuery("Invalid reward configuration.", { show_alert: true });
  }

  worker.credits = (Number(worker.credits) || 0) + reward;
  campaign.completed = completed + 1;

  submission.status = "approved";
  submission.reviewedAt = new Date().toISOString();
  submission.reviewedBy = ctx.from.id;
  submission.reward = reward;

  db.transactions.push({
    id: Date.now().toString(),
    userId: submission.userId,
    type: "task_reward",
    amount: reward,
    campaignId: campaign.id,
    submissionId: submission.id,
    createdAt: new Date().toISOString()
  });

  saveDB();
  await ctx.answerCbQuery("Approved. Reward recorded.");
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply(
    `✅ TASK APPROVED\n\nCampaign: ${campaign.title}\nSubmission ID: ${submission.id}\n` +
    `Worker ID: ${submission.userId}\nReward: ${reward} credits\nCompleted: ${campaign.completed}/${limit}`
  );

  await ctx.telegram.sendMessage(
    submission.userId,
    `✅ Your task was approved by the advertiser!\n\nCampaign: ${campaign.title}\n` +
    `Reward: +${reward} credits\nNew balance: ${worker.credits} credits`
  ).catch(error => console.error("Worker notification failed:", error.message));
});

// ---------- ADVERTISER: REJECT TASK PROOF ----------
bot.action(/^taskreject:(\d+)$/, async ctx => {
  const submission = db.submissions.find(s => String(s.id) === String(ctx.match[1]));
  if (!submission) return ctx.answerCbQuery("Submission not found.", { show_alert: true });

  const campaign = db.campaigns.find(c => String(c.id) === String(submission.campaignId));
  if (!campaign) return ctx.answerCbQuery("Campaign not found.", { show_alert: true });

  if (String(ctx.from.id) !== String(campaign.userId)) {
    return ctx.answerCbQuery("Only this campaign's advertiser can reject.", { show_alert: true });
  }

  if (submission.status !== "pending_review") {
    return ctx.answerCbQuery(`Already ${submission.status}.`, { show_alert: true });
  }

  submission.status = "rejected";
  submission.reviewedAt = new Date().toISOString();
  submission.reviewedBy = ctx.from.id;
  submission.reviewNote = "Rejected by campaign advertiser.";
  saveDB();

  await ctx.answerCbQuery("Submission rejected.");
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply(
    `❌ TASK SUBMISSION REJECTED\n\nCampaign: ${campaign.title}\n` +
    `Submission ID: ${submission.id}\nWorker ID: ${submission.userId}`
  );

  await ctx.telegram.sendMessage(
    submission.userId,
    `❌ Your task submission was rejected by the advertiser.\n\nCampaign: ${campaign.title}\n` +
    "Contact the advertiser or support if you believe this was a mistake."
  ).catch(error => console.error("Worker notification failed:", error.message));
});

// ---------- ERROR HANDLING ----------
bot.catch((error, ctx) => {
  console.error(`TrafficPilot error on update ${ctx.update?.update_id}:`, error);
});

// ---------- START BOT ----------
bot.launch()
  .then(() => console.log("TrafficPilot bot is running."))
  .catch(error => {
    console.error("Failed to start TrafficPilot bot:", error);
    process.exitCode = 1;
  });

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
