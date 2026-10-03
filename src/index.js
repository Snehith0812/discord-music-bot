import "dotenv/config";

import {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  entersState,
  StreamType,
} from "@discordjs/voice";

import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

import fetch from "isomorphic-unfetch";
import spotify from "spotify-url-info";

const require = createRequire(import.meta.url);

// yt-dlp-wrap-plus is CommonJS
const YTDlpWrap =
  require("yt-dlp-wrap-plus").default;

const { getPreview, getTracks } = spotify(fetch);

const PREFIX = "!";
const TOKEN = process.env.DISCORD_TOKEN;

const MAX_SPOTIFY_TRACKS = 25;

// ======================================================
// TOKEN CHECK
// ======================================================

if (!TOKEN) {
  console.error("❌ DISCORD_TOKEN is missing.");
  process.exit(1);
}

// ======================================================
// STORAGE
// ======================================================

const players = new Map();
const connections = new Map();
const queues = new Map();
const nextTrackLocks = new Map();
const currentSongs = new Map();
const ytDlpInstances = new Map();

// ======================================================
// YT-DLP SETUP
// ======================================================

const BIN_DIR = path.join(
  process.cwd(),
  ".yt-dlp"
);

if (!fs.existsSync(BIN_DIR)) {
  fs.mkdirSync(BIN_DIR, {
    recursive: true,
  });
}

function getYtDlpBinaryPath() {
  if (process.platform === "win32") {
    return path.join(
      BIN_DIR,
      "yt-dlp.exe"
    );
  }

  if (process.platform === "darwin") {
    return path.join(
      BIN_DIR,
      "yt-dlp_macos"
    );
  }

  return path.join(
    BIN_DIR,
    "yt-dlp"
  );
}

async function setupYtDlp() {
  const binaryPath =
    getYtDlpBinaryPath();

  if (fs.existsSync(binaryPath)) {
    console.log(
      `✅ yt-dlp found: ${binaryPath}`
    );

    return binaryPath;
  }

  console.log(
    "⬇️ yt-dlp not found. Downloading current binary..."
  );

  try {
    if (process.platform === "win32") {
      await YTDlpWrap.downloadFromGithub(
        binaryPath,
        "",
        "win32"
      );
    } else if (
      process.platform === "darwin"
    ) {
      await YTDlpWrap.downloadFromGithub(
        binaryPath,
        "",
        "macos"
      );
    } else {
      // Linux/Railway
      await YTDlpWrap.downloadFromGithub(
        binaryPath,
        "",
        "linux",
        true
      );
    }

    if (!fs.existsSync(binaryPath)) {
      throw new Error(
        "yt-dlp binary was not created."
      );
    }

    if (process.platform !== "win32") {
      fs.chmodSync(
        binaryPath,
        0o755
      );
    }

    console.log(
      `✅ yt-dlp installed: ${binaryPath}`
    );

    return binaryPath;
  } catch (error) {
    console.error(
      "❌ Failed to install yt-dlp:",
      error
    );

    throw error;
  }
}

async function getYtDlp() {
  if (ytDlpInstances.has("main")) {
    return ytDlpInstances.get("main");
  }

  const binaryPath =
    await setupYtDlp();

  const ytDlp =
    new YTDlpWrap(binaryPath);

  ytDlpInstances.set(
    "main",
    ytDlp
  );

  return ytDlp;
}

// ======================================================
// QUEUE
// ======================================================

function getQueue(guildId) {
  if (!queues.has(guildId)) {
    queues.set(guildId, []);
  }

  return queues.get(guildId);
}

function updateQueuePositions(guildId) {
  const queue =
    getQueue(guildId);

  queue.forEach(
    (song, index) => {
      song.position =
        index + 1;
    }
  );
}

// ======================================================
// AUDIO PLAYER
// ======================================================

