/**
 * spotify.js — Spotify Web API integration for Matrix Digital Rain.
 *
 * "Free your mind" — follow the BPM down the rabbit hole.
 *
 * Uses the Authorization Code + PKCE flow so no backend is required.
 * To use:
 *   1. Click "Connect Spotify" and authorise with your Spotify account.
 *   2. The app is pre-configured with a Spotify Client ID, so no manual
 *      setup is needed for most users.
 *   3. To use your own Client ID, create a free app at
 *      https://developer.spotify.com/dashboard, add this page's URL as a
 *      Redirect URI, and update SPOTIFY_DEFAULT_CLIENT_ID below.
 *
 * Exported state (read by sketch.js):
 *   spotifyState.bpm        — current track BPM (null = not connected / no track)
 *   spotifyState.trackName  — current track title
 *   spotifyState.artistName — primary artist name
 *   spotifyState.energy     — Spotify audio energy 0.0–1.0
 *   spotifyState.connected  — true once a valid token is held
 */

const SPOTIFY_CLIENT_ID_KEY = "matrix_spotify_client_id";
const SPOTIFY_TOKEN_KEY = "matrix_spotify_token";
const SPOTIFY_TOKEN_EXPIRY_KEY = "matrix_spotify_token_expiry";
const SPOTIFY_CODE_VERIFIER_KEY = "matrix_spotify_cv";
const SPOTIFY_REFRESH_TOKEN_KEY = "matrix_spotify_refresh_token";

// Pre-configured Client ID for the Matrix Digital Rain Spotify app.
// This is a PKCE public client — the Client ID is not a secret and is safe
// to include in client-side code. Note: this Client ID is registered with
// specific redirect URIs in the Spotify Developer Dashboard (e.g.
// https://ap0ught.github.io/Matrix-p5/). It will only work when the page
// is served from one of those registered domains. Replace with your own
// Client ID if you deploy this under a different domain.
const SPOTIFY_DEFAULT_CLIENT_ID = "5897079698bd4b0695e2d5364cdfbde2";

const SPOTIFY_AUTH_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API_BASE = "https://api.spotify.com/v1";
const SPOTIFY_SCOPES = "user-read-currently-playing user-read-playback-state user-modify-playback-state";

// Minimum time between any two polls (guards against hammering the API).
const MIN_POLL_INTERVAL_MS = 10_000;
// Poll interval when nothing is currently playing.
const NO_TRACK_POLL_INTERVAL_MS = 30_000;
// Total number of Spotify API polls allowed per track (including the initial
// discovery poll). Remaining polls are spread evenly across the track's
// remaining duration; once the budget is exhausted the poller sleeps until
// the track ends.
const TRACK_POLLS_PER_SONG = 3;

// Buffer (ms) before token expiry at which we proactively refresh.
const TOKEN_REFRESH_BUFFER_MS = 60_000;

// ─── Client ID resolution ─────────────────────────────────────────────────────

/**
 * Return the effective Client ID — either one previously stored by the user
 * or the pre-configured default.  Storing it ensures the same ID is used
 * during the token-refresh leg of the PKCE flow.
 */
function getClientId() {
  return localStorage.getItem(SPOTIFY_CLIENT_ID_KEY) || SPOTIFY_DEFAULT_CLIENT_ID;
}

// Shared state object — sketch.js reads from this.
const spotifyState = {
  bpm: null,
  trackName: null,
  artistName: null,
  energy: null,
  albumArt: null,
  connected: false,
  isPlaying: false,   // true when Spotify reports active playback
  progressMs: null,   // playback position at the last poll (ms)
  durationMs: null,   // total track duration (ms)
  contextName: null,  // playlist / album name the track is playing from
  contextUri: null,   // Spotify context URI (used to detect context changes)
  shuffle: false,     // Spotify shuffle state
  repeatState: "off", // Spotify repeat state: "off" | "context" | "track"
};

// ─── PKCE helpers ────────────────────────────────────────────────────────────

