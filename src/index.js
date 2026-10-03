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

const { getPreview, getTracks } = spotify(fetch);

const PREFIX = "!";
const TOKEN = process.env.DISCORD_TOKEN;

const MAX_SPOTIFY_TRACKS = 25;

// ========================================
// CHECK TOKEN
// ========================================

if (!TOKEN) {
  console.error("❌ DISCORD_TOKEN is missing.");
  process.exit(1);
}

// ========================================
// STORAGE
// ========================================

const players = new Map();
const connections = new Map();
const queues = new Map();
const nextTrackLocks = new Map();
const currentSongs = new Map();

// ========================================
// QUEUE
// ========================================

function getQueue(guildId) {
  if (!queues.has(guildId)) {
    queues.set(guildId, []);
  }

  return queues.get(guildId);
}

function updateQueuePositions(guildId) {
  const queue = getQueue(guildId);

  queue.forEach((song, index) => {
    song.position = index + 1;
  });
}

// ========================================
// AUDIO PLAYER
// ========================================

function getPlayer(guildId) {
  if (players.has(guildId)) {
    return players.get(guildId);
  }

  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Pause,

      // Allows a small amount of missed audio frames
      // before playback is considered stalled.
      maxMissedFrames: 20,
    },
  });

  player.on(AudioPlayerStatus.Buffering, () => {
    console.log(`[${guildId}] 🔄 Buffering...`);
  });

  player.on(AudioPlayerStatus.Playing, () => {
    console.log(`[${guildId}] ▶️ Playing`);
  });

  player.on(AudioPlayerStatus.Paused, () => {
    console.log(`[${guildId}] ⏸️ Paused`);
  });

  player.on(AudioPlayerStatus.Idle, () => {
    console.log(`[${guildId}] ⏹️ Audio ended`);

    scheduleNextTrack(guildId, 700);
  });

  player.on("error", (error) => {
    console.error(
      `[${guildId}] ❌ Audio error:`,
      error?.message || error
    );

    scheduleNextTrack(guildId, 1000);
  });

  players.set(guildId, player);

  return player;
}

// ========================================
// VC CHECK
// ========================================

function isUserInVoice(message) {
  return Boolean(message.member?.voice?.channel);
}

async function requireVoice(message) {
  if (!isUserInVoice(message)) {
    await message.reply(
      "🔒 You must be connected to a voice channel to use music commands."
    );

    return false;
  }

  return true;
}

// ========================================
// CONNECT TO VOICE
// ========================================

async function connectToVoice(message) {
  const voiceChannel = message.member?.voice?.channel;

  if (!voiceChannel) {
    await message.reply(
      "❌ You must be connected to a voice channel first."
    );

    return null;
  }

  let connection = connections.get(message.guild.id);

  // Already connected
  if (
    connection &&
    connection.joinConfig.channelId === voiceChannel.id
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
      connections.delete(message.guild.id);
    }
  }

  // Connected to another channel
  if (
    connection &&
    connection.joinConfig.channelId !== voiceChannel.id
  ) {
    connection.destroy();
    connections.delete(message.guild.id);
  }

  connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: message.guild.id,
    adapterCreator: message.guild.voiceAdapterCreator,

    selfDeaf: false,
    selfMute: false,

    // Keep Discord voice connection debug disabled
    // unless troubleshooting.
    debug: false,
  });

  connections.set(message.guild.id, connection);

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
          `[${message.guild.id}] 🔄 Reconnecting...`
        );
      } catch {
        console.log(
          `[${message.guild.id}] ❌ Voice connection lost`
        );

        connection.destroy();
        connections.delete(message.guild.id);
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
      `[${message.guild.id}] 🔊 Voice connection ready`
    );

    return connection;
  } catch (error) {
    console.error(
      `[${message.guild.id}] Voice connection failed:`,
      error.message
    );

    connection.destroy();
    connections.delete(message.guild.id);

    await message.reply(
      "❌ I couldn't connect to the voice channel. Make sure I have **Connect** and **Speak** permissions."
    );

    return null;
  }
}

// ========================================
// DURATION
// ========================================

function formatDuration(seconds) {
  if (!seconds || Number.isNaN(Number(seconds))) {
    return "Unknown";
  }

  const total = Math.floor(Number(seconds));

  const minutes = Math.floor(total / 60);
  const secondsLeft = total % 60;

  return `${String(minutes).padStart(2, "0")}m ${String(
    secondsLeft
  ).padStart(2, "0")}s`;
}