function getPlayer(guildId) {
  if (players.has(guildId)) {
    return players.get(guildId);
  }

  const player =
    createAudioPlayer({
      behaviors: {
        noSubscriber:
          NoSubscriberBehavior.Pause,

        maxMissedFrames: 30,
      },
    });

  player.on(
    AudioPlayerStatus.Buffering,
    () => {
      console.log(
        `[${guildId}] 🔄 Buffering`
      );
    }
  );

  player.on(
    AudioPlayerStatus.Playing,
    () => {
      console.log(
        `[${guildId}] ▶️ Playing`
      );
    }
  );

  player.on(
    AudioPlayerStatus.Paused,
    () => {
      console.log(
        `[${guildId}] ⏸️ Paused`
      );
    }
  );

  player.on(
    AudioPlayerStatus.Idle,
    () => {
      console.log(
        `[${guildId}] ⏹️ Track ended`
      );

      scheduleNextTrack(
        guildId,
        500
      );
    }
  );

  player.on(
    "error",
    (error) => {
      console.error(
        `[${guildId}] ❌ Player error:`,
        error?.message ||
          error
      );

      scheduleNextTrack(
        guildId,
        1000
      );
    }
  );

  players.set(
    guildId,
    player
  );

  return player;
}

// ======================================================
// VC PERMISSION
// ======================================================

async function requireVoice(
  message
) {
  if (
    !message.member?.voice
      ?.channel
  ) {
    await message.reply(
      "🔒 You must be connected to a voice channel to use music commands."
    );

    return false;
  }

  return true;
}

// ======================================================
// CONNECT
// ======================================================

async function connectToVoice(
  message
) {
  const voiceChannel =
    message.member?.voice
      ?.channel;

  if (!voiceChannel) {
    await message.reply(
      "❌ Join a voice channel first."
    );

    return null;
  }

  let connection =
    connections.get(
      message.guild.id
    );

  // Already in same VC
  if (
    connection &&
    connection.joinConfig
      .channelId ===
      voiceChannel.id
  ) {
    try {
      await entersState(
        connection,
        VoiceConnectionStatus.Ready,
        10000
      );

      return connection;
    } catch {
      connection.destroy();
      connections.delete(
        message.guild.id
      );
    }
  }

  // Move to another VC
  if (connection) {
    connection.destroy();

    connections.delete(
      message.guild.id
    );
  }

  connection =
    joinVoiceChannel({
      channelId:
        voiceChannel.id,

      guildId:
        message.guild.id,

      adapterCreator:
        message.guild
          .voiceAdapterCreator,

      selfDeaf: false,
      selfMute: false,
    });

  connections.set(
    message.guild.id,
    connection
  );

  connection.on(
    VoiceConnectionStatus.Disconnected,
    async () => {
      console.log(
        `[${message.guild.id}] ⚠️ Voice disconnected`
      );

      try {
        await Promise.race([
          entersState(
            connection,
            VoiceConnectionStatus.Signalling,
            5000
          ),

          entersState(
            connection,
            VoiceConnectionStatus.Connecting,
            5000
          ),
        ]);

        console.log(
          `[${message.guild.id}] 🔄 Reconnecting`
        );
      } catch {
        connection.destroy();

        connections.delete(
          message.guild.id
        );

        console.log(
          `[${message.guild.id}] ❌ Voice connection lost`
        );
      }
    }
  );

  try {
    await entersState(
      connection,
      VoiceConnectionStatus.Ready,
      15000
    );

    console.log(
      `[${message.guild.id}] 🔊 Voice ready`
    );

    return connection;
  } catch (error) {
    console.error(
      "Voice connection error:",
      error.message
    );

    connection.destroy();

    connections.delete(
      message.guild.id
    );

    await message.reply(
      "❌ I couldn't connect to your voice channel. Check my Connect and Speak permissions."
    );

    return null;
  }
}

// ======================================================
// YT-DLP METADATA
// ======================================================

async function getMediaInfo(
  url
) {
  const ytDlp =
    await getYtDlp();

  console.log(
    `🔎 yt-dlp info: ${url}`
  );

  const info =
    await ytDlp.getVideoInfo(
      url
    );

  if (!info) {
    throw new Error(
      "yt-dlp returned no information."
    );
  }

  return info;
}

// ======================================================
// SEARCH WITH YT-DLP
// ======================================================

