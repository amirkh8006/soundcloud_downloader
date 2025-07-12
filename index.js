const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

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

      const lyrics = await getLyrics(track.user?.username || '', track.title);
      if (lyrics) {
        await bot.sendMessage(chatId, `📃 *Lyrics:*\n\n${lyrics}`, { parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(chatId, '❌ Lyrics not found.');
      }
      fs.unlinkSync(filepath); // Cleanup
    });

    writer.on('error', err => {
      bot.sendMessage(chatId, '❌ Error saving file.');
    });

  } catch (err) {
    bot.sendMessage(chatId, '❌ Failed to process the link. Make sure it\'s a valid SoundCloud track.');
  }
});


async function getLyrics(artist, title) {
  console.log("Artis" , artist);
  console.log("Track" , track);
  
  try {
    const res = await axios.get(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
    return res.data.lyrics;
  } catch (err) {
    return null;
  }
}