const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');


const TELEGRAM_BOT_TOKEN = '7833659006:AAG4iprF1lShqGJ5bxR3IZJer2nCaLXQCrE';
const SOUNDCLOUD_CLIENT_ID = 'yNSW5UvBmb1A5j7qPUtIMuB9Itx3jsOC';

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });


async function resolveShortUrlViaApi(shortUrl) {
  try {
    const apiUrl = `https://unshorten.me/json/${encodeURIComponent(shortUrl)}`;
    const res = await axios.get(apiUrl);
    if (res.data && res.data.resolved_url) {
      return res.data.resolved_url;
    }
    return shortUrl;
  } catch (err) {
    return shortUrl;
  }
}


bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';

  const match = text.match(/https?:\/\/(soundcloud\.com|on\.soundcloud\.com)\/\S+/i);
  if (!match) {
    return bot.sendMessage(chatId, '🎵 Send me a SoundCloud track link and I\'ll return the MP3!');
  }

  let url = match[0].trim();
  bot.sendMessage(chatId, '🎧 Processing your SoundCloud track...');

  try {
    // 🧭 Handle short URLs
    if (/on\.soundcloud\.com/.test(url)) {      
      url = await resolveShortUrlViaApi(url);
    }



    // 🎯 Step 1: Resolve track metadata
    const resolveUrl = `https://api-v2.soundcloud.com/resolve?url=${url}&client_id=${SOUNDCLOUD_CLIENT_ID}`;
    const resolveRes = await axios.get(resolveUrl);
    const track = resolveRes.data;

    if (!track.media || !track.media.transcodings) {
      return bot.sendMessage(chatId, '❌ Could not find a valid MP3 stream for this track.');
    }

    // 🎯 Step 2: Find progressive stream
    const mp3 = track.media.transcodings.find(t => t.format.protocol === 'progressive');
    if (!mp3) {
      return bot.sendMessage(chatId, '❌ No downloadable MP3 stream available.');
    }

    const streamUrl = `${mp3.url}?client_id=${SOUNDCLOUD_CLIENT_ID}`;
    const mp3Redirect = await axios.get(streamUrl);
    const response = await axios({
      method: 'get',
      url: mp3Redirect.data.url,
      responseType: 'stream'
    });

    const filename = `${track.title.replace(/[^\w\d]/g, '_')}.mp3`;
    const filepath = path.join(__dirname, filename);
    const writer = fs.createWriteStream(filepath);
    response.data.pipe(writer);

    writer.on('finish', async () => {
      await bot.sendAudio(chatId, filepath, {
        title: track.title,
        performer: track.user?.username || 'Unknown'
      });

      fs.unlinkSync(filepath); // Cleanup

      const query = `${track.user?.username || ''} ${track.title}`;
      const results = await searchLyricsOptionsGenius(query);

      if (results.length === 0) {
        return bot.sendMessage(chatId, '❌ No lyrics found.');
      }

      const keyboard = {
        inline_keyboard: results.map(r => [
          {
            text: r.title,
            callback_data: `lyrics|${r.url}`
          }
        ])
      };

      await bot.sendMessage(chatId, '🎼 Choose a lyrics version:', {
        reply_markup: keyboard
      });
    });


    writer.on('error', err => {
      bot.sendMessage(chatId, '❌ Error saving file.');
    });

  } catch (err) {
    bot.sendMessage(chatId, '❌ Failed to process the link. Make sure it\'s a valid SoundCloud track.');
  }
});

bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const data = callbackQuery.data;

  if (data.startsWith('lyrics|')) {
    const url = data.split('|')[1];
    bot.answerCallbackQuery(callbackQuery.id);

    const lyrics = await scrapeLyricsFromGeniusUrl(url);
    if (lyrics) {
      await bot.sendMessage(msg.chat.id, `📃 *Lyrics:*\n\n${lyrics}`, { parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(msg.chat.id, '❌ Failed to fetch lyrics.');
    }
  }
});



const GENIUS_TOKEN = '5sCbGlc5-NTwqH5OvdxMOz84-nTDMzGlsNyjsFc7K3UP-McHWeJvJUa8hI6ysp29';

async function searchLyricsOptionsGenius(query) {
  try {
    const searchUrl = `https://api.genius.com/search?q=${encodeURIComponent(query)}`;
    const searchRes = await axios.get(searchUrl, {
      headers: { Authorization: `Bearer ${GENIUS_TOKEN}` }
    });

    const hits = searchRes.data.response.hits;

    return hits.slice(0, 5).map(hit => ({
      id: hit.result.id,
      title: hit.result.full_title,
      url: hit.result.url
    }));
  } catch (err) {
    return [];
  }
}


async function scrapeLyricsFromGeniusUrl(url) {
  try {
    const htmlRes = await axios.get(url);
    const $ = cheerio.load(htmlRes.data);

    let lyrics = '';
    $('[data-lyrics-container="true"]').each((i, el) => {
      lyrics += $(el).text().trim() + '\n';
    });

    return lyrics.trim() || null;
  } catch (err) {
    return null;
  }
}



function cleanTitle(title) {
  return title.replace(/\(.*?\)|\[.*?\]|[^a-zA-Z0-9\s]/g, '').trim();
}