/** Generate a random code verifier string (RFC 7636). */
function generateCodeVerifier() {
  const array = new Uint8Array(64);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/** Derive the S256 code challenge from a verifier. */
async function generateCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

// ─── OAuth flow ───────────────────────────────────────────────────────────────

/** Returns the redirect URI for the current page (strips query/hash). */
function getRedirectUri() {
  return window.location.origin + window.location.pathname;
}

/** Kick off the Spotify authorization redirect. */
async function startSpotifyAuth(clientId) {
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);

  localStorage.setItem(SPOTIFY_CODE_VERIFIER_KEY, verifier);
  localStorage.setItem(SPOTIFY_CLIENT_ID_KEY, clientId);

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: getRedirectUri(),
    scope: SPOTIFY_SCOPES,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });

  window.location.href = `${SPOTIFY_AUTH_URL}?${params}`;
}

/** Exchange an authorization code for an access token. */
async function exchangeCodeForToken(code, clientId) {
  const verifier = localStorage.getItem(SPOTIFY_CODE_VERIFIER_KEY);
  if (!verifier) throw new Error("Missing PKCE code verifier.");

  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "authorization_code",
    code,
    redirect_uri: getRedirectUri(),
    code_verifier: verifier,
  });

  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) throw new Error("Token exchange failed.");

  const data = await response.json();
  storeToken(data);
  // Clean up the code verifier — it is single-use.
  localStorage.removeItem(SPOTIFY_CODE_VERIFIER_KEY);
  return data.access_token;
}

/** Refresh an expired access token using the stored refresh token. */
async function refreshAccessToken(clientId) {
  const refreshToken = localStorage.getItem(SPOTIFY_REFRESH_TOKEN_KEY);
  if (!refreshToken) throw new Error("No refresh token stored.");

  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) throw new Error("Token refresh failed.");

  const data = await response.json();
  storeToken(data);
  return data.access_token;
}

/** Persist the token response to localStorage. */
function storeToken(data) {
  localStorage.setItem(SPOTIFY_TOKEN_KEY, data.access_token);
  const expiry = Date.now() + data.expires_in * 1000;
  localStorage.setItem(SPOTIFY_TOKEN_EXPIRY_KEY, String(expiry));
  if (data.refresh_token) {
    localStorage.setItem(SPOTIFY_REFRESH_TOKEN_KEY, data.refresh_token);
  }
}

/** Return a valid access token, refreshing if necessary. */
async function getAccessToken() {
  const clientId = getClientId();

  const token = localStorage.getItem(SPOTIFY_TOKEN_KEY);
  const expiry = parseInt(localStorage.getItem(SPOTIFY_TOKEN_EXPIRY_KEY) || "0", 10);

  if (token && Date.now() < expiry - TOKEN_REFRESH_BUFFER_MS) {
    return token; // Still valid with at least 1 minute to spare.
  }

  // Try to refresh.
  try {
    return await refreshAccessToken(clientId);
  } catch {
    return null;
  }
}

// ─── API calls ────────────────────────────────────────────────────────────────

/**
 * Fetch the current playback state (track, progress, play/pause, context,
 * shuffle, and repeat) from the Spotify Web API.
 * @returns {Promise<{item, progressMs, isPlaying, context, shuffle, repeatState}|null>}
 *   Null when there is no active device or nothing playing.
 */
async function fetchCurrentlyPlaying(token) {
  const response = await fetch(`${SPOTIFY_API_BASE}/me/player`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 204 || response.status === 202) return null; // No active playback.
  if (!response.ok) throw new Error(`Spotify API error: ${response.status}`);

  const data = await response.json();
  if (!data || !data.item) return null;

  return {
    item: data.item,
    progressMs: data.progress_ms ?? null,
    isPlaying: data.is_playing ?? false,
    context: data.context ?? null,
    shuffle: data.shuffle_state ?? false,
    repeatState: data.repeat_state ?? "off",
  };
}

// In-memory cache for audio features keyed by Spotify track ID.
// Prevents redundant API calls and console 403 spam for the same track.
const audioFeaturesCache = {};

