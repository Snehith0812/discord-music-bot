import "dotenv/config";

import {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from "discord.js";

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  entersState
} from "@discordjs/voice";

import play from "@iamtraction/play-dl";

import fetch from "isomorphic-unfetch";
import spotifyUrlInfo from "spotify-url-info";

const {
  getPreview,
  getTracks
} = spotifyUrlInfo(fetch);


// =====================================================
// CONFIG
// =====================================================

const PREFIX = "!";

const { DISCORD_TOKEN } = process.env;

if (!DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN is missing from .env");
  process.exit(1);
}


// =====================================================
// DISCORD CLIENT
// =====================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ]
});


// =====================================================
// DATA
// =====================================================

const players = new Map();
const connections = new Map();
const queues = new Map();
const nowPlayingMessages = new Map();


// =====================================================
// QUEUE
// =====================================================

function getQueue(guildId) {

  if (!queues.has(guildId)) {
    queues.set(guildId, []);
  }

  return queues.get(guildId);
}


// =====================================================
// AUDIO PLAYER
// =====================================================

function getPlayer(guildId) {

  if (!players.has(guildId)) {

    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause
      }
    });


    // PLAYING
    player.on(
      AudioPlayerStatus.Playing,
      () => {

        console.log(
          `▶️ Playing in guild ${guildId}`
        );

      }
    );


    // FINISHED
    player.on(
      AudioPlayerStatus.Idle,
      () => {

        console.log(
          `⏹️ Track finished`
        );

        setTimeout(
          () => playNext(guildId),
          500
        );

      }
    );


    // ERROR
    player.on(
      "error",
      error => {

        console.error(
          "❌ Audio error:",
          error.message
        );

        setTimeout(
          () => playNext(guildId),
          500
        );

      }
    );


    players.set(
      guildId,
      player
    );
  }

  return players.get(guildId);
}


// =====================================================
// VOICE CONNECTION
// =====================================================

async function connectToVoice(channel) {

  const guildId =
    channel.guild.id;

  let connection =
    connections.get(guildId);


  if (!connection) {

    console.log(
      `🔊 Joining ${channel.name}`
    );


    connection =
      joinVoiceChannel({

        channelId:
          channel.id,

        guildId:

          guildId,

        adapterCreator:
          channel.guild
            .voiceAdapterCreator,

        selfDeaf: false

      });


    connections.set(
      guildId,
      connection
    );


    connection.on(
      VoiceConnectionStatus.Disconnected,
      async () => {

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
            )

          ]);

        }

        catch {

          console.log(
            "❌ Voice connection lost"
          );

          connection.destroy();

          connections.delete(
            guildId
          );

        }

      }
    );

  }


  await entersState(
    connection,
    VoiceConnectionStatus.Ready,
    30000
  );


  return connection;
}


// =====================================================
// DURATION
// =====================================================

function formatDuration(seconds) {

  if (
    seconds === undefined ||
    seconds === null ||
    Number.isNaN(
      Number(seconds)
    )
  ) {

    return "Unknown";

  }


  seconds =
    Math.floor(
      Number(seconds)
    );


  const minutes =
    Math.floor(
      seconds / 60
    );


  const secs =
    String(
      seconds % 60
    ).padStart(
      2,
      "0"
    );


  return (
    String(minutes).padStart(
      2,
      "0"
    )
    +
    "m "
    +
    secs
    +
    "s"
  );

}


// =====================================================
// LINK DETECTION
// =====================================================

function isYouTube(url) {

  return (
    /youtube\.com/i.test(url) ||
    /youtu\.be/i.test(url)
  );

}


function isSpotify(url) {

  return (
    /open\.spotify\.com/i.test(url) ||
    /spotify\.link/i.test(url)
  );

}


// =====================================================
// YOUTUBE SEARCH
// =====================================================

async function searchYouTube(query) {

  console.log(
    `🔎 YouTube search: ${query}`
  );


  const results =
    await play.search(
      query,
      {
        limit: 1,

        source: {
          youtube: "video"
        }
      }
    );


  if (
    !results ||
    results.length === 0
  ) {

    throw new Error(
      "No YouTube result found"
    );

  }


  const video =
    results[0];


  return {

    title:
      video.title,

    url:
      video.url,

    duration:
      video.durationInSec,

    thumbnail:
      video.thumbnails?.[0]?.url ||
      null

  };

}