// ========================================
// YOUTUBE DETECTION
// ========================================

function isYouTubeUrl(url) {
  return (
    url.includes("youtube.com/") ||
    url.includes("youtu.be/")
  );
}

// ========================================
// SPOTIFY DETECTION
// ========================================

function isSpotifyUrl(url) {
  return /^https?:\/\/open\.spotify\.com\//i.test(url);
}

// ========================================
// YOUTUBE SEARCH
// ========================================

async function searchYouTube(query) {
  console.log(`🔎 Searching YouTube: ${query}`);

  const results = await play.search(query, {
    limit: 5,

    source: {
      youtube: "video",
    },
  });

  const videos = results.filter(
    (item) =>
      item.type === "video" &&
      item.url &&
      item.durationInSec
  );

  if (!videos.length) {
    throw new Error("No playable YouTube result found.");
  }

  const video = videos[0];

  return {
    url: video.url,

    title: video.title || query,

    duration:
      video.durationRaw ||
      formatDuration(video.durationInSec),

    seconds: Number(video.durationInSec) || 0,

    thumbnail:
      video.thumbnails?.[0]?.url ||
      null,
  };
}

// ========================================
// YOUTUBE URL INFORMATION
// ========================================

async function getYouTubeInfo(url) {
  console.log(`🎬 Reading YouTube URL: ${url}`);

  const info = await play.video_basic_info(url);

  const video = info.video_details;

  if (!video) {
    throw new Error("Unable to read YouTube video.");
  }

  return {
    url,

    title:
      video.title ||
      "Unknown Track",

    duration:
      video.durationRaw ||
      formatDuration(video.durationInSec),

    seconds:
      Number(video.durationInSec) || 0,

    thumbnail:
      video.thumbnails?.[0]?.url ||
      null,
  };
}

// ========================================
// SPOTIFY TRACK
// ========================================

async function getSpotifyTrack(url) {
  console.log(`🎧 Reading Spotify track: ${url}`);

  const preview = await getPreview(url);

  if (!preview) {
    throw new Error(
      "Unable to read Spotify track information."
    );
  }

  const artist =
    preview.artist ||
    preview.artists?.[0]?.name ||
    "Unknown Artist";

  return {
    title: preview.title,

    artist,

    thumbnail:
      preview.image ||
      preview.thumbnail ||
      null,
  };
}

// ========================================
// SPOTIFY PLAYLIST / ALBUM
// ========================================

async function getSpotifyTracks(url) {
  console.log(`🎧 Reading Spotify collection: ${url}`);

  const data = await getTracks(url);

  if (!data) {
    return [];
  }

  const tracks = Array.isArray(data)
    ? data
    : data.tracks || [];

  return tracks
    .slice(0, MAX_SPOTIFY_TRACKS)
    .map((track) => ({
      title:
        track.name ||
        "Unknown Track",

      artist:
        track.artist ||
        track.artists
          ?.map((artist) => artist.name)
          .join(", ") ||
        "Unknown Artist",

      thumbnail:
        track.image ||
        track.album?.images?.[0]?.url ||
        null,
    }));
}

// ========================================
// FIND PLAYABLE SOURCE FOR SPOTIFY TRACK
// ========================================

async function findSpotifyPlayableSource(
  title,
  artist
) {
  const searches = [
    `"${title}" "${artist}" official audio`,
    `"${title}" "${artist}"`,
    `${title} ${artist}`,
  ];

  for (const search of searches) {
    try {
      const result = await searchYouTube(search);

      if (result?.url) {
        return result;
      }
    } catch (error) {
      console.log(
        `⚠️ Search failed: ${search}`
      );
    }
  }

  throw new Error(
    `Couldn't find playable audio for ${title}`
  );
}

// ========================================
// EMBED: ENQUEUED
// ========================================

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

// ========================================
// EMBED: NOW PLAYING
// ========================================

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

// ========================================
// MUSIC BUTTONS
// ========================================

function createMusicButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("music_pause")
      .setLabel("Pause")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("music_resume")
      .setLabel("Resume")
      .setStyle(ButtonStyle.Success),

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
      .setStyle(ButtonStyle.Danger)
  );
}