/** Fetch audio features (tempo/BPM, energy) for a track ID. */
async function fetchAudioFeatures(token, trackId) {
  // Return cached result (including a cached null for failed fetches).
  if (Object.prototype.hasOwnProperty.call(audioFeaturesCache, trackId)) {
    return audioFeaturesCache[trackId];
  }

  const response = await fetch(`${SPOTIFY_API_BASE}/audio-features/${trackId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 403) {
    // The audio-features endpoint requires specific Spotify plan / token scope.
    // Cache the failure so we stop retrying and log only once.
    console.warn(
      "[Matrix] Spotify audio-features returned 403 — BPM-sync disabled for this track."
    );
    audioFeaturesCache[trackId] = null;
    return null;
  }

  if (!response.ok) {
    // Don't cache transient failures (401/429/5xx/etc.) — "follow the white rabbit"
    // and let the next poll attempt a fresh fetch instead of poisoning the cache.
    console.warn(
      `[Matrix] Spotify audio-features request failed with status ${response.status}; will retry later.`
    );
    return null;
  }

  const data = await response.json();
  audioFeaturesCache[trackId] = data;
  return data;
}

// ─── Context name resolution ──────────────────────────────────────────────────

// In-memory cache for resolved context names keyed by Spotify context URI.
const contextNameCache = {};

/**
 * Resolve a human-readable name for a Spotify context URI.
 * Handles playlist and album types; other types return null.
 * Results are cached to avoid redundant API calls.
 */
async function fetchContextName(token, contextUri) {
  if (!contextUri) return null;

  if (Object.prototype.hasOwnProperty.call(contextNameCache, contextUri)) {
    return contextNameCache[contextUri];
  }

  try {
    const parts = contextUri.split(":");
    const type = parts[1];
    const id = parts[parts.length - 1];

    let endpoint;
    if (type === "playlist") {
      endpoint = `${SPOTIFY_API_BASE}/playlists/${id}?fields=name`;
    } else if (type === "album") {
      endpoint = `${SPOTIFY_API_BASE}/albums/${id}`;
    } else {
      // Artists, user collections, etc. — skip the extra round-trip.
      contextNameCache[contextUri] = null;
      return null;
    }

    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      contextNameCache[contextUri] = null;
      return null;
    }

    const data = await response.json();
    const name = data.name || null;
    contextNameCache[contextUri] = name;
    return name;
  } catch {
    contextNameCache[contextUri] = null;
    return null;
  }
}

// ─── Playback control ─────────────────────────────────────────────────────────

/**
 * Send a playback command to Spotify's remote-control API.
 * Supported actions: "play", "pause", "next", "previous".
 * The UI is updated optimistically, then a fresh poll is triggered shortly
 * after to confirm the new state from the server.
 */
async function controlPlayback(action) {
  const token = await getAccessToken();
  if (!token) return;

  const commands = {
    pause:    { method: "PUT",  url: `${SPOTIFY_API_BASE}/me/player/pause` },
    play:     { method: "PUT",  url: `${SPOTIFY_API_BASE}/me/player/play` },
    next:     { method: "POST", url: `${SPOTIFY_API_BASE}/me/player/next` },
    previous: { method: "POST", url: `${SPOTIFY_API_BASE}/me/player/previous` },
  };

  const cmd = commands[action];
  if (!cmd) return;

  try {
    await fetch(cmd.url, {
      method: cmd.method,
      headers: { Authorization: `Bearer ${token}` },
    });

    // Optimistic UI update while we wait for the next poll to confirm.
    if (action === "pause") spotifyState.isPlaying = false;
    if (action === "play")  spotifyState.isPlaying = true;
    updateUI();

    // Confirm with a fast re-poll after the device has a moment to respond.
    scheduleNextPoll(1500);
  } catch (err) {
    console.warn("[Matrix] Playback control error:", err);
  }
}

/**
 * Toggle Spotify shuffle on or off.
 * Optimistically flips the state then re-polls to confirm.
 */
async function controlShuffle() {
  const token = await getAccessToken();
  if (!token) return;

  const newState = !spotifyState.shuffle;
  try {
    await fetch(`${SPOTIFY_API_BASE}/me/player/shuffle?state=${newState}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
    });
    spotifyState.shuffle = newState;
    updateUI();
    scheduleNextPoll(1500);
  } catch (err) {
    console.warn("[Matrix] Shuffle control error:", err);
  }
}