async function searchMedia(
  query
) {
  const ytDlp =
    await getYtDlp();

  console.log(
    `🔎 Searching: ${query}`
  );

  const searchUrl =
    `ytsearch1:${query}`;

  const info =
    await ytDlp.getVideoInfo(
      searchUrl
    );

  if (!info) {
    throw new Error(
      "No result found."
    );
  }

  return info;
}

// ======================================================
// CONVERT METADATA
// ======================================================

function convertInfoToSong(
  info
) {
  if (!info) {
    throw new Error(
      "Invalid media information."
    );
  }

  const thumbnail =
    info.thumbnail ||
    info.thumbnails?.at(-1)
      ?.url ||
    null;

  return {
    url:
      info.webpage_url ||
      info.original_url,

    title:
      info.title ||
      "Unknown Track",

    duration:
      Number(info.duration)
        ? formatDuration(
            info.duration
          )
        : "Unknown",

    seconds:
      Number(info.duration) ||
      0,

    thumbnail,
  };
}

// ======================================================
// STREAM AUDIO
// ======================================================

async function createYtDlpAudioStream(
  url
) {
  const ytDlp =
    await getYtDlp();

  console.log(
    `🎵 Creating audio stream: ${url}`
  );

  /*
   * bestaudio prefers an audio-only stream.
   *
   * If that exact format isn't available,
   * yt-dlp falls back to another usable
   * audio format.
   */
  const args = [
    url,

    "--no-playlist",

    "--no-warnings",

    "--no-progress",

    "--quiet",

    "--newline",

    "-f",
    "bestaudio/best",

    "-o",
    "-",
  ];

  const stream =
    ytDlp.execStream(
      args
    );

  return stream;
}

// ======================================================
// FORMAT DURATION
// ======================================================

function formatDuration(
  seconds
) {
  if (
    !seconds ||
    Number.isNaN(
      Number(seconds)
    )
  ) {
    return "Unknown";
  }

  const total =
    Math.floor(
      Number(seconds)
    );

  const hours =
    Math.floor(
      total / 3600
    );

  const minutes =
    Math.floor(
      (total % 3600) / 60
    );

  const secondsLeft =
    total % 60;

  if (hours > 0) {
    return `${String(
      hours
    ).padStart(
      2,
      "0"
    )}:${String(
      minutes
    ).padStart(
      2,
      "0"
    )}:${String(
      secondsLeft
    ).padStart(
      2,
      "0"
    )}`;
  }

  return `${String(
    minutes
  ).padStart(
    2,
    "0"
  )}:${String(
    secondsLeft
  ).padStart(
    2,
    "0"
  )}`;
}

// ======================================================
// URL DETECTION
// ======================================================

function isSpotifyUrl(
  url
) {
  return /^https?:\/\/open\.spotify\.com\//i.test(
    url
  );
}

function isUrl(value) {
  try {
    new URL(value);

    return true;
  } catch {
    return false;
  }
}

// ======================================================
// SPOTIFY TRACK
// ======================================================

async function getSpotifyTrack(
  url
) {
  const preview =
    await getPreview(url);

  if (!preview) {
    throw new Error(
      "Couldn't read Spotify track."
    );
  }

  const artist =
    preview.artist ||
    preview.artists?.[0]
      ?.name ||
    "Unknown Artist";

  return {
    title:
      preview.title,

    artist,

    thumbnail:
      preview.image ||
      preview.thumbnail ||
      null,
  };
}

// ======================================================
// SPOTIFY PLAYLIST / ALBUM
// ======================================================

async function getSpotifyTracks(
  url
) {
  const data =
    await getTracks(url);

  if (!data) {
    return [];
  }

  const tracks =
    Array.isArray(data)
      ? data
      : data.tracks || [];

  return tracks
    .slice(
      0,
      MAX_SPOTIFY_TRACKS
    )
    .map(
      (track) => ({
        title:
          track.name ||
          "Unknown Track",

        artist:
          track.artist ||
          track.artists
            ?.map(
              (a) => a.name
            )
            .join(", ") ||
          "Unknown Artist",

        thumbnail:
          track.image ||
          track.album
            ?.images?.[0]
            ?.url ||
          null,
      })
    );
}

