const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");
const { exec } = require("child_process");


const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const SOUNDCLOUD_CLIENT_ID = process.env.SOUNDCLOUD_CLIENT_ID;

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

const https = require("https");
function resolveShortUrlViaApi(shortUrl) {
  return new Promise((resolve, reject) => {
    const apiUrl = `https://api.redirect.li/v2/http/?url=${encodeURIComponent(
      shortUrl
    )}`;
    const urlObj = new URL(apiUrl);

    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        Accept: "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.steps && json.steps.length > 0) {
            const lastStep = json.steps[json.steps.length - 1];
            resolve(lastStep.request?.url || shortUrl);
          } else {
            resolve(shortUrl);
          }
        } catch (err) {
          console.error("Failed to expand URL:", err);
          reject(err);
        }
      });
    });

    req.on("error", (err) => {
      reject(err);
    });

    req.end();
  });
}



bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || "";

  const match = text.match(
    /https?:\/\/(soundcloud\.com|on\.soundcloud\.com)\/\S+/i
  );
  if (!match) {
    return bot.sendMessage(
      chatId,
      "🎵 Send me a SoundCloud track link and I'll return the MP3!"
    );
  }

  let url = match[0].trim();
  bot.sendMessage(chatId, "🎧 Processing your SoundCloud track...");

  try {
    // 🧭 Handle short URLs
    if (/on\.soundcloud\.com/.test(url)) {
      url = await resolveShortUrlViaApi(url);
    }

    const resolveUrl = `https://api-v2.soundcloud.com/resolve?url=${url}&client_id=${SOUNDCLOUD_CLIENT_ID}`;

    const track = await new Promise((resolve, reject) => {
      exec(`curl -L "${resolveUrl}"`, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          const result = JSON.parse(stdout);
          resolve(result);
        } catch (parseError) {
          reject(parseError);
        }
      });
    });

    if (!track.media || !track.media.transcodings) {
      return bot.sendMessage(
        chatId,
        "❌ Could not find a valid MP3 stream for this track."
      );
    }

    // 🎯 Step 2: Find progressive stream
    const mp3 = track.media.transcodings.find(
      (t) => t.format.protocol === "progressive"
    );
    if (!mp3) {
      return bot.sendMessage(
        chatId,
        "❌ No downloadable MP3 stream available."
      );
    }

    const streamUrl = `${mp3.url}?client_id=${SOUNDCLOUD_CLIENT_ID}`;
    const mp3Redirect = await new Promise((resolve, reject) => {
      exec(
        `curl -L "${streamUrl}" -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"`,
        (error, stdout, stderr) => {
          if (error) {
            reject(error);
            return;
          }
          try {
            const result = JSON.parse(stdout);
            resolve({ data: result });
          } catch (parseError) {
            reject(parseError);
          }
        }
      );
    });

    const filename = `${track.title.replace(/[^\w\d]/g, "_")}.mp3`;
    const filepath = path.join(__dirname, filename);

    // Download the MP3 file using curl
    await new Promise((resolve, reject) => {
      exec(
        `curl -L "${mp3Redirect.data.url}" -o "${filepath}" -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" --connect-timeout 30 --max-time 300`,
        (error, stdout, stderr) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }
      );
    });


    await bot.sendAudio(chatId, filepath, {
        title: track.title,
        performer: track.user?.username || "Unknown",
    });

    fs.unlinkSync(filepath); // Cleanup
  } catch (err) {
    bot.sendMessage(
      chatId,
      "❌ Failed to process the link. Make sure it's a valid SoundCloud track."
    );
  }
});
