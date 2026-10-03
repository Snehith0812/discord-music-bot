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
} from "@discordjs/voice";

import play from "@iamtraction/play-dl";
import fetch from "isomorphic-unfetch";
import spotify from "spotify-url-info";

const {
  getPreview,
  getTracks,
} = spotify(fetch);

const PREFIX = "!";
const TOKEN = process.env.DISCORD_TOKEN;

if (!TOKEN) {
  console.error("❌ DISCORD_TOKEN is missing.");
  process.exit(1);
}

const MAX_SPOTIFY_TRACKS = 25;

// ===============================
// STORAGE
// ===============================

const players = new Map();
const connections = new Map();
const queues = new Map();
const nowPlayingMessages = new Map();
const nextTrackLocks = new Map();

// ===============================
// HELPERS
// ===============================

function getQueue(guildId) {
  if (!queues.has(guildId)) {
    queues.set(guildId, []);
  }

  return queues.get(guildId);
}

function getPlayer(guildId) {
  if (!players.has(guildId)) {
    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause,
        maxMissedFrames: 10,
      },
    });

    player.on(AudioPlayerStatus.Buffering, () => {
      console.log(`[${guildId}] 🔄 Buffering...`);
    });

    player.on(AudioPlayerStatus.Playing, () => {
      console.log(`[${guildId}] ▶️ Playing`);
    });

    player.on(AudioPlayerStatus.Idle, () => {
      console.log(`[${guildId}] ⏹️ Idle`);
      scheduleNextTrack(guildId, 500);
    });

    player.on("error", (error) => {
      console.error(
        `[${guildId}] ❌ Audio player error:`,
        error?.message || error
      );

      scheduleNextTrack(guildId, 1000);
    });

    players.set(guildId, player);
  }

  return players.get(guildId);
}

// ===============================
// VOICE CONNECTION
// ===============================

async function connectToVoice(message) {
  const voiceChannel = message.member?.voice?.channel;

  if (!voiceChannel) {
    await message.reply("❌ You must be connected to a voice channel.");
    return null;
  }

  let connection = connections.get(message.guild.id);

  if (!connection) {
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    connections.set(message.guild.id, connection);

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      console.log(`[${message.guild.id}] ⚠️ Voice disconnected.`);

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

        console.log(`[${message.guild.id}] 🔄 Reconnecting...`);
      } catch {
        console.log(`[${message.guild.id}] ❌ Voice connection lost.`);
        connection.destroy();
        connections.delete(message.guild.id);
      }
    });
  }

  // If bot is already connected to another VC, move it.
  if (connection.joinConfig.channelId !== voiceChannel.id) {
    connection.destroy();

    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    connections.set(message.guild.id, connection);
  }

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15000);
    return connection;
  } catch (error) {
    console.error("Voice connection failed:", error);

    await message.reply(
      "❌ I couldn't connect to the voice channel. Check that I have **Connect** and **Speak** permissions."
    );

    return null;
  }
}

// ===============================
// VC PERMISSION CHECK
// ===============================

function requireVoiceChannel(message) {
  const userChannel = message.member?.voice?.channel;

  if (!userChannel) {
    message.reply(
      "🔒 You must be connected to a voice channel to use music commands."
    );

    return false;
  }

  return true;
}

// ===============================
// FORMAT DURATION
// ===============================

function formatDuration(seconds) {
  if (!seconds || Number.isNaN(seconds)) {
    return "00m 00s";
  }

  seconds = Math.floor(seconds);

  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;

  return `${String(minutes).padStart(2, "0")}m ${String(
    secs
  ).padStart(2, "0")}s`;
}

// ===============================
// YOUTUBE SEARCH
// ===============================

async function searchYouTube(query) {
  console.log(`🔎 YouTube search: ${query}`);

  const results = await play.search(query, {
    limit: 5,
    source: {
      youtube: "video",
    },
  });

  const result = results.find(
    (item) => item.type === "video" && item.url
  );

  if (!result) {
    throw new Error("No playable YouTube result found.");
  }

  return {
    url: result.url,
    title: result.title || query,
    duration: result.durationRaw || "Unknown",
    seconds: result.durationInSec || 0,
    thumbnail:
      result.thumbnails?.[0]?.url ||
      result.thumbnail?.url ||
      null,
  };
}

