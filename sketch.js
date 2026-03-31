let symbolSize = 18;
let timeElapsed = 0.0;

// BPM range used to map Spotify tempo to stream interval speed.
const MIN_BPM = 60;
const MAX_BPM = 200;

// Stream interval bounds: slower interval = slower rain, faster = faster rain.
const SLOW_INTERVAL = 0.08;
const FAST_INTERVAL = 0.01;

let cols;

let streams = [];

let gfx;
let katakanaFont;
let wakeLock = null;

function replaceAt(str, index, replacement) {
  return (
    str.substring(0, index) +
    replacement +
    str.substring(index + replacement.length)
  );
}

async function setup() {
  createCanvas(windowWidth, windowHeight, P2D);
  katakanaFont = await loadFont("fonts/NotoSansJP-Regular.ttf");
  textFont(katakanaFont);

  cols = width / symbolSize;

  for (let i = 0; i < cols; i++) {
    let x = i * symbolSize;
    streams[i] = new Stream(x);
    streams[i].prepare();
  }

  gfx = createGraphics(width, height, P2D);
  gfx.textFont(katakanaFont);
  gfx.textSize(symbolSize);
  colorMode(HSB, 360, 100, 100);

  // Re-acquire the wake lock whenever the page becomes visible again
  // (browsers automatically release it when the tab is hidden).
  document.addEventListener("visibilitychange", () => {
    if (wakeLock !== null && document.visibilityState === "visible") {
      requestWakeLock();
    }
  });
}

function draw() {
  background(0);
  gfx.background(0);

  for (let i = 0; i < streams.length; i++) {
    streams[i].update(timeElapsed);
    streams[i].render();
  }

  //gfx.filter(BLUR, 5); // optional post-processing blur; disabled by default
  image(gfx, 0, 0);

  timeElapsed = 1 / frameRate();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);

  cols = width / symbolSize;

  streams = [];
  for (let i = 0; i < cols; i++) {
    let x = i * symbolSize;
    streams[i] = new Stream(x);
    streams[i].prepare();
  }

  gfx = createGraphics(width, height, P2D);
  gfx.textFont(katakanaFont);
  gfx.textSize(symbolSize);
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch (err) {
    // Request can fail if the document is not visible or the device
    // doesn't permit it (e.g., low battery). Fail silently.
  }
}

/**
 * Map a Spotify BPM value (tempo) to a stream interval.
 * Faster music (higher BPM) → shorter interval → faster rain.
 * Range: MIN_BPM → SLOW_INTERVAL,  MAX_BPM → FAST_INTERVAL.
 */
function bpmToInterval(bpm) {
  const clamped = Math.max(MIN_BPM, Math.min(MAX_BPM, bpm));
  return map(clamped, MIN_BPM, MAX_BPM, SLOW_INTERVAL, FAST_INTERVAL);
}

/**
 * Return a base interval driven by the current Spotify BPM when connected,
 * or a random value for the classic Matrix look.
 */
function getBaseInterval() {
  const state = window.spotifyState;
  if (state && state.connected && state.bpm) {
    return bpmToInterval(state.bpm);
  }
  return random(FAST_INTERVAL, SLOW_INTERVAL);
}

// On click: enter fullscreen and request a screen wake lock.
function mouseClicked() {
  // Enter fullscreen if not already in it. Browsers require a user gesture,
  // so a canvas click is the perfect trigger.
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {
      // Fullscreen may be blocked on some devices/browsers — fail silently.
    });
  }
  requestWakeLock();
}

class Stream {
  constructor(x) {
    this.x = x;
    this.y = 0;
    this.length = 1;
    this.text = "";
    this.interval = 0.05;
    this.time = 0.0;
  }

  prepare() {
    let rows = (height * 0.5) / symbolSize;
    this.y = random(rows) * symbolSize * -1;
    this.length = round(random(12, 64));

    this.text = this.getRandomString(this.length);

    this.interval = getBaseInterval();
  }

  getRandomString(len) {
    let st = "";
    for (let i = 0; i < len; i++) {
      st += this.randomChar();
    }
    return st;
  }

  shiftString(s) {
    return s.charAt(s.length - 1) + s.substring(0, s.length - 1);
  }

  randomChar() {
    return String.fromCharCode(0x30a0 + floor(random(0, 96)));
  }

  flicker() {
    let r = round(random(0, 2));

    if (r === 0 && this.text.length > 2) {
      let idx = floor(random(2, this.text.length));
      this.text = replaceAt(this.text, idx, this.randomChar());
    }
  }

  update(elapsed) {
    if (this.time >= this.interval) {
      this.y += symbolSize;
      this.time = 0;

      this.text = this.shiftString(this.text);
    }

    if (this.y - this.text.length * symbolSize > height) {
      this.prepare();
    }

    this.flicker();

    this.time += elapsed;
  }

  render() {
    for (let i = 0; i < this.text.length; i++) {
      let _x = this.x;
      let _y = this.y - i * symbolSize;

      let brightVal = map(this.interval, FAST_INTERVAL, SLOW_INTERVAL, 100, 20);
      let col = color(132, 92, brightVal);

      let c = this.text[i];

      if (i < 4) {
        col = color(132, 20, brightVal + 20);
      }

      if (i > this.text.length - this.text.length / 4) {
        col = color(132, 92, brightVal - 20);
      }

      if (i === 0) {
        c = this.randomChar();
        col = color(0, 0, 100);
      }

      gfx.fill(col);
      gfx.text(c, _x, _y);
    }
  }
}

