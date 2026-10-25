// Applications use the same persistent, visible Chrome context as sign-in.
// Background discovery may copy cookies into a separate headless profile;
// copying cookies does not reproduce the full signed-in application session.
export const APPLICATION_BROWSER_OPTIONS = Object.freeze({
  headless: false,
  stealth: true,
  offscreen: false,
});