/**
 * Cycle Spotify repeat mode: off → context → track → off.
 * Optimistically advances the state then re-polls to confirm.
 */
async function controlRepeat() {
  const token = await getAccessToken();
  if (!token) return;

  const cycle = { off: "context", context: "track", track: "off" };
  const newState = cycle[spotifyState.repeatState] ?? "off";
  try {
    await fetch(`${SPOTIFY_API_BASE}/me/player/repeat?state=${newState}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
    });
    spotifyState.repeatState = newState;
    updateUI();
    scheduleNextPoll(1500);
  } catch (err) {
    console.warn("[Matrix] Repeat control error:", err);
  }
}

// ─── Client-side progress animation ──────────────────────────────────────────

let progressTimerId = null;
// Wall-clock timestamp (ms) recorded when progressMs was last fetched.
let lastPollTimestamp = null;

/**
 * Estimate the current playback position by extrapolating from the last
 * known progress using elapsed wall-clock time.
 */
function getCurrentProgressMs() {
  if (spotifyState.progressMs == null) return null;
  if (!spotifyState.isPlaying || lastPollTimestamp == null) {
    return spotifyState.progressMs;
  }
  const extrapolated = spotifyState.progressMs + (Date.now() - lastPollTimestamp);
  // Only clamp when we have a known positive duration to clamp against.
  return spotifyState.durationMs > 0
    ? Math.min(extrapolated, spotifyState.durationMs)
    : extrapolated;
}

/** Format a duration in milliseconds as m:ss. */
function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Update the progress bar and timestamps. Called every second by the timer. */
function updateProgressBar() {
  const progressFill = document.getElementById("spotify-progress-fill");
  const progressTime = document.getElementById("spotify-progress-time");
  const durationTime = document.getElementById("spotify-duration-time");

  if (!progressFill) return;

  const cur = getCurrentProgressMs();
  const dur = spotifyState.durationMs;

  if (cur == null || dur == null || dur === 0) {
    progressFill.style.width = "0%";
    return;
  }

  progressFill.style.width = `${Math.min(100, (cur / dur) * 100)}%`;
  if (progressTime) progressTime.textContent = formatTime(cur);
  if (durationTime) durationTime.textContent = formatTime(dur);
}

/** Start the 1-second progress tick. No-op if already running. */
function startProgressTimer() {
  if (progressTimerId !== null) return;
  progressTimerId = setInterval(updateProgressBar, 1000);
}

/** Stop the progress tick. */
function stopProgressTimer() {
  if (progressTimerId !== null) {
    clearInterval(progressTimerId);
    progressTimerId = null;
  }
}

let pollTimer = null;
// Track the Spotify track ID for which the current poll budget applies.
let currentPolledTrackId = null;
// Remaining polls available for the current track (decremented each poll).
let trackPollsRemaining = 0;

/**
 * Schedule the next poll after `delayMs` milliseconds.
 * Cancels any previously pending timer so we never queue duplicate polls.
 */
function scheduleNextPoll(delayMs) {
  if (pollTimer !== null) clearTimeout(pollTimer);
  const delaySec = (delayMs / 1000).toFixed(0);
  console.log(`[Matrix] Next Spotify poll in ${delaySec}s.`);
  pollTimer = setTimeout(() => {
    pollTimer = null;
    pollNowPlaying();
  }, delayMs);
}

/** Poll Spotify and update spotifyState. Self-schedules the next poll. */
async function pollNowPlaying() {
  console.log("[Matrix] pollNowPlaying — follow the white rabbit...");

  const token = await getAccessToken();
  if (!token) {
    console.warn("[Matrix] No valid access token — stopping poll, disconnecting.");
    stopPolling();
    spotifyState.connected = false;
    updateUI();
    return;
  }

  console.log("[Matrix] Access token valid — fetching currently playing track.");
  spotifyState.connected = true;

  // Default delay used when we have no track duration to work from.
  let nextDelay = NO_TRACK_POLL_INTERVAL_MS;

  try {
    const playing = await fetchCurrentlyPlaying(token);

    if (!playing) {
      // Nothing playing — clear track metadata but keep the last known BPM
      // so the rain doesn't abruptly reset. Wake up, Neo: the stream remembers
      // the tempo of the last track that fell.
      console.log("[Matrix] No track currently playing. Retaining last BPM:", spotifyState.bpm);
      spotifyState.trackName = null;
      spotifyState.artistName = null;
      spotifyState.albumArt = null;
      spotifyState.isPlaying = false;
      spotifyState.progressMs = null;
      spotifyState.durationMs = null;
      stopProgressTimer();
      // Keep nextDelay = NO_TRACK_POLL_INTERVAL_MS (already set above).
    } else {
      const track = playing.item;
      const progressMs = playing.progressMs;

      // Capture playback state for the progress animation and play/pause button.
      spotifyState.isPlaying = playing.isPlaying;
      spotifyState.progressMs = progressMs;
      spotifyState.durationMs = track.duration_ms ?? null;
      lastPollTimestamp = Date.now();

      // Capture shuffle and repeat state.
      spotifyState.shuffle = playing.shuffle;
      spotifyState.repeatState = playing.repeatState;

      // Resolve the context (playlist / album) name when it changes.
      const newContextUri = playing.context?.uri ?? null;
      if (newContextUri !== spotifyState.contextUri) {
        spotifyState.contextUri = newContextUri;
        spotifyState.contextName = await fetchContextName(token, newContextUri);
        if (spotifyState.contextName) {
          console.log(
            `[Matrix] Now playing from: "${spotifyState.contextName}" ` +
            `(${playing.context?.type ?? "unknown"}) — free your mind. ` +
            `Track: "${track.name}"`
          );
        }
      }

      // Start or stop the live progress animation based on play/pause state.
      if (spotifyState.isPlaying) {
        startProgressTimer();
      } else {
        stopProgressTimer();
      }

      const prevTrackName = spotifyState.trackName;
      spotifyState.trackName = track.name;
      spotifyState.artistName =
        track.artists && track.artists.length > 0
          ? track.artists[0].name
          : "Unknown";

      // Capture album art URL. Prefer the largest image for the 280×280 card.
      if (track.album && track.album.images && track.album.images.length > 0) {
        // images are sorted largest → smallest; index 0 is the highest-res.
        spotifyState.albumArt = track.album.images[0].url;
      } else {
        spotifyState.albumArt = null;
      }

      if (prevTrackName !== spotifyState.trackName) {
        console.log(
          `[Matrix] Track changed → "${spotifyState.trackName}" by ${spotifyState.artistName}`
        );
      } else {
        console.log(
          `[Matrix] Now playing: "${spotifyState.trackName}" by ${spotifyState.artistName}`
        );
      }

      console.log("[Matrix] Track ID:", track.id, "| Album art:", spotifyState.albumArt);

      // Fetch audio features for BPM and energy.
      const features = await fetchAudioFeatures(token, track.id);
      if (features) {
        const prevBpm = spotifyState.bpm;
        spotifyState.bpm = features.tempo;
        spotifyState.energy = features.energy;
        const bpmStr = spotifyState.bpm != null ? spotifyState.bpm.toFixed(1) : "n/a";
        const energyStr = spotifyState.energy != null ? spotifyState.energy.toFixed(3) : "n/a";
        if (prevBpm !== spotifyState.bpm) {
          const prevBpmStr = prevBpm != null ? prevBpm.toFixed(1) : "none";
          console.log(
            `[Matrix] BPM updated: ${prevBpmStr} → ${bpmStr} | Energy: ${energyStr}`
          );
        } else {
          console.log(
            `[Matrix] BPM: ${bpmStr} | Energy: ${energyStr}`
          );
        }
      } else {
        console.log("[Matrix] Audio features unavailable — BPM unchanged:", spotifyState.bpm);
      }

      // ── Poll budget ────────────────────────────────────────────────────
      // Reset the budget when the track changes; the current poll counts
      // as the first use, so initialise remaining = TRACK_POLLS_PER_SONG - 1.
      if (track.id !== currentPolledTrackId) {
        currentPolledTrackId = track.id;
        trackPollsRemaining = TRACK_POLLS_PER_SONG - 1;
      } else {
        trackPollsRemaining = Math.max(0, trackPollsRemaining - 1);
      }

      const durationMs = track.duration_ms ?? 0;
      const remaining = Math.max(0, durationMs - (progressMs ?? 0));

      if (trackPollsRemaining > 0) {
        // Spread remaining polls evenly across the track's remaining duration.
        nextDelay = Math.max(MIN_POLL_INTERVAL_MS, remaining / trackPollsRemaining);
      } else {
        // Poll budget exhausted — sleep until just after the track ends, then
        // check whether a new track has started.
        nextDelay = remaining > 0
          ? remaining + MIN_POLL_INTERVAL_MS
          : NO_TRACK_POLL_INTERVAL_MS;
      }
    }
  } catch (err) {
    // Log the error but keep the rain falling; retry after the idle interval.
    console.warn("[Matrix] pollNowPlaying error:", err);
  }

  updateUI();
  scheduleNextPoll(nextDelay);
}

function startPolling() {
  if (pollTimer !== null) return; // Already scheduled.
  console.log("[Matrix] Starting Spotify poll — smart scheduling enabled.");
  pollNowPlaying(); // Immediate first poll; subsequent polls are self-scheduled.
}

function stopPolling() {
  if (pollTimer !== null) {
    console.log("[Matrix] Stopping Spotify poll.");
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

/** Spotify Client IDs are exactly 32 lowercase hexadecimal characters. */
function isValidClientId(id) {
  return /^[0-9a-f]{32}$/.test(id);
}

/** Refresh the on-screen player card. */
function updateUI() {
  const playerCard = document.getElementById("spotify-player-card");
  const connectBtn = document.getElementById("spotify-connect-btn");

  if (!playerCard) return;

  if (!spotifyState.connected) {
    connectBtn.style.display = "flex";
    playerCard.style.display = "none";
    stopProgressTimer();
    return;
  }

  connectBtn.style.display = "none";

  if (spotifyState.trackName) {
    playerCard.style.display = "flex";

    // Track name and artist.
    const trackNameEl = document.getElementById("spotify-track-name");
    const artistNameEl = document.getElementById("spotify-artist-name");
    if (trackNameEl) trackNameEl.textContent = spotifyState.trackName;
    if (artistNameEl) artistNameEl.textContent = spotifyState.artistName || "";

    // Context (playlist / album) name.
    const contextNameEl = document.getElementById("spotify-context-name");
    if (contextNameEl) {
      contextNameEl.textContent = spotifyState.contextName
        ? `▶ ${spotifyState.contextName}`
        : "";
    }

    // BPM readout.
    const bpmEl = document.getElementById("spotify-bpm");
    if (bpmEl) {
      bpmEl.textContent = Number.isFinite(spotifyState.bpm)
        ? `${Math.round(spotifyState.bpm)} BPM`
        : "";
    }

    // Album art.
    const albumArtEl = document.getElementById("spotify-album-art");
    if (albumArtEl) {
      if (spotifyState.albumArt) {
        albumArtEl.src = spotifyState.albumArt;
      } else {
        albumArtEl.removeAttribute("src");
      }
    }

    // Toggle play / pause icon.
    const playIcon = document.getElementById("spotify-play-icon");
    const pauseIcon = document.getElementById("spotify-pause-icon");
    if (playIcon && pauseIcon) {
      playIcon.style.display = spotifyState.isPlaying ? "none" : "block";
      pauseIcon.style.display = spotifyState.isPlaying ? "block" : "none";
    }

    // Indicate active shuffle state with a dot marker.
    const shuffleBtn = document.getElementById("spotify-shuffle-btn");
    if (shuffleBtn) {
      shuffleBtn.classList.toggle("sp-btn--active", spotifyState.shuffle);
    }

    // Indicate active repeat state (context or track) with a dot marker.
    const repeatBtn = document.getElementById("spotify-repeat-btn");
    if (repeatBtn) {
      repeatBtn.classList.toggle("sp-btn--active", spotifyState.repeatState !== "off");
    }

    // Sync the progress bar immediately, then let the timer keep it moving.
    updateProgressBar();
    if (spotifyState.isPlaying) {
      startProgressTimer();
    } else {
      stopProgressTimer();
    }
  } else {
    playerCard.style.display = "none";
  }
}

// ─── Initialisation ───────────────────────────────────────────────────────────

/**
 * Called on page load. Handles the OAuth callback (if a `?code=` param is
 * present) and starts polling if a token is already stored.
 */
async function initSpotify() {
  console.log("[Matrix] initSpotify — wake up, Neo. Checking Spotify connection...");

  // Seed the stored Client ID with the default on first run so the PKCE
  // callback leg can always find a consistent ID in localStorage.
  if (!localStorage.getItem(SPOTIFY_CLIENT_ID_KEY)) {
    localStorage.setItem(SPOTIFY_CLIENT_ID_KEY, SPOTIFY_DEFAULT_CLIENT_ID);
  }

  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const clientId = getClientId();

  console.log("[Matrix] Using Client ID:", clientId);

  if (code) {
    console.log("[Matrix] OAuth callback detected — exchanging code for token...");
    // Remove the code from the URL so a refresh doesn't re-attempt the exchange.
    window.history.replaceState({}, document.title, window.location.pathname);
    try {
      await exchangeCodeForToken(code, clientId);
      console.log("[Matrix] Token exchange successful.");
    } catch (err) {
      console.warn("[Matrix] Token exchange failed:", err);
      // Token exchange failed — show the connect button.
    }
  }

  // Start polling if we have a stored token.
  const token = await getAccessToken();
  if (token) {
    console.log("[Matrix] Stored token found — starting polling.");
    spotifyState.connected = true;
    startPolling();
    updateUI();
  } else {
    console.log("[Matrix] No stored token — showing connect button.");
  }

  // Wire up the "Connect Spotify" button.
  // Because the Client ID is pre-configured, clicking the button goes straight
  // to Spotify authorisation without a manual ID entry prompt.
  const connectBtn = document.getElementById("spotify-connect-btn");
  if (connectBtn) {
    connectBtn.addEventListener("click", async (e) => {
      e.stopPropagation(); // Don't trigger fullscreen.
      console.log("[Matrix] Connect Spotify clicked — starting auth flow.");
      await startSpotifyAuth(getClientId());
    });
  }

  // Wire up playback control buttons (previous / play-pause / next).
  const prevBtn = document.getElementById("spotify-prev-btn");
  if (prevBtn) {
    prevBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      controlPlayback("previous");
    });
  }

  const playPauseBtn = document.getElementById("spotify-playpause-btn");
  if (playPauseBtn) {
    playPauseBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      controlPlayback(spotifyState.isPlaying ? "pause" : "play");
    });
  }

  const nextBtn = document.getElementById("spotify-next-btn");
  if (nextBtn) {
    nextBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      controlPlayback("next");
    });
  }

  const shuffleBtn = document.getElementById("spotify-shuffle-btn");
  if (shuffleBtn) {
    shuffleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      controlShuffle();
    });
  }

  const repeatBtn = document.getElementById("spotify-repeat-btn");
  if (repeatBtn) {
    repeatBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      controlRepeat();
    });
  }
}

// Expose state and init function globally for sketch.js to consume.
window.spotifyState = spotifyState;
window.initSpotify = initSpotify;
