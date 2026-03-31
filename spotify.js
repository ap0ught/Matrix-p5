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
const SPOTIFY_SCOPES = "user-read-currently-playing user-read-playback-state";

const POLL_INTERVAL_MS = 5000;

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
  connected: false,
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

/** Fetch the currently playing track. Returns null if nothing is playing. */
async function fetchCurrentlyPlaying(token) {
  const response = await fetch(`${SPOTIFY_API_BASE}/me/player/currently-playing`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 204 || response.status === 202) return null; // No active playback.
  if (!response.ok) throw new Error(`Spotify API error: ${response.status}`);

  const data = await response.json();
  if (!data || !data.item) return null;

  return data.item;
}

/** Fetch audio features (tempo/BPM, energy) for a track ID. */
async function fetchAudioFeatures(token, trackId) {
  const response = await fetch(`${SPOTIFY_API_BASE}/audio-features/${trackId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) return null;
  return response.json();
}

// ─── Polling ──────────────────────────────────────────────────────────────────

let pollTimer = null;

/** Poll Spotify and update spotifyState. Called on an interval. */
async function pollNowPlaying() {
  const token = await getAccessToken();
  if (!token) {
    stopPolling();
    spotifyState.connected = false;
    updateUI();
    return;
  }

  spotifyState.connected = true;

  try {
    const track = await fetchCurrentlyPlaying(token);

    if (!track) {
      // Nothing playing — keep the last known BPM so the rain doesn't reset.
      updateUI();
      return;
    }

    spotifyState.trackName = track.name;
    spotifyState.artistName =
      track.artists && track.artists.length > 0
        ? track.artists[0].name
        : "Unknown";

    // Fetch audio features for BPM and energy.
    const features = await fetchAudioFeatures(token, track.id);
    if (features) {
      spotifyState.bpm = features.tempo;
      spotifyState.energy = features.energy;
    }
  } catch {
    // Fail silently — the rain keeps falling.
  }

  updateUI();
}

function startPolling() {
  if (pollTimer !== null) return;
  pollNowPlaying(); // Immediate first poll.
  pollTimer = setInterval(pollNowPlaying, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

/** Spotify Client IDs are exactly 32 lowercase hexadecimal characters. */
function isValidClientId(id) {
  return /^[0-9a-f]{32}$/.test(id);
}

/** Refresh the on-screen track-info overlay. */
function updateUI() {
  const overlay = document.getElementById("spotify-overlay");
  const connectBtn = document.getElementById("spotify-connect-btn");
  const trackInfo = document.getElementById("spotify-track-info");
  const trackNameEl = document.getElementById("spotify-track-name");
  const artistNameEl = document.getElementById("spotify-artist-name");
  const bpmEl = document.getElementById("spotify-bpm");

  if (!overlay) return;

  if (!spotifyState.connected) {
    connectBtn.style.display = "flex";
    trackInfo.style.display = "none";
    return;
  }

  connectBtn.style.display = "none";

  if (spotifyState.trackName) {
    trackInfo.style.display = "flex";
    trackNameEl.textContent = spotifyState.trackName;
    artistNameEl.textContent = spotifyState.artistName || "";
    bpmEl.textContent = spotifyState.bpm
      ? `${Math.round(spotifyState.bpm)} BPM`
      : "";
  } else {
    trackInfo.style.display = "none";
  }
}

// ─── Initialisation ───────────────────────────────────────────────────────────

/**
 * Called on page load. Handles the OAuth callback (if a `?code=` param is
 * present) and starts polling if a token is already stored.
 */
async function initSpotify() {
  // Seed the stored Client ID with the default on first run so the PKCE
  // callback leg can always find a consistent ID in localStorage.
  if (!localStorage.getItem(SPOTIFY_CLIENT_ID_KEY)) {
    localStorage.setItem(SPOTIFY_CLIENT_ID_KEY, SPOTIFY_DEFAULT_CLIENT_ID);
  }

  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const clientId = getClientId();

  if (code) {
    // Remove the code from the URL so a refresh doesn't re-attempt the exchange.
    window.history.replaceState({}, document.title, window.location.pathname);
    try {
      await exchangeCodeForToken(code, clientId);
    } catch {
      // Token exchange failed — show the connect button.
    }
  }

  // Start polling if we have a stored token.
  const token = await getAccessToken();
  if (token) {
    spotifyState.connected = true;
    startPolling();
    updateUI();
  }

  // Wire up the "Connect Spotify" button.
  // Because the Client ID is pre-configured, clicking the button goes straight
  // to Spotify authorisation without a manual ID entry prompt.
  const connectBtn = document.getElementById("spotify-connect-btn");
  if (connectBtn) {
    connectBtn.addEventListener("click", async (e) => {
      e.stopPropagation(); // Don't trigger fullscreen.
      await startSpotifyAuth(getClientId());
    });
  }
}

// Expose state and init function globally for sketch.js to consume.
window.spotifyState = spotifyState;
window.initSpotify = initSpotify;