// =====================================================
// YOUTUBE URL INFORMATION
// =====================================================

async function getYouTubeInfo(url) {

  console.log(
    "🔎 Reading YouTube video..."
  );


  const info =
    await play.video_info(
      url
    );


  const video =
    info.video_details;


  return {

    title:
      video.title,

    url:
      url,

    duration:
      video.durationInSec,

    thumbnail:
      video.thumbnails?.[0]?.url ||
      null

  };

}


// =====================================================
// SPOTIFY TRACK
// =====================================================

async function getSpotifyTrack(url) {

  console.log(
    "🟢 Spotify track detected"
  );


  const preview =
    await getPreview(
      url
    );


  if (
    !preview ||
    !preview.title
  ) {

    throw new Error(
      "Could not read Spotify track"
    );

  }


  return {

    title:
      preview.title,

    artist:
      preview.artist ||
      "Unknown Artist",

    image:
      preview.image ||
      null

  };

}


// =====================================================
// SPOTIFY PLAYLIST / ALBUM
// =====================================================

async function getSpotifyTracks(url) {

  console.log(
    "🟢 Spotify playlist/album detected"
  );


  const tracks =
    await getTracks(
      url
    );


  if (
    !tracks ||
    tracks.length === 0
  ) {

    throw new Error(
      "No Spotify tracks found"
    );

  }


  return tracks

    .filter(
      track =>
        track &&
        track.name
    )

    .map(
      track => ({

        title:
          track.name,

        artist:
          track.artists
            ?.map(
              artist =>
                artist.name
            )
            .join(", ")
          ||
          "Unknown Artist"

      })
    );

}


// =====================================================
// BUTTONS
// =====================================================

function createMusicButtons() {


  const mainRow =
    new ActionRowBuilder()
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
            "music_skip"
          )
          .setLabel(
            "Skip"
          )
          .setStyle(
            ButtonStyle.Secondary
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


  const likeRow =
    new ActionRowBuilder()
      .addComponents(

        new ButtonBuilder()
          .setCustomId(
            "music_like"
          )
          .setLabel(
            "Like"
          )
          .setStyle(
            ButtonStyle.Success
          )

      );


  return [
    mainRow,
    likeRow
  ];

}


// =====================================================
// ENQUEUED EMBED
// =====================================================

function createEnqueuedEmbed(
  song,
  requester
) {


  const embed =
    new EmbedBuilder()

      .setColor(
        0x5865F2
      )

      .setTitle(
        "🔴  Enqueued Track"
      )

      .setDescription(
        `✅ Added **${song.title}** to the queue.`
      )

      .addFields(

        {
          name:
            "Duration",

          value:
            formatDuration(
              song.duration
            ),

          inline: true
        },

        {
          name:
            "Requester",

          value:
            requester,

          inline: true
        },

        {
          name:
            "Position",

          value:
            String(
              song.position
            ),

          inline: true
        }

      );


  if (song.thumbnail) {

    embed.setThumbnail(
      song.thumbnail
    );

  }


  return embed;

}


// =====================================================
// NOW PLAYING EMBED
// =====================================================

function createNowPlayingEmbed(song) {


  const embed =
    new EmbedBuilder()

      .setColor(
        0x5865F2
      )

      .setTitle(
        "🔴  Now Playing"
      )

      .setDescription(

        `• **${song.title}**\n\n` +

        `• Duration: \`${formatDuration(
          song.duration
        )}\`\n` +

        `  ${song.requester}`

      );


  if (song.thumbnail) {

    embed.setThumbnail(
      song.thumbnail
    );

  }


  return embed;

}


// =====================================================
// PLAY NEXT
// =====================================================

