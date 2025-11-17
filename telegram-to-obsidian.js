// save-as: telegram-to-obsidian.js
// npm i telegraf axios slugify
const { Telegraf } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const slugify = require('slugify');

const BOT_TOKEN = process.env.BOT_TOKEN || '<ВАШ_BOT_TOKEN_ЗДЕСЬ>';
if (!BOT_TOKEN) {
  console.error('Set BOT_TOKEN env var');
  process.exit(1);
}

const VAULT_PATH = path.resolve(__dirname, 'ObsidianVault'); // Путь к вашему vault
const NOTES_FOLDER = path.join(VAULT_PATH, 'telegram-posts');
const ASSETS_FOLDER = path.join(VAULT_PATH, 'telegram-posts', 'assets');

if (!fs.existsSync(NOTES_FOLDER)) fs.mkdirSync(NOTES_FOLDER, { recursive: true });
if (!fs.existsSync(ASSETS_FOLDER)) fs.mkdirSync(ASSETS_FOLDER, { recursive: true });

const bot = new Telegraf(BOT_TOKEN);

// утилита для ISO timestamp и имени файла
function nowIso() {
  return new Date().toISOString();
}
function fileTimestamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

// скачивание файла по URL
async function downloadFile(url, destPath) {
  const writer = fs.createWriteStream(destPath);
  const resp = await axios({ url, method: 'GET', responseType: 'stream' });
  resp.data.pipe(writer);
  return new Promise((res, rej) => {
    writer.on('finish', res);
    writer.on('error', rej);
  });
}

// парсинг текста на заголовок / теги / ссылки
function parseTextMeta(text) {
  const lines = (text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const titleCandidate = lines.length ? lines[0].slice(0, 120) : 'Telegram post';
  // извлечь URL(ы)
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const urls = (text || '').match(urlRegex) || [];
  // теги как хэштеги
  const tagRegex = /#([A-Za-zА-Яа-я0-9_-]+)/g;
  const tags = [];
  let m;
  while ((m = tagRegex.exec(text || '')) !== null) tags.push(m[1]);
  return { titleCandidate, urls, tags };
}

// формирование markdown содержимого
function buildMarkdown(data) {
  // data: {title, text, channel, author, dateIso, imageRelPath, urls, tags, topic}
  const yaml = [
    '---',
    `source-type: "telegram-post"`,
    `platform: "Telegram"`,
    `channel: "${data.channel || ''}"`,
    `author: "${data.author || ''}"`,
    `date: "${data.dateIso}"`,
    `original-url: "${(data.urls && data.urls[0]) || ''}"`,
    `media-image: "${data.imageRelPath || ''}"`,
    `topic: "${data.topic || ''}"`,
    `tags: [${(data.tags || []).map(t => `"${t}"`).join(', ')}]`,
    '---',
    '',
  ].join('\n');

  const body = [
    `# ${data.title}`,
    '',
    data.imageRelPath ? `![[${data.imageRelPath}]]` : '',
    '',
    '---',
    '',
    '## Описание / Текст',
    '',
    data.text || '',
    '',
    '---',
    '',
    '## Источник',
    '',
    `- Канал: ${data.channel || ''}`,
    `- Автор: ${data.author || ''}`,
    `- Оригинальная ссылка: ${(data.urls && data.urls[0]) || ''}`,
    '',
    '## Данные для БД',
    '',
    `- source-type: telegram-post`,
    `- date: ${data.dateIso}`,
    `- tags: ${(data.tags || []).join(', ')}`,
    '',
  ].join('\n');

  return yaml + body;
}

// основной обработчик сообщений
bot.on('message', async (ctx) => {
  try {
    const msg = ctx.message;
    const channel = (msg.chat && (msg.chat.title || msg.chat.username)) || 'unknown';
    const author = (msg.from && `${msg.from.first_name || ''} ${msg.from.last_name || ''}`).trim();
    const text = msg.text || msg.caption || '';
    const dateIso = new Date((msg.date || Date.now()/1000) * 1000).toISOString();
    const meta = parseTextMeta(text);

    // если есть фото — взять самый большой
    let imageRelPath = '';
    if (msg.photo && msg.photo.length) {
      const photo = msg.photo[msg.photo.length - 1]; // последний обычно самый большой
      const fileId = photo.file_id;
      const fileInfo = await ctx.telegram.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
      const imageName = `${fileTimestamp()}-${slugify(channel, {lower:true,strict:true})}-${path.basename(fileInfo.file_path)}`;
      const dest = path.join(ASSETS_FOLDER, imageName);
      await downloadFile(fileUrl, dest);
      imageRelPath = path.join('telegram-posts', 'assets', imageName).replace(/\\/g, '/'); // относительный путь внутри вольта
    }

    const title = meta.titleCandidate || `Post ${fileTimestamp()}`;
    const filename = `${fileTimestamp()}-${slugify(title, {lower:true,strict:true}).slice(0,80)}.md`;
    const filepath = path.join(NOTES_FOLDER, filename);

    const markdown = buildMarkdown({
      title,
      text,
      channel,
      author,
      dateIso,
      imageRelPath,
      urls: meta.urls,
      tags: meta.tags,
      topic: ''
    });

    fs.writeFileSync(filepath, markdown, 'utf8');
    console.log('Saved note:', filepath);
    // необязательно: ответ пользователю ссылкой/подтверждением
    await ctx.reply(`Сохранено в Obsidian: ${filename}`);
  } catch (err) {
    console.error('Error handling message:', err);
    await ctx.reply('Ошибка при сохранении заметки: ' + (err.message || err));
  }
});

bot.launch().then(() => console.log('Bot started'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
