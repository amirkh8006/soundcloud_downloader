const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');

const ytdl = require('ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);


const TELEGRAM_BOT_TOKEN = '7833659006:AAG4iprF1lShqGJ5bxR3IZJer2nCaLXQCrE';
const SOUNDCLOUD_CLIENT_ID = 'yNSW5UvBmb1A5j7qPUtIMuB9Itx3jsOC';

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const lyricsCache = new Map(); // GeniusID => URL


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

async function getYouTubeMp3Url(youtubeUrl) {
  // Example for yt-download.org API (free, no key needed)
  // API endpoint: https://yt-download.org/api/button/mp3/{VIDEO_ID}
  
  const videoId = extractYouTubeVideoID(youtubeUrl);
  if (!videoId) throw new Error('Invalid YouTube URL');

  const apiUrl = `https://yt-download.org/api/button/mp3/${videoId}`;
  const response = await axios.get(apiUrl);
  // response.data has mp3 info and download URLs

  // Extract first mp3 download link
  if (response.data && response.data.links && response.data.links.mp3) {
    // Links array usually sorted by quality
    return response.data.links.mp3[0].url;
  }
  throw new Error('MP3 URL not found');
}

function extractYouTubeVideoID(url) {
  const regex = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/;
  const match = url.match(regex);
  return match ? match[1] : null;
}



bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';

  const youtubeMatch = text.match(/https?:\/\/(www\.|music\.)?(youtube\.com|youtu\.be)\/\S+/i);
  if (youtubeMatch) {
    let ytUrl = youtubeMatch[0].trim();

    if (ytUrl.includes('music.youtube.com')) {
      ytUrl = ytUrl.replace('music.youtube.com', 'www.youtube.com');
    }
    bot.sendMessage(chatId, '📽️ Processing your YouTube link....');

    try {
      await bot.sendMessage(chatId, '🎧 Processing your YouTube track...');
      const mp3Url = await getYouTubeMp3Url(ytUrl);

      // Send audio as Telegram can fetch it via URL
      await bot.sendAudio(chatId, mp3Url, {
        title: 'YouTube Track',
        performer: 'Unknown',
      });
    } catch (err) {
      console.error(err);
      await bot.sendMessage(chatId, '❌ Failed to download MP3 from YouTube.');
    }

    return; // Prevent further processing
  }

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

      const cleanTrackTitle = cleanTitle(track.title);
      const lyrics = await getLyricsFromGenius(track.user?.username || '', cleanTrackTitle);
      if (lyrics) {
        await sendLargeMessage(chatId, `📃 *Lyrics for ${cleanTrackTitle}:*\n\n${lyrics}`, { parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(chatId, '❌ Lyrics not found.');
      }
    });


    writer.on('error', err => {
      bot.sendMessage(chatId, '❌ Error saving file.');
    });

  } catch (err) {
    bot.sendMessage(chatId, '❌ Failed to process the link. Make sure it\'s a valid SoundCloud track.');
  }
});



const GENIUS_TOKEN = '5sCbGlc5-NTwqH5OvdxMOz84-nTDMzGlsNyjsFc7K3UP-McHWeJvJUa8hI6ysp29';


async function sendLargeMessage(chatId, text, options = {}) {
  const limit = 4096;
  for (let i = 0; i < text.length; i += limit) {
    const chunk = text.substring(i, i + limit);
    await bot.sendMessage(chatId, chunk, options);
  }
}

async function getLyricsFromGenius(artist, title) {
  try {
    const query = `${artist} ${title}`;
    const searchUrl = `https://api.genius.com/search?q=${encodeURIComponent(query)}`;
    const searchRes = await axios.get(searchUrl, {
      headers: { Authorization: `Bearer ${GENIUS_TOKEN}` }
    });

    const hit = searchRes.data.response.hits.find(h =>
      h.result.primary_artist.name.toLowerCase().includes(artist.toLowerCase())
    );
    if (!hit) return null;

    const lyricsPageUrl = hit.result.url;
    const lyricsHtml = await axios.get(lyricsPageUrl);
    const $ = cheerio.load(lyricsHtml.data);

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
