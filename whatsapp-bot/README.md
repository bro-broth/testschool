# Phuket Dance Academy — WhatsApp Bot

## Архитектура
```
WhatsApp → Green API webhook → этот сервер → OpenRouter (Claude Haiku) → Google Sheets
```

## Быстрый старт

### 1. Google Sheets — настройка доступа

1. Открой [Google Cloud Console](https://console.cloud.google.com)
2. Создай новый проект (или выбери существующий)
3. Включи **Google Sheets API**: APIs & Services → Enable APIs → Google Sheets API
4. Создай Service Account: APIs & Services → Credentials → Create Credentials → Service Account
5. Дай имя, нажми Create
6. На странице Service Account → Keys → Add Key → JSON → скачается файл
7. Открой файл, скопируй весь JSON — это будет `GOOGLE_CREDENTIALS`
8. В Google Sheets таблице: Поделиться → добавь email сервисного аккаунта (`...@....iam.gserviceaccount.com`) с правами редактора

### 2. Добавь заголовки в таблицу

В строку 1 вставь:
```
Дата | Имя | Телефон | Возраст | Локация | Время урока | Статус
```

### 3. Railway — деплой

1. Зарегистрируйся на [railway.app](https://railway.app)
2. New Project → Deploy from GitHub (загрузи папку через GitHub)
   **или** New Project → Empty Project → Add Service → GitHub Repo
3. В настройках сервиса → Variables добавь:

```
GREEN_API_INSTANCE_ID=  ← из личного кабинета Green API
GREEN_API_TOKEN=        ← из личного кабинета Green API
OPENROUTER_API_KEY=     ← из openrouter.ai
GOOGLE_CREDENTIALS=     ← весь JSON одной строкой (без переносов!)
```

4. После деплоя скопируй URL сервиса — например: `https://your-app.railway.app`

### 4. Green API — настройка вебхука

1. Войди в [console.green-api.com](https://console.green-api.com)
2. Открой свой инстанс
3. Settings → Webhooks
4. Включи: **Incoming messages**
5. Webhook URL: `https://your-app.railway.app/webhook`
6. Сохрани

### 5. Проверь что всё работает

Открой в браузере: `https://your-app.railway.app/`

Должен вернуть JSON:
```json
{
  "status": "ok",
  "school": "Phuket Dance Academy",
  "nextSlots": ["вторник, 25 марта, 12:00", ...]
}
```

Напиши в WhatsApp на подключённый номер — бот должен ответить.

## Структура диалога

```
Клиент: привет
Бот: Привет! Я помогу записать вас на бесплатный пробный урок 
     в Phuket Dance Academy. Как вас зовут?

Клиент: Анна
Бот: Анна, сколько вам лет?

Клиент: 25
Бот: Отлично! В каком районе Пхукета вы живёте?

Клиент: Патонг
Бот: У нас есть студия прямо в Патонге — Patong Beach Rd, 15.
     Ближайший пробный урок: вторник, 25 марта в 12:00.
     Записать вас?

Клиент: да
Бот: ✅ Готово! Записала вас на вторник, 25 марта в 12:00...
     [запись в Google Sheets]
```

## Эскалация менеджеру

Если клиент указывает возраст < 14:
- Бот говорит что передаст менеджеру
- Менеджеру уходит WhatsApp-сообщение на +380737506558
- В таблицу пишется строка со статусом "Нужен менеджер"

## Кастомизация

Все данные школы в `index.js`:
- `CONFIG.schoolName` — название
- `LOCATIONS` — список локаций и их районов
- `getNextTrialSlots()` — логика расписания (сейчас вт/чт 12:00)
- `buildSystemPrompt()` — промпт агента, туда же вставить скрипт продажи

## Модель

Сейчас используется `anthropic/claude-haiku-3` через OpenRouter.
Для смены: в `CONFIG.openrouter.model` поменяй на любую модель с OpenRouter.
