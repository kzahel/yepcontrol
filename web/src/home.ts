import { savedPhones } from "./store.js";

// Visitors and crawlers get the introduction in the initial HTML. Existing
// browsers keep their saved-phone home, with the same origin and keys.
void savedPhones()
  .then(async (phones) => {
    if (phones.length) {
      await import("./viewer.js");
      document.getElementById("welcome")?.remove();
    }
  })
  .catch(() => {
    // The introduction and links still work when browser storage is blocked.
  });