// ===============================
// GET YOUTUBE INFO
// ===============================

async function getYouTubeInfo(url) {
  const info = await play.video_basic_info(url);

  const video = info.video_details;

  return {
    url,
    title: video.title || "Unknown Track",
    duration: video.durationRaw || "Unknown",
    seconds: Number(video.durationInSec) || 0,
    thumbnail:
      video.thumbnails?.[0]?.url ||
      null,
  };
}

// ===============================
// SPOTIFY
// ===============================

function isSpotifyUrl(url) {
  return /^https?:\/\/open\.spotify\.com\//i.test(url);
}

async function getSpotifyTrack(url) {
  const preview = await getPreview(url);

  if (!preview) {
    throw new Error("Unable to read Spotify track.");
  }

  return {
    title: preview.title,
    artist:
      preview.artist ||
      preview.artists?.[0]?.name ||
      "Unknown Artist",
    thumbnail:
      preview.image ||
      preview.thumbnail ||
      null,
  };
}

async function getSpotifyTracks(url) {
  const data = await getTracks(url);

  if (!data) {
    return [];
  }

  const tracks = Array.isArray(data)
    ? data
    : data.tracks || [];

  return tracks.slice(0, MAX_SPOTIFY_TRACKS).map((track) => ({
    title: track.name,
    artist:
      track.artist ||
      track.artists?.map((a) => a.name).join(", ") ||
      "Unknown Artist",
    thumbnail:
      track.image ||
      track.album?.images?.[0]?.url ||
      null,
  }));
}

// ===============================
// SPOTIFY → PLAYABLE SOURCE
// ===============================

async function findSpotifyPlayableSource(title, artist) {
  const searches = [
    `"${title}" "${artist}" official audio`,
    `"${title}" "${artist}" audio`,
    `${title} ${artist}`,
  ];

  for (const query of searches) {
    try {
      const result = await searchYouTube(query);

      if (result?.url) {
        return result;
      }
    } catch (error) {
      console.log(
        `YouTube search failed for "${query}":`,
        error.message
      );
    }
  }

  throw new Error(`Couldn't find playable audio for ${title}`);
}

// ===============================
// QUEUE POSITIONS
// ===============================

function updateQueuePositions(guildId) {
  const queue = getQueue(guildId);

  queue.forEach((song, index) => {
    song.position = index + 1;
  });
}

// ===============================
// NEXT TRACK LOCK
// ===============================

function scheduleNextTrack(guildId, delay = 500) {
  if (nextTrackLocks.get(guildId)) {
    return;
  }

  nextTrackLocks.set(guildId, true);

  setTimeout(async () => {
    try {
      await playNext(guildId);
    } catch (error) {
      console.error(
        `[${guildId}] playNext error:`,
        error.message
      );
    } finally {
      nextTrackLocks.delete(guildId);
    }
  }, delay);
}

// ===============================
// NOW PLAYING EMBED
// ===============================

function createNowPlayingEmbed(song) {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🎵 Now Playing")
    .setDescription(`**${song.title}**`)
    .addFields(
      {
        name: "Duration",
        value: song.duration || "Unknown",
        inline: true,
      },
      {
        name: "Requested by",
        value: `${song.requester}`,
        inline: true,
      }
    )
    .setThumbnail(song.thumbnail || null);
}

// ===============================
// ENQUEUED EMBED
// ===============================

function createEnqueuedEmbed(song) {
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle("Enqueued Track")
    .setDescription(
      `✅ Added **${song.title}** to the queue.`
    )
    .addFields(
      {
        name: "Duration",
        value: song.duration || "Unknown",
        inline: true,
      },
      {
        name: "Requester",
        value: `${song.requester}`,
        inline: true,
      },
      {
        name: "Position",
        value: `${song.position}`,
        inline: true,
      }
    )
    .setThumbnail(song.thumbnail || null);
}

// ===============================
// MUSIC BUTTONS
// ===============================

function createMusicButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("music_pause")
      .setLabel("Pause")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("music_skip")
      .setLabel("Skip")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId("music_shuffle")
      .setLabel("Shuffle")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("music_stop")
      .setLabel("Stop")
      .setStyle(ButtonStyle.Danger),

    new ButtonBuilder()
      .setCustomId("music_like")
      .setLabel("Like")
      .setStyle(ButtonStyle.Success)
  );
}

// ===============================
// PLAY NEXT
// ===============================

async function playNext(guildId) {
  const queue = getQueue(guildId);

  if (!queue.length) {
    console.log(`[${guildId}] Queue empty.`);
    return;
  }

  const song = queue.shift();

  updateQueuePositions(guildId);

  const connection = connections.get(guildId);

  if (!connection) {
    console.log(`[${guildId}] No voice connection.`);
    return;
  }

  try {
    await entersState(
      connection,
      VoiceConnectionStatus.Ready,
      10000
    );

    const player = getPlayer(guildId);

    connection.subscribe(player);

    console.log(
      `[${guildId}] 🎵 Starting: ${song.title}`
    );

    console.log(
      `[${guildId}] 🔗 Source: ${song.url}`
    );

    // Get fresh stream
    const stream = await play.stream(song.url, {
      quality: 2,
    });

    if (!stream || !stream.stream) {
      throw new Error("play-dl returned an empty stream.");
    }

    console.log(
      `[${guildId}] ✅ Audio stream created. Type: ${stream.type}`
    );

    const resource = createAudioResource(stream.stream, {
      inputType: stream.type,
      inlineVolume: false,
      silencePaddingFrames: 5,
    });

    player.play(resource);

    console.log(
      `[${guildId}] ▶️ Audio player started.`
    );

    const channel = await client.channels
      .fetch(song.textChannelId)
      .catch(() => null);

    if (channel?.isTextBased()) {
      const message = await channel.send({
        embeds: [createNowPlayingEmbed(song)],
        components: [createMusicButtons()],
      });

      nowPlayingMessages.set(guildId, message.id);
    }
  } catch (error) {
    console.error(
      `[${guildId}] ❌ Playback failed:`,
      error
    );

    const channel = await client.channels
      .fetch(song.textChannelId)
      .catch(() => null);

    if (channel?.isTextBased()) {
      await channel
        .send(
          `❌ Couldn't play **${song.title}**.\n\`${error.message}\``
        )
        .catch(() => {});
    }

    // Try next track
    scheduleNextTrack(guildId, 1000);
  }
}

// ===============================
// DISCORD CLIENT
// ===============================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// ===============================
// READY
// ===============================

client.once(Events.ClientReady, (bot) => {
  console.log(`✅ Logged in as ${bot.user.tag}`);
  console.log("🎵 Music bot is ready.");
});