// ======================================================
// SPOTIFY → PLAYABLE SOURCE
// ======================================================

async function spotifyToSong(
  title,
  artist
) {
  /*
   * Spotify supplies metadata.
   * We search a publicly accessible
   * playable source for that track.
   */

  const searches = [
    `"${title}" "${artist}"`,
    `${title} ${artist}`,
  ];

  for (const query of searches) {
    try {
      const info =
        await searchMedia(
          query
        );

      const song =
        convertInfoToSong(
          info
        );

      if (song.url) {
        return song;
      }
    } catch (error) {
      console.log(
        `⚠️ Search failed: ${query}`
      );
    }
  }

  throw new Error(
    `Couldn't find a playable source for ${title}`
  );
}

// ======================================================
// EMBEDS
// ======================================================

function createEnqueuedEmbed(
  song
) {
  return new EmbedBuilder()
    .setColor(
      0x57f287
    )
    .setTitle(
      "Enqueued Track"
    )
    .setDescription(
      `✅ Added **${song.title}** to the queue.`
    )
    .addFields(
      {
        name:
          "Duration",
        value:
          song.duration ||
          "Unknown",
        inline: true,
      },
      {
        name:
          "Requester",
        value:
          `${song.requester}`,
        inline: true,
      },
      {
        name:
          "Position",
        value:
          `${song.position}`,
        inline: true,
      }
    )
    .setThumbnail(
      song.thumbnail ||
        null
    );
}

function createNowPlayingEmbed(
  song
) {
  return new EmbedBuilder()
    .setColor(
      0x5865f2
    )
    .setTitle(
      "🎵 Now Playing"
    )
    .setDescription(
      `**${song.title}**`
    )
    .addFields(
      {
        name:
          "Duration",
        value:
          song.duration ||
          "Unknown",
        inline: true,
      },
      {
        name:
          "Requested by",
        value:
          `${song.requester}`,
        inline: true,
      }
    )
    .setThumbnail(
      song.thumbnail ||
        null
    );
}

// ======================================================
// BUTTONS
// ======================================================

function createMusicButtons() {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          "music_pause"
        )
        .setLabel(
          "Pause"
        )
        .setStyle(
          ButtonStyle.Secondary
        ),

      new ButtonBuilder()
        .setCustomId(
          "music_resume"
        )
        .setLabel(
          "Resume"
        )
        .setStyle(
          ButtonStyle.Success
        ),

      new ButtonBuilder()
        .setCustomId(
          "music_skip"
        )
        .setLabel(
          "Skip"
        )
        .setStyle(
          ButtonStyle.Primary
        ),

      new ButtonBuilder()
        .setCustomId(
          "music_shuffle"
        )
        .setLabel(
          "Shuffle"
        )
        .setStyle(
          ButtonStyle.Secondary
        ),

      new ButtonBuilder()
        .setCustomId(
          "music_stop"
        )
        .setLabel(
          "Stop"
        )
        .setStyle(
          ButtonStyle.Danger
        )
    );
}

// ======================================================
// NEXT TRACK LOCK
// ======================================================

function scheduleNextTrack(
  guildId,
  delay = 500
) {
  if (
    nextTrackLocks.get(
      guildId
    )
  ) {
    return;
  }

  nextTrackLocks.set(
    guildId,
    true
  );

  setTimeout(
    async () => {
      try {
        await playNext(
          guildId
        );
      } catch (error) {
        console.error(
          "Next-track error:",
          error
        );
      } finally {
        nextTrackLocks.delete(
          guildId
        );
      }
    },
    delay
  );
}

// ======================================================
// PLAY NEXT
// ======================================================

