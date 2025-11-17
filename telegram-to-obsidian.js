/**
 * telegram-to-obsidian.js
 *
 * Работает так:
 *  - принимает сообщения от Telegram (text/caption + photo)
 *  - парсит title / urls / tags
 *  - сохраняет .md файл в VAULT_PATH (локальный Volume: /data/telegram-posts)
 *  - сохраняет фото(ы) в VAULT_PATH/assets
 *  - загружает .md и media в Google Drive в папку GD_DRIVE_FOLDER_ID (опционально)
 *
 * Требуемые env:
 *  - BOT_TOKEN
 *  - VAULT_PATH (по умолчанию /data/telegram-posts)
 *  - GD_DRIVE_FOLDER_ID
 *  - GOOGLE_SERVICE_ACCOUNT_KEY_BASE64  (base64-encoded JSON key)
 *  - ALLOWED_CHAT_IDS  (опционально, список через запятую)
 */

const { Telegraf } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const slugify = require('slugify');
const { google } = require('googleapis');
const mime = require('mime-types');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('ERROR: BOT_TOKEN is not set');
  process.exit(1);
}

const VAULT_PATH = process.env.VAULT_PATH || '/data/telegram-posts';
const NOTES_FOLDER = path.resolve(VAULT_PATH);
const ASSETS_FOLDER = path.join(NOTES_FOLDER, 'assets');

if (!fs.existsSync(NOTES_FOLDER)) fs.mkdirSync(NOTES_FOLDER, { recursive: true });
if (!fs.existsSync(ASSETS_FOLDER)) fs.mkdirSync(ASSETS_FOLDER, { recursive: true });

// Google Drive setup (service account key expected base64)
const GD_FOLDER_ID = process.env.GD_DRIVE_FOLDER_ID || null;
const GOOGLE_SA_KEY_BASE64 = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 || null;

let drive = null;
if (GD_FOLDER_ID && GOOGLE_SA_KEY_BASE64) {
  try {
    const keyJson = JSON.parse(Buffer.from(GOOGLE_SA_KEY_BASE64, 'base64').toString('utf8'));
    const jwtClient = new google.auth.JWT(
      keyJson.client_email,
      null,
      (keyJson.private_key || keyJson.privateKey),
      ['https://www.googleapis.com/auth/drive.file'],
      null
    );
    drive = google.drive({ version: 'v3', auth: jwtClient });
    // authenticate once
    jwtClient.authorize((err) => {
      if (err) {
        console.error('Google auth error:', err);
        drive = null;
      } else {
        console.log('Google Drive authorized (service account).');
      }
    });
  } catch (e) {
    console.error('Invalid GOOGLE_SERVICE_ACCOUNT_KEY_BASE64:', e.message);
    drive = null;
  }
} else {
  console.log('Google Drive upload disabled (missing GD_DRIVE_FOLDER_ID or GOOGLE_SERVICE_ACCOUNT_KEY_BASE64).');
}

// Utility functions
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

async function downloadFile(url, destPath) {
  const writer = fs.createWriteStream(destPath);
  const resp = await axios({ url, method: 'GET', responseType: 'stream', timeout: 30000 });
  resp.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', () => resolve(destPath));
    writer.on('error', (err) => reject(err));
  });
}

