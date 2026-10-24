const SYNC_MS = 2000;

/**
 * One persistent face element per user: their live camera if Foundry's A/V has a video track for them, otherwise
 * their avatar. Streams are taken from Foundry's AV client, so Foundry keeps doing all the WebRTC work; audio stays
 * muted because voice runs over Discord.
 */
export class CameraFaces {
  constructor() {
    this.faces = new Map();
    this.sync = this.sync.bind(this);
  }

  start() {
    this.hookId = Hooks.on("renderCameraViews", this.sync);
    this.timer = window.setInterval(this.sync, SYNC_MS);
    this.sync();
  }

  stop() {
    Hooks.off("renderCameraViews", this.hookId);
    window.clearInterval(this.timer);
  }

  /** @returns {HTMLElement} */
  get(user) {
    let face = this.faces.get(user.id);
    if (!face) {
      face = document.createElement("div");
      face.className = "tct-face-media";
      const video = document.createElement("video");
      Object.assign(video, { autoplay: true, muted: true, playsInline: true });
      // Everyone sees themselves mirrored, like in any video call.
      video.classList.toggle("is-self", user.isSelf);
      const img = document.createElement("img");
      img.alt = "";
      face.append(img, video);
      this.faces.set(user.id, face);
    }
    face.querySelector("img").src = user.avatar;
    this.syncOne(user.id, face);
    return face;
  }

  sync() {
    for (const [userId, face] of this.faces) this.syncOne(userId, face);
  }

  syncOne(userId, face) {
    const video = face.querySelector("video");
    const stream = this.streamFor(userId);
    if (stream && video.srcObject !== stream) video.srcObject = stream;
    if (!stream && video.srcObject) video.srcObject = null;
    const live = Boolean(stream?.getVideoTracks().some((t) => t.enabled && t.readyState === "live"));
    face.classList.toggle("has-video", live);
    // Moving a video element in the DOM pauses it.
    if (live && video.paused && video.isConnected) video.play().catch(() => {});
  }

  streamFor(userId) {
    const webrtc = game.webrtc;
    if (!webrtc?.client || !game.users.get(userId)?.active) return null;
    if (webrtc.settings.getUser(userId)?.hidden) return null;
    try {
      return webrtc.client.getMediaStreamForUser(userId) ?? null;
    } catch {
      return null;
    }
  }
}