async function playNext(
  guildId
) {
  const queue =
    getQueue(guildId);

  if (!queue.length) {
    currentSongs.delete(
      guildId
    );

    console.log(
      `[${guildId}] 📭 Queue empty`
    );

    return;
  }

  const connection =
    connections.get(
      guildId
    );

  if (!connection) {
    console.log(
      `[${guildId}] ❌ No voice connection`
    );

    return;
  }

  const song =
    queue.shift();

  updateQueuePositions(
    guildId
  );

  currentSongs.set(
    guildId,
    song
  );

  try {
    await entersState(
      connection,
      VoiceConnectionStatus.Ready,
      10000
    );

    const player =
      getPlayer(guildId);

    connection.subscribe(
      player
    );

    console.log(
      `[${guildId}] 🎵 Playing: ${song.title}`
    );

    console.log(
      `[${guildId}] 🔗 ${song.url}`
    );

    // ==========================================
    // CREATE STREAM WITH YT-DLP
    // ==========================================

    const audioStream =
      await createYtDlpAudioStream(
        song.url
      );

    if (!audioStream) {
      throw new Error(
        "yt-dlp returned an empty audio stream."
      );
    }

    // ==========================================
    // DISCORD AUDIO RESOURCE
    // ==========================================

    /*
     * yt-dlp can return different containers/codecs.
     *
     * Arbitrary tells discord.js to use its
     * audio processing pipeline to turn it
     * into playable Discord audio.
     */

    const resource =
      createAudioResource(
        audioStream,
        {
          inputType:
            StreamType.Arbitrary,

          inlineVolume:
            false,

          silencePaddingFrames:
            5,

          metadata: {
            title:
              song.title,
          },
        }
      );

    // ==========================================
    // PLAY
    // ==========================================

    player.play(
      resource
    );

    console.log(
      `[${guildId}] 🔊 Audio started`
    );

    // ==========================================
    // NOW PLAYING
    // ==========================================

    const channel =
      await client.channels
        .fetch(
          song.textChannelId
        )
        .catch(
          () => null
        );

    if (
      channel?.isTextBased()
    ) {
      await channel.send({
        embeds: [
          createNowPlayingEmbed(
            song
          ),
        ],

        components: [
          createMusicButtons(),
        ],
      });
    }
  } catch (error) {
    console.error(
      `[${guildId}] ❌ Playback failed`
    );

    console.error(
      error?.stack ||
        error?.message ||
        error
    );

    const channel =
      await client.channels
        .fetch(
          song.textChannelId
        )
        .catch(
          () => null
        );

    if (
      channel?.isTextBased()
    ) {
      await channel.send(
        `❌ Couldn't play **${song.title}**.\n\`${String(
          error.message
        ).slice(0, 500)}\``
      );
    }

    currentSongs.delete(
      guildId
    );

    if (
      queue.length
    ) {
      scheduleNextTrack(
        guildId,
        1000
      );
    }
  }
}

// ======================================================
// CLIENT
// ======================================================

const client =
  new Client({
    intents: [
      GatewayIntentBits.Guilds,

      GatewayIntentBits.GuildMessages,

      GatewayIntentBits.MessageContent,

      GatewayIntentBits.GuildVoiceStates,
    ],
  });

// ======================================================
// READY
// ======================================================

client.once(
  Events.ClientReady,
  async (bot) => {
    console.log(
      `✅ Logged in as ${bot.user.tag}`
    );

    try {
      await setupYtDlp();

      console.log(
        "🎵 Music engine ready."
      );
    } catch (error) {
      console.error(
        "❌ Music engine setup failed:",
        error
      );
    }
  }
);

// ======================================================
// COMMANDS
// ======================================================