async function playNext(guildId) {

  const queue =
    getQueue(
      guildId
    );


  if (
    queue.length === 0
  ) {

    console.log(
      "📭 Queue empty"
    );

    return;

  }


  const song =
    queue.shift();


  try {

    const connection =
      connections.get(
        guildId
      );


    if (!connection) {

      console.log(
        "❌ No voice connection"
      );

      return;

    }


    const player =
      getPlayer(
        guildId
      );


    connection.subscribe(
      player
    );


    console.log(
      `🔎 Getting audio for ${song.title}`
    );


    const stream =
      await play.stream(
        song.url,
        {
          quality: 2
        }
      );


    console.log(
      "✅ Audio stream received"
    );


    const resource =
      createAudioResource(
        stream.stream,
        {
          inputType:
            stream.type
        }
      );


    player.play(
      resource
    );


    console.log(
      `🎵 Now Playing: ${song.title}`
    );


    const nowPlayingEmbed =
      createNowPlayingEmbed(
        song
      );


    const message =
      await song.textChannel.send({

        embeds: [
          nowPlayingEmbed
        ],

        components:
          createMusicButtons()

      });


    nowPlayingMessages.set(
      guildId,
      message
    );

  }


  catch (error) {

    console.error(
      "❌ Playback error:",
      error.message
    );


    try {

      await song.textChannel.send(
        `❌ Couldn't play **${song.title}**.`
      );

    }

    catch {}


    setTimeout(
      () =>
        playNext(guildId),
      500
    );

  }

}


// =====================================================
// BOT READY
// =====================================================

client.once(
  Events.ClientReady,
  bot => {

    console.log(
      `✅ Logged in as ${bot.user.tag}`
    );

    console.log(
      "🎵 Music UI bot is ready!"
    );

  }
);


// =====================================================
// TEXT COMMANDS
// =====================================================