function parseTextMeta(text) {
  const lines = (text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const titleCandidate = lines.length ? lines[0].slice(0, 120) : 'Telegram post';
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const urls = (text || '').match(urlRegex) || [];
  const tagRegex = /#([A-Za-zА-Яа-я0-9_-]+)/g;
  const tags = [];
  let m;
  while ((m = tagRegex.exec(text || '')) !== null) tags.push(m[1]);
  return { titleCandidate, urls, tags };
}

function buildMarkdown(data) {
  const yamlLines = [
    '---',
    `source-type: "telegram-post"`,
    `platform: "Telegram"`,
    `channel: "${(data.channel || '').replace(/"/g, '\\"')}"`,
    `author: "${(data.author || '').replace(/"/g, '\\"')}"`,
    `date: "${data.dateIso}"`,
    `original-url: "${(data.originalUrl || '').replace(/"/g, '\\"')}"`,
    `media-image: "${(data.mediaImages && data.mediaImages.length ? data.mediaImages.map(p => `assets/${path.basename(p)}`).join(',') : '')}"`,
    `topic: "${(data.topic || '').replace(/"/g, '\\"')}"`,
    `tags: [${(data.tags || []).map(t => `"${t}"`).join(', ')}]`,
    '---',
    ''
  ].join('\n');

  const body = [
    `# ${data.title}`,
    '',
    (data.mediaImages && data.mediaImages.length) ? data.mediaImages.map(img => `![[assets/${path.basename(img)}]]`).join('\n\n') : '',
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
    `- Оригинальная ссылка: ${data.originalUrl || ''}`,
    '',
    '## Данные для БД',
    '',
    `- source-type: telegram-post`,
    `- date: ${data.dateIso}`,
    `- tags: ${(data.tags || []).join(', ')}`,
    '',
  ].join('\n');

  return yamlLines + '\n' + body;
}

// Google Drive upload helpers
async function uploadFileToDrive(localPath, remoteName, mimeType, parentFolderId) {
  if (!drive) return null;
  try {
    const fileMetadata = {
      name: remoteName,
      parents: parentFolderId ? [parentFolderId] : []
    };
    const media = {
      mimeType: mimeType || mime.lookup(localPath) || 'application/octet-stream',
      body: fs.createReadStream(localPath)
    };
    const res = await drive.files.create({
      resource: fileMetadata,
      media,
      fields: 'id, name'
    });
    return res.data;
  } catch (err) {
    console.error('Drive upload error:', err.message || err);
    return null;
  }
}

async function uploadNoteAndAssetsToDrive(notePath, assetPaths) {
  if (!drive || !GD_FOLDER_ID) return;
  try {
    // Создаём подпапку с датой в папке GD_FOLDER_ID: yyyy-mm-dd (чтобы структурировать)
    const dateFolderName = new Date().toISOString().slice(0,10);
    // Найдём, есть ли такая подпапка; если нет — создадим
    const listRes = await drive.files.list({
      q: `name='${dateFolderName}' and '${GD_FOLDER_ID}' in parents and trashed=false`,
      fields: 'files(id, name)',
      spaces: 'drive'
    });
    let dateFolderId = null;
    if (listRes.data.files && listRes.data.files.length > 0) {
      dateFolderId = listRes.data.files[0].id;
    } else {
      const folderRes = await drive.files.create({
        resource: { name: dateFolderName, mimeType: 'application/vnd.google-apps.folder', parents: [GD_FOLDER_ID] },
        fields: 'id'
      });
      dateFolderId = folderRes.data.id;
    }

    // Загрузим assets
    for (const p of assetPaths || []) {
      const rn = path.basename(p);
      console.log('Uploading asset to Drive:', rn);
      await uploadFileToDrive(p, rn, mime.lookup(p) || 'application/octet-stream', dateFolderId);
    }

    // и сам .md
    console.log('Uploading note to Drive:', path.basename(notePath));
    await uploadFileToDrive(notePath, path.basename(notePath), 'text/markdown', dateFolderId);
  } catch (err) {
    console.error('Error uploading to Drive:', err.message || err);
  }
}

// Security: allowed chats
const allowedChatIds = (process.env.ALLOWED_CHAT_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number);

const bot = new Telegraf(BOT_TOKEN, { polling: true });

// Main handler
bot.on('message', async (ctx) => {
  try {
    const msg = ctx.message;
    const chatId = msg.chat && msg.chat.id;
    if (allowedChatIds.length && !allowedChatIds.includes(chatId)) {
      // игнорируем сообщения не из разрешённых чатов
      console.log('Ignored message from chat:', chatId);
      return;
    }

    const channel = (msg.chat && (msg.chat.title || msg.chat.username)) || `${msg.chat && msg.chat.id}`;
    const author = (msg.from && `${msg.from.first_name || ''} ${msg.from.last_name || ''}`).trim();
    const text = msg.text || msg.caption || '';
    const dateIso = new Date((msg.date || Date.now()/1000) * 1000).toISOString();
    const meta = parseTextMeta(text);

    // handle photos (array) and documents
    const savedAssets = [];
    // Photos
    if (msg.photo && msg.photo.length) {
      // take largest
      for (let i = 0; i < msg.photo.length; i++) {
        const p = msg.photo[i];
        const fileId = p.file_id;
        const fileInfo = await ctx.telegram.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
        const imageName = `${fileTimestamp()}-${slugify(channel, {lower:true,strict:true})}-${path.basename(fileInfo.file_path)}`;
        const dest = path.join(ASSETS_FOLDER, imageName);
        await downloadFile(fileUrl, dest);
        savedAssets.push(dest);
      }
    }

    // Document (e.g., image as document)
    if (msg.document) {
      const doc = msg.document;
      const fileInfo = await ctx.telegram.getFile(doc.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
      const docName = `${fileTimestamp()}-${slugify(channel, {lower:true,strict:true})}-${doc.file_name || path.basename(fileInfo.file_path)}`;
      const dest = path.join(ASSETS_FOLDER, docName);
      await downloadFile(fileUrl, dest);
      savedAssets.push(dest);
    }

    // Build markdown
    const title = meta.titleCandidate || `Post ${fileTimestamp()}`;
    const safeTitle = slugify(title, {lower:true,strict:true}).slice(0,80);
    const filename = `${fileTimestamp()}-${safeTitle}.md`;
    const filepath = path.join(NOTES_FOLDER, filename);

    const markdown = buildMarkdown({
      title,
      text,
      channel,
      author,
      dateIso,
      originalUrl: (meta.urls && meta.urls[0]) || '',
      mediaImages: savedAssets,
      urls: meta.urls,
      tags: meta.tags,
      topic: ''
    });

    fs.writeFileSync(filepath, markdown, 'utf8');
    console.log('Saved note:', filepath);

    // Upload to Google Drive (non-blocking best-effort)
    if (drive && GD_FOLDER_ID) {
      uploadNoteAndAssetsToDrive(filepath, savedAssets)
        .then(() => console.log('Upload to Drive finished (background).'))
        .catch(err => console.error('Drive upload background error:', err));
    }

    // Reply back to user as confirmation
    await ctx.replyWithMarkdown(`Заметка сохранена: \`${filename}\``);
  } catch (err) {
    console.error('Error handling message:', err);
    try { await ctx.reply('Ошибка при сохранении заметки: ' + (err.message || err)); } catch (e) {}
  }
});

bot.launch().then(() => console.log('Bot launched (long-polling).'));

// graceful
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
