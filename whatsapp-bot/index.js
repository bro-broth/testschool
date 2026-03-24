import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";
import { DateTime } from "luxon";

const app = express();
app.use(express.json());

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  greenApi: {
    instanceId: process.env.GREEN_API_INSTANCE_ID,
    token: process.env.GREEN_API_TOKEN,
    baseUrl: () =>
      `https://api.green-api.com/waInstance${CONFIG.greenApi.instanceId}`,
  },
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY,
    model: "anthropic/claude-haiku-3",
  },
  google: {
    spreadsheetId: "1RH2QfwJcpmb3DdroD4aOjUf4CShw_JTuhOlX32wIKLs",
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS || "{}"),
  },
  manager: {
    phone: "380737506558", // без +
    whatsappId: "380737506558@c.us",
  },
  timezone: "Asia/Bangkok", // UTC+7
  schoolName: "Phuket Dance Academy",
};

// ─── LOCATIONS ────────────────────────────────────────────────────────────────
const LOCATIONS = [
  {
    id: "patong",
    name: "Патонг",
    address: "Patong Beach Rd, 15, Kathu District",
    districts: ["патонг", "patong", "пляж", "центр", "карон", "karon"],
  },
  {
    id: "chalong",
    name: "Чалонг",
    address: "Chao Fah West Rd, 42, Mueang District",
    districts: ["чалонг", "chalong", "юг", "раваи", "rawai", "най харн", "nai harn"],
  },
  {
    id: "laguna",
    name: "Лагуна",
    address: "Laguna Resort Blvd, 8, Thalang District",
    districts: ["лагуна", "laguna", "север", "bang tao", "банг тао", "сурин", "surin", "камала", "kamala"],
  },
];

// ─── SCHEDULE ─────────────────────────────────────────────────────────────────
// Пробные уроки: каждый вторник и четверг в 12:00 Bangkok Time
function getNextTrialSlots(count = 3) {
  const now = DateTime.now().setZone(CONFIG.timezone);
  const slots = [];
  let cursor = now;

  while (slots.length < count) {
    cursor = cursor.plus({ days: 1 });
    const weekday = cursor.weekday; // 2=вт, 4=чт
    if (weekday === 2 || weekday === 4) {
      const slot = cursor.set({ hour: 12, minute: 0, second: 0 });
      slots.push({
        iso: slot.toISO(),
        display: slot.setLocale("ru").toFormat("EEEE, d MMMM, HH:mm"),
        short: slot.toFormat("dd.MM.yyyy HH:mm"),
      });
    }
  }
  return slots;
}

function findNearestLocation(text) {
  const lower = text.toLowerCase();
  for (const loc of LOCATIONS) {
    if (loc.districts.some((d) => lower.includes(d))) return loc;
  }
  return null;
}

// ─── SESSION STORE ────────────────────────────────────────────────────────────
const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      chatId,
      history: [],
      state: "new", // new → name → age → district → slot → booked
      data: {
        name: null,
        age: null,
        phone: chatId.replace("@c.us", ""),
        location: null,
        slot: null,
      },
    });
  }
  return sessions.get(chatId);
}

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
function buildSystemPrompt(session) {
  const now = DateTime.now().setZone(CONFIG.timezone);
  const slots = getNextTrialSlots(3);

  const locationsList = LOCATIONS.map(
    (l) => `- ${l.name} (${l.address}) — районы: ${l.districts.slice(0, 4).join(", ")}`
  ).join("\n");

  const slotsList = slots
    .map((s, i) => `${i + 1}. ${s.display}`)
    .join("\n");

  return `Ты — приветливый помощник школы танцев "${CONFIG.schoolName}" в Пхукете, Таиланд.
Твоя ГЛАВНАЯ задача — записать клиента на бесплатный пробный урок.

ТЕКУЩЕЕ ВРЕМЯ: ${now.setLocale("ru").toFormat("EEEE, d MMMM yyyy, HH:mm")} (Bangkok Time, UTC+7)

ЛОКАЦИИ ШКОЛЫ:
${locationsList}

БЛИЖАЙШИЕ ПРОБНЫЕ УРОКИ (только вторник и четверг, 12:00):
${slotsList}

ДАННЫЕ КЛИЕНТА УЖЕ СОБРАНЫ:
- Имя: ${session.data.name || "не спрошено"}
- Возраст: ${session.data.age || "не спрошен"}
- Район/Локация: ${session.data.location?.name || "не спрошен"}
- Выбранный слот: ${session.data.slot?.display || "не выбран"}

СЦЕНАРИЙ ДИАЛОГА (строго по порядку):
1. Поздороваться тепло, спросить имя
2. Спросить возраст (если < 14 — скажи что передашь менеджеру и добавь флаг [ESCALATE])
3. Спросить район проживания, предложить ближайшую локацию
4. Предложить конкретный слот из списка выше (ВСЕГДА с конкретной датой и временем, никогда не говори "завтра" или "на этой неделе" — только точную дату)
5. После подтверждения записи — кратко "продай" урок: расскажи что ждёт на пробном, что можно прийти в любой одежде, что тренер подберёт программу под уровень
6. Завершить тепло, напомнить адрес и время

ПРАВИЛА:
- Если клиент спрашивает посторонние вещи — ответь КРАТКО и верни к записи
- НИКОГДА не придумывай даты — используй только слоты из списка выше
- Если клиент хочет другое время — скажи что пробные только вт/чт в 12:00, предложи ближайший
- Пиши по-русски, неформально но вежливо, коротко (1-3 предложения)
- Когда запись подтверждена — добавь в конце сообщения флаг [BOOKED:имя:слот_short:локация]
- Если нужна эскалация менеджеру — добавь флаг [ESCALATE]

ПРИМЕР флага бронирования: [BOOKED:Анна:${slots[0].short}:Патонг]`;
}