client.on(
  Events.MessageCreate,
  async message => {


    if (
      message.author.bot
    ) return;


    if (
      !message.guild
    ) return;


    if (
      !message.content.startsWith(
        PREFIX
      )
    ) return;


    const args =
      message.content

        .slice(
          PREFIX.length
        )

        .trim()

        .split(
          /\s+/
        );


    const command =
      args.shift()
        ?.toLowerCase();


    if (!command) return;


    const guildId =
      message.guild.id;


    // =================================================
    // HELP
    // =================================================

    if (
      command === "help"
    ) {

      return message.reply(

        `🎵 **Music Bot**\n\n` +

        `\`!play <song/link>\` → Play music\n` +

        `\`!pause\` → Pause\n` +

        `\`!resume\` → Resume\n` +

        `\`!skip\` → Skip\n` +

        `\`!shuffle\` → Shuffle\n` +

        `\`!queue\` → Queue\n` +

        `\`!stop\` → Stop\n` +

        `\`!join\` → Join VC\n` +

        `\`!leave\` → Leave VC\n` +

        `\`!ping\` → Ping`

      );

    }


    // =================================================
    // PING
    // =================================================

    if (
      command === "ping"
    ) {

      return message.reply(
        "🏓 Pong!"
      );

    }


    // =================================================
    // VOICE CHANNEL
    // =================================================

    const voiceChannel =
      message.member
        ?.voice
        ?.channel;


    // =================================================
    // JOIN
    // =================================================

    if (
      command === "join"
    ) {

      if (!voiceChannel) {

        return message.reply(
          "❌ Join a voice channel first."
        );

      }


      try {

        await connectToVoice(
          voiceChannel
        );


        return message.reply(
          `🔊 Joined **${voiceChannel.name}**`
        );

      }

      catch (error) {

        console.error(
          error
        );

        return message.reply(
          "❌ Couldn't join the voice channel."
        );

      }

    }


    // =================================================
    // PLAY
    // =================================================

    if (
      command === "play" ||
      command === "p"
    ) {


      if (!voiceChannel) {

        return message.reply(
          "❌ Join a voice channel first."
        );

      }


      const input =
        args.join(" ");


      if (!input) {

        return message.reply(
          "❌ Give me a song name or YouTube/Spotify link."
        );

      }


      try {

        await connectToVoice(
          voiceChannel
        );


        const queue =
          getQueue(
            guildId
          );


        const player =
          getPlayer(
            guildId
          );


        const wasIdle =
          player.state.status ===
          AudioPlayerStatus.Idle;


        let songs = [];


        // =============================================
        // YOUTUBE
        // =============================================

        if (
          isYouTube(input)
        ) {


          const song =
            await getYouTubeInfo(
              input
            );


          songs.push({

            ...song,

            requester:
              `<@${message.author.id}>`,

            textChannel:
              message.channel,

            guildId

          });

        }


        // =============================================
        // SPOTIFY
        // =============================================

        else if (
          isSpotify(input)
        ) {


          const match =
            input.match(
              /spotify\.com\/(track|album|playlist)/i
            );


          const type =
            match?.[1]
              ?.toLowerCase();


          // =========================================
          // SPOTIFY TRACK
          // =========================================

          if (
            type === "track"
          ) {


            const spotifySong =
              await getSpotifyTrack(
                input
              );


            const youtubeSong =
              await searchYouTube(

                `${spotifySong.title} ${spotifySong.artist}`

              );


            songs.push({

              ...youtubeSong,

              title:
                `${spotifySong.title} — ${spotifySong.artist}`,

              thumbnail:
                spotifySong.image ||
                youtubeSong.thumbnail,

              requester:
                `<@${message.author.id}>`,

              textChannel:
                message.channel,

              guildId

            });

          }


          // =========================================
          // SPOTIFY PLAYLIST / ALBUM
          // =========================================

          else if (
            type === "playlist" ||
            type === "album"
          ) {


            const spotifyTracks =
              await getSpotifyTracks(
                input
              );


            const maxTracks =
              Math.min(
                spotifyTracks.length,
                25
              );


            await message.channel.send(

              `📋 Found **${spotifyTracks.length}** tracks.\n` +

              `➕ Adding the first **${maxTracks}** tracks...`

            );


            for (
              const track
              of spotifyTracks.slice(
                0,
                maxTracks
              )
            ) {


              try {

                const youtubeSong =
                  await searchYouTube(

                    `${track.title} ${track.artist}`

                  );


                songs.push({

                  ...youtubeSong,

                  title:
                    `${track.title} — ${track.artist}`,

                  requester:
                    `<@${message.author.id}>`,

                  textChannel:
                    message.channel,

                  guildId

                });

              }

              catch (error) {

                console.log(

                  `⚠️ Couldn't find ${track.title}`,

                  error.message

                );

              }

            }

          }


          else {

            return message.reply(

              "❌ Spotify track, album and playlist links are supported."

            );

          }

        }


        // =============================================
        // NORMAL SONG NAME
        // =============================================

        else {


          const youtubeSong =
            await searchYouTube(
              input
            );


          songs.push({

            ...youtubeSong,

            requester:
              `<@${message.author.id}>`,

            textChannel:
              message.channel,

            guildId

          });

        }


        // =============================================
        // ADD TO QUEUE
        // =============================================

        if (
          songs.length === 0
        ) {

          return message.reply(
            "❌ Nothing was found."
          );

        }


        for (
          const song
          of songs
        ) {


          song.position =
            queue.length + 1;


          queue.push(
            song
          );


          await message.channel.send({

            embeds: [

              createEnqueuedEmbed(

                song,

                `<@${message.author.id}>`

              )

            ]

          });

        }


        // =============================================
        // START PLAYING
        // =============================================

        if (
          wasIdle
        ) {

          await playNext(
            guildId
          );

        }


      }

      catch (error) {

        console.error(
          "❌ PLAY ERROR:",
          error
        );


        return message.channel.send(

          `❌ I couldn't play that.\n` +

          `CMD error: \`${error.message}\``

        );

      }


      return;

    }


    // =================================================
    // PAUSE
    // =================================================

    if (
      command === "pause"
    ) {


      const player =
        players.get(
          guildId
        );


      if (!player) {

        return message.reply(
          "❌ Nothing is playing."
        );

      }


      player.pause();


      return message.reply(
        "⏸️ Music paused."
      );

    }


    // =================================================
    // RESUME
    // =================================================

    if (
      command === "resume"
    ) {


      const player =
        players.get(
          guildId
        );


      if (!player) {

        return message.reply(
          "❌ Nothing is playing."
        );

      }


      player.unpause();


      return message.reply(
        "▶️ Music resumed."
      );

    }


    // =================================================
    // SKIP
    // =================================================

    if (
      command === "skip"
    ) {


      const player =
        players.get(
          guildId
        );


      if (!player) {

        return message.reply(
          "❌ Nothing is playing."
        );

      }


      player.stop();


      return message.reply(
        "⏭️ Skipped."
      );

    }


    // =================================================
    // SHUFFLE
    // =================================================

    if (
      command === "shuffle"
    ) {


      const queue =
        getQueue(
          guildId
        );


      if (
        queue.length === 0
      ) {

        return message.reply(
          "📭 Queue is empty."
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
          queue[j]
        ] = [
          queue[j],
          queue[i]
        ];

      }


      return message.reply(
        "🔀 Queue shuffled!"
      );

    }


    // =================================================
    // QUEUE
    // =================================================

    if (
      command === "queue"
    ) {


      const queue =
        getQueue(
          guildId
        );


      if (
        queue.length === 0
      ) {

        return message.reply(
          "📭 Queue is empty."
        );

      }


      const list =
        queue

          .slice(
            0,
            15
          )

          .map(

            (song, index) =>
              `${index + 1}. ${song.title}`

          )

          .join("\n");


      return message.reply(

        `🎵 **Music Queue**\n\n${list}`

      );

    }


    // =================================================
    // STOP
    // =================================================

    if (
      command === "stop"
    ) {


      const queue =
        getQueue(
          guildId
        );


      queue.length = 0;


      const player =
        players.get(
          guildId
        );


      if (player) {

        player.stop();

      }


      return message.reply(
        "⏹️ Music stopped and queue cleared."
      );

    }


    // =================================================
    // LEAVE
    // =================================================

    if (
      command === "leave"
    ) {


      const connection =
        connections.get(
          guildId
        );


      const player =
        players.get(
          guildId
        );


      if (player) {

        player.stop();

      }


      if (connection) {

        connection.destroy();

        connections.delete(
          guildId
        );

      }


      queues.delete(
        guildId
      );


      players.delete(
        guildId
      );


      nowPlayingMessages.delete(
        guildId
      );


      return message.reply(
        "👋 Left the voice channel."
      );

    }

  }

);