// ========================================
// SCHEDULE NEXT
// ========================================

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
        `[${guildId}] ❌ playNext error:`,
        error.message
      );
    } finally {
      nextTrackLocks.delete(guildId);
    }
  }, delay);
}

// ========================================
// PLAY NEXT TRACK
// ========================================

async function playNext(guildId) {
  const queue = getQueue(guildId);

  if (!queue.length) {
    currentSongs.delete(guildId);

    console.log(
      `[${guildId}] 📭 Queue empty`
    );

    return;
  }

  const connection = connections.get(guildId);

  if (!connection) {
    console.log(
      `[${guildId}] ❌ No voice connection`
    );

    return;
  }

  const song = queue.shift();

  updateQueuePositions(guildId);

  currentSongs.set(guildId, song);

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
      `[${guildId}] 🔗 URL: ${song.url}`
    );

    // ====================================
    // GET AUDIO STREAM
    // ====================================

    const stream = await play.stream(song.url, {
      // Use the library's normal best available
      // audio stream selection.
      quality: 0,
    });

    if (!stream || !stream.stream) {
      throw new Error(
        "No audio stream was returned."
      );
    }

    console.log(
      `[${guildId}] ✅ Stream received`
    );

    console.log(
      `[${guildId}] Stream type: ${stream.type}`
    );

    // ====================================
    // CREATE DISCORD AUDIO RESOURCE
    // ====================================

    const resource = createAudioResource(
      stream.stream,
      {
        inputType: stream.type,

        // Keep disabled because it adds processing cost.
        inlineVolume: false,

        // Small padding prevents end-of-track clicks.
        silencePaddingFrames: 5,

        metadata: {
          title: song.title,
          url: song.url,
        },
      }
    );

    // ====================================
    // START PLAYBACK
    // ====================================

    player.play(resource);

    console.log(
      `[${guildId}] 🔊 Player started`
    );

    // ====================================
    // NOW PLAYING MESSAGE
    // ====================================

    const channel = await client.channels
      .fetch(song.textChannelId)
      .catch(() => null);

    if (channel?.isTextBased()) {
      await channel.send({
        embeds: [
          createNowPlayingEmbed(song),
        ],

        components: [
          createMusicButtons(),
        ],
      });
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

    currentSongs.delete(guildId);

    // Continue with next song.
    if (queue.length > 0) {
      scheduleNextTrack(guildId, 1000);
    }
  }
}

// ========================================
// DISCORD CLIENT
// ========================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// ========================================
// READY
// ========================================

client.once(
  Events.ClientReady,
  (bot) => {
    console.log(
      `✅ Logged in as ${bot.user.tag}`
    );

    console.log(
      "🎵 Music bot is ready."
    );
  }
);

// ========================================
// COMMANDS
// ========================================

