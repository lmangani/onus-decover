export interface NavigatorLike {
  userAgent?: string;
  maxTouchPoints?: number;
  deviceMemory?: number;
}

export interface DemucsCapability {
  allowed: boolean;
  reason: string | null;
}

const MOBILE = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i;

export function demucsCapability(nav: NavigatorLike = globalThis.navigator ?? {}): DemucsCapability {
  const userAgent = nav.userAgent ?? "";
  const touch = nav.maxTouchPoints ?? 0;
  const mobile = MOBILE.test(userAgent) || (/Macintosh/i.test(userAgent) && touch > 1);
  if (mobile) {
    return { allowed: false, reason: "Lyric-detection bypass is desktop-only." };
  }
  if (typeof nav.deviceMemory === "number" && nav.deviceMemory < 4) {
    return { allowed: false, reason: "This device reports under 4 GB RAM." };
  }
  return { allowed: true, reason: null };
}
