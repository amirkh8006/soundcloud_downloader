const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const axios = require('axios');


// ✅ Replace with your own values
const TELEGRAM_BOT_TOKEN = '7833659006:AAG4iprF1lShqGJ5bxR3IZJer2nCaLXQCrE';
const SOUNDCLOUD_CLIENT_ID = 'yNSW5UvBmb1A5j7qPUtIMuB9Itx3jsOC';

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

bot.onText(/https?:\/\/(soundcloud\.com|on\.soundcloud\.com)\/\S+/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const url = match[0];

  bot.sendMessage(chatId, '🎧 Processing your SoundCloud track...');

  try {
    // 🔄 Step 1: Resolve track
    const resolveUrl = `https://api-v2.soundcloud.com/resolve?url=${url}&client_id=${SOUNDCLOUD_CLIENT_ID}`;
    const resolveRes = await axios.get(resolveUrl);
    const track = resolveRes.data;
    
    if (!track.media || !track.media.transcodings) {
      return bot.sendMessage(chatId, '❌ Could not find a valid MP3 stream for this track.');
    }

    // 🔄 Step 2: Find progressive MP3 stream
    const mp3 = track.media.transcodings.find(t => t.format.protocol === 'progressive');
    if (!mp3) {
      return bot.sendMessage(chatId, '❌ No downloadable MP3 stream available.');
    }

    const streamUrl = `${mp3.url}?client_id=${SOUNDCLOUD_CLIENT_ID}`;
    
    // 🔄 Step 3: Download MP3 to temp file
    const filename = `${track.title.replace(/[^\w\d]/g, '_')}.mp3`;
    const filepath = path.join(__dirname, filename);

    const resolveRes1 = await axios.get(streamUrl);

    const response = await axios({
      method: 'get',
      url: resolveRes1.data.url,
      responseType: 'stream'
    });


    const writer = fs.createWriteStream(filepath);
    response.data.pipe(writer);

    writer.on('finish', async () => {
      // 📤 Step 4: Send file to Telegram
      await bot.sendAudio(chatId, filepath, {
        title: track.title,
        performer: track.user?.username || 'Unknown'
      });

      fs.unlinkSync(filepath); // Clean up
    });

    writer.on('error', err => {
      bot.sendMessage(chatId, '❌ Error saving file.');
      console.error(err);
    });

  } catch (err) {
    console.error(err.message);
    bot.sendMessage(chatId, '❌ Failed to process the link. Make sure it\'s a valid SoundCloud track.');
  }
});

bot.on('message', msg => {
  if (!/soundcloud\.com/.test(msg.text)) {
    bot.sendMessage(msg.chat.id, '🎵 Send me a SoundCloud track link and I\'ll return the MP3!');
  }
});
