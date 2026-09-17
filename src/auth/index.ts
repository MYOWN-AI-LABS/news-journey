export async function runAuth(provider: string): Promise<void> {
  if (provider === "google") {
    const { authGoogle } = await import("./google.js");
    await authGoogle();
  } else if (provider === "linkedin") {
    const { authLinkedIn } = await import("./linkedin.js");
    await authLinkedIn();
  } else if (provider === "meta") {
    const { authMeta } = await import("./meta.js");
    await authMeta();
  } else if (provider === "x") {
    const { authX } = await import("./x.js");
    await authX();
  } else if (provider === "threads") {
    const { authThreads } = await import("./threads.js");
    await authThreads();
  } else if (provider === "tiktok") {
    const { authTikTok } = await import("./tiktok.js");
    await authTikTok();
  } else if (provider === "reddit") {
    const { authReddit } = await import("./reddit.js");
    await authReddit();
  } else {
    throw new Error(`Unknown provider "${provider}" — use google|linkedin|meta|x|threads|tiktok|reddit`);
  }
}