// =====================================================
// BUTTON INTERACTIONS
// =====================================================

client.on(
  Events.InteractionCreate,
  async interaction => {


    if (
      !interaction.isButton()
    ) return;


    const guildId =
      interaction.guildId;


    if (!guildId) return;


    const player =
      players.get(
        guildId
      );


    const queue =
      getQueue(
        guildId
      );


    try {


      // ===============================================
      // PAUSE
      // ===============================================

      if (
        interaction.customId ===
        "music_pause"
      ) {


        if (!player) {

          return interaction.reply({

            content:
              "❌ Nothing is playing.",

            ephemeral: true

          });

        }


        if (
          player.state.status ===
          AudioPlayerStatus.Paused
        ) {


          player.unpause();


          return interaction.reply({

            content:
              "▶️ Music resumed.",

            ephemeral: true

          });

        }


        player.pause();


        return interaction.reply({

          content:
            "⏸️ Music paused.",

          ephemeral: true

        });

      }


      // ===============================================
      // SKIP
      // ===============================================

      if (
        interaction.customId ===
        "music_skip"
      ) {


        if (!player) {

          return interaction.reply({

            content:
              "❌ Nothing is playing.",

            ephemeral: true

          });

        }


        player.stop();


        return interaction.reply({

          content:
            "⏭️ Skipped.",

          ephemeral: true

        });

      }


      // ===============================================
      // SHUFFLE
      // ===============================================

      if (
        interaction.customId ===
        "music_shuffle"
      ) {


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
            queue[j]
          ] = [
            queue[j],
            queue[i]
          ];

        }


        return interaction.reply({

          content:
            queue.length
              ? "🔀 Queue shuffled!"
              : "📭 Queue is empty.",

          ephemeral: true

        });

      }


      // ===============================================
      // STOP
      // ===============================================

      if (
        interaction.customId ===
        "music_stop"
      ) {


        queue.length = 0;


        if (player) {

          player.stop();

        }


        return interaction.reply({

          content:
            "⏹️ Music stopped and queue cleared.",

          ephemeral: true

        });

      }


      // ===============================================
      // LIKE
      // ===============================================

      if (
        interaction.customId ===
        "music_like"
      ) {


        return interaction.reply({

          content:
            "👍 Liked!",

          ephemeral: true

        });

      }

    }

    catch (error) {

      console.error(
        "❌ Button error:",
        error
      );


      if (
        !interaction.replied &&
        !interaction.deferred
      ) {

        await interaction.reply({

          content:
            "❌ Something went wrong.",

          ephemeral: true

        });

      }

    }

  }

);


// =====================================================
// LOGIN
// =====================================================

client.login(
  DISCORD_TOKEN
);