client.on(
  Events.MessageCreate,
  async (message) => {
    if (message.author.bot) return;

    if (!message.guild) return;

    if (!message.content.startsWith(PREFIX)) {
      return;
    }

    const args = message.content
      .slice(PREFIX.length)
      .trim()
      .split(/\s+/);

    const command = args
      .shift()
      ?.toLowerCase();

    // ====================================
    // HELP
    // ====================================

    if (command === "help") {
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("🎵 Music Bot Commands")
        .setDescription(
          [
            "`!join` — Join VC",
            "`!leave` — Leave VC",
            "`!play <song/link>` — Play music",
            "`!pause` — Pause",
            "`!resume` — Resume",
            "`!skip` — Skip",
            "`!shuffle` — Shuffle queue",
            "`!queue` — Show queue",
            "`!stop` — Stop music",
          ].join("\n")
        )
        .setFooter({
          text:
            "Music commands require you to be connected to a voice channel.",
        });

      return message.reply({
        embeds: [embed],
      });
    }

    // ====================================
    // PING
    // ====================================

    if (command === "ping") {
      return message.reply("🏓 Pong!");
    }

    // ====================================
    // MUSIC COMMAND CHECK
    // ====================================

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
      musicCommands.includes(command)
    ) {
      const allowed =
        await requireVoice(message);

      if (!allowed) return;
    }

    // ====================================
    // JOIN
    // ====================================

    if (command === "join") {
      const connection =
        await connectToVoice(message);

      if (connection) {
        await message.reply(
          `🔊 Joined **${message.member.voice.channel.name}**.`
        );
      }

      return;
    }

    // ====================================
    // LEAVE
    // ====================================

    if (command === "leave") {
      const connection =
        connections.get(message.guild.id);

      if (connection) {
        connection.destroy();

        connections.delete(
          message.guild.id
        );
      }

      const queue =
        getQueue(message.guild.id);

      queue.length = 0;

      currentSongs.delete(
        message.guild.id
      );

      getPlayer(
        message.guild.id
      ).stop(true);

      await message.reply(
        "👋 Left the voice channel."
      );

      return;
    }

    // ====================================
    // PLAY
    // ====================================

    if (command === "play") {
      if (!args.length) {
        return message.reply(
          "❌ Usage: `!play <song name / YouTube URL / Spotify URL>`"
        );
      }

      const query = args.join(" ");

      const connection =
        await connectToVoice(message);

      if (!connection) return;

      const queue =
        getQueue(message.guild.id);

      try {
        // =================================
        // SPOTIFY
        // =================================

        if (isSpotifyUrl(query)) {
          console.log(
            "🎧 Spotify URL detected"
          );

          // Spotify TRACK
          if (query.includes("/track/")) {
            const spotifyTrack =
              await getSpotifyTrack(query);

            const youtube =
              await findSpotifyPlayableSource(
                spotifyTrack.title,
                spotifyTrack.artist
              );

            const song = {
              ...youtube,

              title:
                `${spotifyTrack.title} — ${spotifyTrack.artist}`,

              thumbnail:
                spotifyTrack.thumbnail ||
                youtube.thumbnail,

              requester:
                message.author,

              textChannelId:
                message.channel.id,
            };

            queue.push(song);

            updateQueuePositions(
              message.guild.id
            );

            await message.channel.send({
              embeds: [
                createEnqueuedEmbed(
                  song
                ),
              ],
            });
          }

          // Spotify PLAYLIST / ALBUM
          else if (
            query.includes("/playlist/") ||
            query.includes("/album/")
          ) {
            const tracks =
              await getSpotifyTracks(
                query
              );

            if (!tracks.length) {
              return message.reply(
                "❌ No Spotify tracks were found."
              );
            }

            await message.reply(
              `🎧 Found **${tracks.length}** Spotify tracks. Searching playable audio...`
            );

            let added = 0;

            for (const track of tracks) {
              try {
                const youtube =
                  await findSpotifyPlayableSource(
                    track.title,
                    track.artist
                  );

                queue.push({
                  ...youtube,

                  title:
                    `${track.title} — ${track.artist}`,

                  thumbnail:
                    track.thumbnail ||
                    youtube.thumbnail,

                  requester:
                    message.author,

                  textChannelId:
                    message.channel.id,
                });

                added++;
              } catch (error) {
                console.log(
                  `⚠️ Skipped: ${track.title}`
                );
              }
            }

            updateQueuePositions(
              message.guild.id
            );

            await message.channel.send(
              `✅ Added **${added}** tracks to the queue.`
            );
          } else {
            return message.reply(
              "❌ Unsupported Spotify URL."
            );
          }
        }

        // =================================
        // YOUTUBE URL
        // =================================

        else if (isYouTubeUrl(query)) {
          const song =
            await getYouTubeInfo(query);

          song.requester =
            message.author;

          song.textChannelId =
            message.channel.id;

          queue.push(song);

          updateQueuePositions(
            message.guild.id
          );

          await message.channel.send({
            embeds: [
              createEnqueuedEmbed(
                song
              ),
            ],
          });
        }

        // =================================
        // SEARCH
        // =================================

        else {
          const song =
            await searchYouTube(query);

          song.requester =
            message.author;

          song.textChannelId =
            message.channel.id;

          queue.push(song);

          updateQueuePositions(
            message.guild.id
          );

          await message.channel.send({
            embeds: [
              createEnqueuedEmbed(
                song
              ),
            ],
          });
        }

        // =================================
        // START IF IDLE
        // =================================

        const player =
          getPlayer(message.guild.id);

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
          "❌ Play command error:",
          error
        );

        await message.reply(
          `❌ Couldn't play that.\n\`${error.message}\``
        );
      }

      return;
    }

    // ====================================
    // PAUSE
    // ====================================

    if (command === "pause") {
      const player =
        getPlayer(message.guild.id);

      if (player.pause(true)) {
        return message.reply(
          "⏸️ Paused."
        );
      }

      return message.reply(
        "❌ Nothing is currently playing."
      );
    }

    // ====================================
    // RESUME
    // ====================================

    if (command === "resume") {
      const player =
        getPlayer(message.guild.id);

      if (player.unpause()) {
        return message.reply(
          "▶️ Resumed."
        );
      }

      return message.reply(
        "❌ Nothing is paused."
      );
    }

    // ====================================
    // SKIP
    // ====================================

    if (command === "skip") {
      const player =
        getPlayer(message.guild.id);

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

    // ====================================
    // SHUFFLE
    // ====================================

    if (command === "shuffle") {
      const queue =
        getQueue(message.guild.id);

      if (queue.length < 2) {
        return message.reply(
          "❌ Need at least 2 songs in the queue."
        );
      }

      for (
        let i = queue.length - 1;
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

    // ====================================
    // QUEUE
    // ====================================

    if (command === "queue") {
      const queue =
        getQueue(message.guild.id);

      if (!queue.length) {
        return message.reply(
          "📭 Queue is empty."
        );
      }

      const text = queue
        .slice(0, 15)
        .map(
          (song, index) =>
            `**${index + 1}.** ${song.title}`
        )
        .join("\n");

      const embed =
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("🎵 Music Queue")
          .setDescription(text);

      return message.reply({
        embeds: [embed],
      });
    }

    // ====================================
    // STOP
    // ====================================

    if (command === "stop") {
      const queue =
        getQueue(message.guild.id);

      queue.length = 0;

      currentSongs.delete(
        message.guild.id
      );

      const player =
        getPlayer(message.guild.id);

      player.stop(true);

      return message.reply(
        "⏹️ Music stopped and queue cleared."
      );
    }
  }
);

// ========================================
// BUTTONS
// ========================================

client.on(
  Events.InteractionCreate,
  async (interaction) => {
    if (!interaction.isButton()) {
      return;
    }

    const guildId =
      interaction.guild?.id;

    if (!guildId) return;

    // ====================================
    // VC PROTECTION
    // ====================================

    const member =
      interaction.member;

    if (!member?.voice?.channel) {
      return interaction.reply({
        content:
          "🔒 You must be connected to a voice channel to use music controls.",
        ephemeral: true,
      });
    }

    const player =
      getPlayer(guildId);

    const queue =
      getQueue(guildId);

    // ====================================
    // PAUSE
    // ====================================

    if (
      interaction.customId ===
      "music_pause"
    ) {
      if (player.pause(true)) {
        return interaction.reply({
          content:
            "⏸️ Paused.",
          ephemeral: true,
        });
      }

      return interaction.reply({
        content:
          "❌ Nothing is playing.",
        ephemeral: true,
      });
    }

    // ====================================
    // RESUME
    // ====================================

    if (
      interaction.customId ===
      "music_resume"
    ) {
      if (player.unpause()) {
        return interaction.reply({
          content:
            "▶️ Resumed.",
          ephemeral: true,
        });
      }

      return interaction.reply({
        content:
          "❌ Nothing is paused.",
        ephemeral: true,
      });
    }

    // ====================================
    // SKIP
    // ====================================

    if (
      interaction.customId ===
      "music_skip"
    ) {
      if (
        player.state.status !==
        AudioPlayerStatus.Idle
      ) {
        player.stop(true);

        return interaction.reply({
          content:
            "⏭️ Skipped.",
          ephemeral: true,
        });
      }

      return interaction.reply({
        content:
          "❌ Nothing is playing.",
        ephemeral: true,
      });
    }

    // ====================================
    // SHUFFLE
    // ====================================

    if (
      interaction.customId ===
      "music_shuffle"
    ) {
      if (queue.length < 2) {
        return interaction.reply({
          content:
            "❌ Need at least 2 queued songs.",
          ephemeral: true,
        });
      }

      for (
        let i = queue.length - 1;
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

      return interaction.reply({
        content:
          "🔀 Queue shuffled.",
        ephemeral: true,
      });
    }

    // ====================================
    // STOP
    // ====================================

    if (
      interaction.customId ===
      "music_stop"
    ) {
      queue.length = 0;

      currentSongs.delete(
        guildId
      );

      player.stop(true);

      return interaction.reply({
        content:
          "⏹️ Music stopped and queue cleared.",
        ephemeral: true,
      });
    }
  }
);

// ========================================
// LOGIN
// ========================================

client.login(TOKEN);