// ===============================
// MESSAGE COMMANDS
// ===============================

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  if (!message.guild) return;

  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content
    .slice(PREFIX.length)
    .trim()
    .split(/\s+/);

  const command = args.shift()?.toLowerCase();

  // ============================
  // HELP
  // ============================

  if (command === "help") {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("🎵 Music Bot Commands")
      .setDescription(
        [
          "`!join` - Join your voice channel",
          "`!leave` - Leave voice channel",
          "`!play <song/link>` - Play music",
          "`!pause` - Pause music",
          "`!resume` - Resume music",
          "`!skip` - Skip current song",
          "`!shuffle` - Shuffle queue",
          "`!queue` - Show queue",
          "`!stop` - Stop music",
        ].join("\n")
      )
      .setFooter({
        text: "Music commands require you to be in a voice channel.",
      });

    return message.reply({ embeds: [embed] });
  }

  // ============================
  // PING
  // ============================

  if (command === "ping") {
    return message.reply("🏓 Pong!");
  }

  // ============================
  // ALL MUSIC COMMANDS BELOW
  // REQUIRE VC
  // ============================

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

  if (musicCommands.includes(command)) {
    if (!requireVoiceChannel(message)) {
      return;
    }
  }

  // ============================
  // JOIN
  // ============================

  if (command === "join") {
    const connection = await connectToVoice(message);

    if (connection) {
      await message.reply(
        `🔊 Joined **${message.member.voice.channel.name}**.`
      );
    }

    return;
  }

  // ============================
  // LEAVE
  // ============================

  if (command === "leave") {
    const connection = connections.get(message.guild.id);

    if (connection) {
      connection.destroy();
      connections.delete(message.guild.id);
    }

    const queue = getQueue(message.guild.id);
    queue.length = 0;

    getPlayer(message.guild.id).stop(true);

    await message.reply("👋 Left the voice channel.");

    return;
  }

  // ============================
  // PLAY
  // ============================

  if (command === "play") {
    if (!args.length) {
      return message.reply(
        "❌ Usage: `!play <YouTube URL / Spotify URL / song name>`"
      );
    }

    const query = args.join(" ");

    const connection = await connectToVoice(message);

    if (!connection) return;

    const queue = getQueue(message.guild.id);

    try {
      let song;

      // ========================
      // SPOTIFY URL
      // ========================

      if (isSpotifyUrl(query)) {
        console.log("🎧 Spotify URL detected.");

        // Track
        if (query.includes("/track/")) {
          const spotifyTrack = await getSpotifyTrack(query);

          console.log(
            `Spotify track: ${spotifyTrack.title} - ${spotifyTrack.artist}`
          );

          const youtube = await findSpotifyPlayableSource(
            spotifyTrack.title,
            spotifyTrack.artist
          );

          song = {
            ...youtube,
            title: `${spotifyTrack.title} — ${spotifyTrack.artist}`,
            thumbnail:
              spotifyTrack.thumbnail ||
              youtube.thumbnail,
          };

          queue.push({
            ...song,
            requester: message.author,
            textChannelId: message.channel.id,
          });
        }

        // Playlist / Album
        else if (
          query.includes("/playlist/") ||
          query.includes("/album/")
        ) {
          const spotifyTracks =
            await getSpotifyTracks(query);

          if (!spotifyTracks.length) {
            return message.reply(
              "❌ No tracks found in this Spotify playlist/album."
            );
          }

          let added = 0;

          await message.reply(
            `🎧 Found **${spotifyTracks.length}** Spotify tracks. Searching playable audio...`
          );

          for (const track of spotifyTracks) {
            try {
              const youtube =
                await findSpotifyPlayableSource(
                  track.title,
                  track.artist
                );

              queue.push({
                ...youtube,
                title: `${track.title} — ${track.artist}`,
                thumbnail:
                  track.thumbnail ||
                  youtube.thumbnail,
                requester: message.author,
                textChannelId: message.channel.id,
              });

              added++;
            } catch (error) {
              console.log(
                `Skipped Spotify track: ${track.title}`,
                error.message
              );
            }
          }

          updateQueuePositions(message.guild.id);

          await message.channel.send(
            `✅ Added **${added}** Spotify tracks to the queue.`
          );
        } else {
          return message.reply(
            "❌ Unsupported Spotify URL."
          );
        }
      }

      // ========================
      // YOUTUBE URL
      // ========================

      else if (
        query.includes("youtube.com/") ||
        query.includes("youtu.be/")
      ) {
        song = await getYouTubeInfo(query);

        queue.push({
          ...song,
          requester: message.author,
          textChannelId: message.channel.id,
        });
      }

      // ========================
      // SONG NAME
      // ========================

      else {
        song = await searchYouTube(query);

        queue.push({
          ...song,
          requester: message.author,
          textChannelId: message.channel.id,
        });
      }

      updateQueuePositions(message.guild.id);

      if (song) {
        const addedSong = queue[queue.length - 1];

        await message.channel.send({
          embeds: [createEnqueuedEmbed(addedSong)],
        });
      }

      // Start playback if player isn't already active
      const player = getPlayer(message.guild.id);

      if (
        player.state.status === AudioPlayerStatus.Idle
      ) {
        scheduleNextTrack(message.guild.id, 300);
      }
    } catch (error) {
      console.error("Play command error:", error);

      await message.reply(
        `❌ Couldn't add that track.\n\`${error.message}\``
      );
    }

    return;
  }

  // ============================
  // PAUSE
  // ============================

  if (command === "pause") {
    const player = getPlayer(message.guild.id);

    if (player.pause(true)) {
      await message.reply("⏸️ Paused.");
    } else {
      await message.reply("❌ Nothing is currently playing.");
    }

    return;
  }

  // ============================
  // RESUME
  // ============================

  if (command === "resume") {
    const player = getPlayer(message.guild.id);

    if (player.unpause()) {
      await message.reply("▶️ Resumed.");
    } else {
      await message.reply("❌ Nothing is paused.");
    }

    return;
  }

  // ============================
  // SKIP
  // ============================

  if (command === "skip") {
    const player = getPlayer(message.guild.id);

    if (player.state.status !== AudioPlayerStatus.Idle) {
      player.stop(true);
      await message.reply("⏭️ Skipped.");
    } else {
      await message.reply("❌ Nothing is currently playing.");
    }

    return;
  }

  // ============================
  // SHUFFLE
  // ============================

  if (command === "shuffle") {
    const queue = getQueue(message.guild.id);

    if (queue.length < 2) {
      return message.reply(
        "❌ Need at least 2 queued songs to shuffle."
      );
    }

    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));

      [queue[i], queue[j]] = [queue[j], queue[i]];
    }

    updateQueuePositions(message.guild.id);

    await message.reply("🔀 Queue shuffled.");

    return;
  }

  // ============================
  // QUEUE
  // ============================

  if (command === "queue") {
    const queue = getQueue(message.guild.id);

    if (!queue.length) {
      return message.reply("📭 The queue is empty.");
    }

    const text = queue
      .slice(0, 15)
      .map(
        (song, index) =>
          `**${index + 1}.** ${song.title}`
      )
      .join("\n");

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("🎵 Music Queue")
      .setDescription(text);

    return message.reply({
      embeds: [embed],
    });
  }

  // ============================
  // STOP
  // ============================

  if (command === "stop") {
    const queue = getQueue(message.guild.id);

    queue.length = 0;

    const player = getPlayer(message.guild.id);

    player.stop(true);

    await message.reply("⏹️ Music stopped and queue cleared.");

    return;
  }
});