client.on(
  Events.MessageCreate,
  async (message) => {
    if (message.author.bot)
      return;

    if (!message.guild)
      return;

    if (
      !message.content.startsWith(
        PREFIX
      )
    ) {
      return;
    }

    const args =
      message.content
        .slice(
          PREFIX.length
        )
        .trim()
        .split(/\s+/);

    const command =
      args
        .shift()
        ?.toLowerCase();

    // ==========================================
    // HELP
    // ==========================================

    if (
      command === "help"
    ) {
      const embed =
        new EmbedBuilder()
          .setColor(
            0x5865f2
          )
          .setTitle(
            "🎵 Lalli MUSIC Commands"
          )
          .setDescription(
            [
              "`!join` — Join VC",
              "`!leave` — Leave VC",
              "`!play <song/link>` — Play",
              "`!pause` — Pause",
              "`!resume` — Resume",
              "`!skip` — Skip",
              "`!shuffle` — Shuffle",
              "`!queue` — Queue",
              "`!stop` — Stop",
            ].join("\n")
          )
          .setFooter({
            text:
              "You must be in a voice channel to use music commands.",
          });

      return message.reply({
        embeds: [
          embed,
        ],
      });
    }

    // ==========================================
    // PING
    // ==========================================

    if (
      command === "ping"
    ) {
      return message.reply(
        "🏓 Pong!"
      );
    }

    // ==========================================
    // MUSIC COMMANDS
    // ==========================================

    const musicCommands = [
      "join",
      "leave",
      "play",
      "pause",
      "resume",
      "skip",
      "shuffle",
      "queue",
      "stop",
    ];

    if (
      musicCommands.includes(
        command
      )
    ) {
      const allowed =
        await requireVoice(
          message
        );

      if (!allowed)
        return;
    }

    // ==========================================
    // JOIN
    // ==========================================

    if (
      command === "join"
    ) {
      const connection =
        await connectToVoice(
          message
        );

      if (connection) {
        await message.reply(
          `🔊 Joined **${message.member.voice.channel.name}**.`
        );
      }

      return;
    }

    // ==========================================
    // LEAVE
    // ==========================================

    if (
      command === "leave"
    ) {
      const connection =
        connections.get(
          message.guild.id
        );

      if (connection) {
        connection.destroy();

        connections.delete(
          message.guild.id
        );
      }

      const queue =
        getQueue(
          message.guild.id
        );

      queue.length = 0;

      currentSongs.delete(
        message.guild.id
      );

      getPlayer(
        message.guild.id
      ).stop(true);

      return message.reply(
        "👋 Left the voice channel."
      );
    }

    // ==========================================
    // PLAY
    // ==========================================

    if (
      command === "play"
    ) {
      if (!args.length) {
        return message.reply(
          "❌ Usage: `!play <song name / URL>`"
        );
      }

      const query =
        args.join(" ");

      const connection =
        await connectToVoice(
          message
        );

      if (!connection)
        return;

      const queue =
        getQueue(
          message.guild.id
        );

      try {
        // ======================================
        // SPOTIFY
        // ======================================

        if (
          isSpotifyUrl(
            query
          )
        ) {
          // Spotify track
          if (
            query.includes(
              "/track/"
            )
          ) {
            const spotifyTrack =
              await getSpotifyTrack(
                query
              );

            const source =
              await spotifyToSong(
                spotifyTrack.title,
                spotifyTrack.artist
              );

            const song = {
              ...source,

              title:
                `${spotifyTrack.title} — ${spotifyTrack.artist}`,

              thumbnail:
                spotifyTrack.thumbnail ||
                source.thumbnail,

              requester:
                message.author,

              textChannelId:
                message.channel.id,
            };

            queue.push(
              song
            );

            updateQueuePositions(
              message.guild.id
            );

            await message.channel.send(
              {
                embeds: [
                  createEnqueuedEmbed(
                    song
                  ),
                ],
              }
            );
          }

          // Spotify playlist / album
          else if (
            query.includes(
              "/playlist/"
            ) ||
            query.includes(
              "/album/"
            )
          ) {
            const tracks =
              await getSpotifyTracks(
                query
              );

            if (!tracks.length) {
              return message.reply(
                "❌ No tracks found in the Spotify collection."
              );
            }

            await message.reply(
              `🎧 Found **${tracks.length}** tracks. Adding them to the queue...`
            );

            let added = 0;

            for (
              const track of tracks
            ) {
              try {
                const source =
                  await spotifyToSong(
                    track.title,
                    track.artist
                  );

                queue.push({
                  ...source,

                  title:
                    `${track.title} — ${track.artist}`,

                  thumbnail:
                    track.thumbnail ||
                    source.thumbnail,

                  requester:
                    message.author,

                  textChannelId:
                    message.channel.id,
                });

                added++;
              } catch {
                console.log(
                  `⚠️ Couldn't find: ${track.title}`
                );
              }
            }

            updateQueuePositions(
              message.guild.id
            );

            await message.channel.send(
              `✅ Added **${added}** tracks.`
            );
          } else {
            return message.reply(
              "❌ Unsupported Spotify URL."
            );
          }
        }

        // ======================================
        // DIRECT URL
        // ======================================

        else if (
          isUrl(query)
        ) {
          console.log(
            `🌐 URL detected: ${query}`
          );

          const info =
            await getMediaInfo(
              query
            );

          const song =
            convertInfoToSong(
              info
            );

          song.requester =
            message.author;

          song.textChannelId =
            message.channel.id;

          queue.push(
            song
          );

          updateQueuePositions(
            message.guild.id
          );

          await message.channel.send(
            {
              embeds: [
                createEnqueuedEmbed(
                  song
                ),
              ],
            }
          );
        }

        // ======================================
        // SEARCH
        // ======================================

        else {
          const info =
            await searchMedia(
              query
            );

          const song =
            convertInfoToSong(
              info
            );

          song.requester =
            message.author;

          song.textChannelId =
            message.channel.id;

          queue.push(
            song
          );

          updateQueuePositions(
            message.guild.id
          );

          await message.channel.send(
            {
              embeds: [
                createEnqueuedEmbed(
                  song
                ),
              ],
            }
          );
        }

        // ======================================
        // START
        // ======================================

        const player =
          getPlayer(
            message.guild.id
          );

        if (
          player.state.status ===
          AudioPlayerStatus.Idle
        ) {
          scheduleNextTrack(
            message.guild.id,
            300
          );
        }
      } catch (error) {
        console.error(
          "❌ Play error:",
          error
        );

        await message.reply(
          `❌ Couldn't play that.\n\`${String(
            error.message
          ).slice(0, 700)}\``
        );
      }

      return;
    }

    // ==========================================
    // PAUSE
    // ==========================================

    if (
      command === "pause"
    ) {
      const player =
        getPlayer(
          message.guild.id
        );

      if (
        player.pause(true)
      ) {
        return message.reply(
          "⏸️ Paused."
        );
      }

      return message.reply(
        "❌ Nothing is playing."
      );
    }

    // ==========================================
    // RESUME
    // ==========================================

    if (
      command === "resume"
    ) {
      const player =
        getPlayer(
          message.guild.id
        );

      if (
        player.unpause()
      ) {
        return message.reply(
          "▶️ Resumed."
        );
      }

      return message.reply(
        "❌ Nothing is paused."
      );
    }

    // ==========================================
    // SKIP
    // ==========================================

    if (
      command === "skip"
    ) {
      const player =
        getPlayer(
          message.guild.id
        );

      if (
        player.state.status !==
        AudioPlayerStatus.Idle
      ) {
        player.stop(true);

        return message.reply(
          "⏭️ Skipped."
        );
      }

      return message.reply(
        "❌ Nothing is playing."
      );
    }

    // ==========================================
    // SHUFFLE
    // ==========================================

    if (
      command === "shuffle"
    ) {
      const queue =
        getQueue(
          message.guild.id
        );

      if (
        queue.length < 2
      ) {
        return message.reply(
          "❌ Need at least 2 songs."
        );
      }

      for (
        let i =
          queue.length - 1;
        i > 0;
        i--
      ) {
        const j =
          Math.floor(
            Math.random() *
              (i + 1)
          );

        [
          queue[i],
          queue[j],
        ] = [
          queue[j],
          queue[i],
        ];
      }

      updateQueuePositions(
        message.guild.id
      );

      return message.reply(
        "🔀 Queue shuffled."
      );
    }

    // ==========================================
    // QUEUE
    // ==========================================

    if (
      command === "queue"
    ) {
      const queue =
        getQueue(
          message.guild.id
        );

      if (!queue.length) {
        return message.reply(
          "📭 Queue is empty."
        );
      }

      const text =
        queue
          .slice(0, 15)
          .map(
            (song, index) =>
              `**${index + 1}.** ${song.title}`
          )
          .join("\n");

      const embed =
        new EmbedBuilder()
          .setColor(
            0x5865f2
          )
          .setTitle(
            "🎵 Music Queue"
          )
          .setDescription(
            text
          );

      return message.reply({
        embeds: [
          embed,
        ],
      });
    }

    // ==========================================
    // STOP
    // ==========================================

    if (
      command === "stop"
    ) {
      const queue =
        getQueue(
          message.guild.id
        );

      queue.length = 0;

      currentSongs.delete(
        message.guild.id
      );

      getPlayer(
        message.guild.id
      ).stop(true);

      return message.reply(
        "⏹️ Music stopped and queue cleared."
      );
    }
  }
);