// ─── OPENROUTER API ───────────────────────────────────────────────────────────
async function callLLM(session, userMessage) {
  const systemPrompt = buildSystemPrompt(session);

  const messages = [
    ...session.history,
    { role: "user", content: userMessage },
  ];

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CONFIG.openrouter.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://phuket-dance-academy.com",
      "X-Title": "Phuket Dance Academy Bot",
    },
    body: JSON.stringify({
      model: CONFIG.openrouter.model,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      max_tokens: 500,
      temperature: 0.7,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("OpenRouter error:", data);
    throw new Error(data.error?.message || "LLM error");
  }

  return data.choices[0].message.content;
}

// ─── GREEN API ────────────────────────────────────────────────────────────────
async function sendMessage(chatId, text) {
  const url = `${CONFIG.greenApi.baseUrl()}/sendMessage/${CONFIG.greenApi.token}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId, message: text }),
  });
  const data = await response.json();
  console.log("Sent message:", data);
  return data;
}

// ─── GOOGLE SHEETS ────────────────────────────────────────────────────────────
async function appendToSheet(rowData) {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: CONFIG.google.credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });
    const now = DateTime.now().setZone(CONFIG.timezone).toFormat("dd.MM.yyyy HH:mm");

    await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.google.spreadsheetId,
      range: "Sheet1!A:G",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          now,
          rowData.name,
          rowData.phone,
          rowData.age,
          rowData.location,
          rowData.slot,
          rowData.status || "Записан",
        ]],
      },
    });
    console.log("✅ Appended to Google Sheets:", rowData);
  } catch (err) {
    console.error("❌ Google Sheets error:", err.message);
  }
}

// ─── PARSE FLAGS FROM LLM RESPONSE ───────────────────────────────────────────
function parseFlags(text) {
  const flags = { booked: null, escalate: false, clean: text };

  const bookedMatch = text.match(/\[BOOKED:([^:]+):([^:]+):([^\]]+)\]/);
  if (bookedMatch) {
    flags.booked = {
      name: bookedMatch[1].trim(),
      slot: bookedMatch[2].trim(),
      location: bookedMatch[3].trim(),
    };
    flags.clean = text.replace(bookedMatch[0], "").trim();
  }

  if (text.includes("[ESCALATE]")) {
    flags.escalate = true;
    flags.clean = flags.clean.replace("[ESCALATE]", "").trim();
  }

  return flags;
}

// ─── MAIN WEBHOOK HANDLER ─────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // отвечаем сразу чтобы Green API не повторял

  try {
    const body = req.body;
    console.log("Incoming webhook:", JSON.stringify(body, null, 2));

    // Фильтруем только входящие текстовые сообщения
    if (body.typeWebhook !== "incomingMessageReceived") return;
    if (body.messageData?.typeMessage !== "textMessage") return;

    const chatId = body.senderData?.chatId;
    const senderName = body.senderData?.senderName || "";
    const text = body.messageData?.textMessageData?.textMessage || "";

    if (!chatId || !text) return;
    if (chatId.includes("@g.us")) return; // игнорируем групповые чаты

    console.log(`📩 [${chatId}] ${senderName}: ${text}`);

    const session = getSession(chatId);

    // Если новая сессия — добавляем имя из WhatsApp профиля как подсказку
    if (session.state === "new" && senderName) {
      session.whatsappName = senderName;
    }

    // Вызываем LLM
    const assistantReply = await callLLM(session, text);
    console.log(`🤖 Reply: ${assistantReply}`);

    // Парсим флаги
    const flags = parseFlags(assistantReply);

    // Обновляем историю диалога
    session.history.push(
      { role: "user", content: text },
      { role: "assistant", content: flags.clean }
    );

    // Ограничиваем историю (последние 20 сообщений)
    if (session.history.length > 20) {
      session.history = session.history.slice(-20);
    }

    // Обрабатываем флаги
    if (flags.booked) {
      session.data.name = flags.booked.name;
      session.data.slot = flags.booked;
      session.data.location = LOCATIONS.find(
        (l) => l.name === flags.booked.location
      ) || { name: flags.booked.location };
      session.state = "booked";

      // Записываем в Google Sheets
      await appendToSheet({
        name: session.data.name,
        phone: session.data.phone,
        age: session.data.age || "",
        location: flags.booked.location,
        slot: flags.booked.slot,
        status: "Записан",
      });
    }

    if (flags.escalate) {
      session.state = "escalated";

      // Уведомляем менеджера
      const managerMsg =
        `🔔 *Новый лид (нужен менеджер)*\n` +
        `Клиент: ${session.data.name || "неизвестно"}\n` +
        `Телефон: +${session.data.phone}\n` +
        `Возраст: ${session.data.age || "не указан"}\n` +
        `Причина: клиент младше 14 лет`;

      await sendMessage(CONFIG.manager.whatsappId, managerMsg);

      // Записываем в Sheets с пометкой
      await appendToSheet({
        name: session.data.name || session.whatsappName || "",
        phone: session.data.phone,
        age: session.data.age || "<14",
        location: "",
        slot: "",
        status: "Нужен менеджер",
      });
    }

    // Отправляем ответ клиенту
    await sendMessage(chatId, flags.clean);
  } catch (err) {
    console.error("❌ Webhook error:", err);
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    school: CONFIG.schoolName,
    uptime: process.uptime(),
    sessions: sessions.size,
    nextSlots: getNextTrialSlots(3).map((s) => s.display),
  });
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 ${CONFIG.schoolName} bot running on port ${PORT}`);
  console.log(`📅 Next slots:`, getNextTrialSlots(3).map((s) => s.display));
});