// ===============================
// BUTTONS
// ===============================

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  const guildId = interaction.guild?.id;

  if (!guildId) return;

  // Buttons also require VC
  const member = interaction.member;

  if (!member?.voice?.channel) {
    return interaction.reply({
      content:
        "🔒 You must be connected to a voice channel to use music controls.",
      ephemeral: true,
    });
  }

  const player = getPlayer(guildId);
  const queue = getQueue(guildId);

  // ============================
  // PAUSE
  // ============================

  if (interaction.customId === "music_pause") {
    if (player.pause(true)) {
      return interaction.reply({
        content: "⏸️ Paused.",
        ephemeral: true,
      });
    }

    return interaction.reply({
      content: "❌ Nothing is playing.",
      ephemeral: true,
    });
  }

  // ============================
  // SKIP
  // ============================

  if (interaction.customId === "music_skip") {
    if (player.state.status !== AudioPlayerStatus.Idle) {
      player.stop(true);

      return interaction.reply({
        content: "⏭️ Skipped.",
        ephemeral: true,
      });
    }

    return interaction.reply({
      content: "❌ Nothing is playing.",
      ephemeral: true,
    });
  }

  // ============================
  // SHUFFLE
  // ============================

  if (interaction.customId === "music_shuffle") {
    if (queue.length < 2) {
      return interaction.reply({
        content:
          "❌ Need at least 2 songs in the queue.",
        ephemeral: true,
      });
    }

    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));

      [queue[i], queue[j]] = [queue[j], queue[i]];
    }

    updateQueuePositions(guildId);

    return interaction.reply({
      content: "🔀 Queue shuffled.",
      ephemeral: true,
    });
  }

  // ============================
  // STOP
  // ============================

  if (interaction.customId === "music_stop") {
    queue.length = 0;

    player.stop(true);

    return interaction.reply({
      content: "⏹️ Music stopped and queue cleared.",
      ephemeral: true,
    });
  }

  // ============================
  // LIKE
  // ============================

  if (interaction.customId === "music_like") {
    return interaction.reply({
      content: "❤️ Liked!",
      ephemeral: true,
    });
  }
});

// ===============================
// LOGIN
// ===============================

client.login(TOKEN);