// ======================================================
// BUTTONS
// ======================================================

client.on(
  Events.InteractionCreate,
  async (interaction) => {
    if (
      !interaction.isButton()
    ) {
      return;
    }

    const guildId =
      interaction.guild?.id;

    if (!guildId)
      return;

    // User must be in VC
    if (
      !interaction.member
        ?.voice?.channel
    ) {
      return interaction.reply(
        {
          content:
            "🔒 You must be connected to a voice channel to use music controls.",

          ephemeral: true,
        }
      );
    }

    const player =
      getPlayer(
        guildId
      );

    const queue =
      getQueue(
        guildId
      );

    // Pause
    if (
      interaction.customId ===
      "music_pause"
    ) {
      if (
        player.pause(true)
      ) {
        return interaction.reply(
          {
            content:
              "⏸️ Paused.",
            ephemeral: true,
          }
        );
      }

      return interaction.reply(
        {
          content:
            "❌ Nothing is playing.",
          ephemeral: true,
        }
      );
    }

    // Resume
    if (
      interaction.customId ===
      "music_resume"
    ) {
      if (
        player.unpause()
      ) {
        return interaction.reply(
          {
            content:
              "▶️ Resumed.",
            ephemeral: true,
          }
        );
      }

      return interaction.reply(
        {
          content:
            "❌ Nothing is paused.",
          ephemeral: true,
        }
      );
    }

    // Skip
    if (
      interaction.customId ===
      "music_skip"
    ) {
      if (
        player.state.status !==
        AudioPlayerStatus.Idle
      ) {
        player.stop(true);

        return interaction.reply(
          {
            content:
              "⏭️ Skipped.",
            ephemeral: true,
          }
        );
      }

      return interaction.reply(
        {
          content:
            "❌ Nothing is playing.",
          ephemeral: true,
        }
      );
    }

    // Shuffle
    if (
      interaction.customId ===
      "music_shuffle"
    ) {
      if (
        queue.length < 2
      ) {
        return interaction.reply(
          {
            content:
              "❌ Need at least 2 queued songs.",
            ephemeral: true,
          }
        );
      }

      for (
        let i =
          queue.length - 1;
        i > 0;
        i--
      ) {
        const j =
          Math.floor(
            Math.random() *
              (i + 1)
          );

        [
          queue[i],
          queue[j],
        ] = [
          queue[j],
          queue[i],
        ];
      }

      updateQueuePositions(
        guildId
      );

      return interaction.reply(
        {
          content:
            "🔀 Queue shuffled.",
          ephemeral: true,
        }
      );
    }

    // Stop
    if (
      interaction.customId ===
      "music_stop"
    ) {
      queue.length = 0;

      currentSongs.delete(
        guildId
      );

      player.stop(true);

      return interaction.reply(
        {
          content:
            "⏹️ Music stopped and queue cleared.",
          ephemeral: true,
        }
      );
    }
  }
);

// ======================================================
// START
// ======================================================

async function startBot() {
  try {
    console.log(
      "🚀 Starting music bot..."
    );

    await setupYtDlp();

    console.log(
      "✅ Music engine initialized."
    );

    await client.login(
      TOKEN
    );
  } catch (error) {
    console.error(
      "❌ Bot startup failed:",
      error
    );

    process.exit(1);
  }
}

startBot();