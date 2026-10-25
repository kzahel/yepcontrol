// A scanned URL contains a short-lived pairing secret in its fragment. Never
// persist it or send it to Play: installation needs a fresh scan and approval.
history.replaceState(null, "", location.pathname);
